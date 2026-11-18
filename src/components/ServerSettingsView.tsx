import React, { useEffect, useState } from 'react';
import { Globe, LoaderCircle, Save } from 'lucide-react';

export const ServerSettingsView: React.FC = () => {
  const [port, setPort] = useState('3003');
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [isRotatingToken, setIsRotatingToken] = useState(false);
  const [newToken, setNewToken] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    fetch('/api/server/config')
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Не удалось получить настройки сервера');
        if (active) setPort(String(data.port));
      })
      .catch((err: unknown) => {
        if (active) setError(err instanceof Error ? err.message : 'Ошибка загрузки настроек');
      })
      .finally(() => {
        if (active) setIsLoading(false);
      });

    return () => {
      active = false;
    };
  }, []);

  const handleRotateToken = async () => {
    if (!window.confirm('Старый API-токен перестанет работать. Продолжить?')) return;
    setIsRotatingToken(true);
    setError(null);
    setNewToken(null);
    try {
      const response = await fetch('/api/auth/rotate', { method: 'POST' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Не удалось перевыпустить токен');
      setNewToken(data.token);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка перевыпуска токена');
    } finally {
      setIsRotatingToken(false);
    }
  };

  const handleSave = async (event: React.FormEvent) => {
    event.preventDefault();
    const nextPort = Number(port);
    if (!Number.isInteger(nextPort) || nextPort < 1024 || nextPort > 65535) {
      setError('Укажите целый порт от 1024 до 65535.');
      return;
    }

    setIsSaving(true);
    setError(null);
    setMessage(null);
    try {
      const response = await fetch('/api/server/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ port: nextPort }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Не удалось изменить порт');

      if (data.unchanged || Number(window.location.port || 3003) === data.port) {
        setMessage('Этот порт уже используется.');
        return;
      }

      setMessage(`Порт изменён. Переключение на http://${window.location.hostname}:${data.port}…`);
      window.setTimeout(() => {
        window.location.assign(`${window.location.protocol}//${window.location.hostname}:${data.port}`);
      }, 700);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка изменения порта');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <section className="p-6 lg:p-8 text-slate-900 dark:text-slate-100">
      <div className="max-w-2xl space-y-6">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Настройки сервера</h1>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            Сетевые параметры локального HTTP-сервера и OpenAI-совместимого API.
          </p>
        </div>

        <form onSubmit={handleSave} className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-700 dark:bg-slate-900">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <Globe className="h-4 w-4 text-blue-600" />
            HTTP-порт
          </div>
          <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
            По умолчанию используется порт 3003. После изменения сервер переключится на новый адрес.
          </p>

          <label htmlFor="server-port" className="mt-5 block text-xs font-medium text-slate-700 dark:text-slate-300">
            Порт сервера
          </label>
          <input
            id="server-port"
            type="number"
            min={1024}
            max={65535}
            step={1}
            required
            value={port}
            disabled={isLoading || isSaving}
            onChange={(event) => setPort(event.target.value)}
            className="mt-2 w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-900 outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 disabled:opacity-60 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100"
          />

          <div className="mt-3 text-xs text-slate-500 dark:text-slate-400">
            Допустимый диапазон: 1024–65535. Настройка сохраняется между перезапусками.
          </div>

          {error && <p role="alert" className="mt-4 text-sm text-rose-600 dark:text-rose-400">{error}</p>}
          {message && <p role="status" className="mt-4 text-sm text-emerald-700 dark:text-emerald-400">{message}</p>}

          <button
            type="submit"
            disabled={isLoading || isSaving}
            className="mt-5 inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isSaving ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            {isSaving ? 'Применение…' : 'Сохранить и перезапустить'}
          </button>
        </form>

        <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-700 dark:bg-slate-900">
          <h2 className="text-sm font-semibold">API-токен</h2>
          <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
            Перевыпуск немедленно отзывает предыдущий токен. Если задан VLLM_API_KEY, управляйте им через переменные окружения.
          </p>
          {newToken && (
            <div className="mt-4 space-y-2">
              <p className="text-xs font-medium text-emerald-700 dark:text-emerald-400">Новый токен. Сохраните его — повторно он не отображается.</p>
              <code className="block break-all rounded-lg bg-slate-100 p-3 text-xs text-slate-900 dark:bg-slate-950 dark:text-slate-100">{newToken}</code>
              <button type="button" onClick={() => navigator.clipboard.writeText(newToken)} className="rounded-lg border border-slate-300 px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 dark:border-slate-600 dark:text-slate-200 dark:hover:bg-slate-800">
                Копировать токен
              </button>
            </div>
          )}
          <button
            type="button"
            onClick={handleRotateToken}
            disabled={isRotatingToken}
            className="mt-4 rounded-lg border border-rose-300 px-4 py-2.5 text-sm font-semibold text-rose-700 transition hover:bg-rose-50 disabled:opacity-50 dark:border-rose-900 dark:text-rose-300 dark:hover:bg-rose-950"
          >
            {isRotatingToken ? 'Перевыпуск…' : 'Перевыпустить токен'}
          </button>
        </div>
      </div>
    </section>
  );
};
