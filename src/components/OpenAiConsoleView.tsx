import React, { useEffect, useMemo, useState } from 'react';
import { Check, Copy, Play } from 'lucide-react';
import type { ServerSnapshot } from '../types/engine';

interface OpenAiConsoleViewProps {
  snapshot: ServerSnapshot;
  onGoToModels: () => void;
}

type EndpointType = '/v1/chat/completions' | '/v1/completions' | '/v1/embeddings';

export const OpenAiConsoleView: React.FC<OpenAiConsoleViewProps> = ({
  snapshot,
  onGoToModels,
}) => {
  const runningModels = snapshot.deployments.filter((d) => d.status === 'running');
  const [endpoint, setEndpoint] = useState<EndpointType>('/v1/chat/completions');

  const compatibleModels = useMemo(() => {
    if (endpoint === '/v1/embeddings') {
      return runningModels.filter((d) => d.capability === 'embedding');
    }
    return runningModels.filter((d) => d.capability === 'text');
  }, [runningModels, endpoint]);

  const [selectedAlias, setSelectedAlias] = useState<string>(
    compatibleModels[0]?.alias ?? ''
  );
  const [systemPrompt, setSystemPrompt] = useState<string>('');
  const [userPrompt, setUserPrompt] = useState<string>(
    'Объясни в трёх пунктах преимущества совместимости локального сервера инференса с форматом OpenAI API.'
  );
  const [stream, setStream] = useState<boolean>(true);

  const [isRunning, setIsRunning] = useState<boolean>(false);
  const [httpStatus, setHttpStatus] = useState<number | null>(null);
  const [outputText, setOutputText] = useState<string>('');
  const [rawTrace, setRawTrace] = useState<string[]>([]);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [metrics, setMetrics] = useState<{
    ttftMs: number | null;
    totalMs: number | null;
    cacheHit: boolean | null;
  }>({ ttftMs: null, totalMs: null, cacheHit: null });
  const [copiedKey, setCopiedKey] = useState<'curl' | 'python' | null>(null);

  useEffect(() => {
    if (!compatibleModels.some((m) => m.alias === selectedAlias)) {
      setSelectedAlias(compatibleModels[0]?.alias ?? '');
    }
  }, [compatibleModels, selectedAlias]);

  const originUrl =
    typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3003';

  const curlSnippet = useMemo(() => {
    const modelName = selectedAlias || 'hydrogen-chat';
    if (endpoint === '/v1/embeddings') {
      return `curl ${originUrl}/v1/embeddings \\\n  -H "Content-Type: application/json" \\\n  -d '${JSON.stringify(
        { model: modelName, input: userPrompt.trim() },
        null,
        2
      )}'`;
    }
    const payload =
      endpoint === '/v1/chat/completions'
        ? {
            model: modelName,
            stream,
            messages: [
              ...(systemPrompt.trim()
                ? [{ role: 'system', content: systemPrompt.trim() }]
                : []),
              { role: 'user', content: userPrompt.trim() },
            ],
          }
        : {
            model: modelName,
            stream,
            prompt: userPrompt.trim(),
          };
    return `curl ${originUrl}${endpoint} \\\n  -H "Content-Type: application/json" \\\n  -d '${JSON.stringify(payload, null, 2)}'`;
  }, [endpoint, selectedAlias, stream, systemPrompt, userPrompt, originUrl]);

  const pythonSnippet = useMemo(() => {
    const modelName = selectedAlias || 'hydrogen-chat';
    if (endpoint === '/v1/embeddings') {
      return `from openai import OpenAI

client = OpenAI(base_url="${originUrl}/v1", api_key="not-required")
res = client.embeddings.create(
    model="${modelName}",
    input=${JSON.stringify(userPrompt.trim())}
)
print(len(res.data[0].embedding))`;
    }
    return `from openai import OpenAI

client = OpenAI(base_url="${originUrl}/v1", api_key="not-required")
res = client.chat.completions.create(
    model="${modelName}",
    messages=[
        {"role": "user", "content": ${JSON.stringify(userPrompt.trim())}}
    ],
    stream=${stream ? 'True' : 'False'}
)`;
  }, [originUrl, endpoint, selectedAlias, userPrompt, stream]);

  const handleCopy = async (kind: 'curl' | 'python', text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedKey(kind);
      setTimeout(() => setCopiedKey(null), 1500);
    } catch {
      // Clipboard may be restricted
    }
  };

  const handleExecute = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!userPrompt.trim() || !selectedAlias || isRunning) return;

    setIsRunning(true);
    setHttpStatus(null);
    setOutputText('');
    setRawTrace([]);
    setErrorText(null);
    setMetrics({ ttftMs: null, totalMs: null, cacheHit: null });

    const startedAt = performance.now();
    let firstChunkMs: number | null = null;

    const payload =
      endpoint === '/v1/embeddings'
        ? { model: selectedAlias, input: userPrompt.trim() }
        : endpoint === '/v1/chat/completions'
        ? {
            model: selectedAlias,
            stream,
            messages: [
              ...(systemPrompt.trim()
                ? [{ role: 'system', content: systemPrompt.trim() }]
                : []),
              { role: 'user', content: userPrompt.trim() },
            ],
          }
        : {
            model: selectedAlias,
            stream,
            prompt: userPrompt.trim(),
          };

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      setHttpStatus(response.status);
      const headerCacheHit = response.headers.get('X-Cache-Hit') === 'true';

      if (endpoint === '/v1/embeddings' || !stream) {
        const json = await response.json();
        const totalMs = Math.round(performance.now() - startedAt);
        if (!response.ok || json.error) {
          setErrorText(json.error?.message || `HTTP ${response.status}`);
          setRawTrace([JSON.stringify(json, null, 2)]);
        } else if (endpoint === '/v1/embeddings') {
          const vec = json.data?.[0]?.embedding ?? [];
          setOutputText(
            `Размерность вектора: ${vec.length}\nПервые 12 координат:\n[${vec
              .slice(0, 12)
              .map((n: number) => n.toFixed(6))
              .join(', ')}, ...]`
          );
          setRawTrace([
            JSON.stringify(
              {
                ...json,
                data: json.data?.map((d: { index: number; embedding: number[] }) => ({
                  object: 'embedding',
                  index: d.index,
                  embedding_length: d.embedding.length,
                  preview: d.embedding.slice(0, 4),
                })),
              },
              null,
              2
            ),
          ]);
          setMetrics({ ttftMs: totalMs, totalMs, cacheHit: false });
        } else {
          const text =
            endpoint === '/v1/chat/completions'
              ? json.choices?.[0]?.message?.content ?? ''
              : json.choices?.[0]?.text ?? '';
          setOutputText(text);
          setRawTrace([JSON.stringify(json, null, 2)]);
          setMetrics({
            ttftMs: totalMs,
            totalMs,
            cacheHit: Boolean(json.x_cache_hit ?? headerCacheHit),
          });
        }
        setIsRunning(false);
        return;
      }

      if (!response.ok || !response.body) {
        const txt = await response.text();
        setErrorText(txt || `HTTP ${response.status}`);
        setIsRunning(false);
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buffer = '';
      let cacheHitResolved = headerCacheHit;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const rawLine of lines) {
          const line = rawLine.trim();
          if (!line.startsWith('data:')) continue;
          const dataStr = line.slice(5).trim();
          if (dataStr === '[DONE]') {
            setRawTrace((prev) => [...prev.slice(-20), 'data: [DONE]']);
            continue;
          }
          try {
            const parsed = JSON.parse(dataStr);
            if (parsed.error) {
              setErrorText(parsed.error.message || 'Ошибка SSE-потока');
              continue;
            }
            if (typeof parsed.x_cache_hit === 'boolean') {
              cacheHitResolved = parsed.x_cache_hit;
            }
            const delta =
              endpoint === '/v1/chat/completions'
                ? parsed.choices?.[0]?.delta?.content ?? ''
                : parsed.choices?.[0]?.text ?? '';
            if (delta) {
              if (firstChunkMs === null) {
                firstChunkMs = Math.round(performance.now() - startedAt);
              }
              setOutputText((prev) => prev + delta);
            }
            setRawTrace((prev) => [...prev.slice(-20), `data: ${dataStr}`]);
          } catch {
            // partial JSON
          }
        }
      }

      setMetrics({
        ttftMs: firstChunkMs ?? Math.round(performance.now() - startedAt),
        totalMs: Math.round(performance.now() - startedAt),
        cacheHit: cacheHitResolved,
      });
    } catch (err) {
      setErrorText(err instanceof Error ? err.message : 'Сетевая ошибка');
    } finally {
      setIsRunning(false);
    }
  };

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold text-slate-900" style={{ textWrap: 'balance' }}>
            Консоль OpenAI-совместимого API
          </h1>
          <p className="text-xs text-slate-600 mt-0.5">
            Выполняйте реальные запросы к работающим моделям через стандартные маршруты{' '}
            <code className="font-mono text-slate-800">/v1/chat/completions</code>,{' '}
            <code className="font-mono text-slate-800">/v1/completions</code> и{' '}
            <code className="font-mono text-slate-800">/v1/embeddings</code>.
          </p>
        </div>

        <a
          href="/v1/models"
          target="_blank"
          rel="noreferrer"
          className="px-3 py-1.5 rounded-md text-xs font-mono bg-white border border-slate-300 text-slate-700 hover:bg-slate-50"
        >
          GET /v1/models
        </a>
      </div>

      {compatibleModels.length === 0 ? (
        <div className="bg-white border border-slate-200 rounded-lg p-6 flex flex-wrap items-center justify-between gap-4">
          <div className="text-xs text-slate-600">
            Для маршрута <code className="font-mono text-slate-900">{endpoint}</code> сейчас нет запущенных совместимых моделей.
          </div>
          <button
            type="button"
            onClick={onGoToModels}
            className="px-3.5 py-2 rounded-md text-xs font-semibold bg-blue-600 text-white hover:bg-blue-700 cursor-pointer"
          >
            Запустить подходящую модель
          </button>
        </div>
      ) : null}

      <div className="grid grid-cols-1 xl:grid-cols-12 gap-6 items-start">
        <form
          onSubmit={handleExecute}
          className="xl:col-span-5 bg-white border border-slate-200 rounded-lg p-5 space-y-4"
        >
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label htmlFor="openai-ep" className="block text-xs font-medium text-slate-700 mb-1">
                Маршрут
              </label>
              <select
                id="openai-ep"
                value={endpoint}
                onChange={(e) => setEndpoint(e.target.value as EndpointType)}
                className="w-full bg-white border border-slate-300 rounded-md px-3 py-2 text-xs font-mono text-slate-900"
              >
                <option value="/v1/chat/completions">POST /v1/chat/completions</option>
                <option value="/v1/completions">POST /v1/completions</option>
                <option value="/v1/embeddings">POST /v1/embeddings</option>
              </select>
            </div>

            <div>
              <label htmlFor="openai-model" className="block text-xs font-medium text-slate-700 mb-1">
                Модель (running)
              </label>
              <select
                id="openai-model"
                value={selectedAlias}
                onChange={(e) => setSelectedAlias(e.target.value)}
                disabled={compatibleModels.length === 0}
                className="w-full bg-white border border-slate-300 rounded-md px-3 py-2 text-xs font-mono text-slate-900 disabled:bg-slate-100"
              >
                {compatibleModels.length === 0 ? (
                  <option value="">Нет запущенных моделей</option>
                ) : (
                  compatibleModels.map((m) => (
                    <option key={m.id} value={m.alias}>
                      {m.alias}
                    </option>
                  ))
                )}
              </select>
            </div>
          </div>

          {endpoint === '/v1/chat/completions' && (
            <div>
              <label htmlFor="openai-sys" className="block text-xs font-medium text-slate-700 mb-1">
                System Prompt (необязательно)
              </label>
              <textarea
                id="openai-sys"
                rows={2}
                value={systemPrompt}
                onChange={(e) => setSystemPrompt(e.target.value)}
                placeholder="Системная роль модели..."
                className="w-full bg-white border border-slate-300 rounded-md p-2.5 text-xs text-slate-900 focus:outline-none focus:border-blue-600"
              />
            </div>
          )}

          <div>
            <label htmlFor="openai-prompt" className="block text-xs font-medium text-slate-700 mb-1">
              {endpoint === '/v1/embeddings' ? 'Текст для векторизации' : 'Текст запроса'}
            </label>
            <textarea
              id="openai-prompt"
              rows={4}
              value={userPrompt}
              onChange={(e) => setUserPrompt(e.target.value)}
              className="w-full bg-white border border-slate-300 rounded-md p-2.5 text-xs text-slate-900 focus:outline-none focus:border-blue-600"
            />
          </div>

          {endpoint !== '/v1/embeddings' && (
            <label className="inline-flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
              <input
                type="checkbox"
                checked={stream}
                onChange={(e) => setStream(e.target.checked)}
                className="w-4 h-4 accent-blue-600 rounded cursor-pointer"
              />
              <span>Потоковый SSE-ответ (stream: true)</span>
            </label>
          )}

          <button
            type="submit"
            disabled={isRunning || !selectedAlias || !userPrompt.trim()}
            className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-md text-xs font-semibold bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 cursor-pointer"
          >
            <Play className="w-3.5 h-3.5 fill-current" />
            <span>{isRunning ? 'Выполняется запрос...' : 'Выполнить HTTP-запрос'}</span>
          </button>
        </form>

        <div className="xl:col-span-7 space-y-5">
          <div className="bg-white border border-slate-200 rounded-lg p-5 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 pb-3">
              <div className="text-sm font-semibold text-slate-900">
                Результат ответа {httpStatus !== null ? `(HTTP ${httpStatus})` : ''}
              </div>
              <div className="flex items-center gap-3 text-xs font-mono text-slate-500">
                <span>TTFT: {metrics.ttftMs !== null ? `${metrics.ttftMs} мс` : '—'}</span>
                <span aria-hidden="true">·</span>
                <span>Всего: {metrics.totalMs !== null ? `${metrics.totalMs} мс` : '—'}</span>
                {metrics.cacheHit !== null && (
                  <>
                    <span aria-hidden="true">·</span>
                    <span className={metrics.cacheHit ? 'text-emerald-600 font-medium' : ''}>
                      {metrics.cacheHit ? 'Cache HIT' : 'Model Live'}
                    </span>
                  </>
                )}
              </div>
            </div>

            {errorText && (
              <div className="p-3 rounded-md bg-rose-50 border border-rose-200 text-xs text-rose-700">
                {errorText}
              </div>
            )}

            <div className="min-h-[160px] max-h-[300px] overflow-y-auto bg-slate-50 border border-slate-200 rounded-md p-4 text-sm text-slate-900 leading-relaxed whitespace-pre-wrap">
              {outputText ? (
                outputText
              ) : isRunning ? (
                <span className="text-xs font-mono text-slate-500">
                  Ожидание ответа сервера...
                </span>
              ) : (
                <span className="text-xs text-slate-500">
                  Нажмите «Выполнить HTTP-запрос», чтобы проверить реальный OpenAI-совместимый API.
                </span>
              )}
            </div>

            {rawTrace.length > 0 && (
              <div>
                <div className="text-[11px] font-medium text-slate-600 mb-1">
                  Реальные данные ответа (JSON / SSE)
                </div>
                <pre className="max-h-40 overflow-y-auto bg-slate-900 text-slate-100 rounded-md p-3 text-[11px] font-mono leading-relaxed">
                  {rawTrace.join('\n')}
                </pre>
              </div>
            )}
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="bg-white border border-slate-200 rounded-lg p-4">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-semibold text-slate-900">cURL</span>
                <button
                  type="button"
                  onClick={() => handleCopy('curl', curlSnippet)}
                  className="inline-flex items-center gap-1 text-[11px] text-slate-500 hover:text-blue-600 cursor-pointer"
                >
                  {copiedKey === 'curl' ? (
                    <>
                      <Check className="w-3 h-3 text-emerald-600" />
                      <span>Скопировано</span>
                    </>
                  ) : (
                    <>
                      <Copy className="w-3 h-3" />
                      <span>Копировать</span>
                    </>
                  )}
                </button>
              </div>
              <pre className="max-h-36 overflow-auto bg-slate-50 border border-slate-200 rounded p-2.5 text-[11px] font-mono text-slate-700">
                {curlSnippet}
              </pre>
            </div>

            <div className="bg-white border border-slate-200 rounded-lg p-4">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-semibold text-slate-900">OpenAI Python SDK</span>
                <button
                  type="button"
                  onClick={() => handleCopy('python', pythonSnippet)}
                  className="inline-flex items-center gap-1 text-[11px] text-slate-500 hover:text-blue-600 cursor-pointer"
                >
                  {copiedKey === 'python' ? (
                    <>
                      <Check className="w-3 h-3 text-emerald-600" />
                      <span>Скопировано</span>
                    </>
                  ) : (
                    <>
                      <Copy className="w-3 h-3" />
                      <span>Копировать</span>
                    </>
                  )}
                </button>
              </div>
              <pre className="max-h-36 overflow-auto bg-slate-50 border border-slate-200 rounded p-2.5 text-[11px] font-mono text-slate-700">
                {pythonSnippet}
              </pre>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
