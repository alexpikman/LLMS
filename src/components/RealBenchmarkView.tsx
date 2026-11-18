import React, { useMemo, useState } from 'react';
import { Play } from 'lucide-react';
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { ServerSnapshot } from '../types/engine';

interface RealBenchmarkViewProps {
  snapshot: ServerSnapshot;
  onGoToModels: () => void;
}

const BENCHMARK_PROMPTS = [
  'Назови три ключевых принципа масштабирования веб-сервисов и кратко поясни каждый.',
  'Напиши компактную функцию бинарного поиска на TypeScript с проверкой граничных условий.',
  'Сравни протоколы HTTP/1.1, HTTP/2 и SSE для потоковой передачи текста.',
  'Объясни разницу между задержкой до первого токена (TTFT) и скоростью генерации (tok/s).',
  'Составь чеклист из 4 пунктов для проверки готовности REST API к продакшену.',
  'Приведи пример SQL-запроса для расчёта 95-го перцентиля времени ответа.',
];

interface BenchmarkRunSummary {
  modelAlias: string;
  concurrencyLabel: string;
  totalRequests: number;
  completed: number;
  failed: number;
  wallDurationMs: number;
  avgTtftMs: number | null;
  p95TtftMs: number | null;
  avgTokensPerSec: number | null;
}

function percentile95(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1);
  return Math.round(sorted[idx]);
}

export const RealBenchmarkView: React.FC<RealBenchmarkViewProps> = ({
  snapshot,
  onGoToModels,
}) => {
  const runningTextModels = snapshot.deployments.filter(
    (d) => d.status === 'running' && d.capability === 'text'
  );

  const [selectedAlias, setSelectedAlias] = useState<string>(
    runningTextModels[0]?.alias ?? ''
  );
  const [totalRequests, setTotalRequests] = useState<number>(4);
  const [concurrency, setConcurrency] = useState<number>(2);
  const [bypassCache, setBypassCache] = useState<boolean>(true);
  const [isRunning, setIsRunning] = useState<boolean>(false);
  const [progress, setProgress] = useState<{ done: number; total: number }>({
    done: 0,
    total: 0,
  });
  const [lastSummary, setLastSummary] = useState<BenchmarkRunSummary | null>(null);
  const [benchmarkError, setBenchmarkError] = useState<string | null>(null);

  const completedRequests = useMemo(
    () =>
      snapshot.requests
        .filter((r) => r.status === 'completed')
        .slice(0, 30)
        .reverse(),
    [snapshot.requests]
  );

  // Per-request chronological dataset for Recharts
  const perRequestData = useMemo(
    () =>
      completedRequests.map((req) => ({
        name: req.id.replace('req-', '#'),
        tokensPerSec: req.tokensPerSec ?? 0,
        ttftMs: req.ttftMs ?? 0,
        kvLoadPct: req.kvLoadPct ?? 0,
        concurrency: req.concurrencyAtRun ?? 1,
        model: req.modelAlias,
      })),
    [completedRequests]
  );

  // Aggregated dataset grouped by real concurrency load level for Recharts
  const loadGroupedData = useMemo(() => {
    const groups = new Map<
      number,
      { concurrency: number; tpsSum: number; ttftSum: number; kvSum: number; count: number }
    >();
    for (const req of completedRequests) {
      const level = req.concurrencyAtRun || 1;
      const existing = groups.get(level) ?? {
        concurrency: level,
        tpsSum: 0,
        ttftSum: 0,
        kvSum: 0,
        count: 0,
      };
      existing.tpsSum += req.tokensPerSec ?? 0;
      existing.ttftSum += req.ttftMs ?? 0;
      existing.kvSum += req.kvLoadPct ?? 0;
      existing.count++;
      groups.set(level, existing);
    }

    return Array.from(groups.values())
      .sort((a, b) => a.concurrency - b.concurrency)
      .map((g) => ({
        loadLabel: `${g.concurrency} поток(ов)`,
        concurrency: g.concurrency,
        avgTokensPerSec: Number((g.tpsSum / g.count).toFixed(1)),
        avgTtftMs: Math.round(g.ttftSum / g.count),
        avgKvLoadPct: Number((g.kvSum / g.count).toFixed(1)),
        samples: g.count,
      }));
  }, [completedRequests]);

  const executeBatch = async (
    targetAlias: string,
    count: number,
    parallelism: number,
    onStepDone: () => void
  ) => {
    const batchId = Date.now();
    const ttfts: number[] = [];
    const tpsList: number[] = [];
    let completed = 0;
    let failed = 0;
    let nextIndex = 0;

    const worker = async () => {
      while (true) {
        const idx = nextIndex++;
        if (idx >= count) break;
        const basePrompt = BENCHMARK_PROMPTS[idx % BENCHMARK_PROMPTS.length];
        const prompt = bypassCache
          ? `[Запрос #${batchId}-${idx + 1}] ${basePrompt}`
          : basePrompt;

        const reqStart = performance.now();
        let reqTtft: number | null = null;
        let textChars = 0;
        let reportedTokens = 0;

        try {
          const res = await fetch('/v1/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              model: targetAlias,
              stream: true,
              messages: [{ role: 'user', content: prompt }],
            }),
          });

          if (!res.ok || !res.body) {
            failed++;
          } else {
            const reader = res.body.getReader();
            const decoder = new TextDecoder('utf-8');
            let buf = '';
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              buf += decoder.decode(value, { stream: true });
              const lines = buf.split('\n');
              buf = lines.pop() ?? '';
              for (const rawLine of lines) {
                const line = rawLine.trim();
                if (!line.startsWith('data:')) continue;
                const payload = line.slice(5).trim();
                if (payload === '[DONE]') continue;
                try {
                  const parsed = JSON.parse(payload);
                  if (parsed.error) {
                    throw new Error(parsed.error.message);
                  }
                  const delta = parsed.choices?.[0]?.delta?.content ?? '';
                  if (delta) {
                    if (reqTtft === null) {
                      reqTtft = performance.now() - reqStart;
                    }
                    textChars += delta.length;
                  }
                  if (parsed.usage?.completion_tokens) {
                    reportedTokens = parsed.usage.completion_tokens;
                  }
                } catch (e) {
                  if (e instanceof Error && !e.message.includes('JSON')) {
                    throw e;
                  }
                }
              }
            }
            const reqTotalMs = Math.max(1, performance.now() - reqStart);
            const tokens = reportedTokens || Math.max(1, Math.ceil(textChars / 4));
            ttfts.push(reqTtft ?? reqTotalMs);
            tpsList.push(tokens / (reqTotalMs / 1000));
            completed++;
          }
        } catch (err) {
          failed++;
          setBenchmarkError(
            err instanceof Error ? err.message : 'Ошибка при выполнении запроса'
          );
        } finally {
          onStepDone();
        }
      }
    };

    const workerCount = Math.min(parallelism, count);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
    return { ttfts, tpsList, completed, failed };
  };

  const handleRunBenchmark = async () => {
    const targetAlias = selectedAlias || runningTextModels[0]?.alias;
    if (!targetAlias || isRunning) return;

    setIsRunning(true);
    setBenchmarkError(null);
    setProgress({ done: 0, total: totalRequests });

    const runStart = performance.now();
    const { ttfts, tpsList, completed, failed } = await executeBatch(
      targetAlias,
      totalRequests,
      concurrency,
      () => setProgress((prev) => ({ ...prev, done: prev.done + 1 }))
    );

    const wallDurationMs = Math.round(performance.now() - runStart);
    setLastSummary({
      modelAlias: targetAlias,
      concurrencyLabel: `${concurrency} поток(ов)`,
      totalRequests,
      completed,
      failed,
      wallDurationMs,
      avgTtftMs:
        ttfts.length > 0
          ? Math.round(ttfts.reduce((a, b) => a + b, 0) / ttfts.length)
          : null,
      p95TtftMs: percentile95(ttfts),
      avgTokensPerSec:
        tpsList.length > 0
          ? Number((tpsList.reduce((a, b) => a + b, 0) / tpsList.length).toFixed(1))
          : null,
    });
    setIsRunning(false);
  };

  const handleRunLoadSweep = async () => {
    const targetAlias = selectedAlias || runningTextModels[0]?.alias;
    if (!targetAlias || isRunning) return;

    const stages = [
      { concurrency: 1, count: 1 },
      { concurrency: 2, count: 2 },
      { concurrency: 4, count: 4 },
    ];
    const grandTotal = stages.reduce((s, st) => s + st.count, 0);

    setIsRunning(true);
    setBenchmarkError(null);
    setProgress({ done: 0, total: grandTotal });

    const runStart = performance.now();
    const allTtfts: number[] = [];
    const allTps: number[] = [];
    let totalCompleted = 0;
    let totalFailed = 0;

    for (const stage of stages) {
      const res = await executeBatch(targetAlias, stage.count, stage.concurrency, () =>
        setProgress((prev) => ({ ...prev, done: prev.done + 1 }))
      );
      allTtfts.push(...res.ttfts);
      allTps.push(...res.tpsList);
      totalCompleted += res.completed;
      totalFailed += res.failed;
    }

    const wallDurationMs = Math.round(performance.now() - runStart);
    setLastSummary({
      modelAlias: targetAlias,
      concurrencyLabel: 'Ступенчато 1 → 2 → 4',
      totalRequests: grandTotal,
      completed: totalCompleted,
      failed: totalFailed,
      wallDurationMs,
      avgTtftMs:
        allTtfts.length > 0
          ? Math.round(allTtfts.reduce((a, b) => a + b, 0) / allTtfts.length)
          : null,
      p95TtftMs: percentile95(allTtfts),
      avgTokensPerSec:
        allTps.length > 0
          ? Number((allTps.reduce((a, b) => a + b, 0) / allTps.length).toFixed(1))
          : null,
    });
    setIsRunning(false);
  };

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-6">
      <div>
        <h1 className="text-lg font-semibold text-slate-900" style={{ textWrap: 'balance' }}>
          Реальное нагрузочное тестирование и аналитика Recharts
        </h1>
        <p className="text-xs text-slate-600 mt-0.5">
          Запускает реальные конкурентные HTTP/SSE-запросы к модели и визуализирует пропускную способность (ток/с) и TTFT (мс) в зависимости от нагрузки на пул и KV-кэш.
        </p>
      </div>

      {runningTextModels.length === 0 ? (
        <div className="bg-white border border-slate-200 rounded-lg p-6 flex flex-wrap items-center justify-between gap-4">
          <div className="text-xs text-slate-600">
            Нет запущенных текстовых моделей для проведения теста.
          </div>
          <button
            type="button"
            onClick={onGoToModels}
            className="px-3.5 py-2 rounded-md text-xs font-semibold bg-blue-600 text-white hover:bg-blue-700 cursor-pointer"
          >
            Перейти к запуску моделей
          </button>
        </div>
      ) : (
        <div className="bg-white border border-slate-200 rounded-lg p-5 space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 items-end">
            <div>
              <label htmlFor="bench-model" className="block text-xs font-medium text-slate-700 mb-1">
                Тестируемая модель
              </label>
              <select
                id="bench-model"
                value={selectedAlias || runningTextModels[0]?.alias}
                onChange={(e) => setSelectedAlias(e.target.value)}
                className="w-full bg-white border border-slate-300 rounded-md px-3 py-2 text-xs font-mono text-slate-900"
              >
                {runningTextModels.map((m) => (
                  <option key={m.id} value={m.alias}>
                    {m.alias}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label htmlFor="bench-total" className="block text-xs font-medium text-slate-700 mb-1">
                Число реальных запросов
              </label>
              <select
                id="bench-total"
                value={totalRequests}
                onChange={(e) => setTotalRequests(Number(e.target.value))}
                className="w-full bg-white border border-slate-300 rounded-md px-3 py-2 text-xs font-mono text-slate-900"
              >
                {[2, 4, 6, 8, 12].map((n) => (
                  <option key={n} value={n}>
                    {n} запросов
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label htmlFor="bench-conc" className="block text-xs font-medium text-slate-700 mb-1">
                Параллельность (Concurrency)
              </label>
              <select
                id="bench-conc"
                value={concurrency}
                onChange={(e) => setConcurrency(Number(e.target.value))}
                className="w-full bg-white border border-slate-300 rounded-md px-3 py-2 text-xs font-mono text-slate-900"
              >
                {[1, 2, 4, 6].map((n) => (
                  <option key={n} value={n}>
                    {n} потоков
                  </option>
                ))}
              </select>
            </div>

            <div className="space-y-2">
              <label className="inline-flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
                <input
                  type="checkbox"
                  checked={bypassCache}
                  onChange={(e) => setBypassCache(e.target.checked)}
                  className="w-4 h-4 accent-blue-600 rounded"
                />
                <span>Уникальные промпты (без кэша)</span>
              </label>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={isRunning}
                  onClick={handleRunBenchmark}
                  className="flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-md text-xs font-semibold bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 whitespace-nowrap cursor-pointer"
                >
                  <Play className="w-3.5 h-3.5 fill-current" />
                  <span>
                    {isRunning
                      ? `${progress.done} / ${progress.total}`
                      : 'Запустить тест'}
                  </span>
                </button>

                <button
                  type="button"
                  disabled={isRunning}
                  onClick={handleRunLoadSweep}
                  title="Выполнить 3 ступени реальной нагрузки: 1, 2 и 4 параллельных запроса"
                  className="px-3 py-2 rounded-md text-xs font-medium bg-white border border-slate-300 text-slate-700 hover:bg-slate-50 disabled:opacity-50 whitespace-nowrap cursor-pointer"
                >
                  1 → 2 → 4
                </button>
              </div>
            </div>
          </div>

          {benchmarkError && (
            <div className="p-3 rounded-md bg-rose-50 border border-rose-200 text-xs text-rose-700">
              {benchmarkError}
            </div>
          )}

          {lastSummary && (
            <div className="pt-4 border-t border-slate-200 grid grid-cols-2 sm:grid-cols-5 gap-4 text-xs">
              <div>
                <div className="text-slate-500">Профиль / Успешно</div>
                <div className="mt-1 font-mono font-semibold text-slate-900">
                  {lastSummary.concurrencyLabel} · {lastSummary.completed}/{lastSummary.totalRequests}
                </div>
              </div>
              <div>
                <div className="text-slate-500">Общее время прогона</div>
                <div className="mt-1 font-mono font-semibold text-slate-900">
                  {lastSummary.wallDurationMs} мс
                </div>
              </div>
              <div>
                <div className="text-slate-500">Средний TTFT</div>
                <div className="mt-1 font-mono font-semibold text-blue-600">
                  {lastSummary.avgTtftMs !== null ? `${lastSummary.avgTtftMs} мс` : '—'}
                </div>
              </div>
              <div>
                <div className="text-slate-500">P95 TTFT</div>
                <div className="mt-1 font-mono font-semibold text-slate-900">
                  {lastSummary.p95TtftMs !== null ? `${lastSummary.p95TtftMs} мс` : '—'}
                </div>
              </div>
              <div>
                <div className="text-slate-500">Средняя скорость</div>
                <div className="mt-1 font-mono font-semibold text-emerald-600">
                  {lastSummary.avgTokensPerSec !== null
                    ? `${lastSummary.avgTokensPerSec} ток/с`
                    : '—'}
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Recharts Visualizations (Empty State until real requests exist) */}
      {completedRequests.length === 0 ? (
        <div className="bg-white border border-dashed border-slate-300 rounded-lg p-12 text-center space-y-2">
          <div className="text-sm font-semibold text-slate-900">
            Нет измеренных данных для построения графиков Recharts
          </div>
          <p className="text-xs text-slate-500 max-w-md mx-auto">
            Графики строятся исключительно по реальным замерам. Нажмите «Запустить тест» или «1 → 2 → 4» выше, чтобы увидеть зависимость tokens/sec и TTFT от нагрузки.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
          {/* Recharts 1: Load vs Throughput & Latency */}
          <div className="bg-white border border-slate-200 rounded-lg p-5 space-y-3">
            <div>
              <h2 className="text-sm font-semibold text-slate-900">
                Зависимость tokens/sec и TTFT от уровня нагрузки
              </h2>
              <p className="text-xs text-slate-500 mt-0.5">
                Агрегация реальных запросов по числу параллельных потоков исполнения
              </p>
            </div>

            <div className="h-72 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart
                  data={loadGroupedData}
                  margin={{ top: 12, right: 16, left: 0, bottom: 8 }}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" />
                  <XAxis
                    dataKey="loadLabel"
                    tick={{ fontSize: 11, fill: '#475569' }}
                    stroke="#CBD5E1"
                  />
                  <YAxis
                    yAxisId="left"
                    tick={{ fontSize: 11, fill: '#475569' }}
                    stroke="#CBD5E1"
                    unit=" т/с"
                  />
                  <YAxis
                    yAxisId="right"
                    orientation="right"
                    tick={{ fontSize: 11, fill: '#475569' }}
                    stroke="#CBD5E1"
                    unit=" мс"
                  />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: '#FFFFFF',
                      borderColor: '#E2E8F0',
                      borderRadius: '6px',
                      fontSize: '12px',
                      color: '#0F172A',
                    }}
                  />
                  <Legend wrapperStyle={{ fontSize: '12px' }} />
                  <Bar
                    yAxisId="left"
                    dataKey="avgTokensPerSec"
                    name="Скорость (ток/с)"
                    fill="#16A34A"
                    radius={[4, 4, 0, 0]}
                    maxBarSize={44}
                  />
                  <Line
                    yAxisId="right"
                    type="monotone"
                    dataKey="avgTtftMs"
                    name="Средний TTFT (мс)"
                    stroke="#2563EB"
                    strokeWidth={2.5}
                    dot={{ r: 4, fill: '#2563EB' }}
                  />
                  <Line
                    yAxisId="left"
                    type="monotone"
                    dataKey="avgKvLoadPct"
                    name="Загрузка KV-кэша (%)"
                    stroke="#D97706"
                    strokeWidth={2}
                    strokeDasharray="4 4"
                    dot={{ r: 3, fill: '#D97706' }}
                  />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* Recharts 2: Chronological Request Series */}
          <div className="bg-white border border-slate-200 rounded-lg p-5 space-y-3">
            <div>
              <h2 className="text-sm font-semibold text-slate-900">
                Профиль реальных запросов: TTFT, tokens/sec и нагрузка KV (%)
              </h2>
              <p className="text-xs text-slate-500 mt-0.5">
                Последние {perRequestData.length} выполненных запросов с фактической загрузкой блоков
              </p>
            </div>

            <div className="h-72 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart
                  data={perRequestData}
                  margin={{ top: 12, right: 16, left: 0, bottom: 8 }}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" />
                  <XAxis
                    dataKey="name"
                    tick={{ fontSize: 11, fill: '#475569' }}
                    stroke="#CBD5E1"
                  />
                  <YAxis
                    yAxisId="left"
                    tick={{ fontSize: 11, fill: '#475569' }}
                    stroke="#CBD5E1"
                  />
                  <YAxis
                    yAxisId="right"
                    orientation="right"
                    tick={{ fontSize: 11, fill: '#475569' }}
                    stroke="#CBD5E1"
                    unit=" мс"
                  />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: '#FFFFFF',
                      borderColor: '#E2E8F0',
                      borderRadius: '6px',
                      fontSize: '12px',
                      color: '#0F172A',
                    }}
                  />
                  <Legend wrapperStyle={{ fontSize: '12px' }} />
                  <Bar
                    yAxisId="left"
                    dataKey="tokensPerSec"
                    name="Скорость (ток/с)"
                    fill="#16A34A"
                    radius={[3, 3, 0, 0]}
                    maxBarSize={28}
                  />
                  <Line
                    yAxisId="right"
                    type="monotone"
                    dataKey="ttftMs"
                    name="TTFT (мс)"
                    stroke="#2563EB"
                    strokeWidth={2}
                    dot={{ r: 3, fill: '#2563EB' }}
                  />
                  <Line
                    yAxisId="left"
                    type="monotone"
                    dataKey="kvLoadPct"
                    name="Нагрузка KV (%)"
                    stroke="#D97706"
                    strokeWidth={2}
                    dot={{ r: 2.5, fill: '#D97706' }}
                  />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
