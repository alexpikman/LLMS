import crypto from 'node:crypto';
import {
  BASE_MODEL_CATALOG,
  type BaseModelId,
  type ModelDeployment,
  type PagedAttentionSnapshot,
  type PagedBlock,
  type RequestRecord,
  type ServerSnapshot,
  type ThinkingLevelOption,
} from '../src/types/engine.ts';
import { isGeminiApiKeyConfigured, probeModelReadiness } from './gemini.ts';

type Listener = (snapshot: ServerSnapshot) => void;

interface CachedResponseEntry {
  key: string;
  deploymentId: string;
  text: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  bytes: number;
  createdAtMs: number;
}

interface QueuedWaiter {
  resolve: () => void;
}

interface InternalSequenceMeta {
  prefixKey: string | null;
  prefixBlockCount: number;
  cacheEnabled: boolean;
}

function shortHash(input: string): string {
  return crypto.createHash('sha1').update(input).digest('hex').slice(0, 8);
}

export class ModelServerRuntime {
  private serverStartedAtMs = Date.now();
  private deployments = new Map<string, ModelDeployment>();
  private waitQueues = new Map<string, QueuedWaiter[]>();
  private requests: RequestRecord[] = [];
  private sequenceMeta = new Map<string, InternalSequenceMeta>();
  private responseCache = new Map<string, CachedResponseEntry>();
  private maxCacheEntries = 100;
  private cacheHitsTotal = 0;
  private listeners = new Set<Listener>();
  private reqCounter = 1;
  private depCounter = 4;

  // Real PagedAttention Physical Block Allocator & Scheduler state
  private pagedBlockSize: 16 | 32 = 16;
  private pagedTotalBlocks = 64;
  private kvMemoryUtilization = 1.0;
  private maxNumSeqs = 8;
  private maxModelLen = 2048;
  private enablePrefixCaching = true;
  private pagedBlocks: PagedBlock[] = [];
  private prefixBlockIndex = new Map<string, number>();
  private lastStreamBroadcastAt = 0;

  constructor() {
    this.seedInitialDeployments();
    this.initPagedPool();
  }

  private initPagedPool(): void {
    this.pagedBlocks = Array.from({ length: this.pagedTotalBlocks }, (_, id) => ({
      id,
      state: 'free',
      refCount: 0,
      blockSize: this.pagedBlockSize,
      tokensFilled: 0,
      prefixHash: null,
      ownerRequestIds: [],
      lastAccessedAtMs: 0,
    }));
    this.prefixBlockIndex.clear();
  }

  private seedInitialDeployments(): void {
    const now = Date.now();
    const initial: ModelDeployment[] = [
      {
        id: 'dep-hydrogen',
        alias: 'hydrogen-chat',
        baseModel: 'gemini-4-hydrogen',
        capability: 'text',
        status: 'running',
        thinkingLevel: 'LOW',
        systemInstruction: '',
        maxConcurrentRequests: 4,
        enableResponseCache: true,
        activeRequests: 0,
        queuedRequests: 0,
        totalServed: 0,
        totalErrors: 0,
        startedAtMs: now,
        lastError: null,
      },
      {
        id: 'dep-flash-lite',
        alias: 'flash-lite-fast',
        baseModel: 'gemini-3.1-flash-lite',
        capability: 'text',
        status: 'stopped',
        thinkingLevel: 'LOW',
        systemInstruction: '',
        maxConcurrentRequests: 8,
        enableResponseCache: true,
        activeRequests: 0,
        queuedRequests: 0,
        totalServed: 0,
        totalErrors: 0,
        startedAtMs: null,
        lastError: null,
      },
      {
        id: 'dep-embedding',
        alias: 'text-embedding-v2',
        baseModel: 'gemini-embedding-2',
        capability: 'embedding',
        status: 'stopped',
        thinkingLevel: 'LOW',
        systemInstruction: '',
        maxConcurrentRequests: 6,
        enableResponseCache: false,
        activeRequests: 0,
        queuedRequests: 0,
        totalServed: 0,
        totalErrors: 0,
        startedAtMs: null,
        lastError: null,
      },
    ];

    for (const dep of initial) {
      this.deployments.set(dep.id, dep);
      this.waitQueues.set(dep.id, []);
    }
  }

  private getUsableBlocksCount(): number {
    return Math.max(8, Math.floor(this.pagedTotalBlocks * this.kvMemoryUtilization));
  }

  public updatePagedConfig(patch: {
    blockSize?: 16 | 32;
    totalBlocks?: number;
    kvMemoryUtilization?: number;
    maxNumSeqs?: number;
    maxModelLen?: number;
    enablePrefixCaching?: boolean;
  }): ServerSnapshot {
    const nextBlockSize =
      patch.blockSize === 32 ? 32 : patch.blockSize === 16 ? 16 : this.pagedBlockSize;
    const nextTotal =
      typeof patch.totalBlocks === 'number'
        ? Math.min(128, Math.max(32, Math.round(patch.totalBlocks)))
        : this.pagedTotalBlocks;

    if (typeof patch.kvMemoryUtilization === 'number') {
      this.kvMemoryUtilization = Math.min(1, Math.max(0.25, Number(patch.kvMemoryUtilization.toFixed(2))));
    }
    if (typeof patch.maxNumSeqs === 'number') {
      this.maxNumSeqs = Math.min(16, Math.max(1, Math.round(patch.maxNumSeqs)));
      for (const dep of this.deployments.values()) {
        this.drainWaitQueue(dep);
      }
    }
    if (typeof patch.maxModelLen === 'number') {
      this.maxModelLen = Math.min(8192, Math.max(512, Math.round(patch.maxModelLen)));
    }
    if (typeof patch.enablePrefixCaching === 'boolean') {
      this.enablePrefixCaching = patch.enablePrefixCaching;
      for (const dep of this.deployments.values()) {
        if (dep.capability === 'text') {
          dep.enableResponseCache = patch.enablePrefixCaching;
        }
      }
      if (!patch.enablePrefixCaching) {
        this.clearUnownedPrefixBlocks();
      }
    }

    if (nextBlockSize !== this.pagedBlockSize || nextTotal !== this.pagedTotalBlocks) {
      this.pagedBlockSize = nextBlockSize;
      this.pagedTotalBlocks = nextTotal;
      this.initPagedPool();
      for (const req of this.requests) {
        if (req.status === 'running' || req.status === 'queued') {
          this.syncSequenceBlocks(
            req,
            Math.max(1, req.promptTokens + req.completionTokens),
            'prefill'
          );
        }
      }
    } else {
      // If usableBlocks shrank, evict unowned prefix blocks beyond the new ceiling
      const usable = this.getUsableBlocksCount();
      for (const block of this.pagedBlocks) {
        if (block.id >= usable && block.state === 'prefix_cached' && block.ownerRequestIds.length === 0) {
          this.evictPrefixBlock(block);
        }
      }
    }

    this.broadcast();
    return this.getSnapshot();
  }

  private evictPrefixBlock(block: PagedBlock): void {
    if (block.prefixHash) {
      for (const [k, bId] of this.prefixBlockIndex.entries()) {
        if (bId === block.id) {
          this.prefixBlockIndex.delete(k);
          break;
        }
      }
    }
    block.state = 'free';
    block.refCount = 0;
    block.tokensFilled = 0;
    block.prefixHash = null;
    block.ownerRequestIds = [];
  }

  private clearUnownedPrefixBlocks(): void {
    for (const block of this.pagedBlocks) {
      if (block.state === 'prefix_cached' && block.ownerRequestIds.length === 0) {
        this.evictPrefixBlock(block);
      }
    }
  }

  private findFreePagedBlock(): PagedBlock | null {
    const usable = this.getUsableBlocksCount();
    for (const block of this.pagedBlocks) {
      if (block.id >= usable) break;
      if (block.state === 'free' && block.refCount === 0) {
        return block;
      }
    }
    // Evict oldest unowned prefix_cached block via LRU within usable ceiling
    let lru: PagedBlock | null = null;
    for (const block of this.pagedBlocks) {
      if (block.id >= usable) break;
      if (block.state === 'prefix_cached' && block.ownerRequestIds.length === 0) {
        if (!lru || block.lastAccessedAtMs < lru.lastAccessedAtMs) {
          lru = block;
        }
      }
    }
    if (lru) {
      this.evictPrefixBlock(lru);
      return lru;
    }
    return null;
  }

  private syncSequenceBlocks(
    record: RequestRecord,
    totalTokens: number,
    phaseState: 'prefill' | 'decode'
  ): void {
    const meta = this.sequenceMeta.get(record.id);
    const blockSize = this.pagedBlockSize;
    const neededBlocks = Math.max(1, Math.ceil(totalTokens / blockSize));
    const now = Date.now();

    while (record.blockTable.length < neededBlocks) {
      const logicalIndex = record.blockTable.length;
      const remaining = totalTokens - logicalIndex * blockSize;
      const tokensUsed = Math.min(blockSize, Math.max(1, remaining));
      const isPrefix = Boolean(meta && meta.prefixKey && logicalIndex < meta.prefixBlockCount);
      const cacheKey = isPrefix && meta?.prefixKey ? `${meta.prefixKey}:${logicalIndex}` : null;

      let reused: PagedBlock | null = null;
      if (cacheKey && meta?.cacheEnabled) {
        const existingId = this.prefixBlockIndex.get(cacheKey);
        if (existingId !== undefined) {
          const candidate = this.pagedBlocks[existingId];
          if (candidate && candidate.prefixHash !== null) {
            candidate.refCount++;
            if (!candidate.ownerRequestIds.includes(record.id)) {
              candidate.ownerRequestIds.push(record.id);
            }
            candidate.state = 'prefix_cached';
            candidate.lastAccessedAtMs = now;
            reused = candidate;
          }
        }
      }

      if (reused) {
        record.blockTable.push({
          logicalIndex,
          physicalBlockId: reused.id,
          tokensUsed: reused.tokensFilled,
          isSharedPrefix: true,
        });
        continue;
      }

      const free = this.findFreePagedBlock();
      if (!free) break;

      free.state = isPrefix && meta?.cacheEnabled ? 'prefix_cached' : phaseState;
      free.refCount = 1;
      free.blockSize = blockSize;
      free.tokensFilled = tokensUsed;
      free.ownerRequestIds = [record.id];
      free.lastAccessedAtMs = now;

      if (cacheKey && meta?.cacheEnabled && tokensUsed === blockSize) {
        free.prefixHash = shortHash(cacheKey);
        this.prefixBlockIndex.set(cacheKey, free.id);
      } else {
        free.prefixHash = null;
      }

      record.blockTable.push({
        logicalIndex,
        physicalBlockId: free.id,
        tokensUsed,
        isSharedPrefix: Boolean(isPrefix && meta?.cacheEnabled),
      });
    }

    // Update fill count in active blocks
    for (let i = 0; i < record.blockTable.length; i++) {
      const entry = record.blockTable[i];
      const physical = this.pagedBlocks[entry.physicalBlockId];
      if (!physical) continue;
      const remaining = totalTokens - i * blockSize;
      const filled = Math.min(blockSize, Math.max(1, remaining));
      entry.tokensUsed = filled;
      if (!entry.isSharedPrefix) {
        physical.tokensFilled = filled;
        physical.state = phaseState;
      }
      physical.lastAccessedAtMs = now;
    }
  }

  private releaseSequencePagedBlocks(record: RequestRecord, retainPrefixCache: boolean): void {
    for (const entry of record.blockTable) {
      const block = this.pagedBlocks[entry.physicalBlockId];
      if (!block) continue;
      block.ownerRequestIds = block.ownerRequestIds.filter((id) => id !== record.id);
      if (retainPrefixCache && entry.isSharedPrefix && block.tokensFilled === block.blockSize) {
        block.state = 'prefix_cached';
        block.refCount = Math.max(1, block.ownerRequestIds.length);
      } else {
        block.refCount = Math.max(0, block.refCount - 1);
        if (block.refCount === 0 && block.ownerRequestIds.length === 0) {
          if (block.prefixHash) {
            for (const [k, bId] of this.prefixBlockIndex.entries()) {
              if (bId === block.id) {
                this.prefixBlockIndex.delete(k);
                break;
              }
            }
          }
          block.state = 'free';
          block.tokensFilled = 0;
          block.prefixHash = null;
        }
      }
    }
  }

  public getRunningDeployments(): ModelDeployment[] {
    return Array.from(this.deployments.values()).filter((d) => d.status === 'running');
  }

  public findDeploymentByModel(requestedModel?: string): ModelDeployment | undefined {
    const all = Array.from(this.deployments.values());
    if (!requestedModel) {
      return all.find((d) => d.status === 'running' && d.capability === 'text');
    }
    return (
      all.find((d) => d.alias === requestedModel) ??
      all.find((d) => d.baseModel === requestedModel && d.status === 'running') ??
      all.find((d) => d.baseModel === requestedModel)
    );
  }

  public async createAndLaunchDeployment(input: {
    alias: string;
    baseModel: BaseModelId;
    thinkingLevel?: ThinkingLevelOption;
    systemInstruction?: string;
    maxConcurrentRequests?: number;
    enableResponseCache?: boolean;
    verifyOnLaunch?: boolean;
  }): Promise<ModelDeployment> {
    const cleanAlias = input.alias.trim();
    if (!cleanAlias) {
      throw new Error('Укажите имя (alias) запускаемой модели.');
    }
    const existing = Array.from(this.deployments.values()).find((d) => d.alias === cleanAlias);
    if (existing) {
      throw new Error(`Модель с именем "${cleanAlias}" уже существует.`);
    }
    const catalogItem = BASE_MODEL_CATALOG[input.baseModel];
    if (!catalogItem) {
      throw new Error(`Неизвестная базовая модель: ${input.baseModel}`);
    }

    const id = `dep-${this.depCounter++}`;
    const deployment: ModelDeployment = {
      id,
      alias: cleanAlias,
      baseModel: input.baseModel,
      capability: catalogItem.capability,
      status: 'starting',
      thinkingLevel: input.thinkingLevel ?? 'LOW',
      systemInstruction: (input.systemInstruction ?? '').trim(),
      maxConcurrentRequests: Math.min(16, Math.max(1, input.maxConcurrentRequests ?? 4)),
      enableResponseCache: Boolean(input.enableResponseCache ?? true),
      activeRequests: 0,
      queuedRequests: 0,
      totalServed: 0,
      totalErrors: 0,
      startedAtMs: null,
      lastError: null,
    };

    this.deployments.set(id, deployment);
    this.waitQueues.set(id, []);
    this.broadcast();

    if (input.verifyOnLaunch !== false) {
      try {
        await probeModelReadiness(deployment.baseModel);
        deployment.status = 'running';
        deployment.startedAtMs = Date.now();
        deployment.lastError = null;
      } catch (err) {
        deployment.status = 'error';
        deployment.lastError = err instanceof Error ? err.message : String(err);
      }
    } else {
      deployment.status = 'running';
      deployment.startedAtMs = Date.now();
    }

    this.broadcast();
    return { ...deployment };
  }

  public async startDeployment(id: string, verify = true): Promise<ModelDeployment> {
    const dep = this.deployments.get(id);
    if (!dep) {
      throw new Error('Развёртывание модели не найдено.');
    }
    dep.status = 'starting';
    dep.lastError = null;
    this.broadcast();

    if (verify) {
      try {
        await probeModelReadiness(dep.baseModel);
        dep.status = 'running';
        dep.startedAtMs = Date.now();
        dep.lastError = null;
      } catch (err) {
        dep.status = 'error';
        dep.lastError = err instanceof Error ? err.message : String(err);
      }
    } else {
      dep.status = 'running';
      dep.startedAtMs = Date.now();
    }

    this.broadcast();
    return { ...dep };
  }

  public stopDeployment(id: string): ModelDeployment {
    const dep = this.deployments.get(id);
    if (!dep) {
      throw new Error('Развёртывание модели не найдено.');
    }
    dep.status = 'stopped';
    dep.startedAtMs = null;
    this.broadcast();
    return { ...dep };
  }

  public updateDeployment(
    id: string,
    patch: Partial<
      Pick<
        ModelDeployment,
        'thinkingLevel' | 'systemInstruction' | 'maxConcurrentRequests' | 'enableResponseCache'
      >
    >
  ): ModelDeployment {
    const dep = this.deployments.get(id);
    if (!dep) {
      throw new Error('Развёртывание модели не найдено.');
    }
    if (patch.thinkingLevel) dep.thinkingLevel = patch.thinkingLevel;
    if (typeof patch.systemInstruction === 'string') {
      dep.systemInstruction = patch.systemInstruction;
    }
    if (typeof patch.maxConcurrentRequests === 'number') {
      dep.maxConcurrentRequests = Math.min(16, Math.max(1, patch.maxConcurrentRequests));
      this.drainWaitQueue(dep);
    }
    if (typeof patch.enableResponseCache === 'boolean') {
      dep.enableResponseCache = patch.enableResponseCache;
    }
    this.broadcast();
    return { ...dep };
  }

  public deleteDeployment(id: string): void {
    const dep = this.deployments.get(id);
    if (!dep) return;
    if (dep.activeRequests > 0) {
      throw new Error('Нельзя удалить модель, пока выполняются активные запросы.');
    }
    this.deployments.delete(id);
    this.waitQueues.delete(id);
    this.broadcast();
  }

  public clearCache(): ServerSnapshot {
    this.responseCache.clear();
    // Free unowned prefix_cached blocks in PagedAttention pool
    for (const block of this.pagedBlocks) {
      if (block.state === 'prefix_cached' && block.ownerRequestIds.length === 0) {
        block.state = 'free';
        block.refCount = 0;
        block.tokensFilled = 0;
        block.prefixHash = null;
      }
    }
    this.prefixBlockIndex.clear();
    this.broadcast();
    return this.getSnapshot();
  }

  public clearLogs(): ServerSnapshot {
    this.requests = this.requests.filter((r) => r.status === 'running' || r.status === 'queued');
    this.broadcast();
    return this.getSnapshot();
  }

  public createRequestRecord(params: {
    deployment: ModelDeployment;
    endpoint: RequestRecord['endpoint'];
    stream: boolean;
    promptPreview: string;
    systemPrompt?: string;
    promptCharCount?: number;
  }): RequestRecord {
    const estimatedPromptTokens = Math.max(
      4,
      Math.ceil((params.promptCharCount ?? params.promptPreview.length) / 3.5)
    );
    const sysText = (params.systemPrompt ?? params.deployment.systemInstruction ?? '').trim();
    const prefixKey = sysText.length > 0 ? `sys-${shortHash(sysText)}` : null;
    const prefixBlockCount = prefixKey
      ? Math.max(1, Math.floor(Math.ceil(sysText.length / 3.5) / this.pagedBlockSize))
      : 0;

    const record: RequestRecord = {
      id: `req-${this.reqCounter++}`,
      deploymentId: params.deployment.id,
      modelAlias: params.deployment.alias,
      baseModel: params.deployment.baseModel,
      endpoint: params.endpoint,
      stream: params.stream,
      status: 'queued',
      cacheHit: false,
      promptTokens: estimatedPromptTokens,
      completionTokens: 0,
      totalTokens: estimatedPromptTokens,
      ttftMs: null,
      tpotMs: null,
      durationMs: null,
      tokensPerSec: null,
      createdAtMs: Date.now(),
      finishedAtMs: null,
      promptPreview: params.promptPreview.slice(0, 140),
      blockTable: [],
      concurrencyAtRun: 1,
      kvLoadPct: 0,
    };

    this.sequenceMeta.set(record.id, {
      prefixKey,
      prefixBlockCount,
      cacheEnabled: params.deployment.enableResponseCache,
    });
    this.syncSequenceBlocks(record, estimatedPromptTokens, 'prefill');

    this.requests.unshift(record);
    if (this.requests.length > 100) {
      const removed = this.requests.splice(100);
      for (const r of removed) {
        this.sequenceMeta.delete(r.id);
      }
    }
    this.broadcast();
    return record;
  }

  public appendStreamTokens(record: RequestRecord, chunkText: string): void {
    if (!chunkText) return;
    const added = Math.max(1, Math.ceil(chunkText.length / 3.5));
    record.completionTokens += added;
    record.totalTokens = record.promptTokens + record.completionTokens;
    this.syncSequenceBlocks(record, record.totalTokens, 'decode');

    const now = Date.now();
    if (now - this.lastStreamBroadcastAt >= 80) {
      this.lastStreamBroadcastAt = now;
      this.broadcast();
    }
  }

  private getEffectiveLimit(dep: ModelDeployment): number {
    return Math.min(dep.maxConcurrentRequests, this.maxNumSeqs);
  }

  public async acquireSlot(deploymentId: string, record: RequestRecord): Promise<void> {
    const dep = this.deployments.get(deploymentId);
    if (!dep) throw new Error('Модель не найдена');

    if (dep.activeRequests < this.getEffectiveLimit(dep)) {
      dep.activeRequests++;
      record.status = 'running';
      record.concurrencyAtRun = Math.max(
        record.concurrencyAtRun,
        this.getTotalActiveAndQueued()
      );
      this.broadcast();
      return;
    }

    dep.queuedRequests++;
    record.status = 'queued';
    record.concurrencyAtRun = Math.max(
      record.concurrencyAtRun,
      this.getTotalActiveAndQueued()
    );
    this.broadcast();

    await new Promise<void>((resolve) => {
      const queue = this.waitQueues.get(deploymentId) ?? [];
      queue.push({ resolve });
      this.waitQueues.set(deploymentId, queue);
    });

    dep.queuedRequests = Math.max(0, dep.queuedRequests - 1);
    dep.activeRequests++;
    record.status = 'running';
    record.concurrencyAtRun = Math.max(
      record.concurrencyAtRun,
      this.getTotalActiveAndQueued()
    );
    this.broadcast();
  }

  private getTotalActiveAndQueued(): number {
    let total = 0;
    for (const d of this.deployments.values()) {
      total += d.activeRequests + d.queuedRequests;
    }
    return Math.max(1, total);
  }

  private drainWaitQueue(dep: ModelDeployment): void {
    const queue = this.waitQueues.get(dep.id);
    if (!queue) return;
    while (dep.activeRequests < this.getEffectiveLimit(dep) && queue.length > 0) {
      const next = queue.shift();
      if (next) next.resolve();
    }
  }

  public releaseSlot(deploymentId: string): void {
    const dep = this.deployments.get(deploymentId);
    if (!dep) return;
    dep.activeRequests = Math.max(0, dep.activeRequests - 1);
    this.drainWaitQueue(dep);
    this.broadcast();
  }

  public computeCacheKey(deployment: ModelDeployment, payload: unknown): string {
    const serialized = JSON.stringify({
      alias: deployment.alias,
      baseModel: deployment.baseModel,
      thinkingLevel: deployment.thinkingLevel,
      systemInstruction: deployment.systemInstruction,
      payload,
    });
    return crypto.createHash('sha256').update(serialized).digest('hex');
  }

  public lookupCache(deployment: ModelDeployment, key: string): CachedResponseEntry | null {
    if (!deployment.enableResponseCache) return null;
    const hit = this.responseCache.get(key);
    if (!hit) return null;
    this.responseCache.delete(key);
    this.responseCache.set(key, hit);
    this.cacheHitsTotal++;
    return hit;
  }

  public storeCache(
    deployment: ModelDeployment,
    key: string,
    data: { text: string; promptTokens: number; completionTokens: number; totalTokens: number }
  ): void {
    if (!deployment.enableResponseCache || !data.text) return;
    if (this.responseCache.size >= this.maxCacheEntries) {
      const oldestKey = this.responseCache.keys().next().value;
      if (oldestKey) this.responseCache.delete(oldestKey);
    }
    const bytes = Buffer.byteLength(data.text, 'utf8');
    this.responseCache.set(key, {
      key,
      deploymentId: deployment.id,
      text: data.text,
      promptTokens: data.promptTokens,
      completionTokens: data.completionTokens,
      totalTokens: data.totalTokens,
      bytes,
      createdAtMs: Date.now(),
    });
    this.broadcast();
  }

  public markRequestCompleted(
    deploymentId: string,
    record: RequestRecord,
    metrics: {
      cacheHit: boolean;
      promptTokens: number;
      completionTokens: number;
      totalTokens: number;
      ttftMs: number;
      durationMs: number;
    }
  ): void {
    const dep = this.deployments.get(deploymentId);
    if (dep) {
      dep.totalServed++;
    }
    const safeDurationMs = Math.max(1, metrics.durationMs);
    const tpotMs =
      metrics.completionTokens > 1
        ? Number(
            (
              (safeDurationMs - Math.min(safeDurationMs, metrics.ttftMs)) /
              Math.max(1, metrics.completionTokens - 1)
            ).toFixed(2)
          )
        : Number(safeDurationMs.toFixed(2));
    const tokensPerSec =
      metrics.completionTokens > 0
        ? Number((metrics.completionTokens / (safeDurationMs / 1000)).toFixed(1))
        : null;

    record.status = 'completed';
    record.cacheHit = metrics.cacheHit;
    record.promptTokens = metrics.promptTokens;
    record.completionTokens = metrics.completionTokens;
    record.totalTokens = metrics.totalTokens || metrics.promptTokens + metrics.completionTokens;
    record.ttftMs = Math.round(metrics.ttftMs);
    record.tpotMs = tpotMs;
    record.durationMs = Math.round(safeDurationMs);
    record.tokensPerSec = tokensPerSec;
    record.finishedAtMs = Date.now();

    const finalTokens = Math.max(1, record.promptTokens + record.completionTokens);
    this.syncSequenceBlocks(record, finalTokens, 'decode');
    const usedBlocksNow = this.pagedBlocks.filter((b) => b.state !== 'free').length;
    record.kvLoadPct = Number(((usedBlocksNow / Math.max(1, this.pagedTotalBlocks)) * 100).toFixed(1));
    this.releaseSequencePagedBlocks(record, Boolean(dep?.enableResponseCache));
    this.broadcast();
  }

  public markRequestError(
    deploymentId: string,
    record: RequestRecord,
    errorMessage: string,
    durationMs: number
  ): void {
    const dep = this.deployments.get(deploymentId);
    if (dep) {
      dep.totalErrors++;
      dep.lastError = errorMessage;
    }
    record.status = 'error';
    record.errorMessage = errorMessage;
    record.durationMs = Math.round(durationMs);
    record.finishedAtMs = Date.now();
    this.releaseSequencePagedBlocks(record, false);
    this.broadcast();
  }

  private buildPagedSnapshot(): PagedAttentionSnapshot {
    let usedBlocks = 0;
    let prefixCachedBlocks = 0;
    let usedSlots = 0;

    for (const block of this.pagedBlocks) {
      if (block.state !== 'free') {
        usedBlocks++;
        usedSlots += block.tokensFilled;
      }
      if (block.state === 'prefix_cached') {
        prefixCachedBlocks++;
      }
    }

    const totalAllocatedSlots = usedBlocks * this.pagedBlockSize;
    const fragmentedSlots = Math.max(0, totalAllocatedSlots - usedSlots);
    const internalFragmentationPct =
      totalAllocatedSlots > 0
        ? Number(((fragmentedSlots / totalAllocatedSlots) * 100).toFixed(1))
        : 0;

    const ownerSet = new Set<string>();
    for (const b of this.pagedBlocks) {
      for (const owner of b.ownerRequestIds) ownerSet.add(owner);
    }
    const usableBlocks = this.getUsableBlocksCount();
    const activeSequenceCount = ownerSet.size;
    const naiveReservedSlots = activeSequenceCount * this.maxModelLen;
    const naiveFragmentationPct =
      naiveReservedSlots > 0
        ? Number(
            Math.max(
              0,
              ((naiveReservedSlots - Math.min(naiveReservedSlots, usedSlots)) /
                naiveReservedSlots) *
                100
            ).toFixed(1)
          )
        : 0;

    return {
      blockSize: this.pagedBlockSize,
      totalBlocks: this.pagedTotalBlocks,
      usableBlocks,
      kvMemoryUtilization: this.kvMemoryUtilization,
      maxNumSeqs: this.maxNumSeqs,
      maxModelLen: this.maxModelLen,
      enablePrefixCaching: this.enablePrefixCaching,
      usedBlocks,
      freeBlocks: Math.max(0, usableBlocks - usedBlocks),
      prefixCachedBlocks,
      totalAllocatedSlots,
      usedSlots,
      fragmentedSlots,
      internalFragmentationPct,
      naiveReservedSlots,
      naiveFragmentationPct,
      blocks: this.pagedBlocks.map((b) => ({
        ...b,
        ownerRequestIds: [...b.ownerRequestIds],
      })),
    };
  }

  public getSnapshot(): ServerSnapshot {
    const deployments = Array.from(this.deployments.values()).map((d) => ({ ...d }));
    const activeRequestsCount = deployments.reduce((sum, d) => sum + d.activeRequests, 0);
    const queuedRequestsCount = deployments.reduce((sum, d) => sum + d.queuedRequests, 0);
    const completed = this.requests.filter((r) => r.status === 'completed');
    const errors = this.requests.filter((r) => r.status === 'error');

    const withTtft = completed.filter((r) => r.ttftMs !== null);
    const avgTtftMs =
      withTtft.length > 0
        ? Math.round(withTtft.reduce((s, r) => s + (r.ttftMs ?? 0), 0) / withTtft.length)
        : null;

    const withTpot = completed.filter((r) => r.tpotMs !== null);
    const avgTpotMs =
      withTpot.length > 0
        ? Number((withTpot.reduce((s, r) => s + (r.tpotMs ?? 0), 0) / withTpot.length).toFixed(1))
        : null;

    const withTps = completed.filter((r) => r.tokensPerSec !== null && !r.cacheHit);
    const avgThroughputTokPerSec =
      withTps.length > 0
        ? Number((withTps.reduce((s, r) => s + (r.tokensPerSec ?? 0), 0) / withTps.length).toFixed(1))
        : null;

    let cacheMemoryBytes = 0;
    for (const entry of this.responseCache.values()) {
      cacheMemoryBytes += entry.bytes;
    }

    return {
      serverStartedAtMs: this.serverStartedAtMs,
      apiKeyConfigured: isGeminiApiKeyConfigured(),
      deployments,
      requests: this.requests.map((r) => ({
        ...r,
        blockTable: r.blockTable.map((e) => ({ ...e })),
      })),
      activeRequestsCount,
      queuedRequestsCount,
      completedRequestsCount: completed.length,
      errorRequestsCount: errors.length,
      cacheEntriesCount: this.responseCache.size,
      cacheMemoryBytes,
      cacheHitsTotal: this.cacheHitsTotal,
      avgTtftMs,
      avgTpotMs,
      avgThroughputTokPerSec,
      pagedAttention: this.buildPagedSnapshot(),
    };
  }

  public subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private broadcast(): void {
    if (this.listeners.size === 0) return;
    const snap = this.getSnapshot();
    for (const listener of this.listeners) {
      listener(snap);
    }
  }
}

export const modelServer = new ModelServerRuntime();
