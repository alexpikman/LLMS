import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentPermissionsConfig } from '../src/types/engine.ts';
import { logger } from './logger.ts';

export const CURRENT_CONFIG_SCHEMA_VERSION = 2;

export const DEFAULT_BLOCKED_COMMAND_PATTERNS = [
  'rm -rf /',
  'rm -rf /*',
  'mkfs',
  'format-volume',
  'clear-disk',
  'shutdown',
  'restart-computer',
  'stop-computer',
  'del /s /q c:\\',
  'rd /s /q c:\\',
];

export interface PersistedPagedConfig {
  blockSize: 16 | 32;
  totalBlocks: number;
  kvMemoryUtilization: number;
  maxNumSeqs: number;
  maxModelLen: number;
  enablePrefixCaching: boolean;
}

export interface PersistedAuthConfig {
  tokenHash: string | null;
  tokenSalt: string | null;
  tokenPrefix: string | null;
  sessionSecret: string;
  setupCompleted: boolean;
}

export interface GatewayConfig {
  schemaVersion: number;
  updatedAt: string;
  auth: PersistedAuthConfig;
  pagedAttention: PersistedPagedConfig;
  agentPermissions: AgentPermissionsConfig;
}

export function getDataDir(): string {
  const dir = process.env.VLLM_DATA_DIR?.trim() || path.join(os.homedir(), '.vllm-gateway');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

export function getConfigPath(dataDir = getDataDir()): string {
  return path.join(dataDir, 'config.json');
}

export function createDefaultAgentPermissions(): AgentPermissionsConfig {
  return {
    enabled: true,
    workspaceRoot: process.cwd(),
    restrictToWorkspace: true,
    allowReadFiles: true,
    allowCreateFiles: true,
    allowEditFiles: true,
    allowDeleteFiles: false,
    allowShell: true,
    shellPreference: 'auto',
    shellTimeoutMs: 15000,
    maxFileSizeKb: 512,
    maxToolIterations: 8,
    blockedCommandPatterns: [...DEFAULT_BLOCKED_COMMAND_PATTERNS],
  };
}

export function createDefaultConfig(): GatewayConfig {
  return {
    schemaVersion: CURRENT_CONFIG_SCHEMA_VERSION,
    updatedAt: new Date().toISOString(),
    auth: {
      tokenHash: null,
      tokenSalt: null,
      tokenPrefix: null,
      sessionSecret: crypto.randomBytes(32).toString('hex'),
      setupCompleted: false,
    },
    pagedAttention: {
      blockSize: 16,
      totalBlocks: 64,
      kvMemoryUtilization: 1.0,
      maxNumSeqs: 8,
      maxModelLen: 2048,
      enablePrefixCaching: true,
    },
    agentPermissions: createDefaultAgentPermissions(),
  };
}

export function migrateConfig(
  raw: Record<string, unknown>,
  configPath?: string
): { config: GatewayConfig; migrated: boolean; backupPath: string | null } {
  const rawVersion = typeof raw.schemaVersion === 'number' ? raw.schemaVersion : 0;
  const defaults = createDefaultConfig();

  const rawAuth =
    raw.auth && typeof raw.auth === 'object' ? (raw.auth as Record<string, unknown>) : {};
  const rawPaged =
    raw.pagedAttention && typeof raw.pagedAttention === 'object'
      ? (raw.pagedAttention as Record<string, unknown>)
      : {};
  const rawPerms =
    raw.agentPermissions && typeof raw.agentPermissions === 'object'
      ? (raw.agentPermissions as Record<string, unknown>)
      : {};

  // v0/v1 -> v2 migration: normalize legacy fields and seed agentPermissions
  let backupPath: string | null = null;
  if (rawVersion < CURRENT_CONFIG_SCHEMA_VERSION && configPath && fs.existsSync(configPath)) {
    backupPath = `${configPath}.v${rawVersion}.bak.${Date.now()}.json`;
    try {
      fs.copyFileSync(configPath, backupPath);
      fs.chmodSync(backupPath, 0o600);
    } catch {
      backupPath = null;
    }
  }

  const blockSize = rawPaged.blockSize === 32 ? 32 : 16;
  const totalBlocks =
    typeof rawPaged.totalBlocks === 'number'
      ? Math.min(128, Math.max(32, Math.round(rawPaged.totalBlocks)))
      : defaults.pagedAttention.totalBlocks;
  const kvUtil =
    typeof rawPaged.kvMemoryUtilization === 'number'
      ? Math.min(1, Math.max(0.25, rawPaged.kvMemoryUtilization))
      : defaults.pagedAttention.kvMemoryUtilization;
  const maxNumSeqs =
    typeof rawPaged.maxNumSeqs === 'number'
      ? Math.min(16, Math.max(1, Math.round(rawPaged.maxNumSeqs)))
      : typeof rawPaged.max_num_seqs === 'number'
      ? Math.min(16, Math.max(1, Math.round(rawPaged.max_num_seqs)))
      : defaults.pagedAttention.maxNumSeqs;
  const maxModelLen =
    typeof rawPaged.maxModelLen === 'number'
      ? Math.min(8192, Math.max(512, Math.round(rawPaged.maxModelLen)))
      : defaults.pagedAttention.maxModelLen;
  const enablePrefixCaching =
    typeof rawPaged.enablePrefixCaching === 'boolean'
      ? rawPaged.enablePrefixCaching
      : defaults.pagedAttention.enablePrefixCaching;

  const permDefaults = defaults.agentPermissions;
  const shellPref =
    rawPerms.shellPreference === 'powershell' ||
    rawPerms.shellPreference === 'bash' ||
    rawPerms.shellPreference === 'auto'
      ? rawPerms.shellPreference
      : permDefaults.shellPreference;

  const migratedConfig: GatewayConfig = {
    schemaVersion: CURRENT_CONFIG_SCHEMA_VERSION,
    updatedAt: new Date().toISOString(),
    auth: {
      tokenHash: typeof rawAuth.tokenHash === 'string' ? rawAuth.tokenHash : null,
      tokenSalt: typeof rawAuth.tokenSalt === 'string' ? rawAuth.tokenSalt : null,
      tokenPrefix: typeof rawAuth.tokenPrefix === 'string' ? rawAuth.tokenPrefix : null,
      sessionSecret:
        typeof rawAuth.sessionSecret === 'string' && rawAuth.sessionSecret.length >= 32
          ? rawAuth.sessionSecret
          : defaults.auth.sessionSecret,
      setupCompleted: Boolean(rawAuth.setupCompleted),
    },
    pagedAttention: {
      blockSize,
      totalBlocks,
      kvMemoryUtilization: kvUtil,
      maxNumSeqs,
      maxModelLen,
      enablePrefixCaching,
    },
    agentPermissions: {
      enabled:
        typeof rawPerms.enabled === 'boolean' ? rawPerms.enabled : permDefaults.enabled,
      workspaceRoot:
        typeof rawPerms.workspaceRoot === 'string' && rawPerms.workspaceRoot.trim().length > 0
          ? rawPerms.workspaceRoot.trim()
          : permDefaults.workspaceRoot,
      restrictToWorkspace:
        typeof rawPerms.restrictToWorkspace === 'boolean'
          ? rawPerms.restrictToWorkspace
          : permDefaults.restrictToWorkspace,
      allowReadFiles:
        typeof rawPerms.allowReadFiles === 'boolean'
          ? rawPerms.allowReadFiles
          : permDefaults.allowReadFiles,
      allowCreateFiles:
        typeof rawPerms.allowCreateFiles === 'boolean'
          ? rawPerms.allowCreateFiles
          : permDefaults.allowCreateFiles,
      allowEditFiles:
        typeof rawPerms.allowEditFiles === 'boolean'
          ? rawPerms.allowEditFiles
          : permDefaults.allowEditFiles,
      allowDeleteFiles:
        typeof rawPerms.allowDeleteFiles === 'boolean'
          ? rawPerms.allowDeleteFiles
          : permDefaults.allowDeleteFiles,
      allowShell:
        typeof rawPerms.allowShell === 'boolean' ? rawPerms.allowShell : permDefaults.allowShell,
      shellPreference: shellPref,
      shellTimeoutMs:
        typeof rawPerms.shellTimeoutMs === 'number'
          ? Math.min(120_000, Math.max(3000, Math.round(rawPerms.shellTimeoutMs)))
          : permDefaults.shellTimeoutMs,
      maxFileSizeKb:
        typeof rawPerms.maxFileSizeKb === 'number'
          ? Math.min(8192, Math.max(32, Math.round(rawPerms.maxFileSizeKb)))
          : permDefaults.maxFileSizeKb,
      maxToolIterations:
        typeof rawPerms.maxToolIterations === 'number'
          ? Math.min(20, Math.max(1, Math.round(rawPerms.maxToolIterations)))
          : permDefaults.maxToolIterations,
      blockedCommandPatterns: Array.isArray(rawPerms.blockedCommandPatterns)
        ? rawPerms.blockedCommandPatterns
            .map((p) => String(p).trim())
            .filter((p) => p.length > 0)
            .slice(0, 64)
        : permDefaults.blockedCommandPatterns,
    },
  };

  return {
    config: migratedConfig,
    migrated: rawVersion < CURRENT_CONFIG_SCHEMA_VERSION,
    backupPath,
  };
}

export function saveConfigAtomic(config: GatewayConfig, dataDir = getDataDir()): void {
  const configPath = getConfigPath(dataDir);
  const tmpPath = `${configPath}.tmp.${process.pid}.${Date.now()}`;
  const payload = JSON.stringify(
    {
      ...config,
      schemaVersion: CURRENT_CONFIG_SCHEMA_VERSION,
      updatedAt: new Date().toISOString(),
    },
    null,
    2
  );
  fs.writeFileSync(tmpPath, payload, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmpPath, configPath);
}

export function loadOrInitConfig(dataDir = getDataDir()): GatewayConfig {
  const configPath = getConfigPath(dataDir);
  if (!fs.existsSync(configPath)) {
    const initial = createDefaultConfig();
    saveConfigAtomic(initial, dataDir);
    return initial;
  }

  try {
    const rawText = fs.readFileSync(configPath, 'utf8');
    const parsed = JSON.parse(rawText) as Record<string, unknown>;
    const { config, migrated, backupPath } = migrateConfig(parsed, configPath);
    if (migrated) {
      logger.info('config', 'Конфигурация мигрирована к актуальной версии схемы', {
        schemaVersion: CURRENT_CONFIG_SCHEMA_VERSION,
        backupCreated: Boolean(backupPath),
      });
      saveConfigAtomic(config, dataDir);
    }
    return config;
  } catch (err) {
    const corruptBackup = `${configPath}.corrupt.${Date.now()}.json`;
    try {
      fs.copyFileSync(configPath, corruptBackup);
    } catch {
      // Ignore backup error
    }
    logger.error('config', 'Повреждённый config.json заменён резервной копией по умолчанию', {
      error: err instanceof Error ? err.message : String(err),
    });
    const fallback = createDefaultConfig();
    saveConfigAtomic(fallback, dataDir);
    return fallback;
  }
}

export function hashApiToken(token: string, salt?: string): { hash: string; salt: string } {
  const usedSalt = salt || crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(token, usedSalt, 32).toString('hex');
  return { hash: derived, salt: usedSalt };
}
