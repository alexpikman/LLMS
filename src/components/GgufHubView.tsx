import React, { useEffect, useState } from 'react';
import {
  Download,
  ExternalLink,
  FolderOpen,
  Pause,
  Play,
  Search,
  Trash2,
  X,
} from 'lucide-react';
import type {
  HubGgufFile,
  HubSearchResult,
  HubSource,
  LocalGgufModel,
  ServerSnapshot,
} from '../types/engine';
import { CompatibilityBadge, formatBytes } from './CompatibilityBadge';
import { HardwareSummaryBanner } from './HardwareSummaryBanner';

interface GgufHubViewProps {
  snapshot: ServerSnapshot;
  onRefreshSnapshot: (snapshot: ServerSnapshot) => void;
  onLaunchLocalModel: (model: LocalGgufModel) => void;
}

const SOURCE_TABS: Array<{ id: HubSource; label: string; placeholder: string }> = [
  {
    id: 'huggingface',
    label: 'Hugging Face',
    placeholder: 'Например: Qwen2.5-3B-Instruct-GGUF или Llama-3.2',
  },
  {
    id: 'ollama',
    label: 'Ollama Registry',
    placeholder: 'Например: qwen2.5:7b, llama3.2:3b или deepseek-r1',
  },
  {
    id: 'modelscope',
    label: 'ModelScope',
    placeholder: 'Например: Qwen/Qwen2.5-3B-Instruct-GGUF',
  },
  {
    id: 'url',
    label: 'Прямой URL (.gguf)',
    placeholder: 'https://.../model-q4_k_m.gguf',
  },
];

function formatEta(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds <= 0) return '—';
  if (seconds < 60) return `${seconds} с`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m} м ${s} с`;
}

export const GgufHubView: React.FC<GgufHubViewProps> = ({
  snapshot,
  onRefreshSnapshot,
  onLaunchLocalModel,
}) => {
  const [source, setSource] = useState<HubSource>('huggingface');
  const [query, setQuery] = useState('Qwen2.5-3B-Instruct-GGUF');
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [results, setResults] = useState<HubSearchResult[]>([]);
  const [selectedRepo, setSelectedRepo] = useState<string | null>(null);
  const [files, setFiles] = useState<HubGgufFile[]>([]);
  const [loadingFiles, setLoadingFiles] = useState(false);
  const [filesError, setFilesError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const ctxSize = snapshot.pagedAttention.maxModelLen;
  const activeTab = SOURCE_TABS.find((t) => t.id === source) ?? SOURCE_TABS[0];

  const runSearch = async (targetSource = source, targetQuery = query) => {
    setSearching(true);
    setSearchError(null);
    setFilesError(null);
    setSelectedRepo(null);
    setFiles([]);

    try {
      if (targetSource === 'url') {
        if (!targetQuery.trim()) {
          setSearching(false);
          return;
        }
        const res = await fetch(
          `/api/hub/probe-url?url=${encodeURIComponent(targetQuery.trim())}&ctxSize=${ctxSize}`
        );
        const json = await res.json();
        if (!res.ok) {
          setSearchError(json.error || 'Не удалось проверить URL');
        } else if (json.file) {
          setSelectedRepo(targetQuery.trim());
          setFiles([json.file]);
        }
        return;
      }

      const res = await fetch(
        `/api/hub/search?source=${encodeURIComponent(targetSource)}&q=${encodeURIComponent(
          targetQuery.trim()
        )}`
      );
      const json = await res.json();
      if (!res.ok) {
        setSearchError(json.error || 'Ошибка поиска моделей');
      } else {
        setResults(json.results ?? []);
      }
    } catch (err) {
      setSearchError(err instanceof Error ? err.message : 'Сетевая ошибка');
    } finally {
      setSearching(false);
    }
  };

  useEffect(() => {
    void runSearch('huggingface', 'Qwen2.5-3B-Instruct-GGUF');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSelectRepo = async (repoId: string) => {
    setSelectedRepo(repoId);
    setLoadingFiles(true);
    setFilesError(null);
    setFiles([]);
    try {
      const res = await fetch(
        `/api/hub/files?source=${encodeURIComponent(source)}&repo=${encodeURIComponent(
          repoId
        )}&ctxSize=${ctxSize}`
      );
      const json = await res.json();
      if (!res.ok) {
        setFilesError(json.error || 'Не удалось загрузить список файлов GGUF');
      } else {
        setFiles(json.files ?? []);
      }
    } catch (err) {
      setFilesError(err instanceof Error ? err.message : 'Сетевая ошибка');
    } finally {
      setLoadingFiles(false);
    }
  };

  const handleStartDownload = async (file: HubGgufFile) => {
    setActionError(null);
    try {
      const res = await fetch('/api/downloads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          source,
          repoId: selectedRepo ?? file.fileName,
          fileName: file.fileName,
          downloadUrl: file.downloadUrl,
          totalBytes: file.sizeBytes,
          quantization: file.quantization,
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        setActionError(json.error || 'Не удалось запустить загрузку');
      } else if (json.snapshot) {
        onRefreshSnapshot(json.snapshot);
      }
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Сетевая ошибка');
    }
  };

  const handleDownloadAction = async (
    id: string,
    action: 'pause' | 'resume' | 'cancel'
  ) => {
    const endpoint =
      action === 'cancel' ? `/api/downloads/${id}` : `/api/downloads/${id}/${action}`;
    const method = action === 'cancel' ? 'DELETE' : 'POST';
    const res = await fetch(endpoint, { method });
    const json = await res.json();
    if (res.ok && json.snapshot) onRefreshSnapshot(json.snapshot);
  };

  const handleDeleteLocal = async (id: string) => {
    const res = await fetch(`/api/gguf/local/${id}`, { method: 'DELETE' });
    const json = await res.json();
    if (res.ok && json.snapshot) onRefreshSnapshot(json.snapshot);
  };

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-6">
      <div>
        <h1 className="text-lg font-semibold text-slate-900" style={{ textWrap: 'balance' }}>
          Центр загрузки GGUF и оценка совместимости ПК
        </h1>
        <p className="text-xs text-slate-600 mt-0.5">
          Поиск и загрузка квантованных моделей из Hugging Face, Ollama Registry, ModelScope или по прямой ссылке с проверкой памяти под текущий контекст ({ctxSize} токенов).
        </p>
      </div>

      <HardwareSummaryBanner
        hardware={snapshot.hardware}
        onRefreshSnapshot={onRefreshSnapshot}
      />

      {actionError && (
        <div className="p-3.5 rounded-md bg-rose-50 border border-rose-200 text-xs text-rose-700">
          {actionError}
        </div>
      )}

      {/* Multi-Source Model Explorer */}
      <section className="bg-white border border-slate-200 rounded-lg p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="inline-flex flex-wrap items-center gap-1 p-1 bg-slate-100 rounded-md">
            {SOURCE_TABS.map((tab) => {
              const active = source === tab.id;
              return (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => {
                    setSource(tab.id);
                    setResults([]);
                    setFiles([]);
                    setSelectedRepo(null);
                    setSearchError(null);
                    setFilesError(null);
                    const defaultQ =
                      tab.id === 'huggingface'
                        ? 'Qwen2.5-3B-Instruct-GGUF'
                        : tab.id === 'ollama'
                        ? 'qwen2.5'
                        : tab.id === 'modelscope'
                        ? 'Qwen/Qwen2.5-3B-Instruct-GGUF'
                        : '';
                    setQuery(defaultQ);
                    if (tab.id !== 'url') {
                      void runSearch(tab.id, defaultQ);
                    }
                  }}
                  className={`px-3 py-1.5 rounded text-xs font-medium whitespace-nowrap transition-colors cursor-pointer ${
                    active
                      ? 'bg-white text-blue-600 shadow-xs font-semibold'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  {tab.label}
                </button>
              );
            })}
          </div>

          <div className="text-[11px] font-mono text-slate-500">
            Папка моделей: {snapshot.hardware.modelsDir || '~/.vllm-gateway/models'}
          </div>
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            void runSearch();
          }}
          className="flex flex-col sm:flex-row gap-2.5"
        >
          <div className="relative flex-1">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={activeTab.placeholder}
              className="w-full bg-white border border-slate-300 rounded-md pl-9 pr-3 py-2 text-xs text-slate-900 focus:outline-none focus:border-blue-600"
            />
          </div>
          <button
            type="submit"
            disabled={searching}
            className="inline-flex items-center justify-center gap-1.5 px-4 py-2 rounded-md text-xs font-semibold bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 whitespace-nowrap cursor-pointer"
          >
            <Search className="w-3.5 h-3.5" />
            <span>
              {searching
                ? 'Запрос...'
                : source === 'url'
                ? 'Проверить URL и ПК'
                : 'Найти модели'}
            </span>
          </button>
        </form>

        {searchError && (
          <div className="p-3 rounded-md bg-rose-50 border border-rose-200 text-xs text-rose-700">
            {searchError}
          </div>
        )}

        {source !== 'url' && (
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 pt-1">
            {/* Repository List */}
            <div className="lg:col-span-5 border border-slate-200 rounded-md divide-y divide-slate-100 max-h-[380px] overflow-y-auto">
              {results.length === 0 && !searching ? (
                <div className="p-6 text-center text-xs text-slate-500">
                  Ничего не найдено. Попробуйте другой запрос или введите точный ID репозитория.
                </div>
              ) : (
                results.map((item) => {
                  const isSelected = selectedRepo === item.id;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => void handleSelectRepo(item.id)}
                      className={`w-full text-left p-3.5 transition-colors cursor-pointer ${
                        isSelected ? 'bg-blue-50/70' : 'hover:bg-slate-50'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-xs font-mono font-semibold text-slate-900 truncate">
                          {item.id}
                        </span>
                        {typeof item.downloads === 'number' && (
                          <span className="text-[11px] font-mono text-slate-500 shrink-0">
                            {item.downloads.toLocaleString('ru-RU')} закр.
                          </span>
                        )}
                      </div>
                      <div className="text-[11px] text-slate-500 mt-1 truncate">
                        {item.author} · {item.description}
                      </div>
                    </button>
                  );
                })
              )}
            </div>

            {/* Quantization Files & Compatibility Check */}
            <div className="lg:col-span-7 border border-slate-200 rounded-md overflow-hidden flex flex-col">
              <div className="px-4 py-2.5 bg-slate-50 border-b border-slate-200 flex items-center justify-between gap-2">
                <span className="text-xs font-semibold text-slate-900 truncate">
                  {selectedRepo
                    ? `Файлы GGUF: ${selectedRepo}`
                    : 'Выберите репозиторий слева для проверки квантований'}
                </span>
                {selectedRepo && source === 'huggingface' && (
                  <a
                    href={`https://huggingface.co/${selectedRepo}`}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 text-[11px] text-blue-600 hover:underline shrink-0"
                  >
                    <span>Страница HF</span>
                    <ExternalLink className="w-3 h-3" />
                  </a>
                )}
              </div>

              {filesError && (
                <div className="p-4 text-xs text-rose-700 bg-rose-50 border-b border-rose-200">
                  {filesError}
                </div>
              )}

              <div className="divide-y divide-slate-100 max-h-[340px] overflow-y-auto">
                {loadingFiles ? (
                  <div className="p-6 text-center text-xs text-slate-500 font-mono">
                    Загрузка списка GGUF и расчёт совместимости...
                  </div>
                ) : files.length === 0 ? (
                  <div className="p-6 text-center text-xs text-slate-500">
                    {selectedRepo
                      ? 'В этом репозитории не найдено файлов с расширением .gguf.'
                      : 'Нажмите на любой репозиторий в списке, чтобы увидеть размеры файлов и статус запуска на вашем ПК.'}
                  </div>
                ) : (
                  files.map((file) => (
                    <div
                      key={file.downloadUrl}
                      className="p-3.5 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
                    >
                      <div className="space-y-1 min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2 text-xs">
                          <span className="font-mono font-semibold text-slate-900 truncate">
                            {file.fileName}
                          </span>
                          <span className="text-slate-400">·</span>
                          <span className="font-mono text-slate-600">
                            {file.quantization}
                          </span>
                          <span className="text-slate-400">·</span>
                          <span className="font-mono font-medium text-slate-900">
                            {formatBytes(file.sizeBytes)}
                          </span>
                        </div>
                        <CompatibilityBadge assessment={file.compatibility} />
                      </div>

                      <button
                        type="button"
                        onClick={() => void handleStartDownload(file)}
                        className="inline-flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold bg-blue-600 text-white hover:bg-blue-700 whitespace-nowrap shrink-0 cursor-pointer"
                      >
                        <Download className="w-3.5 h-3.5" />
                        <span>Скачать</span>
                      </button>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        )}

        {source === 'url' && files.length > 0 && (
          <div className="border border-slate-200 rounded-md divide-y divide-slate-100">
            {files.map((file) => (
              <div
                key={file.downloadUrl}
                className="p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
              >
                <div className="space-y-1 min-w-0">
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <span className="font-mono font-semibold text-slate-900">
                      {file.fileName}
                    </span>
                    <span className="text-slate-400">·</span>
                    <span className="font-mono text-slate-600">{file.quantization}</span>
                    <span className="text-slate-400">·</span>
                    <span className="font-mono font-medium text-slate-900">
                      {formatBytes(file.sizeBytes)}
                    </span>
                  </div>
                  <CompatibilityBadge assessment={file.compatibility} />
                </div>
                <button
                  type="button"
                  onClick={() => void handleStartDownload(file)}
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-md text-xs font-semibold bg-blue-600 text-white hover:bg-blue-700 whitespace-nowrap shrink-0 cursor-pointer"
                >
                  <Download className="w-3.5 h-3.5" />
                  <span>Скачать GGUF</span>
                </button>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Active Downloads Queue */}
      {snapshot.downloads.length > 0 && (
        <section className="bg-white border border-slate-200 rounded-lg overflow-hidden">
          <div className="px-5 py-3.5 border-b border-slate-200">
            <h2 className="text-sm font-semibold text-slate-900">
              Очередь и прогресс загрузок ({snapshot.downloads.length})
            </h2>
          </div>
          <div className="divide-y divide-slate-100">
            {snapshot.downloads.map((job) => {
              const pct =
                job.totalBytes > 0
                  ? Math.min(100, Math.round((job.bytesDownloaded / job.totalBytes) * 100))
                  : 0;
              return (
                <div key={job.id} className="p-4 space-y-2">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-xs font-mono font-semibold text-slate-900 truncate">
                        {job.fileName}
                      </div>
                      <div className="text-[11px] font-mono text-slate-500">
                        {job.source} · {job.repoId} · {formatBytes(job.bytesDownloaded)} /{' '}
                        {job.totalBytes > 0 ? formatBytes(job.totalBytes) : '—'}
                        {job.status === 'downloading' &&
                          ` · ${(job.speedBytesPerSec / (1024 * 1024)).toFixed(2)} МБ/с · ETA: ${formatEta(
                            job.etaSeconds
                          )}`}
                      </div>
                    </div>

                    <div className="flex items-center gap-2 shrink-0">
                      {job.status === 'downloading' && (
                        <button
                          type="button"
                          onClick={() => void handleDownloadAction(job.id, 'pause')}
                          className="inline-flex items-center gap-1 px-2.5 py-1 rounded text-xs bg-white border border-slate-300 text-slate-700 hover:bg-slate-50 cursor-pointer"
                        >
                          <Pause className="w-3 h-3" />
                          <span>Пауза</span>
                        </button>
                      )}
                      {(job.status === 'paused' || job.status === 'error') && (
                        <button
                          type="button"
                          onClick={() => void handleDownloadAction(job.id, 'resume')}
                          className="inline-flex items-center gap-1 px-2.5 py-1 rounded text-xs bg-blue-600 text-white hover:bg-blue-700 cursor-pointer"
                        >
                          <Play className="w-3 h-3" />
                          <span>Докачать</span>
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => void handleDownloadAction(job.id, 'cancel')}
                        className="p-1.5 rounded text-slate-400 hover:text-rose-600 cursor-pointer"
                        aria-label="Удалить загрузку"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    </div>
                  </div>

                  <div className="h-1.5 w-full bg-slate-100 rounded-full overflow-hidden">
                    <div
                      className={`h-full transition-all duration-150 ${
                        job.status === 'error'
                          ? 'bg-rose-500'
                          : job.status === 'completed'
                          ? 'bg-emerald-600'
                          : 'bg-blue-600'
                      }`}
                      style={{ width: `${job.status === 'completed' ? 100 : pct}%` }}
                    />
                  </div>
                  {job.errorMessage && (
                    <div className="text-xs text-rose-600">{job.errorMessage}</div>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* Downloaded Local GGUF Models */}
      <section className="bg-white border border-slate-200 rounded-lg overflow-hidden">
        <div className="px-5 py-3.5 border-b border-slate-200 flex items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-slate-900">
              Локальные GGUF-модели на диске ({snapshot.localModels.length})
            </h2>
            <p className="text-xs text-slate-500">
              Вы можете запустить любую скачанную модель на CPU или GPU через общий OpenAI API.
            </p>
          </div>
          <div className="inline-flex items-center gap-1.5 text-[11px] font-mono text-slate-500">
            <FolderOpen className="w-3.5 h-3.5" />
            <span>{snapshot.hardware.modelsDir || '~/.vllm-gateway/models'}</span>
          </div>
        </div>

        {snapshot.localModels.length === 0 ? (
          <div className="p-8 text-center text-xs text-slate-500">
            Локальных GGUF-файлов пока нет. Выберите модель выше и нажмите «Скачать», либо поместите файл <span className="font-mono">.gguf</span> в папку моделей.
          </div>
        ) : (
          <div className="divide-y divide-slate-100">
            {snapshot.localModels.map((model) => (
              <div
                key={model.id}
                className="p-4 flex flex-col lg:flex-row lg:items-center justify-between gap-4"
              >
                <div className="space-y-1 min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <span className="font-mono font-semibold text-slate-900">
                      {model.fileName}
                    </span>
                    <span className="text-slate-400">·</span>
                    <span className="font-mono text-slate-600">{model.quantization}</span>
                    <span className="text-slate-400">·</span>
                    <span className="font-mono font-medium text-slate-900">
                      {formatBytes(model.sizeBytes)}
                    </span>
                    <span className="text-slate-400">·</span>
                    <span className="font-mono text-slate-500">{model.source}</span>
                  </div>
                  <CompatibilityBadge assessment={model.compatibility} />
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  <button
                    type="button"
                    onClick={() => onLaunchLocalModel(model)}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold bg-emerald-600 text-white hover:bg-emerald-700 whitespace-nowrap cursor-pointer"
                  >
                    <Play className="w-3 h-3 fill-current" />
                    <span>Запустить в движке</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleDeleteLocal(model.id)}
                    className="p-1.5 rounded text-slate-400 hover:text-rose-600 cursor-pointer"
                    title="Удалить файл с диска"
                    aria-label="Удалить локальный GGUF-файл"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
};
