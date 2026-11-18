export type BaseModelId =
  | 'gemini-4-hydrogen'
  | 'gemini-3.1-flash-lite'
  | 'gemini-embedding-2';

export type ModelCapability = 'text' | 'embedding';

export interface BaseModelCatalogItem {
  id: BaseModelId;
  displayName: string;
  capability: ModelCapability;
  description: string;
  supportsThinking: boolean;
}

export const BASE_MODEL_CATALOG: Record<BaseModelId, BaseModelCatalogItem> = {
  'gemini-4-hydrogen': {
    id: 'gemini-4-hydrogen',
    displayName: 'Gemini 4 Hydrogen',
    capability: 'text',
    description: 'Универсальная высокопроизводительная языковая модель с настройкой глубины рассуждений.',
    supportsThinking: true,
  },
  'gemini-3.1-flash-lite': {
    id: 'gemini-3.1-flash-lite',
    displayName: 'Gemini 3.1 Flash Lite',
    capability: 'text',
    description: 'Облегчённая сверхбыстрая модель для задач с минимальной задержкой первого токена.',
    supportsThinking: false,
  },
  'gemini-embedding-2': {
    id: 'gemini-embedding-2',
    displayName: 'Gemini Embedding 2',
    capability: 'embedding',
    description: 'Модель генерации векторных представлений текста для эндпоинта /v1/embeddings.',
    supportsThinking: false,
  },
} as const;

export type ThinkingLevelOption = 'LOW' | 'MEDIUM' | 'HIGH';
export type DeploymentStatus = 'running' | 'stopped' | 'starting' | 'error';

export interface ModelDeployment {
  id: string;
  alias: string;
  baseModel: BaseModelId;
  capability: ModelCapability;
  status: DeploymentStatus;
  thinkingLevel: ThinkingLevelOption;
  systemInstruction: string;
  maxConcurrentRequests: number;
  enableResponseCache: boolean;
  activeRequests: number;
  queuedRequests: number;
  totalServed: number;
  totalErrors: number;
  startedAtMs: number | null;
  lastError: string | null;
}

export type RequestStatus = 'queued' | 'running' | 'completed' | 'error';

export type PagedBlockState = 'free' | 'prefill' | 'decode' | 'prefix_cached';

export interface PagedBlock {
  id: number;
  state: PagedBlockState;
  refCount: number;
  blockSize: number;
  tokensFilled: number;
  prefixHash: string | null;
  ownerRequestIds: string[];
  lastAccessedAtMs: number;
}

export interface PagedBlockEntry {
  logicalIndex: number;
  physicalBlockId: number;
  tokensUsed: number;
  isSharedPrefix: boolean;
}

export interface PagedAttentionSnapshot {
  blockSize: 16 | 32;
  totalBlocks: number;
  usableBlocks: number;
  kvMemoryUtilization: number;
  maxNumSeqs: number;
  maxModelLen: number;
  enablePrefixCaching: boolean;
  usedBlocks: number;
  freeBlocks: number;
  prefixCachedBlocks: number;
  totalAllocatedSlots: number;
  usedSlots: number;
  fragmentedSlots: number;
  internalFragmentationPct: number;
  naiveReservedSlots: number;
  naiveFragmentationPct: number;
  blocks: PagedBlock[];
}

export interface RequestRecord {
  id: string;
  deploymentId: string;
  modelAlias: string;
  baseModel: BaseModelId;
  endpoint: '/v1/chat/completions' | '/v1/completions' | '/v1/embeddings';
  stream: boolean;
  status: RequestStatus;
  cacheHit: boolean;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  ttftMs: number | null;
  tpotMs: number | null;
  durationMs: number | null;
  tokensPerSec: number | null;
  createdAtMs: number;
  finishedAtMs: number | null;
  promptPreview: string;
  blockTable: PagedBlockEntry[];
  concurrencyAtRun: number;
  kvLoadPct: number;
  errorMessage?: string;
}

export interface ServerSnapshot {
  serverStartedAtMs: number;
  apiKeyConfigured: boolean;
  deployments: ModelDeployment[];
  requests: RequestRecord[];
  activeRequestsCount: number;
  queuedRequestsCount: number;
  completedRequestsCount: number;
  errorRequestsCount: number;
  cacheEntriesCount: number;
  cacheMemoryBytes: number;
  cacheHitsTotal: number;
  avgTtftMs: number | null;
  avgTpotMs: number | null;
  avgThroughputTokPerSec: number | null;
  pagedAttention: PagedAttentionSnapshot;
}
