import React, { useState } from 'react';
import { LayoutGrid, RotateCcw } from 'lucide-react';
import type { ServerSnapshot } from '../types/engine';

interface GpuContextControllerProps {
  snapshot: ServerSnapshot;
  activeView: string;
  onRefreshSnapshot: (snapshot: ServerSnapshot) => void;
  onGoToPagedGrid: () => void;
}

export const GpuContextController: React.FC<GpuContextControllerProps> = ({
  snapshot,
  activeView,
  onRefreshSnapshot,
  onGoToPagedGrid,
}) => {
  const { pagedAttention } = snapshot;
  const [isUpdating, setIsUpdating] = useState(false);

  const patchConfig = async (patch: {
    blockSize?: 16 | 32;
    totalBlocks?: number;
    kvMemoryUtilization?: number;
    maxNumSeqs?: number;
    maxModelLen?: number;
    enablePrefixCaching?: boolean;
  }) => {
    setIsUpdating(true);
    try {
      const res = await fetch('/api/engine/paged-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      if (res.ok) {
        onRefreshSnapshot(await res.json());
      }
    } finally {
      setIsUpdating(false);
    }
  };

  const handleClearCache = async () => {
    const res = await fetch('/api/engine/cache/clear', { method: 'POST' });
    if (res.ok) {
      onRefreshSnapshot(await res.json());
    }
  };

  const kvUsedPct =
    pagedAttention.usableBlocks > 0
      ? Math.min(100, Math.round((pagedAttention.usedBlocks / pagedAttention.usableBlocks) * 100))
      : 0;

  return (
    <aside
      aria-label="GPU Context Controller"
      className="w-full lg:w-[300px] shrink-0 border-b lg:border-b-0 lg:border-r border-slate-200 bg-white p-5 flex flex-col gap-5"
    >
      <div className="border-b border-slate-100 pb-3">
        <div className="text-sm font-semibold text-slate-900">
          GPU Context Controller
        </div>
        <p className="text-[11px] text-slate-500 mt-0.5 leading-snug">
          Управление лимитами KV-кэша и планировщиком в реальном времени
        </p>
      </div>

      {/* Live KV Pool Pressure Summary */}
      <div className="bg-slate-50 border border-slate-200 rounded-md p-3 space-y-2">
        <div className="flex items-center justify-between text-xs">
          <span className="text-slate-600">Занято блоков</span>
          <span className="font-mono font-semibold text-slate-900">
            {pagedAttention.usedBlocks} / {pagedAttention.usableBlocks}
          </span>
        </div>
        <div className="h-2 w-full bg-slate-200 rounded-full overflow-hidden">
          <div
            className={`h-full transition-all duration-150 ${
              kvUsedPct >= 85 ? 'bg-amber-500' : 'bg-blue-600'
            }`}
            style={{ width: `${kvUsedPct}%` }}
          />
        </div>
        <div className="flex items-center justify-between text-[11px] font-mono text-slate-500">
          <span>Фрагм.: {pagedAttention.internalFragmentationPct.toFixed(1)}%</span>
          <span>
            Очередь: {snapshot.activeRequestsCount}/{snapshot.queuedRequestsCount}
          </span>
        </div>
      </div>

      {/* KV-Cache Limit Controls */}
      <div className="space-y-4">
        <div>
          <div className="flex items-center justify-between text-xs mb-1.5">
            <label htmlFor="ctrl-kv-util" className="text-slate-700 font-medium">
              Лимит KV-кэша
            </label>
            <span className="font-mono font-semibold text-blue-600">
              {Math.round(pagedAttention.kvMemoryUtilization * 100)}% ({pagedAttention.usableBlocks} бл.)
            </span>
          </div>
          <input
            id="ctrl-kv-util"
            type="range"
            min={0.25}
            max={1}
            step={0.05}
            value={pagedAttention.kvMemoryUtilization}
            onChange={(e) =>
              patchConfig({ kvMemoryUtilization: Number(e.target.value) })
            }
            className="w-full accent-blue-600 cursor-pointer"
          />
          <div className="mt-0.5 flex justify-between text-[10px] font-mono text-slate-400">
            <span>25%</span>
            <span>50%</span>
            <span>75%</span>
            <span>100%</span>
          </div>
        </div>

        <div>
          <div className="flex items-center justify-between text-xs mb-1.5">
            <span className="text-slate-700 font-medium">Пул страниц (total_blocks)</span>
            <span className="font-mono text-slate-600">{pagedAttention.totalBlocks}</span>
          </div>
          <div className="grid grid-cols-3 gap-1 p-1 bg-slate-100 rounded-md">
            {[64, 96, 128].map((count) => (
              <button
                key={count}
                type="button"
                disabled={isUpdating}
                onClick={() => patchConfig({ totalBlocks: count })}
                className={`py-1 text-xs font-mono rounded transition-colors cursor-pointer ${
                  pagedAttention.totalBlocks === count
                    ? 'bg-white text-blue-600 font-semibold shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                {count}
              </button>
            ))}
          </div>
        </div>

        <div>
          <div className="flex items-center justify-between text-xs mb-1.5">
            <span className="text-slate-700 font-medium">Размер блока (block_size)</span>
            <span className="font-mono text-slate-600">{pagedAttention.blockSize} слотов</span>
          </div>
          <div className="grid grid-cols-2 gap-1 p-1 bg-slate-100 rounded-md">
            {([16, 32] as const).map((sz) => (
              <button
                key={sz}
                type="button"
                disabled={isUpdating}
                onClick={() => patchConfig({ blockSize: sz })}
                className={`py-1 text-xs font-mono rounded transition-colors cursor-pointer ${
                  pagedAttention.blockSize === sz
                    ? 'bg-white text-blue-600 font-semibold shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                {sz} tok
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Scheduler Parameters */}
      <div className="border-t border-slate-100 pt-4 space-y-4">
        <div className="text-xs font-semibold text-slate-900">
          Планировщик батчей
        </div>

        <div>
          <div className="flex items-center justify-between text-xs mb-1.5">
            <label htmlFor="ctrl-max-seqs" className="text-slate-700 font-medium">
              max_num_seqs
            </label>
            <span className="font-mono font-semibold text-slate-900">
              {pagedAttention.maxNumSeqs} потоков
            </span>
          </div>
          <input
            id="ctrl-max-seqs"
            type="range"
            min={1}
            max={16}
            step={1}
            value={pagedAttention.maxNumSeqs}
            onChange={(e) =>
              patchConfig({ maxNumSeqs: Number(e.target.value) })
            }
            className="w-full accent-blue-600 cursor-pointer"
          />
          <div className="mt-0.5 flex justify-between text-[10px] font-mono text-slate-400">
            <span>1</span>
            <span>4</span>
            <span>8</span>
            <span>16</span>
          </div>
        </div>

        <div>
          <label
            htmlFor="ctrl-max-model-len"
            className="block text-xs font-medium text-slate-700 mb-1.5"
          >
            Окно контекста (max_model_len)
          </label>
          <select
            id="ctrl-max-model-len"
            value={pagedAttention.maxModelLen}
            onChange={(e) => patchConfig({ maxModelLen: Number(e.target.value) })}
            className="w-full bg-white border border-slate-300 rounded-md px-2.5 py-1.5 text-xs font-mono text-slate-900"
          >
            {[1024, 2048, 4096, 8192].map((len) => (
              <option key={len} value={len}>
                {len} токенов
              </option>
            ))}
          </select>
        </div>

        <label className="flex items-center justify-between gap-2 text-xs text-slate-700 cursor-pointer">
          <span>Prefix Caching (RAM-кэш)</span>
          <input
            type="checkbox"
            checked={pagedAttention.enablePrefixCaching}
            onChange={(e) =>
              patchConfig({ enablePrefixCaching: e.target.checked })
            }
            className="w-4 h-4 accent-blue-600 rounded cursor-pointer"
          />
        </label>
      </div>

      {/* Quick Actions */}
      <div className="border-t border-slate-100 pt-4 space-y-2 mt-auto">
        {activeView !== 'paged_blocks' && (
          <button
            type="button"
            onClick={onGoToPagedGrid}
            className="w-full inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-md text-xs font-semibold bg-blue-50 border border-blue-200 text-blue-700 hover:bg-blue-100 transition-colors cursor-pointer"
          >
            <LayoutGrid className="w-3.5 h-3.5" />
            <span>Открыть сетку PagedAttention</span>
          </button>
        )}

        <button
          type="button"
          onClick={handleClearCache}
          className="w-full inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-md text-xs font-medium bg-white border border-slate-300 text-slate-700 hover:bg-slate-50 transition-colors cursor-pointer"
        >
          <RotateCcw className="w-3.5 h-3.5" />
          <span>Освободить кэш-блоки</span>
        </button>
      </div>
    </aside>
  );
};
