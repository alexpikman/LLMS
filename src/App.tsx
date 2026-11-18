import { useEffect, useState } from 'react';
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

  useEffect(() => {
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
          setLoadError(
            err instanceof Error ? err.message : 'Не удалось подключиться к серверу'
          );
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
  }, []);

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
    <div className="min-h-screen flex flex-col bg-[#F8FAFC] text-[#0F172A]">
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
