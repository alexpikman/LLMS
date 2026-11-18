import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import type { GgufDeviceMode } from '../src/types/engine.ts';
import type { OpenAiChatMessage } from './gemini.ts';
import { detectHardwareProfile } from './hardware.ts';
import { logger } from './logger.ts';

interface ManagedLlamaInstance {
  deploymentId: string;
  port: number;
  pid: number;
  process: ChildProcess;
  stderrTail: string;
  stoppingIntentional: boolean;
}

export interface RawLlamaSlot {
  id: number;
  is_processing?: boolean;
  n_ctx?: number;
}

const runningProcesses = new Map<string, ManagedLlamaInstance>();

async function findFreePort(startPort = 18080): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', () => {
      findFreePort(startPort + 1).then(resolve, reject);
    });
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : startPort;
      srv.close(() => resolve(port));
    });
  });
}

async function waitForHealth(
  port: number,
  proc: ChildProcess,
  getStderr: () => string
): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) {
      throw new Error(
        `Процесс llama-server завершился с кодом ${proc.exitCode}. ${getStderr().slice(-400)}`
      );
    }
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(2000),
      });
      if (res.ok) {
        return;
      }
    } catch {
      // Server socket not ready yet
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`Тайм-аут ожидания запуска llama-server на порту ${port}.`);
}

export async function startGgufProcess(params: {
  deploymentId: string;
  ggufPath: string;
  deviceMode: GgufDeviceMode;
  gpuLayers: number;
  cpuThreads: number;
  ctxSize: number;
  parallelSlots: number;
  onUnexpectedExit?: (code: number | null, signal: NodeJS.Signals | null, stderrTail: string) => void;
}): Promise<{ port: number; pid: number }> {
  await stopGgufProcess(params.deploymentId);

  if (!fs.existsSync(params.ggufPath)) {
    throw new Error(`Файл модели не найден: ${params.ggufPath}`);
  }

  const hw = await detectHardwareProfile(true);
  if (!hw.llamaServerPath) {
    throw new Error(
      `Бинарник llama-server не найден на этом ПК. Установите его из GitHub или локального архива в разделе «Центр GGUF».`
    );
  }

  const port = await findFreePort();
  const resolvedGpuLayers =
    params.deviceMode === 'cpu'
      ? '0'
      : params.gpuLayers < 0
      ? '999'
      : String(Math.max(0, params.gpuLayers));

  const args = [
    '-m',
    params.ggufPath,
    '--host',
    '127.0.0.1',
    '--port',
    String(port),
    '--ctx-size',
    String(Math.max(512, params.ctxSize)),
    '--n-gpu-layers',
    resolvedGpuLayers,
    '--threads',
    String(Math.max(1, params.cpuThreads)),
    '--parallel',
    String(Math.max(1, params.parallelSlots)),
  ];

  const env = { ...process.env };
  const libDir = path.dirname(hw.llamaServerPath);
  if (process.platform === 'linux') {
    env.LD_LIBRARY_PATH = env.LD_LIBRARY_PATH
      ? `${libDir}:${env.LD_LIBRARY_PATH}`
      : libDir;
  } else if (process.platform === 'darwin') {
    env.DYLD_LIBRARY_PATH = env.DYLD_LIBRARY_PATH
      ? `${libDir}:${env.DYLD_LIBRARY_PATH}`
      : libDir;
  }

  const child = spawn(hw.llamaServerPath, args, {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const instance: ManagedLlamaInstance = {
    deploymentId: params.deploymentId,
    port,
    pid: child.pid ?? 0,
    process: child,
    stderrTail: '',
    stoppingIntentional: false,
  };

  child.stderr?.on('data', (chunk: Buffer) => {
    instance.stderrTail = (instance.stderrTail + chunk.toString('utf8')).slice(-2000);
  });
  child.stdout?.on('data', (chunk: Buffer) => {
    instance.stderrTail = (instance.stderrTail + chunk.toString('utf8')).slice(-2000);
  });

  let startedSuccessfully = false;
  child.on('exit', (code, signal) => {
    if (runningProcesses.get(params.deploymentId) === instance) {
      runningProcesses.delete(params.deploymentId);
    }
    if (startedSuccessfully && !instance.stoppingIntentional) {
      logger.error('ggufRunner', 'Неожиданное завершение процесса llama-server', {
        deploymentId: params.deploymentId,
        code,
        signal,
      });
      params.onUnexpectedExit?.(code, signal, instance.stderrTail);
    }
  });

  runningProcesses.set(params.deploymentId, instance);

  try {
    await waitForHealth(port, child, () => instance.stderrTail);
    startedSuccessfully = true;
    logger.info('ggufRunner', 'Процесс llama-server запущен', {
      deploymentId: params.deploymentId,
      port,
      pid: instance.pid,
    });
    return { port, pid: instance.pid };
  } catch (err) {
    await stopGgufProcess(params.deploymentId);
    throw err;
  }
}

export async function stopGgufProcess(deploymentId: string): Promise<void> {
  const inst = runningProcesses.get(deploymentId);
  if (!inst) return;
  inst.stoppingIntentional = true;
  runningProcesses.delete(deploymentId);
  try {
    if (inst.process.exitCode === null) {
      inst.process.kill('SIGTERM');
      await new Promise((r) => setTimeout(r, 350));
      if (inst.process.exitCode === null) {
        inst.process.kill('SIGKILL');
      }
    }
  } catch {
    // Ignore already terminated process
  }
}

export function stopAllGgufProcesses(): void {
  for (const id of Array.from(runningProcesses.keys())) {
    const inst = runningProcesses.get(id);
    if (inst) {
      inst.stoppingIntentional = true;
      if (inst.process.exitCode === null) {
        try {
          inst.process.kill('SIGTERM');
        } catch {
          // Ignore cleanup error
        }
      }
    }
    runningProcesses.delete(id);
  }
}

export async function queryLlamaSlots(deploymentId: string): Promise<RawLlamaSlot[]> {
  const inst = runningProcesses.get(deploymentId);
  if (!inst || inst.process.exitCode !== null) return [];
  try {
    const res = await fetch(`http://127.0.0.1:${inst.port}/slots`, {
      signal: AbortSignal.timeout(1200),
    });
    if (!res.ok) return [];
    const data = (await res.json()) as unknown;
    return Array.isArray(data) ? (data as RawLlamaSlot[]) : [];
  } catch {
    return [];
  }
}

export async function* streamGgufChat(params: {
  deploymentId: string;
  messages: OpenAiChatMessage[];
  defaultSystemInstruction?: string;
  temperature?: number;
  topP?: number;
  stop?: string | string[];
  maxTokens?: number;
}): AsyncGenerator<{
  text?: string;
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
}> {
  const inst = runningProcesses.get(params.deploymentId);
  if (!inst || inst.process.exitCode !== null) {
    throw new Error('Локальный процесс llama-server не запущен.');
  }

  const payloadMessages = [...params.messages];
  if (
    params.defaultSystemInstruction?.trim() &&
    !payloadMessages.some((m) => m.role === 'system')
  ) {
    payloadMessages.unshift({ role: 'system', content: params.defaultSystemInstruction.trim() });
  }

  const res = await fetch(`http://127.0.0.1:${inst.port}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(120_000),
    body: JSON.stringify({
      messages: payloadMessages,
      stream: true,
      stream_options: { include_usage: true },
      temperature: params.temperature ?? 0.7,
      top_p: params.topP,
      stop: params.stop,
      max_tokens: params.maxTokens,
    }),
  });

  if (!res.ok || !res.body) {
    const errText = await res.text().catch(() => '');
    throw new Error(`llama-server ошибка HTTP ${res.status}: ${errText || res.statusText}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
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
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') return;
      try {
        const parsed = JSON.parse(payload) as {
          choices?: Array<{ delta?: { content?: string } }>;
          usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
        };
        const delta = parsed.choices?.[0]?.delta?.content;
        if (delta) {
          yield { text: delta };
        }
        if (parsed.usage) {
          yield {
            usage: {
              promptTokens: parsed.usage.prompt_tokens ?? 0,
              completionTokens: parsed.usage.completion_tokens ?? 0,
              totalTokens: parsed.usage.total_tokens ?? 0,
            },
          };
        }
      } catch {
        // Ignore partial chunk JSON
      }
    }
  }
}

export async function generateGgufChat(params: {
  deploymentId: string;
  messages: OpenAiChatMessage[];
  defaultSystemInstruction?: string;
  temperature?: number;
  topP?: number;
  stop?: string | string[];
  maxTokens?: number;
}): Promise<{
  text: string;
  usage: { promptTokens: number; completionTokens: number; totalTokens: number };
}> {
  const inst = runningProcesses.get(params.deploymentId);
  if (!inst || inst.process.exitCode !== null) {
    throw new Error('Локальный процесс llama-server не запущен.');
  }

  const payloadMessages = [...params.messages];
  if (
    params.defaultSystemInstruction?.trim() &&
    !payloadMessages.some((m) => m.role === 'system')
  ) {
    payloadMessages.unshift({ role: 'system', content: params.defaultSystemInstruction.trim() });
  }

  const res = await fetch(`http://127.0.0.1:${inst.port}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(120_000),
    body: JSON.stringify({
      messages: payloadMessages,
      stream: false,
      temperature: params.temperature ?? 0.7,
      top_p: params.topP,
      stop: params.stop,
      max_tokens: params.maxTokens,
    }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`llama-server ошибка HTTP ${res.status}: ${errText || res.statusText}`);
  }

  const json = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  };

  return {
    text: json.choices?.[0]?.message?.content ?? '',
    usage: {
      promptTokens: json.usage?.prompt_tokens ?? 0,
      completionTokens: json.usage?.completion_tokens ?? 0,
      totalTokens: json.usage?.total_tokens ?? 0,
    },
  };
}
