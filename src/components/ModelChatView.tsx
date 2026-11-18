import React, { useEffect, useRef, useState } from 'react';
import { Send, Trash2 } from 'lucide-react';
import type { ServerSnapshot } from '../types/engine';

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  modelAlias?: string;
  ttftMs?: number | null;
  totalMs?: number | null;
  promptTokens?: number;
  completionTokens?: number;
  tokensPerSec?: number | null;
  cacheHit?: boolean;
  error?: string;
}

interface ModelChatViewProps {
  snapshot: ServerSnapshot;
  preferredModelAlias: string | null;
  onGoToModels: () => void;
}

export const ModelChatView: React.FC<ModelChatViewProps> = ({
  snapshot,
  preferredModelAlias,
  onGoToModels,
}) => {
  const runningTextModels = snapshot.deployments.filter(
    (d) => d.status === 'running' && d.capability === 'text'
  );

  const [selectedAlias, setSelectedAlias] = useState<string>(
    preferredModelAlias ?? runningTextModels[0]?.alias ?? ''
  );
  const [systemPrompt, setSystemPrompt] = useState<string>('');
  const [showSystemInput, setShowSystemInput] = useState<boolean>(false);
  const [input, setInput] = useState<string>('');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isStreaming, setIsStreaming] = useState<boolean>(false);
  const scrollEndRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (preferredModelAlias && runningTextModels.some((m) => m.alias === preferredModelAlias)) {
      setSelectedAlias(preferredModelAlias);
    } else if (!runningTextModels.some((m) => m.alias === selectedAlias)) {
      setSelectedAlias(runningTextModels[0]?.alias ?? '');
    }
  }, [preferredModelAlias, runningTextModels, selectedAlias]);

  useEffect(() => {
    scrollEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleSend = async (e?: React.FormEvent) => {
    e?.preventDefault();
    const trimmed = input.trim();
    if (!trimmed || isStreaming || !selectedAlias) return;

    const userMsg: ChatMessage = {
      id: `u-${Date.now()}`,
      role: 'user',
      content: trimmed,
    };
    const assistantId = `a-${Date.now() + 1}`;
    const assistantPlaceholder: ChatMessage = {
      id: assistantId,
      role: 'assistant',
      content: '',
      modelAlias: selectedAlias,
    };

    const nextHistory = [...messages, userMsg];
    setMessages([...nextHistory, assistantPlaceholder]);
    setInput('');
    setIsStreaming(true);

    const startedAt = performance.now();
    let ttftMs: number | null = null;
    let cacheHit = false;

    const apiMessages = [
      ...(systemPrompt.trim() ? [{ role: 'system' as const, content: systemPrompt.trim() }] : []),
      ...nextHistory.map((m) => ({ role: m.role, content: m.content })),
    ];

    try {
      const response = await fetch('/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: selectedAlias,
          messages: apiMessages,
          stream: true,
        }),
      });

      if (!response.ok || !response.body) {
        let errText = `HTTP ${response.status}`;
        try {
          const errJson = await response.json();
          errText = errJson.error?.message || errText;
        } catch {
          // keep status
        }
        setMessages((prev) =>
          prev.map((m) => (m.id === assistantId ? { ...m, error: errText } : m))
        );
        setIsStreaming(false);
        return;
      }

      cacheHit = response.headers.get('X-Cache-Hit') === 'true';
      const reader = response.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buffer = '';
      let accumulated = '';
      let promptTokens = 0;
      let completionTokens = 0;

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
          if (dataStr === '[DONE]') continue;

          try {
            const parsed = JSON.parse(dataStr);
            if (parsed.error) {
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === assistantId
                    ? { ...m, error: parsed.error.message || 'Ошибка инференса' }
                    : m
                )
              );
              continue;
            }
            if (typeof parsed.x_cache_hit === 'boolean') {
              cacheHit = parsed.x_cache_hit;
            }
            if (parsed.usage) {
              promptTokens = parsed.usage.prompt_tokens ?? promptTokens;
              completionTokens = parsed.usage.completion_tokens ?? completionTokens;
            }
            const delta = parsed.choices?.[0]?.delta?.content ?? '';
            if (delta) {
              if (ttftMs === null) {
                ttftMs = Math.round(performance.now() - startedAt);
              }
              accumulated += delta;
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === assistantId ? { ...m, content: accumulated } : m
                )
              );
            }
          } catch {
            // ignore partial SSE chunk
          }
        }
      }

      const totalMs = Math.round(performance.now() - startedAt);
      const resolvedCompletionTokens =
        completionTokens || Math.max(1, Math.ceil(accumulated.length / 4));
      const tps =
        totalMs > 0
          ? Number((resolvedCompletionTokens / (totalMs / 1000)).toFixed(1))
          : null;

      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantId
            ? {
                ...m,
                ttftMs: ttftMs ?? totalMs,
                totalMs,
                promptTokens,
                completionTokens: resolvedCompletionTokens,
                tokensPerSec: tps,
                cacheHit,
              }
            : m
        )
      );
    } catch (err) {
      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantId
            ? {
                ...m,
                error: err instanceof Error ? err.message : 'Сетевая ошибка',
              }
            : m
        )
      );
    } finally {
      setIsStreaming(false);
    }
  };

  if (runningTextModels.length === 0) {
    return (
      <div className="p-6 max-w-3xl mx-auto">
        <div className="bg-white border border-slate-200 rounded-lg p-8 text-center space-y-3">
          <h1 className="text-base font-semibold text-slate-900">
            Нет запущенных текстовых моделей
          </h1>
          <p className="text-xs text-slate-600">
            Чтобы начать диалог, запустите хотя бы одну текстовую модель в панели управления.
          </p>
          <button
            type="button"
            onClick={onGoToModels}
            className="px-4 py-2 rounded-md text-xs font-semibold bg-blue-600 text-white hover:bg-blue-700 cursor-pointer"
          >
            Перейти к запуску моделей
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-5xl mx-auto flex flex-col h-[calc(100vh-140px)] min-h-[540px]">
      <div className="bg-white border border-slate-200 rounded-lg flex flex-col flex-1 min-h-0 overflow-hidden">
        {/* Chat Top Controls */}
        <div className="px-5 py-3 border-b border-slate-200 flex flex-wrap items-center justify-between gap-3 bg-slate-50/70">
          <div className="flex items-center gap-3">
            <label htmlFor="chat-model-select" className="text-xs font-medium text-slate-600">
              Активная модель:
            </label>
            <select
              id="chat-model-select"
              value={selectedAlias}
              onChange={(e) => setSelectedAlias(e.target.value)}
              className="bg-white border border-slate-300 rounded-md px-3 py-1.5 text-xs font-mono text-slate-900 focus:outline-none focus:border-blue-600"
            >
              {runningTextModels.map((m) => (
                <option key={m.id} value={m.alias}>
                  {m.alias} ({m.baseModel})
                </option>
              ))}
            </select>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setShowSystemInput((v) => !v)}
              className="px-3 py-1.5 rounded-md text-xs font-medium bg-white border border-slate-200 text-slate-700 hover:bg-slate-50 cursor-pointer"
            >
              {showSystemInput ? 'Скрыть System Prompt' : 'System Prompt'}
            </button>
            {messages.length > 0 && (
              <button
                type="button"
                onClick={() => setMessages([])}
                className="inline-flex items-center gap-1 px-3 py-1.5 rounded-md text-xs font-medium bg-white border border-slate-200 text-slate-600 hover:text-rose-600 cursor-pointer"
              >
                <Trash2 className="w-3.5 h-3.5" />
                <span>Очистить</span>
              </button>
            )}
          </div>
        </div>

        {showSystemInput && (
          <div className="px-5 py-3 border-b border-slate-200 bg-slate-50">
            <input
              type="text"
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
              placeholder="Дополнительная системная инструкция для этого диалога..."
              className="w-full bg-white border border-slate-300 rounded-md px-3 py-2 text-xs text-slate-900 focus:outline-none focus:border-blue-600"
            />
          </div>
        )}

        {/* Messages Thread */}
        <div className="flex-1 overflow-y-auto p-5 space-y-5">
          {messages.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center text-center max-w-md mx-auto space-y-3">
              <div className="text-sm font-semibold text-slate-900">
                Диалог с моделью {selectedAlias}
              </div>
              <p className="text-xs text-slate-500 leading-relaxed">
                Сообщения отправляются напрямую на работающий эндпоинт{' '}
                <code className="font-mono text-slate-700">/v1/chat/completions</code> в режиме SSE-стриминга с замером реальной задержки и токенов.
              </p>
              <div className="flex flex-wrap justify-center gap-2 pt-1">
                {[
                  'Напиши функцию быстрой сортировки на TypeScript и оцени её сложность.',
                  'Объясни, как работает PagedAttention и почему он снижает фрагментацию памяти.',
                  'Составь план нагрузочного тестирования веб-сервера на 5 пунктов.',
                ].map((sample) => (
                  <button
                    key={sample}
                    type="button"
                    onClick={() => setInput(sample)}
                    className="px-3 py-1.5 rounded-md text-xs bg-slate-50 border border-slate-200 text-slate-700 hover:border-blue-400 hover:text-blue-700 text-left cursor-pointer"
                  >
                    {sample}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            messages.map((msg) => (
              <div
                key={msg.id}
                className={`flex flex-col ${
                  msg.role === 'user' ? 'items-end' : 'items-start'
                }`}
              >
                <div
                  className={`max-w-[85%] rounded-lg px-4 py-3 text-sm leading-relaxed whitespace-pre-wrap ${
                    msg.role === 'user'
                      ? 'bg-blue-600 text-white'
                      : 'bg-slate-50 border border-slate-200 text-slate-900'
                  }`}
                >
                  {msg.error ? (
                    <span className="text-rose-600 text-xs">{msg.error}</span>
                  ) : msg.content ? (
                    msg.content
                  ) : (
                    <span className="text-slate-400 text-xs font-mono">
                      Генерация ответа...
                    </span>
                  )}
                </div>

                {msg.role === 'assistant' && msg.totalMs !== undefined && !msg.error && (
                  <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[11px] font-mono text-slate-500">
                    <span>{msg.modelAlias}</span>
                    <span aria-hidden="true">·</span>
                    <span>TTFT {msg.ttftMs} мс</span>
                    <span aria-hidden="true">·</span>
                    <span>Всего {msg.totalMs} мс</span>
                    <span aria-hidden="true">·</span>
                    <span>
                      {msg.promptTokens} → {msg.completionTokens} tok
                    </span>
                    {msg.tokensPerSec !== null && (
                      <>
                        <span aria-hidden="true">·</span>
                        <span>{msg.tokensPerSec} ток/с</span>
                      </>
                    )}
                    {msg.cacheHit && (
                      <>
                        <span aria-hidden="true">·</span>
                        <span className="text-emerald-600 font-medium">из RAM-кэша</span>
                      </>
                    )}
                  </div>
                )}
              </div>
            ))
          )}
          <div ref={scrollEndRef} />
        </div>

        {/* Input Composer */}
        <form
          onSubmit={handleSend}
          className="p-4 border-t border-slate-200 bg-slate-50/70 flex items-end gap-3"
        >
          <textarea
            rows={2}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                handleSend();
              }
            }}
            placeholder="Введите сообщение... (Enter — отправить, Shift+Enter — новая строка)"
            className="flex-1 bg-white border border-slate-300 rounded-md px-3.5 py-2.5 text-sm text-slate-900 focus:outline-none focus:border-blue-600 resize-none"
          />
          <button
            type="submit"
            disabled={isStreaming || !input.trim()}
            className="inline-flex items-center gap-1.5 px-4 py-2.5 rounded-md text-xs font-semibold bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 whitespace-nowrap cursor-pointer"
          >
            <Send className="w-3.5 h-3.5" />
            <span>{isStreaming ? 'Генерация...' : 'Отправить'}</span>
          </button>
        </form>
      </div>
    </div>
  );
};
