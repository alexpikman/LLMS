import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { modelServer } from './server/engine.ts';
import {
  formatGeminiError,
  generateGeminiEmbeddings,
  generateGeminiText,
  streamGeminiText,
  type OpenAiChatMessage,
} from './server/gemini.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = 3000;

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

        for await (const chunk of streamGeminiText({
          baseModel: textModel,
          messages,
          defaultSystemInstruction: deployment.systemInstruction,
          thinkingLevel: deployment.thinkingLevel,
        })) {
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
        const result = await generateGeminiText({
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

        for await (const chunk of streamGeminiText({
          baseModel: textModel,
          messages,
          defaultSystemInstruction: deployment.systemInstruction,
          thinkingLevel: deployment.thinkingLevel,
        })) {
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
        const result = await generateGeminiText({
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

  app.post('/api/deployments/:id/stop', (req, res) => {
    try {
      const dep = modelServer.stopDeployment(req.params.id);
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

  app.delete('/api/deployments/:id', (req, res) => {
    try {
      modelServer.deleteDeployment(req.params.id);
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
  // Vite Middleware (Dev) or Static Dist (Prod)
  // =========================================================================
  if (process.env.NODE_ENV === 'production') {
    const distDir = path.resolve(__dirname, 'dist');
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

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`vLLM Gateway Server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start vLLM Gateway Server:', err);
  process.exit(1);
});
