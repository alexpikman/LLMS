import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { promisify } from 'node:util';
import type {
  HardwareProfile,
  HubGgufFile,
  HubSearchResult,
  HubSource,
  LocalGgufModel,
  ModelDownloadJob,
} from '../src/types/engine.ts';
import {
  assessModelCompatibility,
  detectHardwareProfile,
  extractQuantizationFromName,
  resolveAppDataDirs,
} from './hardware.ts';

const execFileAsync = promisify(execFile);

interface LocalModelMetaEntry {
  fileName: string;
  source: HubSource | 'local';
  repoId: string;
  quantization: string;
}

type DownloadListener = () => void;

const OLLAMA_POPULAR_MODELS: Array<{ id: string; desc: string; tags: string[] }> = [
  { id: 'qwen2.5', desc: 'Alibaba Qwen 2.5 (0.5B — 72B)', tags: ['0.5b', '1.5b', '3b', '7b', '14b', '32b'] },
  { id: 'llama3.2', desc: 'Meta Llama 3.2 (1B, 3B)', tags: ['1b', '3b', 'latest'] },
  { id: 'llama3.1', desc: 'Meta Llama 3.1 (8B, 70B)', tags: ['8b', '70b', 'latest'] },
  { id: 'gemma3', desc: 'Google Gemma 3 (1B — 27B)', tags: ['1b', '4b', '12b', '27b'] },
  { id: 'deepseek-r1', desc: 'DeepSeek R1 Distill (1.5B — 70B)', tags: ['1.5b', '7b', '8b', '14b', '32b'] },
  { id: 'mistral', desc: 'Mistral 7B v0.3', tags: ['7b', 'latest'] },
  { id: 'phi4', desc: 'Microsoft Phi-4 14B', tags: ['14b', 'latest'] },
  { id: 'nomic-embed-text', desc: 'Nomic Embed Text (Embeddings)', tags: ['latest'] },
];

function sanitizeFileName(raw: string): string {
  const base = path.basename(raw).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
  if (!base) return `model-${Date.now()}.gguf`;
  return base.toLowerCase().endsWith('.gguf') ? base : `${base}.gguf`;
}

function authHeadersForSource(source: HubSource): Record<string, string> {
  const headers: Record<string, string> = {
    'User-Agent': 'vllm-gateway/1.0',
  };
  if (source === 'huggingface' && process.env.HF_TOKEN?.trim()) {
    headers['Authorization'] = `Bearer ${process.env.HF_TOKEN.trim()}`;
  }
  if (source === 'modelscope' && process.env.MODELSCOPE_TOKEN?.trim()) {
    headers['Authorization'] = `Bearer ${process.env.MODELSCOPE_TOKEN.trim()}`;
  }
  return headers;
}

async function fetchOllamaBearerIfNeeded(
  url: string,
  extraHeaders: Record<string, string> = {}
): Promise<Response> {
  const first = await fetch(url, { headers: { 'User-Agent': 'vllm-gateway/1.0', ...extraHeaders } });
  if (first.status !== 401) return first;

  const wwwAuth = first.headers.get('www-authenticate') ?? '';
  const realmMatch = wwwAuth.match(/realm="([^"]+)"/i);
  const serviceMatch = wwwAuth.match(/service="([^"]+)"/i);
  const scopeMatch = wwwAuth.match(/scope="([^"]+)"/i);
  if (!realmMatch) return first;

  const tokenUrl = new URL(realmMatch[1]);
  if (serviceMatch) tokenUrl.searchParams.set('service', serviceMatch[1]);
  if (scopeMatch) tokenUrl.searchParams.set('scope', scopeMatch[1]);

  const tokenRes = await fetch(tokenUrl.toString());
  if (!tokenRes.ok) return first;
  const tokenJson = (await tokenRes.json()) as { token?: string; access_token?: string };
  const token = tokenJson.token || tokenJson.access_token;
  if (!token) return first;

  return fetch(url, {
    headers: {
      'User-Agent': 'vllm-gateway/1.0',
      Authorization: `Bearer ${token}`,
      ...extraHeaders,
    },
  });
}

export async function searchHubModels(source: HubSource, query: string): Promise<HubSearchResult[]> {
  const q = query.trim();
  if (source === 'url') {
    return [];
  }

  if (source === 'huggingface') {
    const url = new URL('https://huggingface.co/api/models');
    if (q) url.searchParams.set('search', q);
    url.searchParams.set('library', 'gguf');
    url.searchParams.set('sort', 'downloads');
    url.searchParams.set('direction', '-1');
    url.searchParams.set('limit', '15');

    const res = await fetch(url.toString(), { headers: authHeadersForSource('huggingface') });
    if (!res.ok) {
      throw new Error(`Hugging Face API вернул HTTP ${res.status}`);
    }
    const list = (await res.json()) as Array<{
      id: string;
      author?: string;
      downloads?: number;
      likes?: number;
      tags?: string[];
      lastModified?: string;
      pipeline_tag?: string;
    }>;

    return list.map((item) => {
      const parts = item.id.split('/');
      return {
        id: item.id,
        source: 'huggingface',
        name: parts[1] ?? item.id,
        author: item.author ?? parts[0] ?? 'huggingface',
        description: item.pipeline_tag
          ? `Задача: ${item.pipeline_tag}`
          : 'Репозиторий GGUF на Hugging Face Hub',
        downloads: item.downloads,
        likes: item.likes,
        tags: (item.tags ?? []).slice(0, 6),
        updatedAt: item.lastModified,
      };
    });
  }

  if (source === 'ollama') {
    // Allow direct repo queries like "qwen2.5:7b" or search in Ollama registry catalog
    const normalized = q.toLowerCase();
    const matched = OLLAMA_POPULAR_MODELS.filter(
      (m) =>
        !normalized ||
        m.id.includes(normalized.split(':')[0]) ||
        m.desc.toLowerCase().includes(normalized)
    );

    const results: HubSearchResult[] = matched.map((m) => ({
      id: m.id,
      source: 'ollama',
      name: m.id,
      author: 'library',
      description: `${m.desc} · Теги: ${m.tags.join(', ')}`,
      tags: m.tags,
    }));

    if (q && !results.some((r) => r.id === normalized.split(':')[0])) {
      results.unshift({
        id: q,
        source: 'ollama',
        name: q,
        author: q.includes('/') ? q.split('/')[0] : 'library',
        description: 'Запросить OCI-манифест напрямую из registry.ollama.ai',
        tags: [q.includes(':') ? q.split(':')[1] : 'latest'],
      });
    }
    return results;
  }

  // ModelScope
  try {
    const url = new URL('https://modelscope.cn/api/v1/models');
    if (q) url.searchParams.set('search', q);
    url.searchParams.set('page', '1');
    url.searchParams.set('per_page', '15');

    const res = await fetch(url.toString(), { headers: authHeadersForSource('modelscope') });
    if (res.ok) {
      const json = (await res.json()) as {
        Data?: {
          Models?: Array<{
            Path?: string;
            Name?: string;
            ChineseName?: string;
            Downloads?: number;
            Stars?: number;
          }>;
        };
      };
      const models = json.Data?.Models ?? [];
      if (models.length > 0) {
        return models.map((m) => {
          const repoId = m.Path && m.Name ? `${m.Path}/${m.Name}` : m.Name || q;
          return {
            id: repoId,
            source: 'modelscope',
            name: m.Name ?? repoId,
            author: m.Path ?? 'modelscope',
            description: m.ChineseName || 'Репозиторий модели ModelScope',
            downloads: m.Downloads,
            likes: m.Stars,
          };
        });
      }
    }
  } catch {
    // Fall back to direct repo lookup when search endpoint is throttled
  }

  // Fallback suggestions if ModelScope public search returns empty or blocked
  const fallbacks = [
    { id: 'Qwen/Qwen2.5-3B-Instruct-GGUF', name: 'Qwen2.5-3B-Instruct-GGUF', author: 'Qwen' },
    { id: 'Qwen/Qwen2.5-7B-Instruct-GGUF', name: 'Qwen2.5-7B-Instruct-GGUF', author: 'Qwen' },
    { id: 'LLM-Research/Meta-Llama-3.1-8B-Instruct-GGUF', name: 'Meta-Llama-3.1-8B-Instruct-GGUF', author: 'LLM-Research' },
    { id: 'deepseek-ai/DeepSeek-R1-Distill-Qwen-7B-GGUF', name: 'DeepSeek-R1-Distill-Qwen-7B-GGUF', author: 'deepseek-ai' },
  ].filter((item) => !q || item.id.toLowerCase().includes(q.toLowerCase()));

  if (q.includes('/') && !fallbacks.some((f) => f.id === q)) {
    fallbacks.unshift({ id: q, name: q.split('/')[1] || q, author: q.split('/')[0] });
  }

  return fallbacks.map((item) => ({
    id: item.id,
    source: 'modelscope',
    name: item.name,
    author: item.author,
    description: 'Репозиторий GGUF в ModelScope Hub (прямой запрос списка файлов)',
  }));
}

export async function listHubGgufFiles(
  source: HubSource,
  repoId: string,
  ctxLen = 2048
): Promise<HubGgufFile[]> {
  const hw = await detectHardwareProfile();
  const cleanRepo = repoId.trim();
  if (!cleanRepo) throw new Error('Укажите идентификатор модели или URL.');

  if (source === 'huggingface') {
    let filesRes = await fetch(
      `https://huggingface.co/api/models/${encodeURI(cleanRepo)}/tree/main?recursive=true`,
      { headers: authHeadersForSource('huggingface') }
    );
    let branch = 'main';
    if (filesRes.status === 404) {
      branch = 'master';
      filesRes = await fetch(
        `https://huggingface.co/api/models/${encodeURI(cleanRepo)}/tree/master?recursive=true`,
        { headers: authHeadersForSource('huggingface') }
      );
    }
    if (!filesRes.ok) {
      throw new Error(`Не удалось получить файлы репозитория ${cleanRepo} (HTTP ${filesRes.status}).`);
    }

    const entries = (await filesRes.json()) as Array<{
      type: string;
      path: string;
      size?: number;
      lfs?: { size?: number; oid?: string };
    }>;

    return entries
      .filter((e) => e.type === 'file' && e.path.toLowerCase().endsWith('.gguf'))
      .map((e) => {
        const sizeBytes = e.lfs?.size ?? e.size ?? null;
        const fileName = path.basename(e.path);
        return {
          fileName,
          path: e.path,
          sizeBytes,
          quantization: extractQuantizationFromName(fileName),
          downloadUrl: `https://huggingface.co/${cleanRepo}/resolve/${branch}/${e.path}?download=true`,
          sha256: e.lfs?.oid,
          compatibility: sizeBytes ? assessModelCompatibility(hw, sizeBytes, ctxLen) : null,
        };
      })
      .sort((a, b) => (a.sizeBytes ?? 0) - (b.sizeBytes ?? 0));
  }

  if (source === 'ollama') {
    const [rawModel, rawTag] = cleanRepo.includes(':')
      ? cleanRepo.split(':', 2)
      : [cleanRepo, ''];

    const preset = OLLAMA_POPULAR_MODELS.find((m) => m.id === rawModel);
    const tagsToProbe = rawTag ? [rawTag] : preset ? preset.tags.slice(0, 4) : ['latest'];
    const namespaceModel = rawModel.includes('/') ? rawModel : `library/${rawModel}`;

    const files: HubGgufFile[] = [];
    for (const tag of tagsToProbe) {
      try {
        const manifestUrl = `https://registry.ollama.ai/v2/${namespaceModel}/manifests/${tag}`;
        const res = await fetchOllamaBearerIfNeeded(manifestUrl, {
          Accept:
            'application/vnd.docker.distribution.manifest.v2+json, application/vnd.oci.image.manifest.v1+json',
        });
        if (!res.ok) continue;
        const manifest = (await res.json()) as {
          layers?: Array<{ mediaType?: string; digest?: string; size?: number }>;
        };
        const modelLayer = manifest.layers?.find(
          (l) => l.mediaType === 'application/vnd.ollama.image.model'
        );
        if (!modelLayer?.digest) continue;
        const sizeBytes = modelLayer.size ?? null;
        const safeModelName = rawModel.replace(/\//g, '_');
        const fileName = `${safeModelName}-${tag}.gguf`;
        files.push({
          fileName,
          path: `${rawModel}:${tag}`,
          sizeBytes,
          quantization: tag.toUpperCase(),
          downloadUrl: `https://registry.ollama.ai/v2/${namespaceModel}/blobs/${modelLayer.digest}`,
          sha256: modelLayer.digest.replace('sha256:', ''),
          compatibility: sizeBytes ? assessModelCompatibility(hw, sizeBytes, ctxLen) : null,
        });
      } catch {
        // Ignore single tag probe failure
      }
    }

    if (files.length === 0) {
      throw new Error(`Не найден GGUF-слой в Ollama Registry для "${cleanRepo}".`);
    }
    return files;
  }

  if (source === 'modelscope') {
    let revision = 'master';
    let res = await fetch(
      `https://modelscope.cn/api/v1/models/${cleanRepo}/repo/files?Revision=master&Recursive=true`,
      { headers: authHeadersForSource('modelscope') }
    );
    if (!res.ok) {
      revision = 'main';
      res = await fetch(
        `https://modelscope.cn/api/v1/models/${cleanRepo}/repo/files?Revision=main&Recursive=true`,
        { headers: authHeadersForSource('modelscope') }
      );
    }
    if (!res.ok) {
      throw new Error(`ModelScope API вернул HTTP ${res.status} для "${cleanRepo}".`);
    }
    const json = (await res.json()) as {
      Data?: {
        Files?: Array<{ Name?: string; Path?: string; Type?: string; Size?: number; Sha256?: string }>;
      };
    };
    const allFiles = json.Data?.Files ?? [];
    return allFiles
      .filter((f) => (f.Path || f.Name || '').toLowerCase().endsWith('.gguf'))
      .map((f) => {
        const filePath = f.Path || f.Name || '';
        const fileName = path.basename(filePath);
        const sizeBytes = typeof f.Size === 'number' ? f.Size : null;
        return {
          fileName,
          path: filePath,
          sizeBytes,
          quantization: extractQuantizationFromName(fileName),
          downloadUrl: `https://modelscope.cn/api/v1/models/${cleanRepo}/repo?Revision=${revision}&FilePath=${encodeURIComponent(
            filePath
          )}`,
          sha256: f.Sha256,
          compatibility: sizeBytes ? assessModelCompatibility(hw, sizeBytes, ctxLen) : null,
        };
      })
      .sort((a, b) => (a.sizeBytes ?? 0) - (b.sizeBytes ?? 0));
  }

  // Direct URL probe
  return [await probeDirectGgufUrl(cleanRepo, ctxLen, hw)];
}

export async function probeDirectGgufUrl(
  rawUrl: string,
  ctxLen = 2048,
  existingHw?: HardwareProfile
): Promise<HubGgufFile> {
  const hw = existingHw ?? (await detectHardwareProfile());
  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    throw new Error('Некорректный формат URL.');
  }

  let res = await fetch(parsed.toString(), {
    method: 'HEAD',
    headers: { 'User-Agent': 'vllm-gateway/1.0' },
  });
  let sizeBytes: number | null = null;
  const lenHeader = res.headers.get('content-length');
  if (res.ok && lenHeader) {
    const num = Number(lenHeader);
    if (Number.isFinite(num) && num > 0) sizeBytes = num;
  }

  if (!res.ok || sizeBytes === null) {
    res = await fetch(parsed.toString(), {
      method: 'GET',
      headers: {
        'User-Agent': 'vllm-gateway/1.0',
        Range: 'bytes=0-0',
      },
    });
    const rangeHeader = res.headers.get('content-range');
    if (rangeHeader) {
      const m = rangeHeader.match(/\/(\d+)$/);
      if (m) sizeBytes = Number(m[1]);
    } else if (res.headers.get('content-length')) {
      const n = Number(res.headers.get('content-length'));
      if (Number.isFinite(n) && n > 1) sizeBytes = n;
    }
    try {
      await res.body?.cancel();
    } catch {
      // Ignore stream cancel
    }
  }

  if (!res.ok && res.status !== 206) {
    throw new Error(`Удалённый сервер вернул HTTP ${res.status}`);
  }

  const disposition = res.headers.get('content-disposition') ?? '';
  const dispMatch = disposition.match(/filename\*?=(?:UTF-8'')?["']?([^"';\n]+)/i);
  const rawName = dispMatch ? decodeURIComponent(dispMatch[1]) : path.basename(parsed.pathname);
  const fileName = sanitizeFileName(rawName || 'custom-model.gguf');

  return {
    fileName,
    path: fileName,
    sizeBytes,
    quantization: extractQuantizationFromName(fileName),
    downloadUrl: parsed.toString(),
    compatibility: sizeBytes ? assessModelCompatibility(hw, sizeBytes, ctxLen) : null,
  };
}

class GgufDownloadManager {
  private jobs = new Map<string, ModelDownloadJob>();
  private controllers = new Map<string, AbortController>();
  private listeners = new Set<DownloadListener>();
  private lastNotifyMs = 0;

  private getMetaFilePath(): string {
    const { modelsDir } = resolveAppDataDirs();
    return path.join(modelsDir, '.vllm-models.json');
  }

  private readMetaMap(): Record<string, LocalModelMetaEntry> {
    const metaPath = this.getMetaFilePath();
    if (!fs.existsSync(metaPath)) return {};
    try {
      return JSON.parse(fs.readFileSync(metaPath, 'utf8')) as Record<string, LocalModelMetaEntry>;
    } catch {
      return {};
    }
  }

  private saveMetaEntry(entry: LocalModelMetaEntry): void {
    const map = this.readMetaMap();
    map[entry.fileName] = entry;
    fs.writeFileSync(this.getMetaFilePath(), JSON.stringify(map, null, 2), 'utf8');
  }

  public subscribe(listener: DownloadListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(force = false): void {
    const now = Date.now();
    if (!force && now - this.lastNotifyMs < 350) return;
    this.lastNotifyMs = now;
    for (const l of this.listeners) l();
  }

  public getJobs(): ModelDownloadJob[] {
    return Array.from(this.jobs.values()).sort((a, b) => b.createdAtMs - a.createdAtMs);
  }

  public async getLocalModels(ctxLen = 2048): Promise<LocalGgufModel[]> {
    const hw = await detectHardwareProfile();
    const { modelsDir } = resolveAppDataDirs();
    const metaMap = this.readMetaMap();
    const entries = fs.readdirSync(modelsDir, { withFileTypes: true });
    const models: LocalGgufModel[] = [];

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.gguf')) continue;
      const fullPath = path.join(modelsDir, entry.name);
      const stat = fs.statSync(fullPath);
      const meta = metaMap[entry.name];
      const quant = meta?.quantization || extractQuantizationFromName(entry.name);
      const id = crypto.createHash('sha1').update(fullPath).digest('hex').slice(0, 12);
      models.push({
        id,
        fileName: entry.name,
        filePath: fullPath,
        sizeBytes: stat.size,
        quantization: quant,
        source: meta?.source || 'local',
        repoId: meta?.repoId || entry.name,
        modifiedAtMs: stat.mtimeMs,
        compatibility: assessModelCompatibility(hw, stat.size, ctxLen),
      });
    }

    return models.sort((a, b) => b.modifiedAtMs - a.modifiedAtMs);
  }

  public deleteLocalModel(id: string): void {
    const { modelsDir } = resolveAppDataDirs();
    const entries = fs.readdirSync(modelsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.gguf')) continue;
      const fullPath = path.join(modelsDir, entry.name);
      const hash = crypto.createHash('sha1').update(fullPath).digest('hex').slice(0, 12);
      if (hash === id) {
        fs.unlinkSync(fullPath);
        const map = this.readMetaMap();
        delete map[entry.name];
        fs.writeFileSync(this.getMetaFilePath(), JSON.stringify(map, null, 2), 'utf8');
        this.notify(true);
        return;
      }
    }
    throw new Error('Локальный GGUF-файл не найден.');
  }

  public startDownload(input: {
    source: HubSource;
    repoId: string;
    fileName: string;
    downloadUrl: string;
    totalBytes?: number | null;
    quantization?: string;
  }): ModelDownloadJob {
    const { modelsDir } = resolveAppDataDirs();
    const cleanName = sanitizeFileName(input.fileName);
    const targetPath = path.join(modelsDir, cleanName);
    const id = `dl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

    const job: ModelDownloadJob = {
      id,
      source: input.source,
      repoId: input.repoId,
      fileName: cleanName,
      downloadUrl: input.downloadUrl,
      targetPath,
      quantization: input.quantization || extractQuantizationFromName(cleanName),
      status: 'queued',
      bytesDownloaded: 0,
      totalBytes: input.totalBytes ?? 0,
      speedBytesPerSec: 0,
      etaSeconds: null,
      createdAtMs: Date.now(),
      updatedAtMs: Date.now(),
      errorMessage: null,
    };

    this.jobs.set(id, job);
    this.notify(true);
    void this.runDownloadLoop(job);
    return { ...job };
  }

  public pauseDownload(id: string): ModelDownloadJob {
    const job = this.jobs.get(id);
    if (!job) throw new Error('Задача загрузки не найдена.');
    if (job.status === 'downloading' || job.status === 'queued') {
      job.status = 'paused';
      job.speedBytesPerSec = 0;
      job.etaSeconds = null;
      job.updatedAtMs = Date.now();
      this.controllers.get(id)?.abort();
      this.notify(true);
    }
    return { ...job };
  }

  public resumeDownload(id: string): ModelDownloadJob {
    const job = this.jobs.get(id);
    if (!job) throw new Error('Задача загрузки не найдена.');
    if (job.status === 'paused' || job.status === 'error') {
      job.errorMessage = null;
      job.status = 'queued';
      job.updatedAtMs = Date.now();
      this.notify(true);
      void this.runDownloadLoop(job);
    }
    return { ...job };
  }

  public cancelDownload(id: string): void {
    const job = this.jobs.get(id);
    if (!job) return;
    job.status = 'cancelled';
    this.controllers.get(id)?.abort();
    const partPath = `${job.targetPath}.part`;
    try {
      if (fs.existsSync(partPath)) fs.unlinkSync(partPath);
    } catch {
      // Ignore cleanup error
    }
    this.jobs.delete(id);
    this.notify(true);
  }

  private async runDownloadLoop(job: ModelDownloadJob): Promise<void> {
    const partPath = `${job.targetPath}.part`;
    const controller = new AbortController();
    this.controllers.set(job.id, controller);

    try {
      let existingOffset = 0;
      if (fs.existsSync(partPath)) {
        existingOffset = fs.statSync(partPath).size;
      }

      job.status = 'downloading';
      job.bytesDownloaded = existingOffset;
      job.updatedAtMs = Date.now();
      this.notify(true);

      const headers: Record<string, string> = authHeadersForSource(job.source);
      if (existingOffset > 0) {
        headers['Range'] = `bytes=${existingOffset}-`;
      }

      const res =
        job.source === 'ollama'
          ? await fetchOllamaBearerIfNeeded(job.downloadUrl, headers)
          : await fetch(job.downloadUrl, { headers, signal: controller.signal });

      if (!res.ok && res.status !== 206) {
        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      }

      const isPartial = res.status === 206;
      if (!isPartial && existingOffset > 0) {
        existingOffset = 0;
        job.bytesDownloaded = 0;
      }

      const contentLen = Number(res.headers.get('content-length') ?? 0);
      if (isPartial && contentLen > 0) {
        job.totalBytes = existingOffset + contentLen;
      } else if (contentLen > 0) {
        job.totalBytes = contentLen;
      }

      if (!res.body) {
        throw new Error('Сервер не вернул поток данных.');
      }

      const writeStream = fs.createWriteStream(partPath, {
        flags: isPartial ? 'a' : 'w',
      });

      const reader = Readable.fromWeb(res.body as unknown as import('node:stream/web').ReadableStream);
      let windowBytes = 0;
      let windowStartedAt = performance.now();

      await new Promise<void>((resolve, reject) => {
        reader.on('data', (chunk: Buffer) => {
          if (job.status !== 'downloading') {
            reader.destroy();
            return;
          }
          const ok = writeStream.write(chunk);
          if (!ok) {
            reader.pause();
            writeStream.once('drain', () => reader.resume());
          }
          job.bytesDownloaded += chunk.length;
          windowBytes += chunk.length;
          const elapsedSec = (performance.now() - windowStartedAt) / 1000;
          if (elapsedSec >= 0.4) {
            const speed = windowBytes / elapsedSec;
            job.speedBytesPerSec = Math.round(speed);
            if (job.totalBytes > job.bytesDownloaded && speed > 0) {
              job.etaSeconds = Math.round((job.totalBytes - job.bytesDownloaded) / speed);
            } else {
              job.etaSeconds = null;
            }
            windowBytes = 0;
            windowStartedAt = performance.now();
            job.updatedAtMs = Date.now();
            this.notify(false);
          }
        });

        reader.on('end', () => {
          writeStream.end(() => resolve());
        });

        reader.on('error', (err) => {
          writeStream.close();
          reject(err);
        });

        writeStream.on('error', (err) => {
          reader.destroy();
          reject(err);
        });
      });

      if ((job.status as string) !== 'downloading') return;

      fs.renameSync(partPath, job.targetPath);
      this.saveMetaEntry({
        fileName: job.fileName,
        source: job.source,
        repoId: job.repoId,
        quantization: job.quantization,
      });

      job.status = 'completed';
      job.totalBytes = fs.statSync(job.targetPath).size;
      job.bytesDownloaded = job.totalBytes;
      job.speedBytesPerSec = 0;
      job.etaSeconds = 0;
      job.updatedAtMs = Date.now();
      this.notify(true);
    } catch (err) {
      if ((job.status as string) === 'paused' || (job.status as string) === 'cancelled') {
        return;
      }
      job.status = 'error';
      job.speedBytesPerSec = 0;
      job.etaSeconds = null;
      job.errorMessage = err instanceof Error ? err.message : String(err);
      job.updatedAtMs = Date.now();
      this.notify(true);
    } finally {
      this.controllers.delete(job.id);
    }
  }
}

export const downloadManager = new GgufDownloadManager();

export async function installLlamaServerRuntime(): Promise<{
  installedPath: string;
  assetName: string;
}> {
  const { binDir } = resolveAppDataDirs();
  const hw = await detectHardwareProfile(true);

  const relRes = await fetch('https://api.github.com/repos/ggml-org/llama.cpp/releases/latest', {
    headers: { 'User-Agent': 'vllm-gateway/1.0', Accept: 'application/vnd.github+json' },
  });
  if (!relRes.ok) {
    throw new Error(`Не удалось получить список релизов llama.cpp с GitHub (HTTP ${relRes.status}).`);
  }

  const release = (await relRes.json()) as {
    tag_name?: string;
    assets?: Array<{ name: string; browser_download_url: string }>;
  };
  const assets = release.assets ?? [];

  let matcher: RegExp;
  if (hw.osPlatform === 'linux' && hw.arch === 'x64') {
    matcher = /bin-ubuntu-x64\.(tar\.gz|zip)$/i;
  } else if (hw.osPlatform === 'darwin' && hw.arch === 'arm64') {
    matcher = /bin-macos-arm64\.(tar\.gz|zip)$/i;
  } else if (hw.osPlatform === 'darwin' && hw.arch === 'x64') {
    matcher = /bin-macos-x64\.(tar\.gz|zip)$/i;
  } else if (hw.osPlatform === 'win32' && hw.arch === 'x64') {
    matcher = /bin-win-cpu-x64\.zip$/i;
  } else {
    throw new Error(
      `Автоматическая загрузка llama-server для ${hw.osPlatform}/${hw.arch} не поддерживается. Установите llama.cpp вручную.`
    );
  }

  const asset = assets.find((a) => matcher.test(a.name));
  if (!asset) {
    throw new Error(
      `В релизе ${release.tag_name ?? 'latest'} не найден подходящий архив для ${hw.osPlatform}/${hw.arch}.`
    );
  }

  const archivePath = path.join(binDir, asset.name);
  const dlRes = await fetch(asset.browser_download_url, {
    headers: { 'User-Agent': 'vllm-gateway/1.0' },
  });
  if (!dlRes.ok || !dlRes.body) {
    throw new Error(`Ошибка загрузки архива ${asset.name}: HTTP ${dlRes.status}`);
  }

  const buf = Buffer.from(await dlRes.arrayBuffer());
  fs.writeFileSync(archivePath, buf);

  const extractTmp = path.join(binDir, `extract-${Date.now()}`);
  fs.mkdirSync(extractTmp, { recursive: true });

  try {
    if (asset.name.endsWith('.tar.gz')) {
      await execFileAsync('tar', ['-xzf', archivePath, '-C', extractTmp], { timeout: 30000 });
    } else if (hw.osPlatform === 'win32') {
      await execFileAsync(
        'powershell',
        ['-NoProfile', '-Command', `Expand-Archive -Path "${archivePath}" -DestinationPath "${extractTmp}" -Force`],
        { timeout: 30000 }
      );
    } else {
      await execFileAsync('unzip', ['-o', archivePath, '-d', extractTmp], { timeout: 30000 });
    }

    const exeName = hw.osPlatform === 'win32' ? 'llama-server.exe' : 'llama-server';
    const foundServer = findFileRecursive(extractTmp, exeName);
    if (!foundServer) {
      throw new Error(`Файл ${exeName} не найден внутри архива ${asset.name}.`);
    }

    // Copy binary + any shared libs (.so / .dylib / .dll) from same directory
    const sourceDir = path.dirname(foundServer);
    for (const item of fs.readdirSync(sourceDir)) {
      const src = path.join(sourceDir, item);
      if (!fs.statSync(src).isFile()) continue;
      if (
        item === exeName ||
        item.endsWith('.so') ||
        item.includes('.so.') ||
        item.endsWith('.dylib') ||
        item.endsWith('.dll')
      ) {
        const dest = path.join(binDir, item);
        fs.copyFileSync(src, dest);
        if (hw.osPlatform !== 'win32') {
          fs.chmodSync(dest, 0o755);
        }
      }
    }

    await detectHardwareProfile(true);
    return {
      installedPath: path.join(binDir, exeName),
      assetName: asset.name,
    };
  } finally {
    fs.rmSync(extractTmp, { recursive: true, force: true });
    if (fs.existsSync(archivePath)) fs.unlinkSync(archivePath);
  }
}

function findFileRecursive(dir: string, targetName: string): string | null {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isFile() && entry.name === targetName) return full;
    if (entry.isDirectory()) {
      const nested = findFileRecursive(full, targetName);
      if (nested) return nested;
    }
  }
  return null;
}
