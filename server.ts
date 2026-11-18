import 'dotenv/config';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  downloadManager,
  installLlamaServerRuntime,
  listHubGgufFiles,
  probeDirectGgufUrl,
  searchHubModels,
} from './server/downloader.ts';
import { modelServer } from './server/engine.ts';
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
const PORT = Number(process.env.PORT) || 3000;

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

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '4mb' }));

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

    await modelServer.acquireSlot(deployment.id, record);

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

    await modelServer.acquireSlot(deployment.id, record);

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
      modelServer.releaseSlot(deployment.id);
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

  const HOST = process.env.HOST || '127.0.0.1';
  const server = app.listen(PORT, HOST, () => {
    console.log(`vLLM Gateway Server listening on http://${HOST}:${PORT}`);
  });

  const handleSignal = () => {
    modelServer.shutdown();
    server.close(() => process.exit(0));
  };
  process.on('SIGINT', handleSignal);
  process.on('SIGTERM', handleSignal);
}

startServer().catch((err) => {
  console.error('Failed to start vLLM Gateway Server:', err);
  process.exit(1);
});
