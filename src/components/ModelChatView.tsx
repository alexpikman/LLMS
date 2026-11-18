import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowUp,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  Cpu,
  FileEdit,
  FilePlus,
  FileText,
  FolderOpen,
  MessageSquare,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  RotateCcw,
  Shield,
  SlidersHorizontal,
  Square,
  Terminal,
  Trash2,
  Wrench,
} from 'lucide-react';
import type {
  AgentPermissionsConfig,
  AgentToolStep,
  ServerSnapshot,
} from '../types/engine';
import { MarkdownRenderer } from './MarkdownRenderer';

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  modelAlias?: string;
  toolSteps?: AgentToolStep[];
  ttftMs?: number | null;
  totalMs?: number | null;
  promptTokens?: number;
  completionTokens?: number;
  tokensPerSec?: number | null;
  error?: string;
}

interface ChatSession {
  id: string;
  title: string;
  updatedAtMs: number;
  systemPrompt: string;
  messages: ChatMessage[];
}

interface ModelChatViewProps {
  snapshot: ServerSnapshot;
  preferredModelAlias: string | null;
  onGoToModels: () => void;
  onGoToAccess: () => void;
}

const STORAGE_KEY = 'vllm_chat_sessions_v1';

function createEmptySession(): ChatSession {
  return {
    id: `chat-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    title: 'Новый диалог',
    updatedAtMs: Date.now(),
    systemPrompt: '',
    messages: [],
  };
}

function loadInitialSessions(): ChatSession[] {
  if (typeof window === 'undefined') return [createEmptySession()];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [createEmptySession()];
    const parsed = JSON.parse(raw) as ChatSession[];
    if (Array.isArray(parsed) && parsed.length > 0) {
      return parsed.slice(0, 40);
    }
  } catch {
    // ignore storage errors
  }
  return [createEmptySession()];
}

function getToolMeta(toolName: string): {
  label: string;
  Icon: React.ComponentType<{ className?: string }>;
} {
  switch (toolName) {
    case 'list_files':
      return { label: 'Обзор файлов', Icon: FolderOpen };
    case 'read_file':
      return { label: 'Чтение файла', Icon: FileText };
    case 'create_file':
      return { label: 'Создание файла', Icon: FilePlus };
    case 'edit_file':
      return { label: 'Редактирование файла', Icon: FileEdit };
    case 'delete_file':
      return { label: 'Удаление файла', Icon: Trash2 };
    case 'run_powershell':
      return { label: 'PowerShell / Терминал', Icon: Terminal };
    default:
      return { label: toolName, Icon: Wrench };
  }
}

function formatStepTarget(args: Record<string, unknown>): string {
  if (typeof args.command === 'string') return args.command;
  if (typeof args.path === 'string') return args.path;
  return JSON.stringify(args);
}

const ToolStepCard: React.FC<{ step: AgentToolStep }> = ({ step }) => {
  const [expanded, setExpanded] = useState(false);
  const { label, Icon } = getToolMeta(step.toolName);
  const target = formatStepTarget(step.args);

  const statusText =
    step.status === 'running'
      ? 'Выполняется...'
      : step.status === 'completed'
      ? 'Выполнено'
      : step.status === 'blocked'
      ? 'Заблокировано'
      : 'Ошибка';

  const statusClass =
    step.status === 'running'
      ? 'text-blue-600'
      : step.status === 'completed'
      ? 'text-emerald-700'
      : step.status === 'blocked'
      ? 'text-amber-700'
      : 'text-rose-700';

  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50/90 overflow-hidden">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full px-3 py-2 flex items-center justify-between gap-3 text-left hover:bg-slate-100/70 transition-colors cursor-pointer"
      >
        <div className="flex items-center gap-2 min-w-0">
          {expanded ? (
            <ChevronDown className="w-3.5 h-3.5 text-slate-400 shrink-0" />
          ) : (
            <ChevronRight className="w-3.5 h-3.5 text-slate-400 shrink-0" />
          )}
          <Icon className="w-3.5 h-3.5 text-slate-600 shrink-0" />
          <span className="text-xs font-medium text-slate-800 whitespace-nowrap shrink-0">
            {label}
          </span>
          {target && (
            <code className="text-[11px] font-mono text-slate-600 truncate">
              {target}
            </code>
          )}
        </div>
        <div className="flex items-center gap-2 text-[11px] font-mono shrink-0">
          <span className={`font-sans font-medium ${statusClass}`}>{statusText}</span>
          {typeof step.durationMs === 'number' && (
            <>
              <span aria-hidden="true" className="text-slate-300">·</span>
              <span className="text-slate-500">{step.durationMs} мс</span>
            </>
          )}
        </div>
      </button>

      {expanded && (
        <div className="border-t border-slate-200 bg-white p-3 space-y-2">
          <div>
            <div className="text-[11px] font-medium text-slate-500 mb-1">Аргументы</div>
            <pre className="p-2 rounded bg-slate-50 border border-slate-200 text-[11px] font-mono text-slate-700 overflow-x-auto max-h-36">
              {JSON.stringify(step.args, null, 2)}
            </pre>
          </div>
          {(step.output || step.error) && (
            <div>
              <div className="text-[11px] font-medium text-slate-500 mb-1">Результат</div>
              <pre className="p-2 rounded bg-slate-900 text-slate-100 text-[11px] font-mono overflow-x-auto max-h-56 whitespace-pre-wrap">
                {step.output || step.error}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export const ModelChatView: React.FC<ModelChatViewProps> = ({
  snapshot,
  preferredModelAlias,
  onGoToModels,
  onGoToAccess,
}) => {
  const runningTextModels = snapshot.deployments.filter(
    (d) => d.status === 'running' && d.capability === 'text'
  );

  const [sessions, setSessions] = useState<ChatSession[]>(() => loadInitialSessions());
  const [activeSessionId, setActiveSessionId] = useState<string>(() => loadInitialSessions()[0].id);
  const [sidebarOpen, setSidebarOpen] = useState<boolean>(true);
  const [selectedAlias, setSelectedAlias] = useState<string>(
    preferredModelAlias ?? runningTextModels[0]?.alias ?? ''
  );
  const [showSystemInput, setShowSystemInput] = useState<boolean>(false);
  const [enableToolsInChat, setEnableToolsInChat] = useState<boolean>(true);
  const [accessConfig, setAccessConfig] = useState<AgentPermissionsConfig | null>(null);

  const [input, setInput] = useState<string>('');
  const [isStreaming, setIsStreaming] = useState<boolean>(false);
  const [copiedMsgId, setCopiedMsgId] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const scrollEndRef = useRef<HTMLDivElement | null>(null);

  const activeSession = useMemo(
    () => sessions.find((s) => s.id === activeSessionId) ?? sessions[0],
    [sessions, activeSessionId]
  );

  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(sessions.slice(0, 40)));
    } catch {
      // ignore quota errors
    }
  }, [sessions]);

  useEffect(() => {
    fetch('/api/access/config')
      .then((res) => (res.ok ? res.json() : null))
      .then((json) => {
        if (json?.config) setAccessConfig(json.config);
      })
      .catch(() => {
        // ignore
      });
  }, []);

  useEffect(() => {
    if (preferredModelAlias && runningTextModels.some((m) => m.alias === preferredModelAlias)) {
      setSelectedAlias(preferredModelAlias);
    } else if (!runningTextModels.some((m) => m.alias === selectedAlias)) {
      setSelectedAlias(runningTextModels[0]?.alias ?? '');
    }
  }, [preferredModelAlias, runningTextModels, selectedAlias]);

  useEffect(() => {
    scrollEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [activeSession?.messages.length, isStreaming]);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(180, Math.max(44, el.scrollHeight))}px`;
  }, [input]);

  const updateActiveSession = (updater: (session: ChatSession) => ChatSession) => {
    setSessions((prev) =>
      prev.map((s) => (s.id === activeSession.id ? updater(s) : s))
    );
  };

  const handleNewChat = () => {
    if (isStreaming) return;
    const fresh = createEmptySession();
    setSessions((prev) => [fresh, ...prev]);
    setActiveSessionId(fresh.id);
    setInput('');
  };

  const handleDeleteSession = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (isStreaming && id === activeSession.id) return;
    setSessions((prev) => {
      const remaining = prev.filter((s) => s.id !== id);
      if (remaining.length === 0) {
        const fresh = createEmptySession();
        setActiveSessionId(fresh.id);
        return [fresh];
      }
      if (id === activeSession.id) {
        setActiveSessionId(remaining[0].id);
      }
      return remaining;
    });
  };

  const handleCopyMessage = async (msgId: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedMsgId(msgId);
      window.setTimeout(() => setCopiedMsgId(null), 1500);
    } catch {
      // ignore
    }
  };

  const handleStop = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    setIsStreaming(false);
  };

  const sendPrompt = async (promptText: string, baseMessages?: ChatMessage[]) => {
    const trimmed = promptText.trim();
    if (!trimmed || isStreaming || !selectedAlias) return;

    const currentMsgs = baseMessages ?? activeSession.messages;
    const userMsg: ChatMessage = {
      id: `u-${Date.now()}`,
      role: 'user',
      content: trimmed,
    };
    const assistantId = `a-${Date.now() + 1}`;
    const assistantPlaceholder: ChatMessage = {
      id: assistantId,
      role: 'assistant',
      content: '',
      modelAlias: selectedAlias,
      toolSteps: [],
    };

    const nextHistory = [...currentMsgs, userMsg];
    const autoTitle =
      currentMsgs.length === 0
        ? trimmed.slice(0, 46) + (trimmed.length > 46 ? '…' : '')
        : activeSession.title;

    updateActiveSession((s) => ({
      ...s,
      title: autoTitle,
      updatedAtMs: Date.now(),
      messages: [...nextHistory, assistantPlaceholder],
    }));
    setInput('');
    setIsStreaming(true);

    const controller = new AbortController();
    abortRef.current = controller;

    const apiMessages = nextHistory.map((m) => ({ role: m.role, content: m.content }));
    let accumulatedText = '';
    let steps: AgentToolStep[] = [];

    const patchAssistant = (patch: Partial<ChatMessage>) => {
      updateActiveSession((s) => ({
        ...s,
        updatedAtMs: Date.now(),
        messages: s.messages.map((m) =>
          m.id === assistantId ? { ...m, ...patch } : m
        ),
      }));
    };

    try {
      const response = await fetch('/api/chat/agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          model: selectedAlias,
          messages: apiMessages,
          systemPrompt: activeSession.systemPrompt.trim() || undefined,
          enableTools: Boolean(enableToolsInChat && accessConfig?.enabled),
        }),
      });

      if (!response.ok || !response.body) {
        let errText = `HTTP ${response.status}`;
        try {
          const errJson = await response.json();
          errText = errJson.error?.message || errJson.error || errText;
        } catch {
          // keep status
        }
        patchAssistant({ error: errText });
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const rawLine of lines) {
          const line = rawLine.trim();
          if (!line.startsWith('data:')) continue;
          const dataStr = line.slice(5).trim();
          if (dataStr === '[DONE]') continue;

          try {
            const evt = JSON.parse(dataStr) as {
              type: string;
              delta?: string;
              step?: AgentToolStep;
              message?: string;
              ttftMs?: number;
              totalMs?: number;
              promptTokens?: number;
              completionTokens?: number;
              tokensPerSec?: number | null;
            };

            if (evt.type === 'text' && evt.delta) {
              accumulatedText += evt.delta;
              patchAssistant({ content: accumulatedText });
            } else if (evt.type === 'tool_start' && evt.step) {
              steps = [...steps, evt.step];
              patchAssistant({ toolSteps: steps });
            } else if (evt.type === 'tool_result' && evt.step) {
              const updatedStep = evt.step;
              steps = steps.map((st) => (st.id === updatedStep.id ? updatedStep : st));
              patchAssistant({ toolSteps: steps });
            } else if (evt.type === 'done') {
              patchAssistant({
                ttftMs: evt.ttftMs ?? null,
                totalMs: evt.totalMs ?? null,
                promptTokens: evt.promptTokens ?? 0,
                completionTokens: evt.completionTokens ?? 0,
                tokensPerSec: evt.tokensPerSec ?? null,
              });
            } else if (evt.type === 'error') {
              patchAssistant({ error: evt.message || 'Ошибка выполнения модели' });
            }
          } catch {
            // ignore partial JSON chunk
          }
        }
      }
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        patchAssistant({
          error: err instanceof Error ? err.message : 'Сетевая ошибка',
        });
      }
    } finally {
      abortRef.current = null;
      setIsStreaming(false);
    }
  };

  const handleSubmit = (e?: React.FormEvent) => {
    e?.preventDefault();
    void sendPrompt(input);
  };

  const handleRegenerateLast = () => {
    if (isStreaming) return;
    const msgs = activeSession.messages;
    const lastUserIdx = [...msgs].reverse().findIndex((m) => m.role === 'user');
    if (lastUserIdx === -1) return;
    const actualIdx = msgs.length - 1 - lastUserIdx;
    const promptToRetry = msgs[actualIdx].content;
    const prior = msgs.slice(0, actualIdx);
    void sendPrompt(promptToRetry, prior);
  };

  const activeToolsSummary = useMemo(() => {
    if (!accessConfig?.enabled || !enableToolsInChat) {
      return 'Только диалог (доступ к ФС/PowerShell отключён)';
    }
    const list: string[] = [];
    if (accessConfig.allowReadFiles) list.push('чтение');
    if (accessConfig.allowCreateFiles) list.push('создание');
    if (accessConfig.allowEditFiles) list.push('правка');
    if (accessConfig.allowDeleteFiles) list.push('удаление');
    const fsPart = list.length > 0 ? `Файлы: ${list.join('/')}` : 'Файлы: нет';
    const psPart = accessConfig.allowShell ? 'PowerShell: вкл' : 'PowerShell: выкл';
    return `${fsPart} · ${psPart}`;
  }, [accessConfig, enableToolsInChat]);

  const starterPrompts = useMemo(() => {
    if (accessConfig?.enabled && enableToolsInChat) {
      return [
        {
          title: 'Обзор рабочей папки',
          prompt: 'Посмотри структуру файлов в рабочей директории и кратко опиши проект.',
        },
        {
          title: 'Создать PowerShell-скрипт',
          prompt:
            'Создай файл system-check.ps1, который выводит текущую дату, имя хоста и список файлов в папке, а затем проверь его содержимое.',
        },
        {
          title: 'Написать и объяснить код',
          prompt:
            'Напиши функцию быстрой сортировки на TypeScript с тестами в памяти и оцени её алгоритмическую сложность.',
        },
        {
          title: 'Проверить системную среду',
          prompt:
            'Выполни команду через PowerShell/терминал, чтобы проверить текущую рабочую директорию и версию Node.js.',
        },
      ];
    }
    return [
      {
        title: 'Алгоритмы на TypeScript',
        prompt: 'Напиши функцию быстрой сортировки на TypeScript и оцени её сложность.',
      },
      {
        title: 'Архитектура PagedAttention',
        prompt: 'Объясни, как работает PagedAttention и почему он снижает фрагментацию памяти KV-кэша.',
      },
      {
        title: 'План нагрузочного теста',
        prompt: 'Составь практический план нагрузочного тестирования LLM-шлюза на 5 этапов.',
      },
      {
        title: 'SQL-оптимизация',
        prompt: 'Разбери 4 частые причины медленных SQL-запросов и способы их профилирования.',
      },
    ];
  }, [accessConfig?.enabled, enableToolsInChat]);

  if (runningTextModels.length === 0) {
    return (
      <div className="p-6 max-w-3xl mx-auto">
        <div className="bg-white border border-slate-200 rounded-xl p-8 text-center space-y-3">
          <h1 className="text-base font-semibold text-slate-900">
            Нет запущенных текстовых моделей
          </h1>
          <p className="text-xs text-slate-600">
            Чтобы начать диалог, запустите локальную GGUF или облачную текстовую модель в панели управления.
          </p>
          <button
            type="button"
            onClick={onGoToModels}
            className="px-4 py-2 rounded-md text-xs font-semibold bg-blue-600 text-white hover:bg-blue-700 cursor-pointer"
          >
            Перейти к запуску моделей
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-[calc(100vh-108px)] min-h-[560px] bg-white">
      {/* Left Chat History Sidebar */}
      {sidebarOpen && (
        <aside className="w-64 shrink-0 border-r border-slate-200 bg-[#F8FAFC] flex flex-col">
          <div className="p-3 border-b border-slate-200 flex items-center justify-between gap-2">
            <button
              type="button"
              disabled={isStreaming}
              onClick={handleNewChat}
              className="flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold bg-white border border-slate-300 text-slate-800 hover:bg-slate-50 disabled:opacity-50 whitespace-nowrap cursor-pointer"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>Новый чат</span>
            </button>
            <button
              type="button"
              onClick={() => setSidebarOpen(false)}
              title="Скрыть историю чатов"
              className="p-2 rounded-lg text-slate-500 hover:text-slate-800 hover:bg-slate-200/60 cursor-pointer"
            >
              <PanelLeftClose className="w-4 h-4" />
            </button>
          </div>

          <div className="flex-1 overflow-y-auto p-2 space-y-1">
            {sessions.map((s) => {
              const isActive = s.id === activeSession.id;
              return (
                <div
                  key={s.id}
                  onClick={() => {
                    if (!isStreaming) setActiveSessionId(s.id);
                  }}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if ((e.key === 'Enter' || e.key === ' ') && !isStreaming) {
                      setActiveSessionId(s.id);
                    }
                  }}
                  className={`group flex items-center justify-between gap-2 px-3 py-2.5 rounded-lg text-xs transition-colors cursor-pointer ${
                    isActive
                      ? 'bg-white border border-slate-200 text-slate-900 font-medium shadow-xs'
                      : 'text-slate-600 hover:bg-slate-200/50 hover:text-slate-900'
                  }`}
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <MessageSquare className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                    <span className="truncate">{s.title}</span>
                  </div>
                  <button
                    type="button"
                    onClick={(e) => handleDeleteSession(s.id, e)}
                    title="Удалить чат"
                    className="opacity-0 group-hover:opacity-100 p-1 rounded text-slate-400 hover:text-rose-600 transition-opacity cursor-pointer"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              );
            })}
          </div>

          <div className="p-3 border-t border-slate-200 space-y-1.5">
            <div className="text-[11px] font-medium text-slate-500">Доступ к ОС и файлам</div>
            <div className="text-[11px] text-slate-700 leading-snug">
              {activeToolsSummary}
            </div>
            <button
              type="button"
              onClick={onGoToAccess}
              className="w-full mt-1 inline-flex items-center justify-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium bg-white border border-slate-300 text-slate-700 hover:bg-slate-50 cursor-pointer"
            >
              <Shield className="w-3.5 h-3.5 text-blue-600" />
              <span>Настроить права доступа</span>
            </button>
          </div>
        </aside>
      )}

      {/* Main Chat Canvas */}
      <div className="flex-1 flex flex-col min-w-0 bg-white">
        {/* Top Minimal Toolbar */}
        <div className="px-5 py-2.5 border-b border-slate-200 flex flex-wrap items-center justify-between gap-3 bg-white">
          <div className="flex items-center gap-2.5 min-w-0">
            {!sidebarOpen && (
              <button
                type="button"
                onClick={() => setSidebarOpen(true)}
                title="Показать историю чатов"
                className="p-1.5 rounded-md text-slate-500 hover:text-slate-900 hover:bg-slate-100 cursor-pointer"
              >
                <PanelLeftOpen className="w-4 h-4" />
              </button>
            )}

            <select
              id="chat-model-select"
              aria-label="Активная модель"
              value={selectedAlias}
              onChange={(e) => setSelectedAlias(e.target.value)}
              className="bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-xs font-semibold text-slate-900 focus:outline-none focus:border-blue-600 max-w-xs truncate"
            >
              {runningTextModels.map((m) => (
                <option key={m.id} value={m.alias}>
                  {m.alias} ({m.provider === 'local_gguf' ? 'GGUF' : m.baseModel})
                </option>
              ))}
            </select>

            <span className="hidden md:inline text-xs text-slate-400" aria-hidden="true">
              ·
            </span>
            <span
              className="hidden md:inline text-xs text-slate-500 truncate max-w-sm"
              title={accessConfig?.workspaceRoot}
            >
              {activeToolsSummary}
            </span>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <label className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border border-slate-200 bg-slate-50 text-xs font-medium text-slate-700 cursor-pointer whitespace-nowrap">
              <input
                type="checkbox"
                checked={enableToolsInChat}
                disabled={!accessConfig?.enabled}
                onChange={(e) => setEnableToolsInChat(e.target.checked)}
                className="w-3.5 h-3.5 accent-blue-600 rounded cursor-pointer"
              />
              <span>Файлы и PowerShell</span>
            </label>

            <button
              type="button"
              onClick={onGoToAccess}
              className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md text-xs font-medium bg-white border border-slate-200 text-slate-700 hover:bg-slate-50 whitespace-nowrap cursor-pointer"
            >
              <Shield className="w-3.5 h-3.5 text-blue-600" />
              <span>Доступ</span>
            </button>

            <button
              type="button"
              onClick={() => setShowSystemInput((v) => !v)}
              className={`inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md text-xs font-medium border whitespace-nowrap cursor-pointer ${
                showSystemInput || activeSession.systemPrompt
                  ? 'bg-blue-50 border-blue-200 text-blue-700'
                  : 'bg-white border-slate-200 text-slate-700 hover:bg-slate-50'
              }`}
            >
              <SlidersHorizontal className="w-3.5 h-3.5" />
              <span>Инструкция</span>
            </button>

            {activeSession.messages.length > 0 && (
              <button
                type="button"
                disabled={isStreaming}
                onClick={() =>
                  updateActiveSession((s) => ({
                    ...s,
                    title: 'Новый диалог',
                    messages: [],
                  }))
                }
                title="Очистить сообщения текущего чата"
                className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md text-xs font-medium bg-white border border-slate-200 text-slate-600 hover:text-rose-600 disabled:opacity-50 whitespace-nowrap cursor-pointer"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        </div>

        {showSystemInput && (
          <div className="px-5 py-3 border-b border-slate-200 bg-slate-50">
            <div className="max-w-3xl mx-auto">
              <input
                type="text"
                value={activeSession.systemPrompt}
                onChange={(e) =>
                  updateActiveSession((s) => ({ ...s, systemPrompt: e.target.value }))
                }
                placeholder="Системная инструкция для этого диалога (например: Отвечай кратко, пиши код на PowerShell и TypeScript)..."
                className="w-full bg-white border border-slate-300 rounded-lg px-3.5 py-2 text-xs text-slate-900 focus:outline-none focus:border-blue-600"
              />
            </div>
          </div>
        )}

        {/* Messages Viewport */}
        <div className="flex-1 overflow-y-auto px-4 sm:px-6 py-6">
          <div className="max-w-3xl mx-auto space-y-6">
            {activeSession.messages.length === 0 ? (
              <div className="pt-10 pb-6 space-y-8">
                <div className="text-center space-y-2.5">
                  <div className="w-11 h-11 rounded-xl bg-slate-900 text-white flex items-center justify-center mx-auto">
                    <Cpu className="w-5 h-5" />
                  </div>
                  <h1 className="text-xl font-semibold text-slate-900" style={{ textWrap: 'balance' }}>
                    Чем помочь сегодня?
                  </h1>
                  <div className="flex flex-wrap items-center justify-center gap-2 text-xs text-slate-500">
                    <span>Модель: {selectedAlias}</span>
                    <span aria-hidden="true">·</span>
                    <span>
                      {accessConfig?.enabled && enableToolsInChat
                        ? `Рабочая папка: ${accessConfig.workspaceRoot}`
                        : 'Инструменты ОС отключены'}
                    </span>
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {starterPrompts.map((item) => (
                    <button
                      key={item.title}
                      type="button"
                      onClick={() => void sendPrompt(item.prompt)}
                      className="p-4 rounded-xl border border-slate-200 bg-slate-50/70 hover:bg-white hover:border-blue-400 text-left transition-colors cursor-pointer space-y-1"
                    >
                      <div className="text-xs font-semibold text-slate-900">{item.title}</div>
                      <div className="text-xs text-slate-600 line-clamp-2 leading-relaxed">
                        {item.prompt}
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              activeSession.messages.map((msg, idx) => {
                const isLastAssistant =
                  msg.role === 'assistant' && idx === activeSession.messages.length - 1;

                if (msg.role === 'user') {
                  return (
                    <div key={msg.id} className="flex justify-end">
                      <div className="max-w-[82%] rounded-2xl bg-slate-100 border border-slate-200 px-4 py-3 text-sm leading-relaxed text-slate-900 whitespace-pre-wrap">
                        {msg.content}
                      </div>
                    </div>
                  );
                }

                return (
                  <div key={msg.id} className="flex items-start gap-3.5">
                    <div className="w-7 h-7 rounded-lg bg-slate-900 text-white flex items-center justify-center shrink-0 mt-0.5">
                      <Cpu className="w-3.5 h-3.5" />
                    </div>

                    <div className="flex-1 min-w-0 space-y-3">
                      {msg.toolSteps && msg.toolSteps.length > 0 && (
                        <div className="space-y-2">
                          {msg.toolSteps.map((step) => (
                            <ToolStepCard key={step.id} step={step} />
                          ))}
                        </div>
                      )}

                      {msg.error ? (
                        <div className="p-3 rounded-lg bg-rose-50 border border-rose-200 text-xs text-rose-700">
                          {msg.error}
                        </div>
                      ) : msg.content ? (
                        <MarkdownRenderer content={msg.content} />
                      ) : isStreaming && isLastAssistant ? (
                        <div className="text-xs font-mono text-slate-400 py-1">
                          {msg.toolSteps && msg.toolSteps.some((s) => s.status === 'running')
                            ? 'Выполнение инструментов...'
                            : 'Генерация ответа...'}
                        </div>
                      ) : null}

                      {!msg.error && (msg.content || (msg.totalMs !== undefined && msg.totalMs !== null)) && (
                        <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
                          <div className="flex items-center gap-1.5">
                            {msg.content && (
                              <button
                                type="button"
                                onClick={() => void handleCopyMessage(msg.id, msg.content)}
                                className="inline-flex items-center gap-1 px-2 py-1 rounded text-[11px] text-slate-500 hover:text-slate-900 hover:bg-slate-100 cursor-pointer"
                              >
                                {copiedMsgId === msg.id ? (
                                  <>
                                    <Check className="w-3 h-3 text-emerald-600" />
                                    <span>Скопировано</span>
                                  </>
                                ) : (
                                  <>
                                    <Copy className="w-3 h-3" />
                                    <span>Копировать</span>
                                  </>
                                )}
                              </button>
                            )}
                            {isLastAssistant && !isStreaming && (
                              <button
                                type="button"
                                onClick={handleRegenerateLast}
                                className="inline-flex items-center gap-1 px-2 py-1 rounded text-[11px] text-slate-500 hover:text-slate-900 hover:bg-slate-100 cursor-pointer"
                              >
                                <RotateCcw className="w-3 h-3" />
                                <span>Повторить</span>
                              </button>
                            )}
                          </div>

                          {msg.totalMs !== undefined && msg.totalMs !== null && (
                            <div className="flex flex-wrap items-center gap-2 text-[11px] font-mono text-slate-400">
                              <span>{msg.modelAlias}</span>
                              <span aria-hidden="true">·</span>
                              <span>TTFT {msg.ttftMs} мс</span>
                              <span aria-hidden="true">·</span>
                              <span>Всего {msg.totalMs} мс</span>
                              <span aria-hidden="true">·</span>
                              <span>
                                {msg.promptTokens} → {msg.completionTokens} tok
                              </span>
                              {msg.tokensPerSec !== null && msg.tokensPerSec !== undefined && (
                                <>
                                  <span aria-hidden="true">·</span>
                                  <span>{msg.tokensPerSec} ток/с</span>
                                </>
                              )}
                              {msg.toolSteps && msg.toolSteps.length > 0 && (
                                <>
                                  <span aria-hidden="true">·</span>
                                  <span>{msg.toolSteps.length} инстр.</span>
                                </>
                              )}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })
            )}
            <div ref={scrollEndRef} />
          </div>
        </div>

        {/* Modern Floating Composer */}
        <div className="px-4 sm:px-6 pb-4 pt-2 bg-white">
          <form
            onSubmit={handleSubmit}
            className="max-w-3xl mx-auto rounded-2xl border border-slate-300 bg-white shadow-sm focus-within:border-blue-500 transition-colors p-3"
          >
            <textarea
              ref={textareaRef}
              rows={1}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  handleSubmit();
                }
              }}
              placeholder="Напишите сообщение или задачу для файлов / PowerShell..."
              className="w-full bg-transparent px-1.5 py-1 text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none resize-none max-h-44"
            />

            <div className="mt-2 flex items-center justify-between gap-3 pt-1.5 border-t border-slate-100">
              <div className="flex items-center gap-2 text-[11px] text-slate-500 min-w-0 truncate">
                <span>Enter — отправить · Shift+Enter — новая строка</span>
              </div>

              <div className="flex items-center gap-2 shrink-0">
                {isStreaming ? (
                  <button
                    type="button"
                    onClick={handleStop}
                    className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl text-xs font-semibold bg-slate-900 text-white hover:bg-slate-800 cursor-pointer"
                  >
                    <Square className="w-3 h-3 fill-current" />
                    <span>Остановить</span>
                  </button>
                ) : (
                  <button
                    type="submit"
                    disabled={!input.trim()}
                    aria-label="Отправить сообщение"
                    className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl text-xs font-semibold bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-40 cursor-pointer"
                  >
                    <ArrowUp className="w-3.5 h-3.5" />
                    <span>Отправить</span>
                  </button>
                )}
              </div>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
};
