import React from 'react';
import { Plus, Settings } from 'lucide-react';

export type WorkspaceViewId =
  | 'models'
  | 'gguf_hub'
  | 'chat'
  | 'paged_blocks'
  | 'openai_api'
  | 'benchmarks'
  | 'settings';

interface TopBarProps {
  activeView: WorkspaceViewId;
  onSelectView: (view: WorkspaceViewId) => void;
  onOpenLaunchForm: () => void;
}

const NAV_ITEMS: Array<{ id: WorkspaceViewId; label: string }> = [
  { id: 'models', label: 'Модели и запуск' },
  { id: 'gguf_hub', label: 'Центр GGUF' },
  { id: 'chat', label: 'Чат с моделью' },
  { id: 'paged_blocks', label: 'Блоки PagedAttention' },
  { id: 'openai_api', label: 'OpenAI API' },
  { id: 'benchmarks', label: 'Бенчмарк' },
  { id: 'settings', label: 'Настройки' },
];

export const TopBar: React.FC<TopBarProps> = ({
  activeView,
  onSelectView,
  onOpenLaunchForm,
}) => {
  return (
    <header className="h-14 border-b border-slate-200 bg-white px-6 flex items-center justify-between gap-8 shrink-0">
      <button
        type="button"
        onClick={() => onSelectView('models')}
        className="text-lg font-bold tracking-tight text-slate-900 whitespace-nowrap shrink-0 hover:text-blue-600 transition-colors cursor-pointer"
      >
        vLLM Gateway
      </button>

      <nav className="flex items-center gap-6 overflow-x-auto" aria-label="Навигация">
        {NAV_ITEMS.map((item) => {
          const isActive = activeView === item.id;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => onSelectView(item.id)}
              className={`relative py-4 text-sm font-medium whitespace-nowrap shrink-0 transition-colors cursor-pointer ${
                isActive ? 'text-blue-600' : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              {item.id === 'settings' ? <Settings className="inline-block w-3.5 h-3.5 mr-1.5" /> : null}
              {item.label}
              {isActive && (
                <span
                  className="absolute bottom-0 left-0 right-0 h-[2px] bg-blue-600"
                  aria-hidden="true"
                />
              )}
            </button>
          );
        })}
      </nav>

      <div className="shrink-0">
        <button
          type="button"
          onClick={onOpenLaunchForm}
          className="inline-flex items-center gap-1.5 px-4 py-2 rounded-md text-xs font-semibold bg-blue-600 text-white hover:bg-blue-700 whitespace-nowrap shrink-0 transition-colors cursor-pointer"
        >
          <Plus className="w-3.5 h-3.5" />
          <span>Запустить модель</span>
        </button>
      </div>
    </header>
  );
};
