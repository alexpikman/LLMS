import React, { useState } from 'react';
import { MessageSquare, Play, Square, Trash2, X } from 'lucide-react';
import {
  BASE_MODEL_CATALOG,
  type BaseModelId,
  type ModelDeployment,
  type ServerSnapshot,
  type ThinkingLevelOption,
} from '../types/engine';

interface ModelsManagerViewProps {
  snapshot: ServerSnapshot;
  showLaunchForm: boolean;
  onCloseLaunchForm: () => void;
  onOpenLaunchForm: () => void;
  onRefreshSnapshot: (snapshot: ServerSnapshot) => void;
  onUseModelInChat: (alias: string) => void;
}

const STATUS_META: Record<
  ModelDeployment['status'],
  { label: string; color: string }
> = {
  running: { label: '● Работает', color: 'text-emerald-600' },
  stopped: { label: '○ Остановлена', color: 'text-slate-500' },
  starting: { label: '◐ Проверка и запуск...', color: 'text-blue-600' },
  error: { label: '✖ Ошибка запуска', color: 'text-rose-600' },
};

export const ModelsManagerView: React.FC<ModelsManagerViewProps> = ({
  snapshot,
  showLaunchForm,
  onCloseLaunchForm,
  onOpenLaunchForm,
  onRefreshSnapshot,
  onUseModelInChat,
}) => {
  const [alias, setAlias] = useState('custom-hydrogen-pro');
  const [baseModel, setBaseModel] = useState<BaseModelId>('gemini-4-hydrogen');
  const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevelOption>('LOW');
  const [systemInstruction, setSystemInstruction] = useState('');
  const [maxConcurrency, setMaxConcurrency] = useState(4);
  const [enableCache, setEnableCache] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyDeploymentId, setBusyDeploymentId] = useState<string | null>(null);

  const handleLaunchNew = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!alias.trim() || isSubmitting) return;
    setIsSubmitting(true);
    setActionError(null);
    try {
      const res = await fetch('/api/deployments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          alias: alias.trim(),
          baseModel,
          thinkingLevel,
          systemInstruction,
          maxConcurrentRequests: maxConcurrency,
          enableResponseCache: enableCache,
          verifyOnLaunch: true,
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        setActionError(json.error || 'Не удалось создать развёртывание модели.');
      } else {
        onRefreshSnapshot(json.snapshot);
        setAlias(`model-${snapshot.deployments.length + 1}`);
        onCloseLaunchForm();
      }
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Сетевая ошибка');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleStart = async (id: string) => {
    setBusyDeploymentId(id);
    setActionError(null);
    try {
      const res = await fetch(`/api/deployments/${id}/start`, { method: 'POST' });
      const json = await res.json();
      if (!res.ok) {
        setActionError(json.error || 'Не удалось запустить модель');
      } else {
        onRefreshSnapshot(json.snapshot);
      }
    } finally {
      setBusyDeploymentId(null);
    }
  };

  const handleStop = async (id: string) => {
    setBusyDeploymentId(id);
    try {
      const res = await fetch(`/api/deployments/${id}/stop`, { method: 'POST' });
      const json = await res.json();
      if (res.ok) onRefreshSnapshot(json.snapshot);
    } finally {
      setBusyDeploymentId(null);
    }
  };

  const handlePatch = async (
    id: string,
    patch: Partial<Pick<ModelDeployment, 'maxConcurrentRequests' | 'enableResponseCache' | 'thinkingLevel'>>
  ) => {
    const res = await fetch(`/api/deployments/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    const json = await res.json();
    if (res.ok) onRefreshSnapshot(json.snapshot);
  };

  const handleDelete = async (id: string) => {
    setActionError(null);
    const res = await fetch(`/api/deployments/${id}`, { method: 'DELETE' });
    const json = await res.json();
    if (!res.ok) {
      setActionError(json.error || 'Ошибка удаления');
    } else {
      onRefreshSnapshot(json.snapshot);
    }
  };

  const handleClearCache = async () => {
    const res = await fetch('/api/engine/cache/clear', { method: 'POST' });
    if (res.ok) onRefreshSnapshot(await res.json());
  };

  const handleClearLogs = async () => {
    const res = await fetch('/api/engine/logs/clear', { method: 'POST' });
    if (res.ok) onRefreshSnapshot(await res.json());
  };

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold text-slate-900" style={{ textWrap: 'balance' }}>
            Управление запущенными моделями и очередью запросов
          </h1>
          <p className="text-xs text-slate-600 mt-0.5">
            Запускайте и останавливайте реальные конечные точки LLM, настраивайте лимиты параллелизма и системные инструкции.
          </p>
        </div>

        {!showLaunchForm && (
          <button
            type="button"
            onClick={onOpenLaunchForm}
            className="px-3.5 py-2 rounded-md text-xs font-medium bg-white border border-slate-300 text-slate-700 hover:bg-slate-50 transition-colors cursor-pointer"
          >
            Новое развёртывание
          </button>
        )}
      </div>

      {actionError && (
        <div className="p-3.5 rounded-md bg-rose-50 border border-rose-200 text-xs text-rose-700">
          {actionError}
        </div>
      )}

      {/* Launch New Model Form */}
      {showLaunchForm && (
        <form
          onSubmit={handleLaunchNew}
          className="bg-white border border-slate-200 rounded-lg p-5 space-y-4"
        >
          <div className="flex items-center justify-between border-b border-slate-100 pb-3">
            <div>
              <h2 className="text-sm font-semibold text-slate-900">
                Запуск нового экземпляра модели
              </h2>
              <p className="text-xs text-slate-500 mt-0.5">
                При запуске выполняется реальный проверочный запрос к модели для подтверждения готовности.
              </p>
            </div>
            <button
              type="button"
              onClick={onCloseLaunchForm}
              className="p-1.5 rounded text-slate-400 hover:text-slate-700 cursor-pointer"
              aria-label="Закрыть форму"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <label htmlFor="new-alias" className="block text-xs font-medium text-slate-700 mb-1">
                Имя модели в OpenAI API (model)
              </label>
              <input
                id="new-alias"
                type="text"
                required
                value={alias}
                onChange={(e) => setAlias(e.target.value)}
                placeholder="например, assistant-ru"
                className="w-full bg-white border border-slate-300 rounded-md px-3 py-2 text-xs font-mono text-slate-900 focus:outline-none focus:border-blue-600"
              />
            </div>

            <div>
              <label htmlFor="new-base" className="block text-xs font-medium text-slate-700 mb-1">
                Базовая модель
              </label>
              <select
                id="new-base"
                value={baseModel}
                onChange={(e) => setBaseModel(e.target.value as BaseModelId)}
                className="w-full bg-white border border-slate-300 rounded-md px-3 py-2 text-xs text-slate-900 focus:outline-none focus:border-blue-600"
              >
                {Object.values(BASE_MODEL_CATALOG).map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.displayName} ({item.id})
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label htmlFor="new-concurrency" className="block text-xs font-medium text-slate-700 mb-1">
                Лимит параллельных запросов
              </label>
              <input
                id="new-concurrency"
                type="number"
                min={1}
                max={16}
                value={maxConcurrency}
                onChange={(e) => setMaxConcurrency(Number(e.target.value))}
                className="w-full bg-white border border-slate-300 rounded-md px-3 py-2 text-xs font-mono text-slate-900 focus:outline-none focus:border-blue-600"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 items-start">
            <div className="md:col-span-2">
              <label htmlFor="new-system" className="block text-xs font-medium text-slate-700 mb-1">
                Системная инструкция по умолчанию (необязательно)
              </label>
              <input
                id="new-system"
                type="text"
                value={systemInstruction}
                onChange={(e) => setSystemInstruction(e.target.value)}
                placeholder="Например: Отвечай кратко и строго по делу на русском языке."
                className="w-full bg-white border border-slate-300 rounded-md px-3 py-2 text-xs text-slate-900 focus:outline-none focus:border-blue-600"
              />
            </div>

            <div className="space-y-2">
              {BASE_MODEL_CATALOG[baseModel].supportsThinking && (
                <div>
                  <label htmlFor="new-thinking" className="block text-xs font-medium text-slate-700 mb-1">
                    Глубина рассуждений (Thinking)
                  </label>
                  <select
                    id="new-thinking"
                    value={thinkingLevel}
                    onChange={(e) => setThinkingLevel(e.target.value as ThinkingLevelOption)}
                    className="w-full bg-white border border-slate-300 rounded-md px-3 py-2 text-xs font-mono text-slate-900"
                  >
                    <option value="LOW">LOW (минимальная задержка)</option>
                    <option value="MEDIUM">MEDIUM (баланс)</option>
                    <option value="HIGH">HIGH (максимум логики)</option>
                  </select>
                </div>
              )}

              <label className="inline-flex items-center gap-2 text-xs text-slate-700 pt-1 cursor-pointer">
                <input
                  type="checkbox"
                  checked={enableCache}
                  onChange={(e) => setEnableCache(e.target.checked)}
                  className="w-4 h-4 accent-blue-600 rounded cursor-pointer"
                />
                <span>Кэшировать идентичные ответы в RAM</span>
              </label>
            </div>
          </div>

          <div className="flex items-center justify-end gap-3 pt-2 border-t border-slate-100">
            <button
              type="button"
              onClick={onCloseLaunchForm}
              className="px-4 py-2 rounded-md text-xs font-medium text-slate-600 hover:text-slate-900 cursor-pointer"
            >
              Отмена
            </button>
            <button
              type="submit"
              disabled={isSubmitting || !alias.trim()}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-md text-xs font-semibold bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 cursor-pointer"
            >
              <Play className="w-3.5 h-3.5 fill-current" />
              <span>{isSubmitting ? 'Запуск и проверка...' : 'Запустить на сервере'}</span>
            </button>
          </div>
        </form>
      )}

      {/* Active & Available Model Deployments */}
      <div className="bg-white border border-slate-200 rounded-lg divide-y divide-slate-200">
        {snapshot.deployments.map((dep) => {
          const statusInfo = STATUS_META[dep.status];
          const catalog = BASE_MODEL_CATALOG[dep.baseModel];
          const isBusy = busyDeploymentId === dep.id || dep.status === 'starting';

          return (
            <div
              key={dep.id}
              className="p-5 flex flex-col lg:flex-row lg:items-center justify-between gap-4"
            >
              <div className="space-y-1.5 min-w-0">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span className="text-sm font-mono font-semibold text-slate-900">
                    {dep.alias}
                  </span>
                  <span className="text-xs text-slate-500">·</span>
                  <span className="text-xs font-mono text-slate-600">{dep.baseModel}</span>
                  <span className="text-xs text-slate-500">·</span>
                  <span className={`text-xs font-medium ${statusInfo.color}`}>
                    {statusInfo.label}
                  </span>
                </div>

                <p className="text-xs text-slate-600">
                  {catalog.description}
                </p>

                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] font-mono text-slate-500 pt-0.5">
                  <span>Активных: {dep.activeRequests}/{dep.maxConcurrentRequests}</span>
                  <span>В очереди: {dep.queuedRequests}</span>
                  <span>Обслужено: {dep.totalServed}</span>
                  {dep.totalErrors > 0 && (
                    <span className="text-rose-600">Ошибок: {dep.totalErrors}</span>
                  )}
                  {dep.systemInstruction && (
                    <span className="text-slate-600 truncate max-w-xs">
                      System: «{dep.systemInstruction}»
                    </span>
                  )}
                </div>

                {dep.lastError && (
                  <div className="text-xs text-rose-600 pt-1">
                    {dep.lastError}
                  </div>
                )}
              </div>

              <div className="flex flex-wrap items-center gap-3 shrink-0">
                {catalog.supportsThinking && (
                  <select
                    aria-label={`Thinking level для ${dep.alias}`}
                    value={dep.thinkingLevel}
                    onChange={(e) =>
                      handlePatch(dep.id, {
                        thinkingLevel: e.target.value as ThinkingLevelOption,
                      })
                    }
                    className="bg-slate-50 border border-slate-200 rounded px-2.5 py-1.5 text-xs font-mono text-slate-700"
                  >
                    <option value="LOW">Thinking: LOW</option>
                    <option value="MEDIUM">Thinking: MEDIUM</option>
                    <option value="HIGH">Thinking: HIGH</option>
                  </select>
                )}

                <label className="inline-flex items-center gap-1.5 text-xs text-slate-700 bg-slate-50 border border-slate-200 rounded px-2.5 py-1.5 cursor-pointer">
                  <span>Слоты:</span>
                  <select
                    value={dep.maxConcurrentRequests}
                    onChange={(e) =>
                      handlePatch(dep.id, {
                        maxConcurrentRequests: Number(e.target.value),
                      })
                    }
                    className="bg-transparent font-mono text-slate-900 focus:outline-none"
                  >
                    {[1, 2, 4, 6, 8, 12, 16].map((n) => (
                      <option key={n} value={n}>
                        {n}
                      </option>
                    ))}
                  </select>
                </label>

                {dep.capability === 'text' && (
                  <label className="inline-flex items-center gap-1.5 text-xs text-slate-700 bg-slate-50 border border-slate-200 rounded px-2.5 py-1.5 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={dep.enableResponseCache}
                      onChange={(e) =>
                        handlePatch(dep.id, { enableResponseCache: e.target.checked })
                      }
                      className="w-3.5 h-3.5 accent-blue-600 rounded"
                    />
                    <span>RAM-кэш</span>
                  </label>
                )}

                {dep.status === 'running' ? (
                  <>
                    {dep.capability === 'text' && (
                      <button
                        type="button"
                        onClick={() => onUseModelInChat(dep.alias)}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium bg-blue-600 text-white hover:bg-blue-700 whitespace-nowrap cursor-pointer"
                      >
                        <MessageSquare className="w-3.5 h-3.5" />
                        <span>Открыть в чате</span>
                      </button>
                    )}
                    <button
                      type="button"
                      disabled={isBusy}
                      onClick={() => handleStop(dep.id)}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium bg-white border border-slate-300 text-slate-700 hover:bg-slate-50 whitespace-nowrap cursor-pointer"
                    >
                      <Square className="w-3 h-3 fill-current" />
                      <span>Остановить</span>
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    disabled={isBusy}
                    onClick={() => handleStart(dep.id)}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50 whitespace-nowrap cursor-pointer"
                  >
                    <Play className="w-3 h-3 fill-current" />
                    <span>{isBusy ? 'Запуск...' : 'Запустить'}</span>
                  </button>
                )}

                {!['dep-hydrogen', 'dep-flash-lite', 'dep-embedding'].includes(dep.id) && (
                  <button
                    type="button"
                    onClick={() => handleDelete(dep.id)}
                    className="p-1.5 rounded text-slate-400 hover:text-rose-600 cursor-pointer"
                    title="Удалить развёртывание"
                    aria-label="Удалить развёртывание"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Real Server Request Audit Table */}
      <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
        <div className="px-5 py-3.5 border-b border-slate-200 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-slate-900">
              Журнал реальных запросов сервера
            </h2>
            <p className="text-xs text-slate-500">
              Отображаются только фактически выполненные HTTP/SSE-запросы и их замеренные метрики.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleClearCache}
              className="px-3 py-1.5 rounded-md text-xs font-medium bg-white border border-slate-200 text-slate-700 hover:bg-slate-50 cursor-pointer"
            >
              Очистить RAM-кэш ({snapshot.cacheEntriesCount})
            </button>
            <button
              type="button"
              onClick={handleClearLogs}
              className="px-3 py-1.5 rounded-md text-xs font-medium bg-white border border-slate-200 text-slate-700 hover:bg-slate-50 cursor-pointer"
            >
              Очистить журнал
            </button>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-[11px] font-medium text-slate-600">
                <th className="py-2.5 px-4">Время</th>
                <th className="py-2.5 px-4">Модель</th>
                <th className="py-2.5 px-4">Маршрут</th>
                <th className="py-2.5 px-4">Статус</th>
                <th className="py-2.5 px-4 text-right">Токены (вх/вых)</th>
                <th className="py-2.5 px-4 text-right">TTFT</th>
                <th className="py-2.5 px-4 text-right">Всего</th>
                <th className="py-2.5 px-4 text-right">Скорость</th>
                <th className="py-2.5 px-4 text-right">Кэш</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 text-xs">
              {snapshot.requests.length === 0 ? (
                <tr>
                  <td colSpan={9} className="py-10 text-center text-slate-500">
                    Запросов пока не было. Перейдите в «Чат с моделью» или «OpenAI API», чтобы выполнить первый реальный запрос.
                  </td>
                </tr>
              ) : (
                snapshot.requests.map((req) => {
                  const statusColor =
                    req.status === 'completed'
                      ? 'text-emerald-600'
                      : req.status === 'running'
                      ? 'text-blue-600'
                      : req.status === 'queued'
                      ? 'text-amber-600'
                      : 'text-rose-600';
                  const statusLabel =
                    req.status === 'completed'
                      ? 'Выполнен'
                      : req.status === 'running'
                      ? 'Выполняется'
                      : req.status === 'queued'
                      ? 'В очереди'
                      : 'Ошибка';

                  return (
                    <tr key={req.id} className="hover:bg-slate-50/80">
                      <td className="py-2.5 px-4 font-mono text-slate-500 whitespace-nowrap">
                        {new Date(req.createdAtMs).toLocaleTimeString('ru-RU')}
                      </td>
                      <td className="py-2.5 px-4 font-mono text-slate-900 whitespace-nowrap">
                        {req.modelAlias}
                      </td>
                      <td className="py-2.5 px-4 font-mono text-slate-600 whitespace-nowrap">
                        {req.endpoint}
                      </td>
                      <td className={`py-2.5 px-4 font-medium whitespace-nowrap ${statusColor}`}>
                        {statusLabel}
                      </td>
                      <td className="py-2.5 px-4 font-mono text-right text-slate-700">
                        {req.promptTokens} / {req.completionTokens}
                      </td>
                      <td className="py-2.5 px-4 font-mono text-right text-slate-900">
                        {req.ttftMs !== null ? `${req.ttftMs} мс` : '—'}
                      </td>
                      <td className="py-2.5 px-4 font-mono text-right text-slate-900">
                        {req.durationMs !== null ? `${req.durationMs} мс` : '—'}
                      </td>
                      <td className="py-2.5 px-4 font-mono text-right text-slate-700">
                        {req.tokensPerSec !== null ? `${req.tokensPerSec} ток/с` : '—'}
                      </td>
                      <td className="py-2.5 px-4 font-mono text-right">
                        {req.cacheHit ? (
                          <span className="text-emerald-600 font-medium">HIT</span>
                        ) : (
                          <span className="text-slate-400">MISS</span>
                        )}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
