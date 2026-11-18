import React, { useMemo, useState } from 'react';
import type { PagedBlock, PagedBlockState, RequestRecord, ServerSnapshot } from '../types/engine';

interface PagedAttentionGridProps {
  snapshot: ServerSnapshot;
  onRefreshSnapshot: (snapshot: ServerSnapshot) => void;
  onGoToChat: () => void;
}

const BLOCK_STATE_META: Record<
  PagedBlockState,
  {
    label: string;
    cardClass: string;
    slotFilledClass: string;
    textClass: string;
  }
> = {
  free: {
    label: 'Свободен',
    cardClass: 'bg-slate-50 border-slate-200',
    slotFilledClass: 'bg-slate-300',
    textClass: 'text-slate-400',
  },
  prefill: {
    label: 'Prefill',
    cardClass: 'bg-blue-50/80 border-blue-300',
    slotFilledClass: 'bg-blue-600',
    textClass: 'text-blue-800',
  },
  decode: {
    label: 'Decode',
    cardClass: 'bg-emerald-50/80 border-emerald-300',
    slotFilledClass: 'bg-emerald-600',
    textClass: 'text-emerald-800',
  },
  prefix_cached: {
    label: 'Prefix Cache',
    cardClass: 'bg-indigo-50/80 border-indigo-300',
    slotFilledClass: 'bg-indigo-600',
    textClass: 'text-indigo-800',
  },
};

export const PagedAttentionGrid: React.FC<PagedAttentionGridProps> = ({
  snapshot,
  onRefreshSnapshot,
  onGoToChat,
}) => {
  const { pagedAttention } = snapshot;
  const [selectedReqId, setSelectedReqId] = useState<string | null>(null);
  const [hoveredBlock, setHoveredBlock] = useState<PagedBlock | null>(null);
  const [isUpdatingConfig, setIsUpdatingConfig] = useState(false);

  const requestsWithBlocks = useMemo(
    () => snapshot.requests.filter((r) => r.blockTable.length > 0),
    [snapshot.requests]
  );

  const selectedRequest: RequestRecord | null = useMemo(() => {
    if (selectedReqId) {
      const found = requestsWithBlocks.find((r) => r.id === selectedReqId);
      if (found) return found;
    }
    return requestsWithBlocks[0] ?? null;
  }, [requestsWithBlocks, selectedReqId]);

  const highlightedBlockIds = useMemo(() => {
    if (!selectedRequest) return new Set<number>();
    return new Set(selectedRequest.blockTable.map((e) => e.physicalBlockId));
  }, [selectedRequest]);

  const handleUpdatePagedConfig = async (patch: {
    blockSize?: 16 | 32;
    totalBlocks?: number;
  }) => {
    setIsUpdatingConfig(true);
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
      setIsUpdatingConfig(false);
    }
  };

  const handleClearPrefixCache = async () => {
    const res = await fetch('/api/engine/cache/clear', { method: 'POST' });
    if (res.ok) {
      onRefreshSnapshot(await res.json());
    }
  };

  const slotEfficiencyPct =
    pagedAttention.totalAllocatedSlots > 0
      ? ((pagedAttention.usedSlots / pagedAttention.totalAllocatedSlots) * 100).toFixed(1)
      : '100.0';

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-6">
      {/* Header & Geometry Controls */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold text-slate-900" style={{ textWrap: 'balance' }}>
            Динамическая сетка блоков PagedAttention и слотов KV-кэша
          </h1>
          <p className="text-xs text-slate-600 mt-0.5">
            Реальное отображение страничной памяти: каждый блок разбит на {pagedAttention.blockSize} слотов токенов с подсчётом фактической внутренней фрагментации.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1 p-1 bg-white border border-slate-200 rounded-md">
            <span className="px-2 text-[11px] text-slate-500">Размер блока:</span>
            {([16, 32] as const).map((sz) => (
              <button
                key={sz}
                type="button"
                disabled={isUpdatingConfig}
                onClick={() => handleUpdatePagedConfig({ blockSize: sz })}
                className={`px-2.5 py-1 rounded text-xs font-mono cursor-pointer transition-colors ${
                  pagedAttention.blockSize === sz
                    ? 'bg-blue-600 text-white'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                {sz}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-1 p-1 bg-white border border-slate-200 rounded-md">
            <span className="px-2 text-[11px] text-slate-500">Пул:</span>
            {[64, 96, 128].map((count) => (
              <button
                key={count}
                type="button"
                disabled={isUpdatingConfig}
                onClick={() => handleUpdatePagedConfig({ totalBlocks: count })}
                className={`px-2.5 py-1 rounded text-xs font-mono cursor-pointer transition-colors ${
                  pagedAttention.totalBlocks === count
                    ? 'bg-blue-600 text-white'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                {count}
              </button>
            ))}
          </div>

          <button
            type="button"
            onClick={handleClearPrefixCache}
            className="px-3 py-1.5 rounded-md text-xs font-medium bg-white border border-slate-300 text-slate-700 hover:bg-slate-50 cursor-pointer"
          >
            Освободить кэш-блоки
          </button>
        </div>
      </div>

      {/* Real-Time Fragmentation & Slot Usage Breakdown */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-white border border-slate-200 rounded-lg p-4">
          <div className="text-xs text-slate-500">Занятые страницы KV-кэша</div>
          <div className="mt-1 flex items-baseline gap-1.5">
            <span className="text-xl font-mono font-semibold text-slate-900">
              {pagedAttention.usedBlocks}
            </span>
            <span className="text-xs font-mono text-slate-500">
              / {pagedAttention.usableBlocks} доступно
            </span>
          </div>
          <div className="mt-1 text-[11px] font-mono text-slate-500">
            Лимит: {Math.round(pagedAttention.kvMemoryUtilization * 100)}% ({pagedAttention.totalBlocks} всего) · max_num_seqs={pagedAttention.maxNumSeqs}
          </div>
        </div>

        <div className="bg-white border border-slate-200 rounded-lg p-4">
          <div className="text-xs text-slate-500">Использование слотов токенов</div>
          <div className="mt-1 flex items-baseline gap-1.5">
            <span className="text-xl font-mono font-semibold text-blue-600">
              {pagedAttention.usedSlots}
            </span>
            <span className="text-xs font-mono text-slate-500">
              / {pagedAttention.totalAllocatedSlots} слотов
            </span>
          </div>
          <div className="mt-1 text-[11px] font-mono text-slate-500">
            Плотность упаковки: {slotEfficiencyPct}%
          </div>
        </div>

        <div className="bg-white border border-slate-200 rounded-lg p-4">
          <div className="text-xs text-slate-500">Внутренняя фрагментация</div>
          <div className="mt-1 flex items-baseline gap-1.5">
            <span className="text-xl font-mono font-semibold text-amber-600">
              {pagedAttention.internalFragmentationPct.toFixed(1)}%
            </span>
            <span className="text-xs font-mono text-slate-500">
              ({pagedAttention.fragmentedSlots} слотов)
            </span>
          </div>
          <div className="mt-1 text-[11px] text-slate-500">
            Пустые хвосты последних страниц
          </div>
        </div>

        <div className="bg-white border border-slate-200 rounded-lg p-4">
          <div className="text-xs text-slate-500">Непрерывное выделение (без Paging)</div>
          <div className="mt-1 flex items-baseline gap-1.5">
            <span className="text-xl font-mono font-semibold text-slate-900">
              {pagedAttention.naiveReservedSlots > 0
                ? `${pagedAttention.naiveFragmentationPct}%`
                : '0.0%'}
            </span>
            <span className="text-xs font-mono text-slate-500">потерь</span>
          </div>
          <div className="mt-1 text-[11px] font-mono text-slate-500">
            {pagedAttention.naiveReservedSlots > 0
              ? `Резерв: ${pagedAttention.naiveReservedSlots} слотов`
              : 'Нет активных последовательностей'}
          </div>
        </div>
      </div>

      {/* Main Split: Dynamic Block & Slot Grid + Page Table Inspector */}
      <div className="grid grid-cols-1 xl:grid-cols-12 gap-6 items-start">
        <div className="xl:col-span-8 bg-white border border-slate-200 rounded-lg p-5 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="text-sm font-semibold text-slate-900">
                Физическая память блоков и слоты токенов
              </h2>
              <p className="text-xs text-slate-500 mt-0.5">
                {hoveredBlock ? (
                  <span className="font-mono text-blue-700">
                    P{hoveredBlock.id} · {BLOCK_STATE_META[hoveredBlock.state].label} ·{' '}
                    {hoveredBlock.tokensFilled}/{hoveredBlock.blockSize} слотов занято
                    {hoveredBlock.state !== 'free'
                      ? ` · фрагментация ${hoveredBlock.blockSize - hoveredBlock.tokensFilled} слотов`
                      : ''}
                    {hoveredBlock.refCount > 1 ? ` · refCount=${hoveredBlock.refCount}` : ''}
                  </span>
                ) : (
                  'Наведите на блок для инспекции слотов и фрагментации. Клик по занятому блоку выбирает запрос.'
                )}
              </p>
            </div>
          </div>

          {/* Dynamic Grid of Physical Blocks with Individual KV Slots */}
          <div className="grid grid-cols-4 sm:grid-cols-8 gap-2">
            {pagedAttention.blocks.map((block) => {
              const meta = BLOCK_STATE_META[block.state];
              const isHighlighted = highlightedBlockIds.has(block.id);
              const slotsCount = block.blockSize;
              const isOccupied = block.state !== 'free';
              const isCappedOut = block.id >= pagedAttention.usableBlocks && !isOccupied;

              return (
                <button
                  key={block.id}
                  type="button"
                  onMouseEnter={() => setHoveredBlock(block)}
                  onMouseLeave={() => setHoveredBlock(null)}
                  onClick={() => {
                    if (block.ownerRequestIds.length > 0) {
                      setSelectedReqId(block.ownerRequestIds[0]);
                    } else {
                      const match = requestsWithBlocks.find((r) =>
                        r.blockTable.some((e) => e.physicalBlockId === block.id)
                      );
                      if (match) setSelectedReqId(match.id);
                    }
                  }}
                  className={`p-2 rounded-md border text-left transition-all cursor-pointer ${
                    isCappedOut
                      ? 'bg-slate-100/80 border-dashed border-slate-300 opacity-50'
                      : meta.cardClass
                  } ${isHighlighted ? 'ring-2 ring-blue-600 ring-offset-1' : 'hover:border-slate-400'}`}
                >
                  <div className="flex items-center justify-between text-[10px] font-mono mb-1.5">
                    <span className={`font-semibold ${isCappedOut ? 'text-slate-400' : meta.textClass}`}>
                      P{block.id}
                    </span>
                    <span className="text-slate-500">
                      {isCappedOut
                        ? 'лимит'
                        : block.refCount > 1
                        ? `×${block.refCount}`
                        : isOccupied
                        ? `${block.tokensFilled}/${slotsCount}`
                        : '0'}
                    </span>
                  </div>

                  {/* Individual KV-Cache Slots inside the Physical Block */}
                  <div
                    className="grid grid-cols-8 gap-[2px]"
                    aria-hidden="true"
                  >
                    {Array.from({ length: slotsCount }, (_, slotIdx) => {
                      const isFilled = slotIdx < block.tokensFilled;
                      const slotClass = isCappedOut
                        ? 'bg-slate-200/60'
                        : !isOccupied
                        ? 'bg-slate-200/80'
                        : isFilled
                        ? meta.slotFilledClass
                        : 'bg-amber-300/90';

                      return (
                        <span
                          key={slotIdx}
                          className={`h-1.5 rounded-[1px] ${slotClass}`}
                        />
                      );
                    })}
                  </div>
                </button>
              );
            })}
          </div>

          {/* Explicit Text + Color Legend */}
          <div className="pt-3 border-t border-slate-100 flex flex-wrap items-center gap-x-5 gap-y-2 text-[11px] text-slate-600">
            <span className="inline-flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-xs bg-blue-600" />
              <span>Слот Prefill (промпт)</span>
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-xs bg-emerald-600" />
              <span>Слот Decode (генерация)</span>
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-xs bg-indigo-600" />
              <span>Prefix Cache (общий блок CoW)</span>
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-xs bg-amber-300 border border-amber-400" />
              <span>Незаполненный слот (фрагментация)</span>
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-xs bg-slate-200" />
              <span>Свободный блок</span>
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-xs bg-slate-100 border border-dashed border-slate-400" />
              <span>Вне лимита KV-кэша</span>
            </span>
          </div>
        </div>

        {/* Right: Real Sequence Page Table Inspector */}
        <div className="xl:col-span-4 bg-white border border-slate-200 rounded-lg p-5 space-y-4">
          <div>
            <h2 className="text-sm font-semibold text-slate-900">
              Таблица страниц реальных запросов
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              Выберите запрос, чтобы подсветить его несмежные физические блоки в сетке.
            </p>
          </div>

          {requestsWithBlocks.length === 0 ? (
            <div className="py-8 px-4 text-center border border-dashed border-slate-300 rounded-md space-y-3">
              <div className="text-xs text-slate-600">
                Реальных запросов пока нет — все физические блоки свободны.
              </div>
              <button
                type="button"
                onClick={onGoToChat}
                className="px-3.5 py-2 rounded-md text-xs font-semibold bg-blue-600 text-white hover:bg-blue-700 cursor-pointer"
              >
                Отправить запрос в чате
              </button>
            </div>
          ) : (
            <>
              <div className="max-h-56 overflow-y-auto divide-y divide-slate-100 border border-slate-200 rounded-md">
                {requestsWithBlocks.map((req) => {
                  const isSelected = selectedRequest?.id === req.id;
                  const wastedSlots = req.blockTable.reduce(
                    (acc, e) => acc + Math.max(0, pagedAttention.blockSize - e.tokensUsed),
                    0
                  );

                  return (
                    <button
                      key={req.id}
                      type="button"
                      onClick={() => setSelectedReqId(req.id)}
                      className={`w-full text-left px-3 py-2.5 transition-colors cursor-pointer ${
                        isSelected ? 'bg-blue-50/70' : 'hover:bg-slate-50'
                      }`}
                    >
                      <div className="flex items-center justify-between text-xs">
                        <span className="font-mono font-semibold text-slate-900">
                          {req.id}
                          <span className="font-normal text-slate-500 ml-1.5">
                            · {req.modelAlias}
                          </span>
                        </span>
                        <span
                          className={`font-mono ${
                            req.status === 'running'
                              ? 'text-blue-600'
                              : req.status === 'completed'
                              ? 'text-emerald-600'
                              : 'text-slate-500'
                          }`}
                        >
                          {req.status === 'running'
                            ? 'Поток'
                            : req.status === 'completed'
                            ? 'Готов'
                            : req.status}
                        </span>
                      </div>
                      <div className="mt-1 flex items-center justify-between text-[11px] font-mono text-slate-500">
                        <span>{req.totalTokens} tok · {req.blockTable.length} блоков</span>
                        <span>потерь: {wastedSlots} сл.</span>
                      </div>
                    </button>
                  );
                })}
              </div>

              {selectedRequest && (
                <div className="pt-2 border-t border-slate-100 space-y-2.5">
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-mono font-semibold text-blue-700">
                      {selectedRequest.id}
                    </span>
                    <span className="font-mono text-slate-500">
                      {selectedRequest.promptTokens} вх + {selectedRequest.completionTokens} вых tok
                    </span>
                  </div>

                  <div className="text-xs text-slate-600 bg-slate-50 border border-slate-200 rounded p-2.5 line-clamp-2">
                    {selectedRequest.promptPreview}
                  </div>

                  <div className="text-[11px] font-medium text-slate-600">
                    Logical Block → Physical Block (слоты)
                  </div>

                  <div className="grid grid-cols-2 gap-1.5 max-h-48 overflow-y-auto pr-1">
                    {selectedRequest.blockTable.map((entry) => {
                      const wasted = Math.max(0, pagedAttention.blockSize - entry.tokensUsed);
                      return (
                        <div
                          key={`${selectedRequest.id}-${entry.logicalIndex}`}
                          className={`px-2.5 py-1.5 rounded border text-[11px] font-mono flex items-center justify-between ${
                            entry.isSharedPrefix
                              ? 'bg-indigo-50 border-indigo-200 text-indigo-900'
                              : 'bg-slate-50 border-slate-200 text-slate-800'
                          }`}
                        >
                          <span>
                            L{entry.logicalIndex} → P{entry.physicalBlockId}
                          </span>
                          <span className={wasted > 0 ? 'text-amber-700' : 'text-slate-500'}>
                            {entry.tokensUsed}/{pagedAttention.blockSize}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
};
