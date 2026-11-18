import 'dotenv/config';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAgentChatStream } from './server/agentChat.ts';
import { getDataDir, loadOrInitConfig } from './server/config.ts';
import {
  downloadManager,
  installLlamaServerFromArchive,
  installLlamaServerRuntime,
  listHubGgufFiles,
  probeDirectGgufUrl,
  searchHubModels,
  type LlamaBackendPreference,
} from './server/downloader.ts';
import { modelServer, type ModelServerRuntime } from './server/engine.ts';
import {
  formatGeminiError,
  generateGeminiEmbeddings,
  generateGeminiText,
  streamGeminiText,
  type OpenAiChatMessage,
} from './server/gemini.ts';
import { generateGgufChat, streamGgufChat } from './server/ggufRunner.ts';
import { assessModelCompatibility, detectHardwareProfile } from './server/hardware.ts';
import { logger, maskSecretValue } from './server/logger.ts';
import { normalizeOpenAiMessages, openAiError } from './server/security.ts';
import {
  clearToolAuditLogs,
  detectShellEnvironment,
  getAccessConfig,
  getToolAuditLogs,
  resetAccessConfig,
  testWorkspacePath,
  updateAccessConfig,
} from './server/workspaceTools.ts';
import type { HubSource } from './src/types/engine.ts';

const __filename = typeof import.meta?.url === 'string' ? fileURLToPath(import.meta.url) : '';
const __dirname = __filename ? path.dirname(__filename) : process.cwd();
const DEFAULT_PORT = 3003;
const PORT_CONFIG_DIR = process.env.VLLM_DATA_DIR || path.join(os.homedir(), '.vllm-gateway');
const PORT_CONFIG_PATH = path.join(PORT_CONFIG_DIR, 'server-config.json');

function resolvePublicDistDir(): string {
  const candidates = [
    process.env.VLLM_DIST_DIR,
    path.resolve(__dirname, 'dist'),
    path.resolve(__dirname, '..', 'dist'),
    path.resolve(path.dirname(process.execPath), 'dist'),
    path.resolve(process.cwd(), 'dist'),
  ].filter((p): p is string => Boolean(p));

  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'index.html'))) {
      return dir;
    }
  }
  return path.resolve(process.cwd(), 'dist');
}

export interface GatewayAppOptions {
  engine?: ModelServerRuntime;
  enableVite?: boolean;
  host?: string;
  initialPort?: number;
  getServer?: () => ReturnType<express.Express['listen']> | undefined;
  setServer?: (next: ReturnType<express.Express['listen']>) => void;
}

export async function createGatewayApp(options: GatewayAppOptions = {}) {
  const engine = options.engine ?? modelServer;
  const HOST = options.host ?? process.env.HOST ?? '127.0.0.1';
  let currentPort = options.initialPort ?? (Number(process.env.PORT) || DEFAULT_PORT);

  const app = express();
  app.use(express.json({ limit: '4mb' }));

  // =========================================================================
  // Health, Readiness & Diagnostics (Tokenless)
  // =========================================================================
  app.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      version: '0.1.0',
      uptimeSec: Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
    });
  });

  app.get('/ready', (_req, res) => {
    let dataDirWritable = false;
    try {
      const dir = getDataDir();
      fs.accessSync(dir, fs.constants.W_OK);
      dataDirWritable = true;
    } catch {
      dataDirWritable = false;
    }
    const runningModels = engine.getRunningDeployments().length;
    res.status(dataDirWritable ? 200 : 503).json({
      ready: dataDirWritable,
      dataDirWritable,
      runningModels,
    });
  });

  app.get('/api/diagnostics', (_req, res) => {
    const cfg = loadOrInitConfig();
    const snap = engine.getSnapshot();
    res.json({
      generatedAt: new Date().toISOString(),
      version: '0.1.0',
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
      uptimeSec: Math.round(process.uptime()),
      config: {
        schemaVersion: cfg.schemaVersion,
        updatedAt: cfg.updatedAt,
        pagedAttention: cfg.pagedAttention,
        agentPermissions: cfg.agentPermissions,
        secretsMasked: {
          geminiApiKey: process.env.GEMINI_API_KEY ? maskSecretValue(process.env.GEMINI_API_KEY) : null,
          hfToken: process.env.HF_TOKEN ? maskSecretValue(process.env.HF_TOKEN) : null,
          modelscopeToken: process.env.MODELSCOPE_TOKEN ? maskSecretValue(process.env.MODELSCOPE_TOKEN) : null,
        },
      },
      hardware: snap.hardware,
      deployments: snap.deployments.map((d) => ({
        id: d.id,
        alias: d.alias,
        baseModel: d.baseModel,
        provider: d.provider,
        status: d.status,
        totalServed: d.totalServed,
        totalErrors: d.totalErrors,
        lastError: d.lastError,
      })),
      recentLogs: logger.getRecentLogs(100),
    });
  });

  app.get('/api/server/config', (_req, res) => {
    res.json({ host: HOST, port: currentPort, defaultPort: DEFAULT_PORT });
  });

  app.put('/api/server/config', (req, res) => {
    const nextPort = Number(req.body?.port);
    if (!Number.isInteger(nextPort) || nextPort < 1024 || nextPort > 65535) {
      res.status(400).json({ error: 'Порт должен быть целым числом от 1024 до 65535.' });
      return;
    }
    if (nextPort === currentPort) {
      res.json({ port: currentPort, unchanged: true });
      return;
    }

    const activeServer = options.getServer?.();
    const nextServer = app.listen(nextPort, HOST);
    nextServer.once('error', (err: NodeJS.ErrnoException) => {
      res.status(409).json({
        error: err.code === 'EADDRINUSE'
          ? `Порт ${nextPort} уже занят. Выберите другой порт.`
          : `Не удалось открыть порт ${nextPort}: ${err.message}`,
      });
    });
    nextServer.once('listening', () => {
      try {
        fs.mkdirSync(PORT_CONFIG_DIR, { recursive: true });
        fs.writeFileSync(PORT_CONFIG_PATH, JSON.stringify({ port: nextPort }, null, 2), 'utf8');
      } catch (err) {
        nextServer.close();
        res.status(500).json({
          error: err instanceof Error ? err.message : 'Не удалось сохранить настройки порта.',
        });
        return;
      }

      options.setServer?.(nextServer);
      currentPort = nextPort;
      res.json({ port: currentPort, unchanged: false });
      if (activeServer) {
        res.once('finish', () => activeServer.close());
      }
    });
  });

  // =========================================================================
  // Model OS / Filesystem & PowerShell Access Settings + Agent Chat (/api/access/*, /api/chat/agent)
  // =========================================================================
  app.get('/api/access/config', (_req, res) => {
    res.json({
      config: getAccessConfig(),
      environment: detectShellEnvironment(true),
    });
  });

  app.put('/api/access/config', (req, res) => {
    try {
      const updated = updateAccessConfig(req.body ?? {});
      res.json({
        config: updated,
        environment: detectShellEnvironment(),
      });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/access/reset', (_req, res) => {
    res.json({
      config: resetAccessConfig(),
      environment: detectShellEnvironment(),
    });
  });

  app.post('/api/access/test-path', (req, res) => {
    try {
      const target = String(req.body?.path ?? '');
      res.json(testWorkspacePath(target));
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get('/api/access/logs', (_req, res) => {
    res.json({ logs: getToolAuditLogs() });
  });

  app.delete('/api/access/logs', (_req, res) => {
    clearToolAuditLogs();
    res.json({ logs: [] });
  });

  app.post('/api/chat/agent', async (req, res) => {
    const body = req.body ?? {};
    let messages: OpenAiChatMessage[];
    try {
      messages = normalizeOpenAiMessages(body.messages);
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : 'Некорректный формат сообщений.',
      });
      return;
    }

    const deployment = engine.findDeploymentByModel(body.model);
    if (!deployment) {
      res.status(404).json({ error: `Модель "${body.model ?? ''}" не найдена на сервере.` });
      return;
    }
    if (deployment.status !== 'running') {
      res.status(503).json({
        error: `Модель "${deployment.alias}" сейчас остановлена (статус: ${deployment.status}).`,
      });
      return;
    }
    if (deployment.capability !== 'text') {
      res.status(400).json({ error: `Модель "${deployment.alias}" предназначена для эмбеддингов.` });
      return;
    }

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    const abortController = new AbortController();
    req.on('close', () => {
      abortController.abort();
    });

    await runAgentChatStream({
      engine,
      deployment,
      messages,
      userSystemPrompt: typeof body.systemPrompt === 'string' ? body.systemPrompt : undefined,
      enableTools: body.enableTools !== false,
      signal: abortController.signal,
      emit: (evt) => {
        if (!res.writableEnded) {
          res.write(`data: ${JSON.stringify(evt)}\n\n`);
        }
      },
    });

    if (!res.writableEnded) {
      res.write('data: [DONE]\n\n');
      res.end();
    }
  });

  // =========================================================================
  // OpenAI-Compatible Endpoints (/v1/*)
  // =========================================================================
  app.get('/v1/models', (_req, res) => {
    const running = engine.getRunningDeployments();
    res.json({
      object: 'list',
      data: running.map((dep) => ({
        id: dep.alias,
        object: 'model',
        created: Math.floor((dep.startedAtMs ?? Date.now()) / 1000),
        owned_by: 'vllm-gateway',
        root: dep.baseModel,
        capability: dep.capability,
      })),
    });
  });

  app.post('/v1/chat/completions', async (req, res) => {
    const body = req.body ?? {};
    let messages: OpenAiChatMessage[];
    try {
      messages = normalizeOpenAiMessages(body.messages);
    } catch (err) {
      res.status(400).json(openAiError(err instanceof Error ? err.message : 'Некорректный формат messages.', 'invalid_request_error', 'messages'));
      return;
    }

    if (body.temperature !== undefined && (typeof body.temperature !== 'number' || body.temperature < 0 || body.temperature > 2)) {
      res.status(400).json(openAiError('Параметр temperature должен быть числом от 0 до 2.', 'invalid_request_error', 'temperature'));
      return;
    }
    if (body.top_p !== undefined && (typeof body.top_p !== 'number' || body.top_p <= 0 || body.top_p > 1)) {
      res.status(400).json(openAiError('Параметр top_p должен быть числом в диапазоне (0, 1].', 'invalid_request_error', 'top_p'));
      return;
    }
    if (body.n !== undefined && body.n !== 1) {
      res.status(400).json(openAiError('Поддерживается только n=1.', 'invalid_request_error', 'n'));
      return;
    }

    const deployment = engine.findDeploymentByModel(body.model);
    if (!deployment) {
      res.status(404).json(openAiError(`Модель "${body.model ?? ''}" не найдена на сервере.`, 'model_not_found', 'model', 'model_not_found'));
      return;
    }
    if (deployment.status !== 'running') {
      res.status(503).json(openAiError(`Модель "${deployment.alias}" сейчас остановлена (статус: ${deployment.status}). Запустите её в панели моделей.`, 'model_not_running'));
      return;
    }
    if (deployment.capability !== 'text') {
      res.status(400).json(openAiError(`Модель "${deployment.alias}" предназначена для эмбеддингов (/v1/embeddings).`, 'invalid_request_error'));
      return;
    }

    const stream = Boolean(body.stream);
    const lastUserMessage =
      [...messages].reverse().find((m) => m.role === 'user')?.content ??
      messages[messages.length - 1]?.content ??
      '';

    const systemPrompt = messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n');
    const promptCharCount = messages.reduce(
      (sum, m) => sum + (typeof m.content === 'string' ? m.content.length : 0),
      0
    );

    const record = engine.createRequestRecord({
      deployment,
      endpoint: '/v1/chat/completions',
      stream,
      promptPreview: String(lastUserMessage),
      systemPrompt,
      promptCharCount,
    });

    const startedAt = performance.now();
    const completionId = `chatcmpl-${record.id}`;
    const created = Math.floor(Date.now() / 1000);
    const cacheKey = engine.computeCacheKey(deployment, { endpoint: 'chat', messages });
    const textModel = deployment.baseModel as 'gemini-4-hydrogen' | 'gemini-3.1-flash-lite';

    await engine.acquireSlot(deployment.id, record);

    try {
      const cached = engine.lookupCache(deployment, cacheKey);
      if (cached) {
        const elapsedMs = Math.max(0.2, performance.now() - startedAt);
        engine.markRequestCompleted(deployment.id, record, {
          cacheHit: true,
          promptTokens: cached.promptTokens,
          completionTokens: cached.completionTokens,
          totalTokens: cached.totalTokens,
          ttftMs: elapsedMs,
          durationMs: elapsedMs,
        });

        if (stream) {
          res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
          res.setHeader('Cache-Control', 'no-cache, no-transform');
          res.setHeader('Connection', 'keep-alive');
          res.setHeader('X-Cache-Hit', 'true');
          res.flushHeaders?.();

          res.write(
            `data: ${JSON.stringify({
              id: completionId,
              object: 'chat.completion.chunk',
              created,
              model: deployment.alias,
              choices: [{ index: 0, delta: { role: 'assistant', content: cached.text }, finish_reason: null }],
            })}\n\n`
          );
          res.write(
            `data: ${JSON.stringify({
              id: completionId,
              object: 'chat.completion.chunk',
              created,
              model: deployment.alias,
              choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
              usage: {
                prompt_tokens: cached.promptTokens,
                completion_tokens: cached.completionTokens,
                total_tokens: cached.totalTokens,
              },
              x_cache_hit: true,
            })}\n\n`
          );
          res.write('data: [DONE]\n\n');
          res.end();
        } else {
          res.setHeader('X-Cache-Hit', 'true');
          res.json({
            id: completionId,
            object: 'chat.completion',
            created,
            model: deployment.alias,
            choices: [
              { index: 0, message: { role: 'assistant', content: cached.text }, finish_reason: 'stop' },
            ],
            usage: {
              prompt_tokens: cached.promptTokens,
              completion_tokens: cached.completionTokens,
              total_tokens: cached.totalTokens,
            },
            x_cache_hit: true,
          });
        }
        return;
      }

      if (stream) {
        res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache, no-transform');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Cache-Hit', 'false');
        res.flushHeaders?.();

        res.write(
          `data: ${JSON.stringify({
            id: completionId,
            object: 'chat.completion.chunk',
            created,
            model: deployment.alias,
            choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
          })}\n\n`
        );

        let fullText = '';
        let ttftMs: number | null = null;
        let promptTokens = 0;
        let completionTokens = 0;
        let totalTokens = 0;

        const tokenStream =
          deployment.provider === 'local_gguf'
            ? streamGgufChat({
                deploymentId: deployment.id,
                messages,
                defaultSystemInstruction: deployment.systemInstruction,
                temperature: typeof body.temperature === 'number' ? body.temperature : undefined,
                maxTokens: typeof body.max_tokens === 'number' ? body.max_tokens : undefined,
              })
            : streamGeminiText({
                baseModel: textModel,
                messages,
                defaultSystemInstruction: deployment.systemInstruction,
                thinkingLevel: deployment.thinkingLevel,
              });

        for await (const chunk of tokenStream) {
          if (chunk.text) {
            if (ttftMs === null) {
              ttftMs = performance.now() - startedAt;
            }
            fullText += chunk.text;
            engine.appendStreamTokens(record, chunk.text);
            res.write(
              `data: ${JSON.stringify({
                id: completionId,
                object: 'chat.completion.chunk',
                created,
                model: deployment.alias,
                choices: [{ index: 0, delta: { content: chunk.text }, finish_reason: null }],
              })}\n\n`
            );
          }
          if (chunk.usage) {
            promptTokens = chunk.usage.promptTokens || promptTokens;
            completionTokens = chunk.usage.completionTokens || completionTokens;
            totalTokens = chunk.usage.totalTokens || totalTokens;
          }
        }

        const totalDurationMs = performance.now() - startedAt;
        const resolvedTtft = ttftMs ?? totalDurationMs;
        if (completionTokens === 0 && fullText.length > 0) {
          completionTokens = Math.max(1, Math.ceil(fullText.length / 4));
        }
        if (totalTokens === 0) {
          totalTokens = promptTokens + completionTokens;
        }

        engine.storeCache(deployment, cacheKey, {
          text: fullText,
          promptTokens,
          completionTokens,
          totalTokens,
        });
        engine.markRequestCompleted(deployment.id, record, {
          cacheHit: false,
          promptTokens,
          completionTokens,
          totalTokens,
          ttftMs: resolvedTtft,
          durationMs: totalDurationMs,
        });

        res.write(
          `data: ${JSON.stringify({
            id: completionId,
            object: 'chat.completion.chunk',
            created,
            model: deployment.alias,
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
            usage: {
              prompt_tokens: promptTokens,
              completion_tokens: completionTokens,
              total_tokens: totalTokens,
            },
            x_cache_hit: false,
          })}\n\n`
        );
        res.write('data: [DONE]\n\n');
        res.end();
      } else {
        const result =
          deployment.provider === 'local_gguf'
            ? await generateGgufChat({
                deploymentId: deployment.id,
                messages,
                defaultSystemInstruction: deployment.systemInstruction,
                temperature: typeof body.temperature === 'number' ? body.temperature : undefined,
                maxTokens: typeof body.max_tokens === 'number' ? body.max_tokens : undefined,
              })
            : await generateGeminiText({
                baseModel: textModel,
                messages,
                defaultSystemInstruction: deployment.systemInstruction,
                thinkingLevel: deployment.thinkingLevel,
              });
        const totalDurationMs = performance.now() - startedAt;
        const promptTokens = result.usage.promptTokens;
        const completionTokens =
          result.usage.completionTokens || Math.max(1, Math.ceil(result.text.length / 4));
        const totalTokens = result.usage.totalTokens || promptTokens + completionTokens;

        engine.storeCache(deployment, cacheKey, {
          text: result.text,
          promptTokens,
          completionTokens,
          totalTokens,
        });
        engine.markRequestCompleted(deployment.id, record, {
          cacheHit: false,
          promptTokens,
          completionTokens,
          totalTokens,
          ttftMs: totalDurationMs,
          durationMs: totalDurationMs,
        });

        res.setHeader('X-Cache-Hit', 'false');
        res.json({
          id: completionId,
          object: 'chat.completion',
          created,
          model: deployment.alias,
          choices: [
            { index: 0, message: { role: 'assistant', content: result.text }, finish_reason: 'stop' },
          ],
          usage: {
            prompt_tokens: promptTokens,
            completion_tokens: completionTokens,
            total_tokens: totalTokens,
          },
          x_cache_hit: false,
        });
      }
    } catch (err) {
      const mapped = formatGeminiError(err);
      engine.markRequestError(
        deployment.id,
        record,
        mapped.message,
        performance.now() - startedAt
      );
      if (stream && res.headersSent) {
        res.write(
          `data: ${JSON.stringify({ error: { message: mapped.message, code: mapped.status } })}\n\n`
        );
        res.write('data: [DONE]\n\n');
        res.end();
      } else {
        res.status(mapped.status).json({
          error: { message: mapped.message, type: 'api_error' },
        });
      }
    } finally {
      engine.releaseSlot(deployment.id);
    }
  });

  app.post('/v1/completions', async (req, res) => {
    const body = req.body ?? {};
    const prompt = typeof body.prompt === 'string' ? body.prompt : '';
    if (!prompt.trim()) {
      res.status(400).json({
        error: { message: 'Поле prompt не может быть пустым.', type: 'invalid_request_error' },
      });
      return;
    }

    const deployment = engine.findDeploymentByModel(body.model);
    if (!deployment) {
      res.status(404).json({
        error: { message: `Модель "${body.model ?? ''}" не найдена на сервере.`, type: 'model_not_found' },
      });
      return;
    }
    if (deployment.status !== 'running') {
      res.status(503).json({
        error: { message: `Модель "${deployment.alias}" остановлена.`, type: 'model_not_running' },
      });
      return;
    }
    if (deployment.capability !== 'text') {
      res.status(400).json({
        error: { message: `Модель "${deployment.alias}" не поддерживает генерацию текста.`, type: 'invalid_request_error' },
      });
      return;
    }

    const stream = Boolean(body.stream);
    const record = engine.createRequestRecord({
      deployment,
      endpoint: '/v1/completions',
      stream,
      promptPreview: prompt,
      promptCharCount: prompt.length,
    });

    const startedAt = performance.now();
    const completionId = `cmpl-${record.id}`;
    const created = Math.floor(Date.now() / 1000);
    const messages: OpenAiChatMessage[] = [{ role: 'user', content: prompt }];
    const cacheKey = engine.computeCacheKey(deployment, { endpoint: 'completions', prompt });
    const textModel = deployment.baseModel as 'gemini-4-hydrogen' | 'gemini-3.1-flash-lite';

    await engine.acquireSlot(deployment.id, record);

    try {
      const cached = engine.lookupCache(deployment, cacheKey);
      if (cached) {
        const elapsedMs = Math.max(0.2, performance.now() - startedAt);
        engine.markRequestCompleted(deployment.id, record, {
          cacheHit: true,
          promptTokens: cached.promptTokens,
          completionTokens: cached.completionTokens,
          totalTokens: cached.totalTokens,
          ttftMs: elapsedMs,
          durationMs: elapsedMs,
        });

        if (stream) {
          res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
          res.setHeader('Cache-Control', 'no-cache, no-transform');
          res.flushHeaders?.();
          res.write(
            `data: ${JSON.stringify({
              id: completionId,
              object: 'text_completion',
              created,
              model: deployment.alias,
              choices: [{ index: 0, text: cached.text, finish_reason: 'stop' }],
              x_cache_hit: true,
            })}\n\n`
          );
          res.write('data: [DONE]\n\n');
          res.end();
        } else {
          res.json({
            id: completionId,
            object: 'text_completion',
            created,
            model: deployment.alias,
            choices: [{ index: 0, text: cached.text, finish_reason: 'stop' }],
            usage: {
              prompt_tokens: cached.promptTokens,
              completion_tokens: cached.completionTokens,
              total_tokens: cached.totalTokens,
            },
            x_cache_hit: true,
          });
        }
        return;
      }

      if (stream) {
        res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache, no-transform');
        res.flushHeaders?.();

        let fullText = '';
        let ttftMs: number | null = null;
        let promptTokens = 0;
        let completionTokens = 0;
        let totalTokens = 0;

        const compStream =
          deployment.provider === 'local_gguf'
            ? streamGgufChat({
                deploymentId: deployment.id,
                messages,
                defaultSystemInstruction: deployment.systemInstruction,
                temperature: typeof body.temperature === 'number' ? body.temperature : undefined,
                maxTokens: typeof body.max_tokens === 'number' ? body.max_tokens : undefined,
              })
            : streamGeminiText({
                baseModel: textModel,
                messages,
                defaultSystemInstruction: deployment.systemInstruction,
                thinkingLevel: deployment.thinkingLevel,
              });

        for await (const chunk of compStream) {
          if (chunk.text) {
            if (ttftMs === null) ttftMs = performance.now() - startedAt;
            fullText += chunk.text;
            engine.appendStreamTokens(record, chunk.text);
            res.write(
              `data: ${JSON.stringify({
                id: completionId,
                object: 'text_completion',
                created,
                model: deployment.alias,
                choices: [{ index: 0, text: chunk.text, finish_reason: null }],
              })}\n\n`
            );
          }
          if (chunk.usage) {
            promptTokens = chunk.usage.promptTokens || promptTokens;
            completionTokens = chunk.usage.completionTokens || completionTokens;
            totalTokens = chunk.usage.totalTokens || totalTokens;
          }
        }

        const totalDurationMs = performance.now() - startedAt;
        if (completionTokens === 0 && fullText.length > 0) {
          completionTokens = Math.max(1, Math.ceil(fullText.length / 4));
        }
        if (totalTokens === 0) totalTokens = promptTokens + completionTokens;

        engine.storeCache(deployment, cacheKey, {
          text: fullText,
          promptTokens,
          completionTokens,
          totalTokens,
        });
        engine.markRequestCompleted(deployment.id, record, {
          cacheHit: false,
          promptTokens,
          completionTokens,
          totalTokens,
          ttftMs: ttftMs ?? totalDurationMs,
          durationMs: totalDurationMs,
        });

        res.write(
          `data: ${JSON.stringify({
            id: completionId,
            object: 'text_completion',
            created,
            model: deployment.alias,
            choices: [{ index: 0, text: '', finish_reason: 'stop' }],
            usage: {
              prompt_tokens: promptTokens,
              completion_tokens: completionTokens,
              total_tokens: totalTokens,
            },
          })}\n\n`
        );
        res.write('data: [DONE]\n\n');
        res.end();
      } else {
        const result =
          deployment.provider === 'local_gguf'
            ? await generateGgufChat({
                deploymentId: deployment.id,
                messages,
                defaultSystemInstruction: deployment.systemInstruction,
                temperature: typeof body.temperature === 'number' ? body.temperature : undefined,
                maxTokens: typeof body.max_tokens === 'number' ? body.max_tokens : undefined,
              })
            : await generateGeminiText({
                baseModel: textModel,
                messages,
                defaultSystemInstruction: deployment.systemInstruction,
                thinkingLevel: deployment.thinkingLevel,
              });
        const totalDurationMs = performance.now() - startedAt;
        const promptTokens = result.usage.promptTokens;
        const completionTokens =
          result.usage.completionTokens || Math.max(1, Math.ceil(result.text.length / 4));
        const totalTokens = result.usage.totalTokens || promptTokens + completionTokens;

        engine.storeCache(deployment, cacheKey, {
          text: result.text,
          promptTokens,
          completionTokens,
          totalTokens,
        });
        engine.markRequestCompleted(deployment.id, record, {
          cacheHit: false,
          promptTokens,
          completionTokens,
          totalTokens,
          ttftMs: totalDurationMs,
          durationMs: totalDurationMs,
        });

        res.json({
          id: completionId,
          object: 'text_completion',
          created,
          model: deployment.alias,
          choices: [{ index: 0, text: result.text, finish_reason: 'stop' }],
          usage: {
            prompt_tokens: promptTokens,
            completion_tokens: completionTokens,
            total_tokens: totalTokens,
          },
        });
      }
    } catch (err) {
      const mapped = formatGeminiError(err);
      engine.markRequestError(
        deployment.id,
        record,
        mapped.message,
        performance.now() - startedAt
      );
      if (stream && res.headersSent) {
        res.write(
          `data: ${JSON.stringify({ error: { message: mapped.message, code: mapped.status } })}\n\n`
        );
        res.write('data: [DONE]\n\n');
        res.end();
      } else {
        res.status(mapped.status).json({ error: { message: mapped.message, type: 'api_error' } });
      }
    } finally {
      engine.releaseSlot(deployment.id);
    }
  });

  app.post('/v1/embeddings', async (req, res) => {
    const body = req.body ?? {};
    const rawInput = body.input;
    const inputs = Array.isArray(rawInput)
      ? rawInput.map(String)
      : typeof rawInput === 'string' && rawInput.trim()
      ? [rawInput]
      : [];

    if (inputs.length === 0) {
      res.status(400).json({
        error: { message: 'Поле input должно содержать строку или массив строк.', type: 'invalid_request_error' },
      });
      return;
    }

    const deployment = engine.findDeploymentByModel(body.model ?? 'text-embedding-v2');
    if (!deployment || deployment.capability !== 'embedding') {
      res.status(404).json({
        error: { message: 'Модель эмбеддингов не найдена. Запустите модель gemini-embedding-2.', type: 'model_not_found' },
      });
      return;
    }
    if (deployment.status !== 'running') {
      res.status(503).json({
        error: { message: `Модель "${deployment.alias}" остановлена. Запустите её в панели моделей.`, type: 'model_not_running' },
      });
      return;
    }

    const record = engine.createRequestRecord({
      deployment,
      endpoint: '/v1/embeddings',
      stream: false,
      promptPreview: inputs[0],
    });
    const startedAt = performance.now();
    await engine.acquireSlot(deployment.id, record);

    try {
      const { embeddings, totalTokens } = await generateGeminiEmbeddings(inputs);
      const durationMs = performance.now() - startedAt;
      engine.markRequestCompleted(deployment.id, record, {
        cacheHit: false,
        promptTokens: totalTokens,
        completionTokens: 0,
        totalTokens,
        ttftMs: durationMs,
        durationMs,
      });

      res.json({
        object: 'list',
        data: embeddings.map((vec, index) => ({
          object: 'embedding',
          index,
          embedding: vec,
        })),
        model: deployment.alias,
        usage: {
          prompt_tokens: totalTokens,
          total_tokens: totalTokens,
        },
      });
    } catch (err) {
      const mapped = formatGeminiError(err);
      engine.markRequestError(
        deployment.id,
        record,
        mapped.message,
        performance.now() - startedAt
      );
      res.status(mapped.status).json({ error: { message: mapped.message, type: 'api_error' } });
    } finally {
      engine.releaseSlot(deployment.id);
    }
  });

  // =========================================================================
  // Model Lifecycle & Real Telemetry Endpoints (/api/*)
  // =========================================================================
  app.get('/api/engine/state', (_req, res) => {
    res.json(engine.getSnapshot());
  });

  app.get('/api/engine/stream', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    res.write(`data: ${JSON.stringify(engine.getSnapshot())}\n\n`);
    const unsubscribe = engine.subscribe((snap) => {
      res.write(`data: ${JSON.stringify(snap)}\n\n`);
    });
    req.on('close', unsubscribe);
  });

  app.post('/api/deployments', async (req, res) => {
    try {
      const dep = await engine.createAndLaunchDeployment(req.body ?? {});
      res.status(201).json({ deployment: dep, snapshot: engine.getSnapshot() });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/deployments/:id/start', async (req, res) => {
    try {
      const dep = await engine.startDeployment(req.params.id, true);
      res.json({ deployment: dep, snapshot: engine.getSnapshot() });
    } catch (err) {
      res.status(404).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/deployments/:id/stop', async (req, res) => {
    try {
      const dep = await engine.stopDeployment(req.params.id);
      res.json({ deployment: dep, snapshot: engine.getSnapshot() });
    } catch (err) {
      res.status(404).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.patch('/api/deployments/:id', (req, res) => {
    try {
      const dep = engine.updateDeployment(req.params.id, req.body ?? {});
      res.json({ deployment: dep, snapshot: engine.getSnapshot() });
    } catch (err) {
      res.status(404).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.delete('/api/deployments/:id', async (req, res) => {
    try {
      await engine.deleteDeployment(req.params.id);
      res.json({ snapshot: engine.getSnapshot() });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/engine/cache/clear', (_req, res) => {
    res.json(engine.clearCache());
  });

  app.post('/api/engine/logs/clear', (_req, res) => {
    res.json(engine.clearLogs());
  });

  app.post('/api/engine/paged-config', (req, res) => {
    const body = req.body ?? {};
    res.json(
      engine.updatePagedConfig({
        blockSize: body.blockSize,
        totalBlocks: body.totalBlocks,
        kvMemoryUtilization: body.kvMemoryUtilization,
        maxNumSeqs: body.maxNumSeqs,
        maxModelLen: body.maxModelLen,
        enablePrefixCaching: body.enablePrefixCaching,
      })
    );
  });

  // =========================================================================
  // Real PC Hardware Profiler & GGUF Compatibility Endpoints
  // =========================================================================
  app.get('/api/hardware', async (req, res) => {
    try {
      const force = req.query.refresh === '1' || req.query.refresh === 'true';
      const snapshot = await engine.refreshHardwareAndModels(force);
      res.json({ hardware: snapshot.hardware, snapshot });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/hardware/assess', async (req, res) => {
    try {
      const sizeBytes = Number(req.body?.sizeBytes);
      const ctxLen = Number(req.body?.ctxSize ?? 2048);
      if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) {
        res.status(400).json({ error: 'Укажите корректный размер модели в байтах.' });
        return;
      }
      const hw = await detectHardwareProfile();
      res.json(assessModelCompatibility(hw, sizeBytes, ctxLen));
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // =========================================================================
  // Multi-Source Model Hub Search & Resumable GGUF Downloader
  // =========================================================================
  app.get('/api/hub/search', async (req, res) => {
    try {
      const source = (String(req.query.source ?? 'huggingface') as HubSource);
      const query = String(req.query.q ?? '');
      const results = await searchHubModels(source, query);
      res.json({ results });
    } catch (err) {
      res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get('/api/hub/files', async (req, res) => {
    try {
      const source = (String(req.query.source ?? 'huggingface') as HubSource);
      const repo = String(req.query.repo ?? '');
      const ctxSize = Number(req.query.ctxSize ?? 2048);
      const files = await listHubGgufFiles(source, repo, ctxSize);
      res.json({ files });
    } catch (err) {
      res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get('/api/hub/probe-url', async (req, res) => {
    try {
      const targetUrl = String(req.query.url ?? '');
      const ctxSize = Number(req.query.ctxSize ?? 2048);
      const file = await probeDirectGgufUrl(targetUrl, ctxSize);
      res.json({ file });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get('/api/gguf/local', async (_req, res) => {
    try {
      await engine.refreshLocalModels();
      res.json({ localModels: engine.getSnapshot().localModels });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.delete('/api/gguf/local/:id', async (req, res) => {
    try {
      downloadManager.deleteLocalModel(req.params.id);
      await engine.refreshLocalModels();
      res.json({ snapshot: engine.getSnapshot() });
    } catch (err) {
      res.status(404).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/gguf/install-runtime', async (req, res) => {
    try {
      const rawBackend = String(req.body?.backend ?? 'auto');
      const backend: LlamaBackendPreference =
        rawBackend === 'cpu' || rawBackend === 'cuda' || rawBackend === 'vulkan'
          ? rawBackend
          : 'auto';
      const result = await installLlamaServerRuntime(backend);
      const snapshot = await engine.refreshHardwareAndModels(true);
      res.json({ ...result, snapshot });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get('/api/gguf/archives', async (_req, res) => {
    try {
      const hw = await detectHardwareProfile(true);
      res.json({
        archives: hw.localArchives,
        vendorArchivesDir: hw.vendorArchivesDir,
        archivesDir: hw.archivesDir,
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/gguf/install-from-archive', async (req, res) => {
    try {
      const archivePath = String(req.body?.archivePath ?? '').trim();
      if (!archivePath) {
        res.status(400).json({ error: 'Укажите путь или имя архива llama-server.' });
        return;
      }
      const result = await installLlamaServerFromArchive({ archivePath });
      const snapshot = await engine.refreshHardwareAndModels(true);
      res.json({ ...result, snapshot });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post(
    '/api/gguf/upload-archive',
    express.raw({ type: 'application/octet-stream', limit: '350mb' }),
    async (req, res) => {
      try {
        const fileNameHeader = String(req.headers['x-archive-name'] ?? 'llama-server.zip');
        const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
        if (buf.length === 0) {
          res.status(400).json({ error: 'Пустое тело архива.' });
          return;
        }
        const result = await installLlamaServerFromArchive({
          fileName: fileNameHeader,
          buffer: buf,
        });
        const snapshot = await engine.refreshHardwareAndModels(true);
        res.json({ ...result, snapshot });
      } catch (err) {
        res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
      }
    }
  );

  app.get('/api/downloads', (_req, res) => {
    res.json({ downloads: downloadManager.getJobs() });
  });

  app.post('/api/downloads', async (req, res) => {
    try {
      const body = req.body ?? {};
      if (!body.downloadUrl || !body.fileName) {
        res.status(400).json({ error: 'Необходимо указать downloadUrl и fileName.' });
        return;
      }
      const job = await downloadManager.startDownload({
        source: (body.source as HubSource) ?? 'url',
        repoId: String(body.repoId ?? body.fileName),
        fileName: String(body.fileName),
        downloadUrl: String(body.downloadUrl),
        totalBytes: typeof body.totalBytes === 'number' ? body.totalBytes : null,
        quantization: typeof body.quantization === 'string' ? body.quantization : undefined,
      });
      res.status(201).json({ job, snapshot: engine.getSnapshot() });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/downloads/:id/pause', (req, res) => {
    try {
      const job = downloadManager.pauseDownload(req.params.id);
      res.json({ job, snapshot: engine.getSnapshot() });
    } catch (err) {
      res.status(404).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/downloads/:id/resume', (req, res) => {
    try {
      const job = downloadManager.resumeDownload(req.params.id);
      res.json({ job, snapshot: engine.getSnapshot() });
    } catch (err) {
      res.status(404).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.delete('/api/downloads/:id', (req, res) => {
    downloadManager.cancelDownload(req.params.id);
    res.json({ snapshot: engine.getSnapshot() });
  });

  // =========================================================================
  // Vite Middleware (Dev) or Static Dist (Prod / Standalone Binary)
  // =========================================================================
  if (options.enableVite !== false) {
    if (process.env.NODE_ENV === 'production') {
      const distDir = resolvePublicDistDir();
      app.use(express.static(distDir));
      app.get('*', (_req, res) => {
        res.sendFile(path.join(distDir, 'index.html'));
      });
    } else {
      const { createServer: createViteServer } = await import('vite');
      const vite = await createViteServer({
        server: { middlewareMode: true },
        appType: 'spa',
      });
      app.use(vite.middlewares);
    }
  }

  return app;
}

async function startServer() {
  const HOST = process.env.HOST || '127.0.0.1';
  let currentPort = Number(process.env.PORT) || DEFAULT_PORT;
  if (!process.env.PORT) {
    try {
      const savedConfig = JSON.parse(fs.readFileSync(PORT_CONFIG_PATH, 'utf8')) as { port?: number };
      const savedPort = Number(savedConfig.port);
      if (Number.isInteger(savedPort) && savedPort >= 1024 && savedPort <= 65535) {
        currentPort = savedPort;
      }
    } catch {
      // First run: use the default port.
    }
  }

  let server: ReturnType<express.Express['listen']> | undefined;
  const app = await createGatewayApp({
    engine: modelServer,
    enableVite: true,
    host: HOST,
    initialPort: currentPort,
    getServer: () => server,
    setServer: (next) => {
      server = next;
    },
  });

  server = app.listen(currentPort, HOST, () => {
    console.log(`vLLM Gateway Server listening on http://${HOST}:${currentPort}`);
  });

  const handleSignal = () => {
    modelServer.shutdown();
    server?.close(() => process.exit(0));
  };
  process.on('SIGINT', handleSignal);
  process.on('SIGTERM', handleSignal);
}

if (process.env.VLLM_NO_LISTEN !== '1') {
  startServer().catch((err) => {
    console.error('Failed to start vLLM Gateway Server:', err);
    process.exit(1);
  });
}
