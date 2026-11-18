import { useEffect, useState, type FormEvent } from 'react';
import { GgufHubView } from './components/GgufHubView';
import { GpuContextController } from './components/GpuContextController';
import { ModelChatView } from './components/ModelChatView';
import { ModelsManagerView } from './components/ModelsManagerView';
import { OpenAiConsoleView } from './components/OpenAiConsoleView';
import { PagedAttentionGrid } from './components/PagedAttentionGrid';
import { RealBenchmarkView } from './components/RealBenchmarkView';
import { TelemetryStrip } from './components/TelemetryStrip';
import { TopBar, type WorkspaceViewId } from './components/TopBar';
import { ServerSettingsView } from './components/ServerSettingsView';
import type { LocalGgufModel, ServerSnapshot } from './types/engine';

export default function App() {
  const [snapshot, setSnapshot] = useState<ServerSnapshot | null>(null);
  const [activeView, setActiveView] = useState<WorkspaceViewId>('models');
  const [showLaunchForm, setShowLaunchForm] = useState<boolean>(false);
  const [preferredChatAlias, setPreferredChatAlias] = useState<string | null>(null);
  const [preselectedGguf, setPreselectedGguf] = useState<LocalGgufModel | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [authState, setAuthState] = useState<'checking' | 'setup' | 'login' | 'authenticated'>('checking');
  const [authToken, setAuthToken] = useState('');
  const [authError, setAuthError] = useState<string | null>(null);
  const [authBusy, setAuthBusy] = useState(false);
  const [issuedToken, setIssuedToken] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    fetch('/api/auth/status')
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((status: { authenticated: boolean; setupRequired: boolean }) => {
        if (!active) return;
        setAuthState(status.authenticated ? 'authenticated' : status.setupRequired ? 'setup' : 'login');
      })
      .catch((err) => {
        if (active) {
          setAuthError(err instanceof Error ? err.message : 'Не удалось проверить авторизацию');
          setAuthState('login');
        }
      });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (authState !== 'authenticated') return;
    let isMounted = true;

    fetch('/api/engine/state')
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((data: ServerSnapshot) => {
        if (isMounted) {
          setSnapshot(data);
          setLoadError(null);
        }
      })
      .catch((err) => {
        if (isMounted) {
          setLoadError(err instanceof Error ? err.message : 'Не удалось подключиться к серверу');
        }
      });

    const eventSource = new EventSource('/api/engine/stream');
    eventSource.onmessage = (evt) => {
      if (!isMounted) return;
      try {
        const next = JSON.parse(evt.data) as ServerSnapshot;
        setSnapshot(next);
      } catch {
        // Ignore malformed frame
      }
    };

    return () => {
      isMounted = false;
      eventSource.close();
    };
  }, [authState]);

  const submitAuth = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setAuthBusy(true);
    setAuthError(null);
    try {
      const setup = authState === 'setup';
      const response = await fetch(setup ? '/api/auth/setup' : '/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(setup ? {} : { token: authToken }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Ошибка авторизации');
      if (setup && typeof data.token === 'string') setIssuedToken(data.token);
      setAuthToken('');
      setAuthState('authenticated');
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : 'Ошибка авторизации');
    } finally {
      setAuthBusy(false);
    }
  };

  if (authState !== 'authenticated') {
    return (
      <div className="min-h-screen bg-slate-50 text-slate-900 dark:bg-slate-950 dark:text-slate-100 flex items-center justify-center p-6">
        <form onSubmit={submitAuth} className="w-full max-w-md space-y-5 rounded-xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-800 dark:bg-slate-900">
          <div>
            <h1 className="text-lg font-semibold">vLLM Gateway</h1>
            <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
              {authState === 'checking' ? 'Проверка доступа…' : authState === 'setup' ? 'Первичная настройка API-токена' : 'Вход в панель управления'}
            </p>
          </div>
          {authState === 'login' && (
            <label className="block space-y-2 text-sm">
              <span className="font-medium">API-токен</span>
              <input
                type="password"
                autoComplete="current-password"
                required
                minLength={16}
                value={authToken}
                onChange={(event) => setAuthToken(event.target.value)}
                className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-sm outline-none focus:border-blue-500 dark:border-slate-700 dark:bg-slate-950"
              />
            </label>
          )}
          {authError && <p role="alert" className="text-sm text-rose-600 dark:text-rose-400">{authError}</p>}
          <button
            type="submit"
            disabled={authBusy || authState === 'checking'}
            className="w-full rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {authBusy ? 'Проверка…' : authState === 'setup' ? 'Создать токен и продолжить' : 'Войти'}
          </button>
        </form>
      </div>
    );
  }

  if (!snapshot) {
    return (
      <div className="min-h-screen bg-[#F8FAFC] text-slate-900 flex items-center justify-center p-6">
        <div className="max-w-md w-full bg-white border border-slate-200 rounded-lg p-6 text-center space-y-2">
          <div className="text-sm font-semibold">Запуск vLLM Gateway</div>
          {loadError ? (
            <div className="text-xs text-rose-600">{loadError}</div>
          ) : (
            <div className="text-xs font-mono text-slate-500">
              Подключение к серверу моделей...
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col bg-[#F8FAFC] text-[#0F172A] dark:bg-slate-950 dark:text-slate-100">
      {issuedToken && (
        <div role="status" className="border-b border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-950 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-100">
          <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-3">
            <span className="font-semibold">Сохраните API-токен — он показывается только один раз:</span>
            <code className="break-all rounded bg-white/70 px-2 py-1 dark:bg-black/20">{issuedToken}</code>
            <button type="button" onClick={() => navigator.clipboard.writeText(issuedToken)} className="rounded border border-current px-2 py-1 text-xs font-semibold">Копировать</button>
            <button type="button" onClick={() => setIssuedToken(null)} className="ml-auto text-xs underline">Скрыть</button>
          </div>
        </div>
      )}
      <TopBar
        activeView={activeView}
        onSelectView={setActiveView}
        onOpenLaunchForm={() => {
          setActiveView('models');
          setShowLaunchForm(true);
        }}
      />

      <TelemetryStrip snapshot={snapshot} />

      <div className="flex-1 flex flex-col lg:flex-row min-h-0">
        <GpuContextController
          snapshot={snapshot}
          activeView={activeView}
          onRefreshSnapshot={setSnapshot}
          onGoToPagedGrid={() => setActiveView('paged_blocks')}
        />

        <main className="flex-1 min-w-0">
          {activeView === 'models' && (
            <ModelsManagerView
              snapshot={snapshot}
              showLaunchForm={showLaunchForm}
              preselectedGguf={preselectedGguf}
              onClearPreselectedGguf={() => setPreselectedGguf(null)}
              onCloseLaunchForm={() => setShowLaunchForm(false)}
              onOpenLaunchForm={() => setShowLaunchForm(true)}
              onGoToGgufHub={() => setActiveView('gguf_hub')}
              onRefreshSnapshot={setSnapshot}
              onUseModelInChat={(alias) => {
                setPreferredChatAlias(alias);
                setActiveView('chat');
              }}
            />
          )}

          {activeView === 'gguf_hub' && (
            <GgufHubView
              snapshot={snapshot}
              onRefreshSnapshot={setSnapshot}
              onLaunchLocalModel={(model) => {
                setPreselectedGguf(model);
                setShowLaunchForm(true);
                setActiveView('models');
              }}
            />
          )}

          {activeView === 'chat' && (
            <ModelChatView
              snapshot={snapshot}
              preferredModelAlias={preferredChatAlias}
              onGoToModels={() => setActiveView('models')}
            />
          )}

          {activeView === 'paged_blocks' && (
            <PagedAttentionGrid
              snapshot={snapshot}
              onRefreshSnapshot={setSnapshot}
              onGoToChat={() => setActiveView('chat')}
            />
          )}

          {activeView === 'openai_api' && (
            <OpenAiConsoleView
              snapshot={snapshot}
              onGoToModels={() => setActiveView('models')}
            />
          )}

          {activeView === 'settings' && <ServerSettingsView />}

          {activeView === 'benchmarks' && (
            <RealBenchmarkView
              snapshot={snapshot}
              onGoToModels={() => setActiveView('models')}
            />
          )}
        </main>
      </div>
    </div>
  );
}
