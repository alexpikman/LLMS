export type BaseModelId =
  | 'gemini-4-hydrogen'
  | 'gemini-3.1-flash-lite'
  | 'gemini-embedding-2'
  | 'local-gguf';

export type DeploymentProvider = 'cloud_gemini' | 'local_gguf';
export type ModelCapability = 'text' | 'embedding';
export type GgufDeviceMode = 'auto' | 'gpu' | 'cpu';

export interface BaseModelCatalogItem {
  id: BaseModelId;
  displayName: string;
  capability: ModelCapability;
  description: string;
  supportsThinking: boolean;
  provider: DeploymentProvider;
}

export const BASE_MODEL_CATALOG: Record<BaseModelId, BaseModelCatalogItem> = {
  'gemini-4-hydrogen': {
    id: 'gemini-4-hydrogen',
    displayName: 'Gemini 4 Hydrogen',
    capability: 'text',
    description: 'Универсальная облачная языковая модель с настройкой глубины рассуждений.',
    supportsThinking: true,
    provider: 'cloud_gemini',
  },
  'gemini-3.1-flash-lite': {
    id: 'gemini-3.1-flash-lite',
    displayName: 'Gemini 3.1 Flash Lite',
    capability: 'text',
    description: 'Облегчённая сверхбыстрая облачная модель для задач с минимальной задержкой первого токена.',
    supportsThinking: false,
    provider: 'cloud_gemini',
  },
  'gemini-embedding-2': {
    id: 'gemini-embedding-2',
    displayName: 'Gemini Embedding 2',
    capability: 'embedding',
    description: 'Модель генерации векторных представлений текста для эндпоинта /v1/embeddings.',
    supportsThinking: false,
    provider: 'cloud_gemini',
  },
  'local-gguf': {
    id: 'local-gguf',
    displayName: 'Локальная GGUF (CPU / GPU)',
    capability: 'text',
    description: 'Локальный инференс квантованных GGUF-моделей через llama.cpp на CPU и/или GPU.',
    supportsThinking: false,
    provider: 'local_gguf',
  },
} as const;

export type ThinkingLevelOption = 'LOW' | 'MEDIUM' | 'HIGH';
export type DeploymentStatus = 'running' | 'stopped' | 'starting' | 'error';

export interface GpuDeviceInfo {
  index: number;
  name: string;
  vendor: 'nvidia' | 'apple' | 'amd' | 'unknown';
  vramTotalBytes: number;
  vramFreeBytes: number;
  driverVersion: string | null;
}

export interface LlamaArchiveInfo {
  fileName: string;
  filePath: string;
  sizeBytes: number;
  location: 'vendor' | 'data';
}

export interface HardwareProfile {
  hostname: string;
  osPlatform: string;
  osRelease: string;
  arch: string;
  cpuModel: string;
  cpuCores: number;
  cpuThreads: number;
  totalRamBytes: number;
  freeRamBytes: number;
  unifiedMemory: boolean;
  gpus: GpuDeviceInfo[];
  totalVramBytes: number;
  freeVramBytes: number;
  diskFreeBytes: number;
  diskTotalBytes: number;
  modelsDir: string;
  binDir: string;
  archivesDir: string;
  vendorArchivesDir: string;
  llamaServerPath: string | null;
  llamaServerAvailable: boolean;
  llamaServerVersion: string | null;
  localArchives: LlamaArchiveInfo[];
  detectedAtMs: number;
}

export type CompatibilityVerdict = 'gpu_full' | 'gpu_partial' | 'cpu_only' | 'insufficient';

export interface CompatibilityAssessment {
  verdict: CompatibilityVerdict;
  label: string;
  summary: string;
  modelSizeBytes: number;
  estimatedKvCacheBytes: number;
  runtimeOverheadBytes: number;
  requiredMemoryBytes: number;
  availableVramBytes: number;
  availableRamBytes: number;
  totalEstimatedLayers: number;
  recommendedGpuLayers: number;
  fitsInVram: boolean;
  fitsInRam: boolean;
  fitsOnDisk: boolean;
}

export type HubSource = 'huggingface' | 'ollama' | 'modelscope' | 'url';

export interface HubSearchResult {
  id: string;
  source: HubSource;
  name: string;
  author: string;
  description: string;
  downloads?: number;
  likes?: number;
  tags?: string[];
  updatedAt?: string;
}

export interface HubGgufFile {
  fileName: string;
  path: string;
  sizeBytes: number | null;
  quantization: string;
  downloadUrl: string;
  sha256?: string;
  compatibility?: CompatibilityAssessment | null;
}

export type DownloadStatus =
  | 'queued'
  | 'downloading'
  | 'paused'
  | 'completed'
  | 'error'
  | 'cancelled';

export interface ModelDownloadJob {
  id: string;
  source: HubSource;
  repoId: string;
  fileName: string;
  downloadUrl: string;
  targetPath: string;
  quantization: string;
  status: DownloadStatus;
  bytesDownloaded: number;
  totalBytes: number;
  speedBytesPerSec: number;
  etaSeconds: number | null;
  createdAtMs: number;
  updatedAtMs: number;
  errorMessage: string | null;
}

export interface LocalGgufModel {
  id: string;
  fileName: string;
  filePath: string;
  sizeBytes: number;
  quantization: string;
  source: HubSource | 'local';
  repoId: string;
  modifiedAtMs: number;
  compatibility: CompatibilityAssessment;
}

export interface ModelDeployment {
  id: string;
  alias: string;
  baseModel: BaseModelId;
  provider: DeploymentProvider;
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
  ggufPath?: string;
  ggufFileName?: string;
  ggufSizeBytes?: number;
  deviceMode?: GgufDeviceMode;
  gpuLayers?: number;
  cpuThreads?: number;
  ctxSize?: number;
  localPort?: number | null;
  pid?: number | null;
  compatibility?: CompatibilityAssessment | null;
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

export interface LlamaSlotInfo {
  deploymentAlias: string;
  slotId: number;
  isProcessing: boolean;
  nCtx: number;
}

export interface PagedAttentionSnapshot {
  telemetryMode: 'logical_model' | 'hybrid_llama_slots';
  llamaSlots: LlamaSlotInfo[];
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

export interface AuthStatusSnapshot {
  authEnabled: boolean;
  setupRequired: boolean;
  authenticated: boolean;
  managedByEnv: boolean;
  tokenPrefix: string | null;
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
  hardware: HardwareProfile;
  localModels: LocalGgufModel[];
  downloads: ModelDownloadJob[];
}

export type ShellPreference = 'auto' | 'powershell' | 'bash';

export interface AgentPermissionsConfig {
  enabled: boolean;
  workspaceRoot: string;
  restrictToWorkspace: boolean;
  allowReadFiles: boolean;
  allowCreateFiles: boolean;
  allowEditFiles: boolean;
  allowDeleteFiles: boolean;
  allowShell: boolean;
  shellPreference: ShellPreference;
  shellTimeoutMs: number;
  maxFileSizeKb: number;
  maxToolIterations: number;
  blockedCommandPatterns: string[];
}

export interface DetectedShellEnvironment {
  platform: string;
  defaultWorkspaceRoot: string;
  powershellAvailable: boolean;
  powershellBinary: string | null;
  bashAvailable: boolean;
}

export interface ToolAuditEntry {
  id: string;
  timestampMs: number;
  modelAlias: string;
  toolName: string;
  argsSummary: string;
  allowed: boolean;
  status: 'completed' | 'blocked' | 'error';
  durationMs: number;
  resultPreview: string;
  error?: string;
}

export interface AgentToolStep {
  id: string;
  toolName: string;
  args: Record<string, unknown>;
  status: 'running' | 'completed' | 'blocked' | 'error';
  durationMs?: number;
  output?: string;
  error?: string;
}
