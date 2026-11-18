import React, { useEffect, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  FolderCheck,
  FolderOpen,
  RefreshCw,
  RotateCcw,
  Save,
  ShieldAlert,
  ShieldCheck,
  Terminal,
  Trash2,
} from 'lucide-react';
import type {
  AgentPermissionsConfig,
  DetectedShellEnvironment,
  ShellPreference,
  ToolAuditEntry,
} from '../types/engine';

export const AccessSettingsView: React.FC = () => {
  const [config, setConfig] = useState<AgentPermissionsConfig | null>(null);
  const [envInfo, setEnvInfo] = useState<DetectedShellEnvironment | null>(null);
  const [logs, setLogs] = useState<ToolAuditEntry[]>([]);
  const [blockedText, setBlockedText] = useState('');

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testingPath, setTestingPath] = useState(false);
  const [pathCheck, setPathCheck] = useState<{
    resolvedPath: string;
    exists: boolean;
    isDirectory: boolean;
    readable: boolean;
    writable: boolean;
  } | null>(null);

  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const loadAll = async () => {
    setLoading(true);
    setErrorMessage(null);
    try {
      const [cfgRes, logsRes] = await Promise.all([
        fetch('/api/access/config'),
        fetch('/api/access/logs'),
      ]);
      const cfgJson = await cfgRes.json();
      const logsJson = await logsRes.json();
      if (!cfgRes.ok) throw new Error(cfgJson.error || 'Не удалось загрузить права доступа');
      setConfig(cfgJson.config);
      setEnvInfo(cfgJson.environment);
      setBlockedText((cfgJson.config.blockedCommandPatterns ?? []).join('\n'));
      setLogs(Array.isArray(logsJson.logs) ? logsJson.logs : []);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Ошибка загрузки настроек доступа');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadAll();
  }, []);

  const refreshLogs = async () => {
    try {
      const res = await fetch('/api/access/logs');
      const json = await res.json();
      if (res.ok && Array.isArray(json.logs)) {
        setLogs(json.logs);
      }
    } catch {
      // ignore log refresh failure
    }
  };

  const handleSave = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!config) return;
    setSaving(true);
    setStatusMessage(null);
    setErrorMessage(null);

    try {
      const patterns = blockedText
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean);

      const res = await fetch('/api/access/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...config,
          blockedCommandPatterns: patterns,
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        throw new Error(json.error || 'Не удалось сохранить настройки доступа');
      }
      setConfig(json.config);
      setEnvInfo(json.environment);
      setBlockedText((json.config.blockedCommandPatterns ?? []).join('\n'));
      setStatusMessage('Настройки доступа моделей к файлам и PowerShell сохранены.');
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Ошибка сохранения');
    } finally {
      setSaving(false);
    }
  };

  const handleReset = async () => {
    setSaving(true);
    setStatusMessage(null);
    setErrorMessage(null);
    try {
      const res = await fetch('/api/access/reset', { method: 'POST' });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Не удалось сбросить настройки');
      setConfig(json.config);
      setEnvInfo(json.environment);
      setBlockedText((json.config.blockedCommandPatterns ?? []).join('\n'));
      setPathCheck(null);
      setStatusMessage('Политика доступа восстановлена к значениям по умолчанию.');
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Ошибка сброса');
    } finally {
      setSaving(false);
    }
  };

  const handleTestPath = async () => {
    if (!config) return;
    setTestingPath(true);
    setErrorMessage(null);
    try {
      const res = await fetch('/api/access/test-path', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: config.workspaceRoot }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Ошибка проверки пути');
      setPathCheck(json);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Ошибка проверки директории');
    } finally {
      setTestingPath(false);
    }
  };

  const handleClearLogs = async () => {
    try {
      const res = await fetch('/api/access/logs', { method: 'DELETE' });
      if (res.ok) {
        setLogs([]);
      }
    } catch {
      // ignore
    }
  };

  if (loading || !config) {
    return (
      <div className="p-6 max-w-5xl mx-auto">
        <div className="bg-white border border-slate-200 rounded-lg p-6 text-xs font-mono text-slate-500">
          Загрузка политики доступа к файловой системе и PowerShell...
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold text-slate-900" style={{ textWrap: 'balance' }}>
            Доступ моделей к файлам и PowerShell
          </h1>
          <p className="text-xs text-slate-600 mt-1">
            Управляйте тем, какие операции чтения, создания, редактирования и удаления файлов, а также команды терминала доступны моделям в чате.
          </p>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            disabled={saving}
            onClick={() => void handleReset()}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-md text-xs font-medium bg-white border border-slate-300 text-slate-700 hover:bg-slate-50 disabled:opacity-50 whitespace-nowrap cursor-pointer"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            <span>Сбросить</span>
          </button>
          <button
            type="button"
            disabled={saving}
            onClick={() => void handleSave()}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-md text-xs font-semibold bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 whitespace-nowrap cursor-pointer"
          >
            <Save className="w-3.5 h-3.5" />
            <span>{saving ? 'Сохранение...' : 'Сохранить права'}</span>
          </button>
        </div>
      </div>

      {statusMessage && (
        <div
          role="status"
          className="p-3 rounded-lg bg-emerald-50 border border-emerald-200 text-xs text-emerald-800 flex items-center gap-2"
        >
          <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
          <span>{statusMessage}</span>
        </div>
      )}

      {errorMessage && (
        <div
          role="alert"
          className="p-3 rounded-lg bg-rose-50 border border-rose-200 text-xs text-rose-700 flex items-center gap-2"
        >
          <AlertTriangle className="w-4 h-4 text-rose-600 shrink-0" />
          <span>{errorMessage}</span>
        </div>
      )}

      {/* Master Switch & Environment Summary */}
      <form onSubmit={handleSave} className="space-y-6">
        <section className="bg-white border border-slate-200 rounded-lg p-5">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="space-y-1">
              <div className="flex items-center gap-2 text-sm font-semibold text-slate-900">
                {config.enabled ? (
                  <ShieldCheck className="w-4 h-4 text-emerald-600" />
                ) : (
                  <ShieldAlert className="w-4 h-4 text-slate-400" />
                )}
                <span>Инструменты агента для моделей (ФС + PowerShell)</span>
              </div>
              <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
                <span>ОС сервера: {envInfo?.platform ?? 'unknown'}</span>
                <span aria-hidden="true">·</span>
                <span>
                  PowerShell:{' '}
                  {envInfo?.powershellAvailable
                    ? `доступен (${envInfo.powershellBinary})`
                    : 'не установлен (будет использован bash)'}
                </span>
                <span aria-hidden="true">·</span>
                <span>Политика: {config.enabled ? 'активна' : 'отключена'}</span>
              </div>
            </div>

            <label className="inline-flex items-center gap-2.5 px-3.5 py-2 rounded-md border border-slate-200 bg-slate-50 text-xs font-semibold text-slate-800 cursor-pointer shrink-0">
              <input
                type="checkbox"
                checked={config.enabled}
                onChange={(e) => setConfig({ ...config, enabled: e.target.checked })}
                className="w-4 h-4 accent-blue-600 rounded cursor-pointer"
              />
              <span>{config.enabled ? 'Доступ разрешён' : 'Доступ отключён'}</span>
            </label>
          </div>
        </section>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 items-start">
          {/* Filesystem Access Card */}
          <section className="bg-white border border-slate-200 rounded-lg p-5 space-y-5">
            <div className="flex items-center gap-2 border-b border-slate-100 pb-3">
              <FolderOpen className="w-4 h-4 text-blue-600" />
              <h2 className="text-sm font-semibold text-slate-900">Файловая система</h2>
            </div>

            <div className="space-y-2">
              <label
                htmlFor="access-workspace-root"
                className="block text-xs font-medium text-slate-700"
              >
                Рабочая директория (Workspace Root)
              </label>
              <div className="flex items-center gap-2">
                <input
                  id="access-workspace-root"
                  type="text"
                  value={config.workspaceRoot}
                  onChange={(e) => {
                    setConfig({ ...config, workspaceRoot: e.target.value });
                    setPathCheck(null);
                  }}
                  placeholder={envInfo?.defaultWorkspaceRoot ?? ''}
                  className="flex-1 bg-white border border-slate-300 rounded-md px-3 py-2 text-xs font-mono text-slate-900 focus:outline-none focus:border-blue-600"
                />
                <button
                  type="button"
                  disabled={testingPath}
                  onClick={() => void handleTestPath()}
                  className="inline-flex items-center gap-1.5 px-3 py-2 rounded-md text-xs font-medium bg-slate-50 border border-slate-300 text-slate-700 hover:bg-slate-100 whitespace-nowrap cursor-pointer"
                >
                  <FolderCheck className="w-3.5 h-3.5" />
                  <span>{testingPath ? 'Проверка...' : 'Проверить'}</span>
                </button>
              </div>
              {pathCheck && (
                <div
                  className={`text-[11px] font-mono ${
                    pathCheck.exists && pathCheck.isDirectory
                      ? 'text-emerald-700'
                      : 'text-rose-700'
                  }`}
                >
                  {pathCheck.exists && pathCheck.isDirectory
                    ? `Папка найдена · Чтение: ${pathCheck.readable ? 'да' : 'нет'} · Запись: ${
                        pathCheck.writable ? 'да' : 'нет'
                      }`
                    : `Путь не найден или не является директорией: ${pathCheck.resolvedPath}`}
                </div>
              )}
            </div>

            <label className="flex items-start gap-2.5 p-3 rounded-md border border-slate-200 bg-slate-50 cursor-pointer">
              <input
                type="checkbox"
                checked={config.restrictToWorkspace}
                onChange={(e) => setConfig({ ...config, restrictToWorkspace: e.target.checked })}
                className="mt-0.5 w-4 h-4 accent-blue-600 rounded cursor-pointer"
              />
              <div>
                <div className="text-xs font-semibold text-slate-900">
                  Изолировать операции в рабочей папке
                </div>
                <div className="text-[11px] text-slate-600 mt-0.5">
                  Блокировать выход за пределы Workspace Root (../ или абсолютные пути к системным папкам).
                </div>
              </div>
            </label>

            <div className="space-y-3 pt-1">
              <div className="text-xs font-semibold text-slate-900">Разрешённые операции</div>

              <label className="flex items-center justify-between gap-3 text-xs text-slate-700 cursor-pointer">
                <span>Чтение файлов и просмотр структуры (list_files, read_file)</span>
                <input
                  type="checkbox"
                  checked={config.allowReadFiles}
                  onChange={(e) => setConfig({ ...config, allowReadFiles: e.target.checked })}
                  className="w-4 h-4 accent-blue-600 rounded cursor-pointer"
                />
              </label>

              <label className="flex items-center justify-between gap-3 text-xs text-slate-700 cursor-pointer">
                <span>Создание новых файлов и директорий (create_file)</span>
                <input
                  type="checkbox"
                  checked={config.allowCreateFiles}
                  onChange={(e) => setConfig({ ...config, allowCreateFiles: e.target.checked })}
                  className="w-4 h-4 accent-blue-600 rounded cursor-pointer"
                />
              </label>

              <label className="flex items-center justify-between gap-3 text-xs text-slate-700 cursor-pointer">
                <span>Редактирование, замена текста и перезапись (edit_file)</span>
                <input
                  type="checkbox"
                  checked={config.allowEditFiles}
                  onChange={(e) => setConfig({ ...config, allowEditFiles: e.target.checked })}
                  className="w-4 h-4 accent-blue-600 rounded cursor-pointer"
                />
              </label>

              <label className="flex items-center justify-between gap-3 text-xs text-slate-700 cursor-pointer">
                <span className="text-rose-700 font-medium">
                  Удаление файлов (delete_file)
                </span>
                <input
                  type="checkbox"
                  checked={config.allowDeleteFiles}
                  onChange={(e) => setConfig({ ...config, allowDeleteFiles: e.target.checked })}
                  className="w-4 h-4 accent-rose-600 rounded cursor-pointer"
                />
              </label>
            </div>

            <div className="pt-2 border-t border-slate-100">
              <label
                htmlFor="access-max-file-kb"
                className="block text-xs font-medium text-slate-700 mb-1"
              >
                Максимальный размер читаемого/записываемого файла (КБ)
              </label>
              <input
                id="access-max-file-kb"
                type="number"
                min={32}
                max={8192}
                value={config.maxFileSizeKb}
                onChange={(e) =>
                  setConfig({ ...config, maxFileSizeKb: Number(e.target.value) || 512 })
                }
                className="w-40 bg-white border border-slate-300 rounded-md px-3 py-1.5 text-xs font-mono text-slate-900"
              />
            </div>
          </section>

          {/* PowerShell / Shell Access Card */}
          <section className="bg-white border border-slate-200 rounded-lg p-5 space-y-5">
            <div className="flex items-center gap-2 border-b border-slate-100 pb-3">
              <Terminal className="w-4 h-4 text-blue-600" />
              <h2 className="text-sm font-semibold text-slate-900">PowerShell и терминал</h2>
            </div>

            <label className="flex items-start gap-2.5 p-3 rounded-md border border-slate-200 bg-slate-50 cursor-pointer">
              <input
                type="checkbox"
                checked={config.allowShell}
                onChange={(e) => setConfig({ ...config, allowShell: e.target.checked })}
                className="mt-0.5 w-4 h-4 accent-blue-600 rounded cursor-pointer"
              />
              <div>
                <div className="text-xs font-semibold text-slate-900">
                  Разрешить моделям запускать PowerShell (run_powershell)
                </div>
                <div className="text-[11px] text-slate-600 mt-0.5">
                  Модель сможет выполнять команды сборки, тесты, скрипты и системные утилиты с возвратом stdout/stderr.
                </div>
              </div>
            </label>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label
                  htmlFor="access-shell-pref"
                  className="block text-xs font-medium text-slate-700 mb-1"
                >
                  Оболочка выполнения
                </label>
                <select
                  id="access-shell-pref"
                  value={config.shellPreference}
                  onChange={(e) =>
                    setConfig({
                      ...config,
                      shellPreference: e.target.value as ShellPreference,
                    })
                  }
                  className="w-full bg-white border border-slate-300 rounded-md px-3 py-2 text-xs font-mono text-slate-900"
                >
                  <option value="auto">Auto (PowerShell, затем bash)</option>
                  <option value="powershell">PowerShell (pwsh / powershell.exe)</option>
                  <option value="bash">Bash (Linux / macOS)</option>
                </select>
              </div>

              <div>
                <label
                  htmlFor="access-timeout-ms"
                  className="block text-xs font-medium text-slate-700 mb-1"
                >
                  Таймаут команды (мс)
                </label>
                <input
                  id="access-timeout-ms"
                  type="number"
                  min={3000}
                  max={120000}
                  step={1000}
                  value={config.shellTimeoutMs}
                  onChange={(e) =>
                    setConfig({ ...config, shellTimeoutMs: Number(e.target.value) || 15000 })
                  }
                  className="w-full bg-white border border-slate-300 rounded-md px-3 py-2 text-xs font-mono text-slate-900"
                />
              </div>
            </div>

            <div>
              <label
                htmlFor="access-max-iters"
                className="block text-xs font-medium text-slate-700 mb-1"
              >
                Максимум шагов инструментов за один ответ (1–20)
              </label>
              <input
                id="access-max-iters"
                type="number"
                min={1}
                max={20}
                value={config.maxToolIterations}
                onChange={(e) =>
                  setConfig({ ...config, maxToolIterations: Number(e.target.value) || 8 })
                }
                className="w-40 bg-white border border-slate-300 rounded-md px-3 py-1.5 text-xs font-mono text-slate-900"
              />
            </div>

            <div>
              <label
                htmlFor="access-blocked-patterns"
                className="block text-xs font-medium text-slate-700 mb-1"
              >
                Стоп-шаблоны запрещённых команд (по одному на строку)
              </label>
              <textarea
                id="access-blocked-patterns"
                rows={4}
                value={blockedText}
                onChange={(e) => setBlockedText(e.target.value)}
                className="w-full bg-white border border-slate-300 rounded-md p-2.5 text-xs font-mono text-slate-900 focus:outline-none focus:border-blue-600"
              />
            </div>
          </section>
        </div>
      </form>

      {/* Real Audit Log Table */}
      <section className="bg-white border border-slate-200 rounded-lg p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 pb-3">
          <div>
            <h2 className="text-sm font-semibold text-slate-900">
              Журнал обращений моделей к ФС и PowerShell
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              Реальные вызовы инструментов за текущую сессию сервера ({logs.length} записей).
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void refreshLogs()}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium bg-white border border-slate-300 text-slate-700 hover:bg-slate-50 cursor-pointer"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              <span>Обновить</span>
            </button>
            {logs.length > 0 && (
              <button
                type="button"
                onClick={() => void handleClearLogs()}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium bg-white border border-slate-300 text-slate-700 hover:text-rose-600 cursor-pointer"
              >
                <Trash2 className="w-3.5 h-3.5" />
                <span>Очистить</span>
              </button>
            )}
          </div>
        </div>

        {logs.length === 0 ? (
          <div className="py-8 text-center text-xs text-slate-500">
            Модели ещё не вызывали файловые инструменты или PowerShell в этой сессии.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full text-xs text-left border-collapse">
              <thead className="border-b border-slate-200 text-slate-500">
                <tr>
                  <th className="py-2 pr-4 font-medium">Время</th>
                  <th className="py-2 pr-4 font-medium">Модель</th>
                  <th className="py-2 pr-4 font-medium">Инструмент</th>
                  <th className="py-2 pr-4 font-medium">Цель / Команда</th>
                  <th className="py-2 pr-4 font-medium">Статус</th>
                  <th className="py-2 text-right font-medium">Время (мс)</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {logs.map((entry) => (
                  <tr key={entry.id} className="hover:bg-slate-50/80">
                    <td className="py-2.5 pr-4 font-mono text-slate-500 whitespace-nowrap">
                      {new Date(entry.timestampMs).toLocaleTimeString('ru-RU')}
                    </td>
                    <td className="py-2.5 pr-4 font-mono text-slate-800 whitespace-nowrap">
                      {entry.modelAlias}
                    </td>
                    <td className="py-2.5 pr-4 font-mono font-medium text-slate-900 whitespace-nowrap">
                      {entry.toolName}
                    </td>
                    <td className="py-2.5 pr-4 font-mono text-slate-600 max-w-xs truncate" title={entry.argsSummary}>
                      {entry.argsSummary || '—'}
                    </td>
                    <td className="py-2.5 pr-4 whitespace-nowrap">
                      <span
                        className={`font-medium ${
                          entry.status === 'completed'
                            ? 'text-emerald-700'
                            : entry.status === 'blocked'
                            ? 'text-amber-700'
                            : 'text-rose-700'
                        }`}
                      >
                        {entry.status === 'completed'
                          ? 'Выполнено'
                          : entry.status === 'blocked'
                          ? 'Запрещено'
                          : 'Ошибка'}
                      </span>
                    </td>
                    <td className="py-2.5 text-right font-mono text-slate-600 whitespace-nowrap">
                      {entry.durationMs}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
};
