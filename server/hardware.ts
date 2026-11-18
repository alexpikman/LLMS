import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type {
  CompatibilityAssessment,
  GpuDeviceInfo,
  HardwareProfile,
} from '../src/types/engine.ts';

const execFileAsync = promisify(execFile);
const GIB = 1024 * 1024 * 1024;
const MIB = 1024 * 1024;

let cachedProfile: HardwareProfile | null = null;
let cachedAtMs = 0;

export function resolveAppDataDirs(): { dataDir: string; modelsDir: string; binDir: string } {
  const dataDir =
    process.env.VLLM_DATA_DIR?.trim() || path.join(os.homedir(), '.vllm-gateway');
  const modelsDir = path.join(dataDir, 'models');
  const binDir = path.join(dataDir, 'bin');

  for (const dir of [dataDir, modelsDir, binDir]) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  return { dataDir, modelsDir, binDir };
}

function getLinuxAvailableRamBytes(fallbackFreeBytes: number): number {
  if (process.platform !== 'linux') return fallbackFreeBytes;
  try {
    const content = fs.readFileSync('/proc/meminfo', 'utf8');
    const match = content.match(/^MemAvailable:\s+(\d+)\s+kB$/m);
    if (match) {
      return Number(match[1]) * 1024;
    }
  } catch {
    // Fallback to os.freemem
  }
  return fallbackFreeBytes;
}

async function detectNvidiaGpus(): Promise<GpuDeviceInfo[]> {
  try {
    const { stdout } = await execFileAsync(
      'nvidia-smi',
      [
        '--query-gpu=index,name,memory.total,memory.free,driver_version',
        '--format=csv,noheader,nounits',
      ],
      { timeout: 2500 }
    );
    const lines = stdout
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);

    const gpus: GpuDeviceInfo[] = [];
    for (const line of lines) {
      const parts = line.split(',').map((p) => p.trim());
      if (parts.length < 4) continue;
      const index = Number.parseInt(parts[0], 10);
      const name = parts[1];
      const totalMib = Number.parseFloat(parts[2]);
      const freeMib = Number.parseFloat(parts[3]);
      const driverVersion = parts[4] || null;
      if (Number.isFinite(totalMib) && totalMib > 0) {
        gpus.push({
          index: Number.isFinite(index) ? index : gpus.length,
          name,
          vendor: 'nvidia',
          vramTotalBytes: Math.round(totalMib * MIB),
          vramFreeBytes: Math.round((Number.isFinite(freeMib) ? freeMib : totalMib * 0.9) * MIB),
          driverVersion,
        });
      }
    }
    return gpus;
  } catch {
    return [];
  }
}

async function detectAppleSiliconGpu(totalRamBytes: number): Promise<GpuDeviceInfo[]> {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') return [];
  try {
    let chipName = 'Apple Silicon GPU (Metal)';
    try {
      const { stdout } = await execFileAsync('sysctl', ['-n', 'machdep.cpu.brand_string'], {
        timeout: 1500,
      });
      if (stdout.trim()) {
        chipName = `${stdout.trim()} (Metal Unified)`;
      }
    } catch {
      // Keep default label
    }
    const maxUnified = Math.round(totalRamBytes * 0.72);
    return [
      {
        index: 0,
        name: chipName,
        vendor: 'apple',
        vramTotalBytes: maxUnified,
        vramFreeBytes: Math.round(totalRamBytes * 0.6),
        driverVersion: 'Metal',
      },
    ];
  } catch {
    return [];
  }
}

async function findLlamaServerBinary(binDir: string): Promise<{
  path: string | null;
  version: string | null;
}> {
  const exeName = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server';
  const candidates: string[] = [];
  if (process.env.LLAMA_SERVER_PATH?.trim()) {
    candidates.push(process.env.LLAMA_SERVER_PATH.trim());
  }
  candidates.push(path.join(binDir, exeName));
  candidates.push(path.join(process.cwd(), 'bin', exeName));
  if (process.platform !== 'win32') {
    candidates.push('/usr/local/bin/llama-server', '/usr/bin/llama-server', '/opt/homebrew/bin/llama-server');
  }

  let resolvedPath: string | null = null;
  for (const candidate of candidates) {
    try {
      if (candidate && fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        resolvedPath = candidate;
        break;
      }
    } catch {
      // Ignore permission errors
    }
  }

  if (!resolvedPath) {
    const lookupCmd = process.platform === 'win32' ? 'where' : 'which';
    try {
      const { stdout } = await execFileAsync(lookupCmd, [exeName], { timeout: 1500 });
      const firstLine = stdout.split(/\r?\n/).find((l) => l.trim().length > 0)?.trim();
      if (firstLine && fs.existsSync(firstLine)) {
        resolvedPath = firstLine;
      }
    } catch {
      // Not on PATH
    }
  }

  if (!resolvedPath) {
    return { path: null, version: null };
  }

  try {
    const { stdout, stderr } = await execFileAsync(resolvedPath, ['--version'], {
      timeout: 2000,
    });
    const combined = `${stdout}\n${stderr}`
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l.toLowerCase().includes('version') || l.startsWith('b'));
    return { path: resolvedPath, version: combined ?? 'detected' };
  } catch {
    return { path: resolvedPath, version: 'detected' };
  }
}

export async function detectHardwareProfile(forceRefresh = false): Promise<HardwareProfile> {
  const now = Date.now();
  if (!forceRefresh && cachedProfile && now - cachedAtMs < 5000) {
    return cachedProfile;
  }

  const { modelsDir, binDir } = resolveAppDataDirs();
  const cpus = os.cpus();
  const totalRamBytes = os.totalmem();
  const freeRamBytes = getLinuxAvailableRamBytes(os.freemem());

  let diskFreeBytes = 0;
  let diskTotalBytes = 0;
  try {
    const stat = fs.statfsSync(modelsDir);
    diskFreeBytes = Number(stat.bavail) * Number(stat.bsize);
    diskTotalBytes = Number(stat.blocks) * Number(stat.bsize);
  } catch {
    // Some restricted sandboxes disallow statfsSync
  }

  const nvidiaGpus = await detectNvidiaGpus();
  const appleGpus = nvidiaGpus.length === 0 ? await detectAppleSiliconGpu(totalRamBytes) : [];
  const gpus = nvidiaGpus.length > 0 ? nvidiaGpus : appleGpus;
  const unifiedMemory = gpus.some((g) => g.vendor === 'apple');

  const totalVramBytes = gpus.reduce((sum, g) => sum + g.vramTotalBytes, 0);
  const freeVramBytes = gpus.reduce((sum, g) => sum + g.vramFreeBytes, 0);

  const llama = await findLlamaServerBinary(binDir);

  const profile: HardwareProfile = {
    hostname: os.hostname(),
    osPlatform: os.platform(),
    osRelease: os.release(),
    arch: os.arch(),
    cpuModel: cpus[0]?.model?.trim() || `${os.arch()} CPU`,
    cpuCores: Math.max(1, Math.floor(cpus.length / 2) || cpus.length),
    cpuThreads: Math.max(1, cpus.length),
    totalRamBytes,
    freeRamBytes,
    unifiedMemory,
    gpus,
    totalVramBytes,
    freeVramBytes,
    diskFreeBytes,
    diskTotalBytes,
    modelsDir,
    binDir,
    llamaServerPath: llama.path,
    llamaServerAvailable: Boolean(llama.path),
    llamaServerVersion: llama.version,
    detectedAtMs: now,
  };

  cachedProfile = profile;
  cachedAtMs = now;
  return profile;
}

export function extractQuantizationFromName(fileName: string): string {
  const match = fileName.match(
    /(IQ[1-4]_[A-Z0-9_]+|Q[2-8]_[0-9A-Z_]+|F16|BF16|FP16|F32|INT4|INT8)/i
  );
  return match ? match[1].toUpperCase() : 'GGUF';
}

export function formatBytesRu(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 Б';
  if (bytes >= GIB) return `${(bytes / GIB).toFixed(2)} ГБ`;
  if (bytes >= MIB) return `${(bytes / MIB).toFixed(1)} МБ`;
  return `${Math.round(bytes / 1024)} КБ`;
}

export function assessModelCompatibility(
  hw: HardwareProfile,
  modelSizeBytes: number,
  ctxLen = 2048
): CompatibilityAssessment {
  const safeSize = Math.max(1, modelSizeBytes);
  const sizeGb = safeSize / GIB;

  // Estimate transformer layers from typical GGUF weight sizes (1B..70B)
  let totalEstimatedLayers = 32;
  if (sizeGb < 1.5) totalEstimatedLayers = 24;
  else if (sizeGb < 6) totalEstimatedLayers = 32;
  else if (sizeGb < 12) totalEstimatedLayers = 40;
  else if (sizeGb < 26) totalEstimatedLayers = 48;
  else if (sizeGb < 45) totalEstimatedLayers = 64;
  else totalEstimatedLayers = 80;

  // Realistic GQA FP16 KV-cache footprint estimate scaled by context length and model size
  const kvGb = Math.max(0.15, (ctxLen / 4096) * Math.min(3.5, Math.max(0.25, sizeGb * 0.085)));
  const estimatedKvCacheBytes = Math.round(kvGb * GIB);
  const runtimeOverheadBytes = Math.round(0.45 * GIB);
  const requiredMemoryBytes = safeSize + estimatedKvCacheBytes + runtimeOverheadBytes;

  const fitsOnDisk = hw.diskFreeBytes === 0 ? true : safeSize <= hw.diskFreeBytes * 0.96;
  const hasDedicatedGpu = hw.gpus.length > 0 && hw.freeVramBytes > 0;
  const fitsInVram = hasDedicatedGpu && hw.freeVramBytes >= requiredMemoryBytes;
  const fitsInRam = hw.freeRamBytes >= requiredMemoryBytes;

  // Hybrid GPU+CPU check: at least 1.2 GiB free VRAM + enough combined memory
  const canPartialGpu =
    hasDedicatedGpu &&
    !hw.unifiedMemory &&
    hw.freeVramBytes >= 1.2 * GIB &&
    hw.freeVramBytes + hw.freeRamBytes >= requiredMemoryBytes + 0.3 * GIB;

  if (!fitsOnDisk) {
    return {
      verdict: 'insufficient',
      label: 'Недостаточно места на диске',
      summary: `Требуется ${formatBytesRu(safeSize)} на диске, свободно ${formatBytesRu(hw.diskFreeBytes)}.`,
      modelSizeBytes: safeSize,
      estimatedKvCacheBytes,
      runtimeOverheadBytes,
      requiredMemoryBytes,
      availableVramBytes: hw.freeVramBytes,
      availableRamBytes: hw.freeRamBytes,
      totalEstimatedLayers,
      recommendedGpuLayers: 0,
      fitsInVram,
      fitsInRam,
      fitsOnDisk,
    };
  }

  if (fitsInVram) {
    return {
      verdict: 'gpu_full',
      label: 'Подходит для GPU',
      summary: `Полная выгрузка в VRAM (${formatBytesRu(requiredMemoryBytes)} из ${formatBytesRu(hw.freeVramBytes)} свободно).`,
      modelSizeBytes: safeSize,
      estimatedKvCacheBytes,
      runtimeOverheadBytes,
      requiredMemoryBytes,
      availableVramBytes: hw.freeVramBytes,
      availableRamBytes: hw.freeRamBytes,
      totalEstimatedLayers,
      recommendedGpuLayers: totalEstimatedLayers,
      fitsInVram: true,
      fitsInRam,
      fitsOnDisk,
    };
  }

  if (canPartialGpu) {
    const usableVramForWeights = Math.max(
      0,
      hw.freeVramBytes - runtimeOverheadBytes - estimatedKvCacheBytes * 0.5
    );
    const ratio = Math.min(0.95, usableVramForWeights / safeSize);
    const recommendedGpuLayers = Math.max(1, Math.floor(totalEstimatedLayers * ratio));
    return {
      verdict: 'gpu_partial',
      label: 'Гибрид GPU + CPU',
      summary: `В VRAM поместится ~${recommendedGpuLayers}/${totalEstimatedLayers} слоёв, остальные будут в RAM (${formatBytesRu(requiredMemoryBytes)} всего).`,
      modelSizeBytes: safeSize,
      estimatedKvCacheBytes,
      runtimeOverheadBytes,
      requiredMemoryBytes,
      availableVramBytes: hw.freeVramBytes,
      availableRamBytes: hw.freeRamBytes,
      totalEstimatedLayers,
      recommendedGpuLayers,
      fitsInVram: false,
      fitsInRam: true,
      fitsOnDisk,
    };
  }

  if (fitsInRam) {
    return {
      verdict: 'cpu_only',
      label: 'Только CPU (RAM)',
      summary: `Помещается в оперативную память (${formatBytesRu(requiredMemoryBytes)} из ${formatBytesRu(hw.freeRamBytes)} свободно).`,
      modelSizeBytes: safeSize,
      estimatedKvCacheBytes,
      runtimeOverheadBytes,
      requiredMemoryBytes,
      availableVramBytes: hw.freeVramBytes,
      availableRamBytes: hw.freeRamBytes,
      totalEstimatedLayers,
      recommendedGpuLayers: 0,
      fitsInVram: false,
      fitsInRam: true,
      fitsOnDisk,
    };
  }

  return {
    verdict: 'insufficient',
    label: 'Недостаточно памяти',
    summary: `Требуется ${formatBytesRu(requiredMemoryBytes)} (VRAM/RAM), доступно RAM: ${formatBytesRu(hw.freeRamBytes)}${
      hw.freeVramBytes > 0 ? `, VRAM: ${formatBytesRu(hw.freeVramBytes)}` : ''
    }.`,
    modelSizeBytes: safeSize,
    estimatedKvCacheBytes,
    runtimeOverheadBytes,
    requiredMemoryBytes,
    availableVramBytes: hw.freeVramBytes,
    availableRamBytes: hw.freeRamBytes,
    totalEstimatedLayers,
    recommendedGpuLayers: 0,
    fitsInVram: false,
    fitsInRam: false,
    fitsOnDisk,
  };
}
