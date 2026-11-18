import 'dotenv/config';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  downloadManager,
  installLlamaServerRuntime,
  listHubGgufFiles,
  probeDirectGgufUrl,
  searchHubModels,
} from './server/downloader.ts';
import { modelServer as defaultModelServer, type ModelServerRuntime } from './server/engine.ts';
import { AuthManager, createAuthMiddleware, createRateLimiter } from './server/security.ts';
import {
  formatGeminiError,
  generateGeminiEmbeddings,
  generateGeminiText,
  streamGeminiText,
  type OpenAiChatMessage,
} from './server/gemini.ts';
import { generateGgufChat, streamGgufChat } from './server/ggufRunner.ts';
import { assessModelCompatibility, detectHardwareProfile } from './server/hardware.ts';
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

export async function createGatewayApp(options: {
  engine?: ModelServerRuntime;
  authManager?: AuthManager;
  enableVite?: boolean;
} = {}) {
  const app = express();
  app.use(express.json({ limit: '4mb' }));
  const modelServer = options.engine ?? defaultModelServer;
  const authManager = options.authManager ?? new AuthManager();
  app.locals.engine = modelServer;

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
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', version: '0.1.0' });
  });

  app.get('/ready', (_req, res) => {
    try {
      const dataDir = process.env.VLLM_DATA_DIR?.trim() || PORT_CONFIG_DIR;
      fs.accessSync(dataDir, fs.constants.W_OK);
      res.json({ ready: true, dataDirWritable: true });
    } catch {
      res.status(503).json({ ready: false, dataDirWritable: false });
    }
  });

  const authRateLimiter = createRateLimiter({ windowMs: 15 * 60 * 1000, maxRequests: 10 });

  app.get('/api/auth/status', (req, res) => {
    res.json(authManager.getAuthStatus(req));
  });

  app.post('/api/auth/setup', authRateLimiter, (req, res) => {
    const remoteAddress = req.socket.remoteAddress?.replace(/^::ffff:/i, '');
    const requestHost = req.hostname.toLowerCase();
    const localBind = HOST === '127.0.0.1' || HOST === '::1' || HOST === 'localhost';
    const localHost = requestHost === 'localhost' || requestHost === '127.0.0.1' || requestHost === '::1';
    if (
      authManager.isSetupRequired() &&
      (!localBind || !localHost || (remoteAddress !== '127.0.0.1' && remoteAddress !== '::1'))
    ) {
      res.status(403).json({ error: 'Первичную настройку токена разрешено выполнять только с localhost. Для удалённого сервера задайте VLLM_API_KEY.' });
      return;
    }
    try {
      const requestedToken = typeof req.body?.token === 'string' ? req.body.token : undefined;
      const result = authManager.setupInitialToken(requestedToken);
      authManager.setSessionCookieHeader(
        res,
        req.secure || String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim() === 'https'
      );
      res.status(201).json(result);
    } catch (err) {
      res.status(409).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/auth/login', authRateLimiter, (req, res) => {
    const token = typeof req.body?.token === 'string' ? req.body.token : '';
    if (!authManager.verifyToken(token)) {
      res.status(401).json({ error: 'Неверный API-токен.' });
      return;
    }
    authManager.setSessionCookieHeader(
      res,
      req.secure || String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim() === 'https'
    );
    res.json({ authenticated: true });
  });

  app.post('/api/auth/logout', (req, res) => {
    authManager.clearSessionCookieHeader(
      res,
      req.secure || String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim() === 'https'
    );
    res.status(204).end();
  });

  app.use(
    ['/api', '/v1'],
    createRateLimiter({ windowMs: 60_000, maxRequests: 180 }),
    createAuthMiddleware(authManager)
  );

  app.post('/api/auth/rotate', (req, res) => {
    try {
      const requestedToken = typeof req.body?.token === 'string' ? req.body.token : undefined;
      const result = authManager.rotateToken(requestedToken);
      authManager.setSessionCookieHeader(
        res,
        req.secure || String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim() === 'https'
      );
      res.json(result);
    } catch (err) {
      res.status(409).json({ error: err instanceof Error ? err.message : String(err) });
    }
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

      const previousServer = app.locals.server as ReturnType<typeof app.listen> | undefined;
      app.locals.server = nextServer;
      currentPort = nextPort;
      res.json({ port: currentPort, unchanged: false });
      res.once('finish', () => previousServer?.close());
    });
  });

  // =========================================================================
  // OpenAI-Compatible Endpoints (/v1/*)
  // =========================================================================
  app.get('/v1/models', (_req, res) => {
    const running = modelServer.getRunningDeployments();
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
    if (body.temperature !== undefined && (typeof body.temperature !== 'number' || body.temperature < 0 || body.temperature > 2)) {
      res.status(400).json({ error: { message: 'temperature должен быть числом от 0 до 2.', type: 'invalid_request_error' } });
      return;
    }
    if (body.top_p !== undefined && (typeof body.top_p !== 'number' || body.top_p <= 0 || body.top_p > 1)) {
      res.status(400).json({ error: { message: 'top_p должен быть числом больше 0 и не больше 1.', type: 'invalid_request_error' } });
      return;
    }
    if (body.n !== undefined && body.n !== 1) {
      res.status(400).json({ error: { message: 'Поддерживается только n=1.', type: 'invalid_request_error' } });
      return;
    }
    if (body.max_tokens !== undefined && (!Number.isInteger(body.max_tokens) || body.max_tokens < 1)) {
      res.status(400).json({ error: { message: 'max_tokens должен быть положительным целым числом.', type: 'invalid_request_error' } });
      return;
    }
    const messages = Array.isArray(body.messages) ? (body.messages as OpenAiChatMessage[]) : [];
    if (messages.length === 0) {
      res.status(400).json({
        error: { message: 'Поле messages должно содержать хотя бы одно сообщение.', type: 'invalid_request_error' },
      });
      return;
    }

    const deployment = modelServer.findDeploymentByModel(body.model);
    if (!deployment) {
      res.status(404).json({
        error: { message: `Модель "${body.model ?? ''}" не найдена на сервере.`, type: 'model_not_found' },
      });
      return;
    }
    if (deployment.status !== 'running') {
      res.status(503).json({
        error: {
          message: `Модель "${deployment.alias}" сейчас остановлена (статус: ${deployment.status}). Запустите её в панели моделей.`,
          type: 'model_not_running',
        },
      });
      return;
    }
    if (deployment.capability !== 'text') {
      res.status(400).json({
        error: {
          message: `Модель "${deployment.alias}" предназначена для эмбеддингов (/v1/embeddings).`,
          type: 'invalid_request_error',
        },
      });
      return;
    }

    const stream = Boolean(body.stream);
    const streamAbortController = stream ? new AbortController() : null;
    const abortOnDisconnect = () => {
      if (streamAbortController && !res.writableEnded) streamAbortController.abort();
    };
    if (stream) res.once('close', abortOnDisconnect);
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

    const record = modelServer.createRequestRecord({
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
    const cacheKey = modelServer.computeCacheKey(deployment, { endpoint: 'chat', messages });
    const textModel = deployment.baseModel as 'gemini-4-hydrogen' | 'gemini-3.1-flash-lite';

    try {
      await modelServer.acquireSlot(deployment.id, record, streamAbortController?.signal);
    } catch (err) {
      if (streamAbortController?.signal.aborted) {
        res.off('close', abortOnDisconnect);
        modelServer.markRequestError(
          deployment.id,
          record,
          'Клиент прервал запрос до получения слота инференса.',
          performance.now() - startedAt
        );
        return;
      }
      throw err;
    }

    try {
      const cached = modelServer.lookupCache(deployment, cacheKey);
      if (cached) {
        const elapsedMs = Math.max(0.2, performance.now() - startedAt);
        modelServer.markRequestCompleted(deployment.id, record, {
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
                signal: streamAbortController?.signal,
              })
            : streamGeminiText({
                baseModel: textModel,
                messages,
                defaultSystemInstruction: deployment.systemInstruction,
                thinkingLevel: deployment.thinkingLevel,
                signal: streamAbortController?.signal,
              });

        for await (const chunk of tokenStream) {
          if (streamAbortController?.signal.aborted) break;
          if (chunk.text) {
            if (ttftMs === null) {
              ttftMs = performance.now() - startedAt;
            }
            fullText += chunk.text;
            modelServer.appendStreamTokens(record, chunk.text);
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

        if (streamAbortController?.signal.aborted) {
          modelServer.markRequestError(deployment.id, record, 'Клиент прервал потоковый запрос.', performance.now() - startedAt);
          return;
        }

        const totalDurationMs = performance.now() - startedAt;
        const resolvedTtft = ttftMs ?? totalDurationMs;
        if (completionTokens === 0 && fullText.length > 0) {
          completionTokens = Math.max(1, Math.ceil(fullText.length / 4));
        }
        if (totalTokens === 0) {
          totalTokens = promptTokens + completionTokens;
        }

        modelServer.storeCache(deployment, cacheKey, {
          text: fullText,
          promptTokens,
          completionTokens,
          totalTokens,
        });
        modelServer.markRequestCompleted(deployment.id, record, {
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
                signal: streamAbortController?.signal,
              });
        const totalDurationMs = performance.now() - startedAt;
        const promptTokens = result.usage.promptTokens;
        const completionTokens =
          result.usage.completionTokens || Math.max(1, Math.ceil(result.text.length / 4));
        const totalTokens = result.usage.totalTokens || promptTokens + completionTokens;

        modelServer.storeCache(deployment, cacheKey, {
          text: result.text,
          promptTokens,
          completionTokens,
          totalTokens,
        });
        modelServer.markRequestCompleted(deployment.id, record, {
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
      modelServer.markRequestError(
        deployment.id,
        record,
        mapped.message,
        performance.now() - startedAt
      );
      if (stream && res.headersSent && !res.destroyed) {
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
      if (stream) res.off('close', abortOnDisconnect);
      modelServer.releaseSlot(deployment.id);
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

    const deployment = modelServer.findDeploymentByModel(body.model);
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
    const streamAbortController = stream ? new AbortController() : null;
    const abortOnDisconnect = () => {
      if (streamAbortController && !res.writableEnded) streamAbortController.abort();
    };
    if (stream) res.once('close', abortOnDisconnect);
    const record = modelServer.createRequestRecord({
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
    const cacheKey = modelServer.computeCacheKey(deployment, { endpoint: 'completions', prompt });
    const textModel = deployment.baseModel as 'gemini-4-hydrogen' | 'gemini-3.1-flash-lite';

    try {
      await modelServer.acquireSlot(deployment.id, record, streamAbortController?.signal);
    } catch (err) {
      if (streamAbortController?.signal.aborted) {
        res.off('close', abortOnDisconnect);
        modelServer.markRequestError(
          deployment.id,
          record,
          'Клиент прервал запрос до получения слота инференса.',
          performance.now() - startedAt
        );
        return;
      }
      throw err;
    }

    try {
      const cached = modelServer.lookupCache(deployment, cacheKey);
      if (cached) {
        const elapsedMs = Math.max(0.2, performance.now() - startedAt);
        modelServer.markRequestCompleted(deployment.id, record, {
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
                signal: streamAbortController?.signal,
              })
            : streamGeminiText({
                baseModel: textModel,
                messages,
                defaultSystemInstruction: deployment.systemInstruction,
                thinkingLevel: deployment.thinkingLevel,
              });

        for await (const chunk of compStream) {
          if (streamAbortController?.signal.aborted) break;
          if (chunk.text) {
            if (ttftMs === null) ttftMs = performance.now() - startedAt;
            fullText += chunk.text;
            modelServer.appendStreamTokens(record, chunk.text);
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

        if (streamAbortController?.signal.aborted) {
          modelServer.markRequestError(deployment.id, record, 'Клиент прервал потоковый запрос.', performance.now() - startedAt);
          return;
        }

        const totalDurationMs = performance.now() - startedAt;
        if (completionTokens === 0 && fullText.length > 0) {
          completionTokens = Math.max(1, Math.ceil(fullText.length / 4));
        }
        if (totalTokens === 0) totalTokens = promptTokens + completionTokens;

        modelServer.storeCache(deployment, cacheKey, {
          text: fullText,
          promptTokens,
          completionTokens,
          totalTokens,
        });
        modelServer.markRequestCompleted(deployment.id, record, {
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

        modelServer.storeCache(deployment, cacheKey, {
          text: result.text,
          promptTokens,
          completionTokens,
          totalTokens,
        });
        modelServer.markRequestCompleted(deployment.id, record, {
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
      modelServer.markRequestError(
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
      if (stream) res.off('close', abortOnDisconnect);
      modelServer.releaseSlot(deployment.id);
    }
  });

  app.post('/v1/embeddings', async (req, res) => {
    const body = req.body ?? {};
    if (body.encoding_format !== undefined && !['float', 'base64'].includes(body.encoding_format)) {
      res.status(400).json({ error: { message: 'encoding_format должен быть float или base64.', type: 'invalid_request_error' } });
      return;
    }
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

    const deployment = modelServer.findDeploymentByModel(body.model ?? 'text-embedding-v2');
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

    const record = modelServer.createRequestRecord({
      deployment,
      endpoint: '/v1/embeddings',
      stream: false,
      promptPreview: inputs[0],
    });
    const startedAt = performance.now();
    await modelServer.acquireSlot(deployment.id, record);

    try {
      const { embeddings, totalTokens } = await generateGeminiEmbeddings(inputs);
      const durationMs = performance.now() - startedAt;
      modelServer.markRequestCompleted(deployment.id, record, {
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
      modelServer.markRequestError(
        deployment.id,
        record,
        mapped.message,
        performance.now() - startedAt
      );
      res.status(mapped.status).json({ error: { message: mapped.message, type: 'api_error' } });
    } finally {
      modelServer.releaseSlot(deployment.id);
    }
  });

  // =========================================================================
  // Model Lifecycle & Real Telemetry Endpoints (/api/*)
  // =========================================================================
  app.get('/api/diagnostics', (_req, res) => {
    res.json({
      version: '0.1.0',
      nodeVersion: process.version,
      platform: process.platform,
      architecture: process.arch,
      uptimeSeconds: Math.floor(process.uptime()),
      snapshot: modelServer.getSnapshot(),
    });
  });

  app.get('/api/engine/state', (_req, res) => {
    res.json(modelServer.getSnapshot());
  });

  app.get('/api/engine/stream', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    res.write(`data: ${JSON.stringify(modelServer.getSnapshot())}\n\n`);
    const unsubscribe = modelServer.subscribe((snap) => {
      res.write(`data: ${JSON.stringify(snap)}\n\n`);
    });
    req.on('close', unsubscribe);
  });

  app.post('/api/deployments', async (req, res) => {
    try {
      const dep = await modelServer.createAndLaunchDeployment(req.body ?? {});
      res.status(201).json({ deployment: dep, snapshot: modelServer.getSnapshot() });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/deployments/:id/start', async (req, res) => {
    try {
      const dep = await modelServer.startDeployment(req.params.id, true);
      res.json({ deployment: dep, snapshot: modelServer.getSnapshot() });
    } catch (err) {
      res.status(404).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/deployments/:id/stop', async (req, res) => {
    try {
      const dep = await modelServer.stopDeployment(req.params.id);
      res.json({ deployment: dep, snapshot: modelServer.getSnapshot() });
    } catch (err) {
      res.status(404).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.patch('/api/deployments/:id', (req, res) => {
    try {
      const dep = modelServer.updateDeployment(req.params.id, req.body ?? {});
      res.json({ deployment: dep, snapshot: modelServer.getSnapshot() });
    } catch (err) {
      res.status(404).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.delete('/api/deployments/:id', async (req, res) => {
    try {
      await modelServer.deleteDeployment(req.params.id);
      res.json({ snapshot: modelServer.getSnapshot() });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/engine/cache/clear', (_req, res) => {
    res.json(modelServer.clearCache());
  });

  app.post('/api/engine/logs/clear', (_req, res) => {
    res.json(modelServer.clearLogs());
  });

  app.post('/api/engine/paged-config', (req, res) => {
    const body = req.body ?? {};
    res.json(
      modelServer.updatePagedConfig({
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
      const snapshot = await modelServer.refreshHardwareAndModels(force);
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
      await modelServer.refreshLocalModels();
      res.json({ localModels: modelServer.getSnapshot().localModels });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.delete('/api/gguf/local/:id', async (req, res) => {
    try {
      downloadManager.deleteLocalModel(req.params.id);
      await modelServer.refreshLocalModels();
      res.json({ snapshot: modelServer.getSnapshot() });
    } catch (err) {
      res.status(404).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/gguf/install-runtime', async (_req, res) => {
    try {
      const result = await installLlamaServerRuntime();
      const snapshot = await modelServer.refreshHardwareAndModels(true);
      res.json({ ...result, snapshot });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get('/api/downloads', (_req, res) => {
    res.json({ downloads: downloadManager.getJobs() });
  });

  app.post('/api/downloads', (req, res) => {
    try {
      const body = req.body ?? {};
      if (!body.downloadUrl || !body.fileName) {
        res.status(400).json({ error: 'Необходимо указать downloadUrl и fileName.' });
        return;
      }
      const job = downloadManager.startDownload({
        source: (body.source as HubSource) ?? 'url',
        repoId: String(body.repoId ?? body.fileName),
        fileName: String(body.fileName),
        downloadUrl: String(body.downloadUrl),
        totalBytes: typeof body.totalBytes === 'number' ? body.totalBytes : null,
        quantization: typeof body.quantization === 'string' ? body.quantization : undefined,
      });
      res.status(201).json({ job, snapshot: modelServer.getSnapshot() });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/downloads/:id/pause', (req, res) => {
    try {
      const job = downloadManager.pauseDownload(req.params.id);
      res.json({ job, snapshot: modelServer.getSnapshot() });
    } catch (err) {
      res.status(404).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/downloads/:id/resume', (req, res) => {
    try {
      const job = downloadManager.resumeDownload(req.params.id);
      res.json({ job, snapshot: modelServer.getSnapshot() });
    } catch (err) {
      res.status(404).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.delete('/api/downloads/:id', (req, res) => {
    downloadManager.cancelDownload(req.params.id);
    res.json({ snapshot: modelServer.getSnapshot() });
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
  const app = await createGatewayApp();
  const HOST = process.env.HOST || '127.0.0.1';
  const savedPort = Number(process.env.PORT) || DEFAULT_PORT;
  let currentPort = savedPort;
  if (!process.env.PORT) {
    try {
      const savedConfig = JSON.parse(fs.readFileSync(PORT_CONFIG_PATH, 'utf8')) as { port?: number };
      const candidate = Number(savedConfig.port);
      if (Number.isInteger(candidate) && candidate >= 1024 && candidate <= 65535) currentPort = candidate;
    } catch {
      // First run: use the default port.
    }
  }
  const server = app.listen(currentPort, HOST, () => {
    console.log(`vLLM Gateway Server listening on http://${HOST}:${currentPort}`);
  });
  app.locals.server = server;

  const handleSignal = () => {
    const engine = app.locals.engine as ModelServerRuntime;
    const activeServer = app.locals.server as ReturnType<typeof app.listen>;
    activeServer.close();
    activeServer.closeAllConnections?.();
    void engine.shutdown()
      .catch((err) => console.error('Failed to stop inference processes:', err))
      .finally(() => process.exit(0));
  };
  process.once('SIGINT', handleSignal);
  process.once('SIGTERM', handleSignal);
}

if (process.env.VLLM_NO_LISTEN !== '1') {
  startServer().catch((err) => {
    console.error('Failed to start vLLM Gateway Server:', err);
    process.exit(1);
  });
}
