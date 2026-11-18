import React, { useState } from 'react';
import { Download, HardDrive, RefreshCw } from 'lucide-react';
import type { HardwareProfile, ServerSnapshot } from '../types/engine';
import { formatBytes } from './CompatibilityBadge';

interface HardwareSummaryBannerProps {
  hardware: HardwareProfile;
  onRefreshSnapshot: (snapshot: ServerSnapshot) => void;
}

export const HardwareSummaryBanner: React.FC<HardwareSummaryBannerProps> = ({
  hardware,
  onRefreshSnapshot,
}) => {
  const [refreshing, setRefreshing] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const handleRefresh = async () => {
    setRefreshing(true);
    setErrorMessage(null);
    try {
      const res = await fetch('/api/hardware?refresh=1');
      const json = await res.json();
      if (!res.ok) {
        setErrorMessage(json.error || 'Не удалось обновить аппаратный профиль');
      } else if (json.snapshot) {
        onRefreshSnapshot(json.snapshot);
      }
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Сетевая ошибка');
    } finally {
      setRefreshing(false);
    }
  };

  const handleInstallRuntime = async () => {
    setInstalling(true);
    setErrorMessage(null);
    setStatusMessage(null);
    try {
      const res = await fetch('/api/gguf/install-runtime', { method: 'POST' });
      const json = await res.json();
      if (!res.ok) {
        setErrorMessage(json.error || 'Не удалось установить llama-server');
      } else {
        setStatusMessage(`Установлен llama-server (${json.assetName})`);
        if (json.snapshot) onRefreshSnapshot(json.snapshot);
      }
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Ошибка установки');
    } finally {
      setInstalling(false);
    }
  };

  const primaryGpu = hardware.gpus[0];

  return (
    <section
      aria-label="Аппаратные ресурсы ПК"
      className="bg-white border border-slate-200 rounded-lg p-5 space-y-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 pb-3">
        <div>
          <h2 className="text-sm font-semibold text-slate-900">
            Реальные ресурсы вашего ПК ({hardware.osPlatform} · {hardware.arch})
          </h2>
          <p className="text-xs text-slate-500 mt-0.5">
            Совместимость моделей рассчитывается по свободной VRAM/RAM, объёму диска и текущему окну контекста.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {!hardware.llamaServerAvailable && (
            <button
              type="button"
              disabled={installing}
              onClick={handleInstallRuntime}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 cursor-pointer"
            >
              <Download className="w-3.5 h-3.5" />
              <span>{installing ? 'Установка llama-server...' : 'Установить llama-server'}</span>
            </button>
          )}
          <button
            type="button"
            disabled={refreshing}
            onClick={handleRefresh}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium bg-white border border-slate-300 text-slate-700 hover:bg-slate-50 disabled:opacity-50 cursor-pointer"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`} />
            <span>Обновить ПК</span>
          </button>
        </div>
      </div>

      {statusMessage && (
        <div className="p-3 rounded-md bg-emerald-50 border border-emerald-200 text-xs text-emerald-700">
          {statusMessage}
        </div>
      )}
      {errorMessage && (
        <div className="p-3 rounded-md bg-rose-50 border border-rose-200 text-xs text-rose-700">
          {errorMessage}
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="space-y-1">
          <div className="text-[11px] text-slate-500">Процессор (CPU)</div>
          <div className="text-xs font-semibold text-slate-900 truncate" title={hardware.cpuModel}>
            {hardware.cpuModel}
          </div>
          <div className="text-[11px] font-mono text-slate-600">
            Потоков: {hardware.cpuThreads} · Архитектура: {hardware.arch}
          </div>
        </div>

        <div className="space-y-1">
          <div className="text-[11px] text-slate-500">Оперативная память (RAM)</div>
          <div className="text-xs font-mono font-semibold text-slate-900">
            {formatBytes(hardware.freeRamBytes)} свободно
          </div>
          <div className="text-[11px] font-mono text-slate-600">
            Всего: {formatBytes(hardware.totalRamBytes)}
          </div>
        </div>

        <div className="space-y-1">
          <div className="text-[11px] text-slate-500">Видеокарта (GPU / VRAM)</div>
          {primaryGpu ? (
            <>
              <div className="text-xs font-semibold text-slate-900 truncate" title={primaryGpu.name}>
                {primaryGpu.name}
              </div>
              <div className="text-[11px] font-mono text-emerald-700">
                Свободно VRAM: {formatBytes(hardware.freeVramBytes)} / {formatBytes(hardware.totalVramBytes)}
              </div>
            </>
          ) : (
            <>
              <div className="text-xs font-medium text-slate-700">GPU не обнаружен</div>
              <div className="text-[11px] font-mono text-slate-500">
                Доступен инференс на CPU
              </div>
            </>
          )}
        </div>

        <div className="space-y-1">
          <div className="text-[11px] text-slate-500">Диск и рантайм GGUF</div>
          <div className="flex items-center gap-1.5 text-xs font-mono font-semibold text-slate-900">
            <HardDrive className="w-3.5 h-3.5 text-slate-400 shrink-0" />
            <span>
              {hardware.diskFreeBytes > 0
                ? `${formatBytes(hardware.diskFreeBytes)} свободно`
                : 'Путь настроен'}
            </span>
          </div>
          <div
            className={`text-[11px] font-mono truncate ${
              hardware.llamaServerAvailable ? 'text-emerald-700' : 'text-amber-700'
            }`}
            title={hardware.llamaServerPath ?? 'llama-server не найден'}
          >
            {hardware.llamaServerAvailable
              ? `llama-server: готов (${hardware.llamaServerVersion ?? 'ok'})`
              : 'llama-server: не установлен'}
          </div>
        </div>
      </div>
    </section>
  );
};
