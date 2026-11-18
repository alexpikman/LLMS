import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface StructuredLogEntry {
  timestamp: string;
  level: LogLevel;
  scope: string;
  message: string;
  meta?: Record<string, unknown>;
}

const MAX_LOG_FILE_BYTES = 5 * 1024 * 1024;
const MAX_ROTATED_FILES = 5;
const MAX_MEMORY_ENTRIES = 200;

const SECRET_KEYS = new Set([
  'authorization',
  'apikey',
  'api_key',
  'token',
  'secret',
  'password',
  'gemini_api_key',
  'hf_token',
  'modelscope_token',
  'vllm_api_key',
  'cookie',
  'set-cookie',
]);

export function maskSecretValue(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length <= 8) return '***';
  return `${trimmed.slice(0, 4)}****${trimmed.slice(-4)}`;
}

export function maskSecretsInText(input: string): string {
  return input
    .replace(/(Bearer\s+)([A-Za-z0-9._~+/=-]{6,})/gi, (_m, prefix: string, tok: string) => {
      return `${prefix}${maskSecretValue(tok)}`;
    })
    .replace(/\b(AIza[0-9A-Za-z_-]{12,})\b/g, (tok) => maskSecretValue(tok))
    .replace(/\b(hf_[0-9A-Za-z]{8,})\b/g, (tok) => maskSecretValue(tok))
    .replace(/\b(sk-[0-9A-Za-z_-]{8,})\b/g, (tok) => maskSecretValue(tok));
}

export function sanitizeLogMeta(value: unknown, depth = 0): unknown {
  if (depth > 5) return '[truncated]';
  if (typeof value === 'string') return maskSecretsInText(value);
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => sanitizeLogMeta(item, depth + 1));

  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_KEYS.has(key.toLowerCase())) {
      out[key] = typeof val === 'string' ? maskSecretValue(val) : '***';
    } else {
      out[key] = sanitizeLogMeta(val, depth + 1);
    }
  }
  return out;
}

class GatewayLogger {
  private memoryBuffer: StructuredLogEntry[] = [];
  private minLevel: LogLevel =
    (process.env.LOG_LEVEL?.toLowerCase() as LogLevel) || 'info';

  private levelRank(level: LogLevel): number {
    switch (level) {
      case 'debug':
        return 0;
      case 'info':
        return 1;
      case 'warn':
        return 2;
      case 'error':
        return 3;
    }
  }

  private getLogFilePath(): string | null {
    try {
      const dataDir =
        process.env.VLLM_DATA_DIR?.trim() || path.join(os.homedir(), '.vllm-gateway');
      const logsDir = path.join(dataDir, 'logs');
      if (!fs.existsSync(logsDir)) {
        fs.mkdirSync(logsDir, { recursive: true });
      }
      return path.join(logsDir, 'gateway.log');
    } catch {
      return null;
    }
  }

  private rotateIfNeeded(logPath: string): void {
    try {
      if (!fs.existsSync(logPath)) return;
      const stat = fs.statSync(logPath);
      if (stat.size < MAX_LOG_FILE_BYTES) return;

      for (let i = MAX_ROTATED_FILES - 1; i >= 1; i--) {
        const src = `${logPath}.${i}`;
        const dst = `${logPath}.${i + 1}`;
        if (fs.existsSync(src)) {
          fs.renameSync(src, dst);
        }
      }
      fs.renameSync(logPath, `${logPath}.1`);
    } catch {
      // Ignore rotation failures so logging never crashes server
    }
  }

  public log(
    level: LogLevel,
    scope: string,
    message: string,
    meta?: Record<string, unknown>
  ): void {
    if (this.levelRank(level) < this.levelRank(this.minLevel)) return;

    const entry: StructuredLogEntry = {
      timestamp: new Date().toISOString(),
      level,
      scope,
      message: maskSecretsInText(message),
      ...(meta ? { meta: sanitizeLogMeta(meta) as Record<string, unknown> } : {}),
    };

    this.memoryBuffer.push(entry);
    if (this.memoryBuffer.length > MAX_MEMORY_ENTRIES) {
      this.memoryBuffer.shift();
    }

    const line = JSON.stringify(entry);
    if (process.env.NODE_ENV !== 'test') {
      if (level === 'error') console.error(line);
      else if (level === 'warn') console.warn(line);
      else console.log(line);
    }

    const logPath = this.getLogFilePath();
    if (logPath) {
      try {
        this.rotateIfNeeded(logPath);
        fs.appendFileSync(logPath, `${line}\n`, { encoding: 'utf8', mode: 0o600 });
      } catch {
        // Ignore disk log errors
      }
    }
  }

  public debug(scope: string, message: string, meta?: Record<string, unknown>): void {
    this.log('debug', scope, message, meta);
  }

  public info(scope: string, message: string, meta?: Record<string, unknown>): void {
    this.log('info', scope, message, meta);
  }

  public warn(scope: string, message: string, meta?: Record<string, unknown>): void {
    this.log('warn', scope, message, meta);
  }

  public error(scope: string, message: string, meta?: Record<string, unknown>): void {
    this.log('error', scope, message, meta);
  }

  public getRecentLogs(limit = 100): StructuredLogEntry[] {
    return this.memoryBuffer.slice(-Math.max(1, Math.min(MAX_MEMORY_ENTRIES, limit)));
  }
}

export const logger = new GatewayLogger();
