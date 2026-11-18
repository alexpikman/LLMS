import React from 'react';
import type { ServerSnapshot } from '../types/engine';

interface TelemetryStripProps {
  snapshot: ServerSnapshot;
}

export const TelemetryStrip: React.FC<TelemetryStripProps> = ({ snapshot }) => {
  const runningModels = snapshot.deployments.filter((d) => d.status === 'running').length;
  const cacheKb = (snapshot.cacheMemoryBytes / 1024).toFixed(1);

  return (
    <section
      aria-label="Реальные показатели сервера"
      className="grid grid-cols-2 xl:grid-cols-4 border-b border-slate-200 bg-white"
    >
      <div className="p-4 border-b xl:border-b-0 border-r border-slate-200">
        <div className="text-xs text-slate-500">Запущенные модели</div>
        <div className="mt-1 flex items-baseline gap-1.5">
          <span className="text-2xl font-mono font-semibold text-slate-900">
            {runningModels}
          </span>
          <span className="text-xs font-mono text-slate-500">
            / {snapshot.deployments.length}
          </span>
        </div>
        <div className="mt-1 text-[11px] text-slate-500">
          {snapshot.apiKeyConfigured
            ? 'Серверный API-ключ подключён'
            : 'Серверный API-ключ не настроен'}
        </div>
      </div>

      <div className="p-4 border-b xl:border-b-0 xl:border-r border-slate-200">
        <div className="text-xs text-slate-500">Активные / В очереди</div>
        <div className="mt-1 flex items-baseline gap-1.5">
          <span className="text-2xl font-mono font-semibold text-blue-600">
            {snapshot.activeRequestsCount}
          </span>
          <span className="text-xs font-mono text-slate-500">
            / {snapshot.queuedRequestsCount} в очереди
          </span>
        </div>
        <div className="mt-1 text-[11px] font-mono text-slate-500">
          Выполнено: {snapshot.completedRequestsCount} · Ошибок: {snapshot.errorRequestsCount}
        </div>
      </div>

      <div className="p-4 border-r border-slate-200">
        <div className="text-xs text-slate-500">Средний TTFT и скорость</div>
        <div className="mt-1 flex items-baseline gap-2">
          <span className="text-2xl font-mono font-semibold text-slate-900">
            {snapshot.avgTtftMs !== null ? snapshot.avgTtftMs : '—'}
          </span>
          <span className="text-xs font-mono text-slate-500">мс</span>
        </div>
        <div className="mt-1 text-[11px] font-mono text-slate-500">
          Генерация:{' '}
          {snapshot.avgThroughputTokPerSec !== null
            ? `${snapshot.avgThroughputTokPerSec} ток/с`
            : 'нет замеров'}
        </div>
      </div>

      <div className="p-4">
        <div className="text-xs text-slate-500">Кэш ответов (RAM)</div>
        <div className="mt-1 flex items-baseline gap-1.5">
          <span className="text-2xl font-mono font-semibold text-emerald-600">
            {snapshot.cacheHitsTotal}
          </span>
          <span className="text-xs font-mono text-slate-500">попаданий</span>
        </div>
        <div className="mt-1 text-[11px] font-mono text-slate-500">
          Записей: {snapshot.cacheEntriesCount} · Память: {cacheKb} КБ
        </div>
      </div>
    </section>
  );
};
