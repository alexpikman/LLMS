import { execFile, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { Type, type FunctionDeclaration } from '@google/genai';
import type {
  AgentPermissionsConfig,
  DetectedShellEnvironment,
  ToolAuditEntry,
} from '../src/types/engine.ts';
import {
  createDefaultAgentPermissions,
  DEFAULT_BLOCKED_COMMAND_PATTERNS,
  getDataDir,
  loadOrInitConfig,
  saveConfigAtomic,
} from './config.ts';
import { logger } from './logger.ts';

const execFileAsync = promisify(execFile);

const MAX_AUDIT_LOGS = 200;
const auditLogs: ToolAuditEntry[] = [];
let cachedShellEnv: DetectedShellEnvironment | null = null;

function commandExists(bin: string): boolean {
  try {
    const checker = process.platform === 'win32' ? 'where' : 'which';
    const res = spawnSync(checker, [bin], { stdio: 'ignore', timeout: 2500 });
    return res.status === 0;
  } catch {
    return false;
  }
}

export function detectShellEnvironment(force = false): DetectedShellEnvironment {
  if (cachedShellEnv && !force) return cachedShellEnv;
  const isWin = process.platform === 'win32';
  let powershellBinary: string | null = null;
  if (isWin) {
    powershellBinary = commandExists('pwsh')
      ? 'pwsh'
      : commandExists('powershell.exe')
      ? 'powershell.exe'
      : 'powershell';
  } else if (commandExists('pwsh')) {
    powershellBinary = 'pwsh';
  }

  const bashAvailable = commandExists('bash') || commandExists('sh');
  cachedShellEnv = {
    platform: process.platform,
    defaultWorkspaceRoot: process.cwd(),
    powershellAvailable: Boolean(powershellBinary),
    powershellBinary,
    bashAvailable,
  };
  return cachedShellEnv;
}

export function getAccessConfig(dataDir = getDataDir()): AgentPermissionsConfig {
  const cfg = loadOrInitConfig(dataDir);
  return {
    ...cfg.agentPermissions,
    blockedCommandPatterns: [...cfg.agentPermissions.blockedCommandPatterns],
  };
}

export function updateAccessConfig(
  patch: Partial<AgentPermissionsConfig>,
  dataDir = getDataDir()
): AgentPermissionsConfig {
  const cfg = loadOrInitConfig(dataDir);
  const current = cfg.agentPermissions;

  const nextWorkspaceRoot =
    typeof patch.workspaceRoot === 'string' && patch.workspaceRoot.trim().length > 0
      ? path.resolve(patch.workspaceRoot.trim())
      : current.workspaceRoot;

  if (!fs.existsSync(nextWorkspaceRoot)) {
    throw new Error(`Указанная рабочая папка не существует: ${nextWorkspaceRoot}`);
  }
  if (!fs.statSync(nextWorkspaceRoot).isDirectory()) {
    throw new Error(`Путь не является директорией: ${nextWorkspaceRoot}`);
  }

  const nextShellPref =
    patch.shellPreference === 'powershell' ||
    patch.shellPreference === 'bash' ||
    patch.shellPreference === 'auto'
      ? patch.shellPreference
      : current.shellPreference;

  const nextBlocked = Array.isArray(patch.blockedCommandPatterns)
    ? patch.blockedCommandPatterns
        .map((p) => String(p).trim())
        .filter((p) => p.length > 0)
        .slice(0, 64)
    : current.blockedCommandPatterns;

  const updated: AgentPermissionsConfig = {
    enabled: typeof patch.enabled === 'boolean' ? patch.enabled : current.enabled,
    workspaceRoot: nextWorkspaceRoot,
    restrictToWorkspace:
      typeof patch.restrictToWorkspace === 'boolean'
        ? patch.restrictToWorkspace
        : current.restrictToWorkspace,
    allowReadFiles:
      typeof patch.allowReadFiles === 'boolean' ? patch.allowReadFiles : current.allowReadFiles,
    allowCreateFiles:
      typeof patch.allowCreateFiles === 'boolean'
        ? patch.allowCreateFiles
        : current.allowCreateFiles,
    allowEditFiles:
      typeof patch.allowEditFiles === 'boolean' ? patch.allowEditFiles : current.allowEditFiles,
    allowDeleteFiles:
      typeof patch.allowDeleteFiles === 'boolean'
        ? patch.allowDeleteFiles
        : current.allowDeleteFiles,
    allowShell: typeof patch.allowShell === 'boolean' ? patch.allowShell : current.allowShell,
    shellPreference: nextShellPref,
    shellTimeoutMs:
      typeof patch.shellTimeoutMs === 'number' && Number.isFinite(patch.shellTimeoutMs)
        ? Math.min(120_000, Math.max(3000, Math.round(patch.shellTimeoutMs)))
        : current.shellTimeoutMs,
    maxFileSizeKb:
      typeof patch.maxFileSizeKb === 'number' && Number.isFinite(patch.maxFileSizeKb)
        ? Math.min(8192, Math.max(32, Math.round(patch.maxFileSizeKb)))
        : current.maxFileSizeKb,
    maxToolIterations:
      typeof patch.maxToolIterations === 'number' && Number.isFinite(patch.maxToolIterations)
        ? Math.min(20, Math.max(1, Math.round(patch.maxToolIterations)))
        : current.maxToolIterations,
    blockedCommandPatterns: nextBlocked,
  };

  cfg.agentPermissions = updated;
  saveConfigAtomic(cfg, dataDir);
  logger.info('access', 'Обновлены права доступа моделей к ФС и PowerShell', {
    enabled: updated.enabled,
    workspaceRoot: updated.workspaceRoot,
    allowShell: updated.allowShell,
    allowCreateFiles: updated.allowCreateFiles,
    allowEditFiles: updated.allowEditFiles,
    allowDeleteFiles: updated.allowDeleteFiles,
  });
  return { ...updated, blockedCommandPatterns: [...updated.blockedCommandPatterns] };
}

export function resetAccessConfig(dataDir = getDataDir()): AgentPermissionsConfig {
  const cfg = loadOrInitConfig(dataDir);
  const defaults = createDefaultAgentPermissions();
  cfg.agentPermissions = defaults;
  saveConfigAtomic(cfg, dataDir);
  return { ...defaults, blockedCommandPatterns: [...DEFAULT_BLOCKED_COMMAND_PATTERNS] };
}

export function testWorkspacePath(rawPath: string): {
  resolvedPath: string;
  exists: boolean;
  isDirectory: boolean;
  readable: boolean;
  writable: boolean;
} {
  const clean = rawPath.trim() || process.cwd();
  const resolvedPath = path.resolve(clean);
  if (!fs.existsSync(resolvedPath)) {
    return {
      resolvedPath,
      exists: false,
      isDirectory: false,
      readable: false,
      writable: false,
    };
  }
  const stat = fs.statSync(resolvedPath);
  let readable = false;
  let writable = false;
  try {
    fs.accessSync(resolvedPath, fs.constants.R_OK);
    readable = true;
  } catch {
    readable = false;
  }
  try {
    fs.accessSync(resolvedPath, fs.constants.W_OK);
    writable = true;
  } catch {
    writable = false;
  }
  return {
    resolvedPath,
    exists: true,
    isDirectory: stat.isDirectory(),
    readable,
    writable,
  };
}

export function getToolAuditLogs(): ToolAuditEntry[] {
  return [...auditLogs];
}

export function clearToolAuditLogs(): void {
  auditLogs.length = 0;
}

function recordAudit(entry: Omit<ToolAuditEntry, 'id' | 'timestampMs'>): void {
  auditLogs.unshift({
    id: `aud-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    timestampMs: Date.now(),
    ...entry,
  });
  if (auditLogs.length > MAX_AUDIT_LOGS) {
    auditLogs.length = MAX_AUDIT_LOGS;
  }
}

export function resolveAllowedPath(rawTarget: string, cfg: AgentPermissionsConfig): string {
  if (rawTarget.includes('\0')) {
    throw new Error('Недопустимый символ в пути файла.');
  }
  const root = path.resolve(cfg.workspaceRoot || process.cwd());
  const cleaned = rawTarget.trim() || '.';
  const candidate = path.isAbsolute(cleaned) ? path.resolve(cleaned) : path.resolve(root, cleaned);

  if (cfg.restrictToWorkspace) {
    const rel = path.relative(root, candidate);
    if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
      throw new Error(
        `Доступ за пределы рабочей папки запрещён (${cfg.workspaceRoot}): ${rawTarget}`
      );
    }
  }
  return candidate;
}

function listFilesRecursive(
  dir: string,
  baseRoot: string,
  recursive: boolean,
  maxEntries: number,
  out: Array<{ path: string; type: 'dir' | 'file'; sizeBytes: number }>
): void {
  if (out.length >= maxEntries) return;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  entries.sort((a, b) => {
    if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  for (const entry of entries) {
    if (out.length >= maxEntries) break;
    if (
      entry.name === 'node_modules' ||
      entry.name === '.git' ||
      entry.name === 'dist' ||
      entry.name === 'dist-server' ||
      entry.name === 'release-build'
    ) {
      continue;
    }
    const full = path.join(dir, entry.name);
    const rel = path.relative(baseRoot, full) || entry.name;
    if (entry.isDirectory()) {
      out.push({ path: rel.replace(/\\/g, '/'), type: 'dir', sizeBytes: 0 });
      if (recursive) {
        listFilesRecursive(full, baseRoot, true, maxEntries, out);
      }
    } else if (entry.isFile()) {
      let size = 0;
      try {
        size = fs.statSync(full).size;
      } catch {
        size = 0;
      }
      out.push({ path: rel.replace(/\\/g, '/'), type: 'file', sizeBytes: size });
    }
  }
}

function summarizeArgs(args: Record<string, unknown>): string {
  if (typeof args.command === 'string') return args.command.slice(0, 120);
  if (typeof args.path === 'string') return args.path.slice(0, 120);
  return JSON.stringify(args).slice(0, 120);
}

export async function executeWorkspaceTool(params: {
  toolName: string;
  args: Record<string, unknown>;
  modelAlias: string;
  dataDir?: string;
}): Promise<{ ok: boolean; status: 'completed' | 'blocked' | 'error'; output: string; durationMs: number }> {
  const startedAt = performance.now();
  const cfg = getAccessConfig(params.dataDir);
  const { toolName, args, modelAlias } = params;

  const fail = (
    status: 'blocked' | 'error',
    message: string
  ): { ok: boolean; status: 'blocked' | 'error'; output: string; durationMs: number } => {
    const durationMs = Math.max(1, Math.round(performance.now() - startedAt));
    recordAudit({
      modelAlias,
      toolName,
      argsSummary: summarizeArgs(args),
      allowed: status !== 'blocked',
      status,
      durationMs,
      resultPreview: message.slice(0, 240),
      error: message,
    });
    return { ok: false, status, output: message, durationMs };
  };

  if (!cfg.enabled) {
    return fail('blocked', 'Доступ моделей к файловой системе и PowerShell отключён в настройках.');
  }

  try {
    if (toolName === 'list_files') {
      if (!cfg.allowReadFiles) {
        return fail('blocked', 'Чтение списка файлов запрещено политикой доступа.');
      }
      const target = resolveAllowedPath(String(args.path ?? '.'), cfg);
      if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) {
        return fail('error', `Директория не найдена: ${target}`);
      }
      const recursive = Boolean(args.recursive);
      const maxEntries = Math.min(250, Math.max(10, Number(args.maxEntries ?? 100)));
      const items: Array<{ path: string; type: 'dir' | 'file'; sizeBytes: number }> = [];
      listFilesRecursive(target, path.resolve(cfg.workspaceRoot), recursive, maxEntries, items);

      const text =
        items.length === 0
          ? '(пустая директория)'
          : items
              .map((it) =>
                it.type === 'dir' ? `[DIR]  ${it.path}/` : `[FILE] ${it.path} (${it.sizeBytes} B)`
              )
              .join('\n');

      const durationMs = Math.max(1, Math.round(performance.now() - startedAt));
      recordAudit({
        modelAlias,
        toolName,
        argsSummary: summarizeArgs(args),
        allowed: true,
        status: 'completed',
        durationMs,
        resultPreview: `Найдено объектов: ${items.length}`,
      });
      return { ok: true, status: 'completed', output: text, durationMs };
    }

    if (toolName === 'read_file') {
      if (!cfg.allowReadFiles) {
        return fail('blocked', 'Чтение файлов запрещено политикой доступа.');
      }
      const target = resolveAllowedPath(String(args.path ?? ''), cfg);
      if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
        return fail('error', `Файл не найден: ${target}`);
      }
      const stat = fs.statSync(target);
      const maxBytes = cfg.maxFileSizeKb * 1024;
      if (stat.size > maxBytes) {
        return fail(
          'error',
          `Файл слишком велик (${Math.round(stat.size / 1024)} КБ > лимит ${cfg.maxFileSizeKb} КБ).`
        );
      }
      const raw = fs.readFileSync(target, 'utf8');
      const lines = raw.split(/\r?\n/);
      const startLine = Math.max(1, Number(args.startLine ?? 1));
      const endLine = Math.min(
        lines.length,
        Math.max(startLine, Number(args.endLine ?? Math.min(lines.length, startLine + 299)))
      );
      const slice = lines
        .slice(startLine - 1, endLine)
        .map((line, i) => `${startLine + i}: ${line}`)
        .join('\n');
      const header = `Файл: ${target} (строки ${startLine}–${endLine} из ${lines.length})\n`;
      const output = header + slice;
      const durationMs = Math.max(1, Math.round(performance.now() - startedAt));
      recordAudit({
        modelAlias,
        toolName,
        argsSummary: summarizeArgs(args),
        allowed: true,
        status: 'completed',
        durationMs,
        resultPreview: `Прочитано строк: ${endLine - startLine + 1}`,
      });
      return { ok: true, status: 'completed', output, durationMs };
    }

    if (toolName === 'create_file') {
      const target = resolveAllowedPath(String(args.path ?? ''), cfg);
      const exists = fs.existsSync(target);
      if (exists) {
        if (!Boolean(args.overwrite)) {
          return fail('error', `Файл уже существует: ${target}. Используйте edit_file или overwrite=true.`);
        }
        if (!cfg.allowEditFiles) {
          return fail('blocked', 'Перезапись существующих файлов запрещена политикой доступа.');
        }
      } else if (!cfg.allowCreateFiles) {
        return fail('blocked', 'Создание новых файлов запрещено политикой доступа.');
      }

      const content = typeof args.content === 'string' ? args.content : String(args.content ?? '');
      const byteSize = Buffer.byteLength(content, 'utf8');
      if (byteSize > cfg.maxFileSizeKb * 1024) {
        return fail(
          'error',
          `Размер создаваемого файла (${Math.round(byteSize / 1024)} КБ) превышает лимит ${cfg.maxFileSizeKb} КБ.`
        );
      }
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content, 'utf8');

      const durationMs = Math.max(1, Math.round(performance.now() - startedAt));
      const msg = `${exists ? 'Перезаписан' : 'Создан'} файл ${target} (${byteSize} байт, ${content.split(/\r?\n/).length} строк).`;
      recordAudit({
        modelAlias,
        toolName,
        argsSummary: summarizeArgs(args),
        allowed: true,
        status: 'completed',
        durationMs,
        resultPreview: msg,
      });
      return { ok: true, status: 'completed', output: msg, durationMs };
    }

    if (toolName === 'edit_file') {
      if (!cfg.allowEditFiles) {
        return fail('blocked', 'Редактирование файлов запрещено политикой доступа.');
      }
      const target = resolveAllowedPath(String(args.path ?? ''), cfg);
      if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
        return fail('error', `Файл для редактирования не найден: ${target}`);
      }
      const mode =
        args.mode === 'overwrite' || args.mode === 'append' ? args.mode : 'replace';
      const current = fs.readFileSync(target, 'utf8');
      const newText = typeof args.newText === 'string' ? args.newText : String(args.newText ?? '');
      let updated = current;

      if (mode === 'overwrite') {
        updated = newText;
      } else if (mode === 'append') {
        updated = current.endsWith('\n') || current.length === 0 ? current + newText : `${current}\n${newText}`;
      } else {
        const oldText = typeof args.oldText === 'string' ? args.oldText : '';
        if (!oldText) {
          return fail('error', 'Для режима replace необходимо передать непустое поле oldText.');
        }
        const firstIdx = current.indexOf(oldText);
        if (firstIdx === -1) {
          return fail('error', `Фрагмент oldText не найден в файле ${target}.`);
        }
        const replaceAll = Boolean(args.replaceAll);
        if (!replaceAll && current.indexOf(oldText, firstIdx + oldText.length) !== -1) {
          return fail(
            'error',
            'Найдено несколько совпадений oldText. Уточните контекст или передайте replaceAll=true.'
          );
        }
        updated = replaceAll ? current.split(oldText).join(newText) : current.replace(oldText, newText);
      }

      const byteSize = Buffer.byteLength(updated, 'utf8');
      if (byteSize > cfg.maxFileSizeKb * 1024) {
        return fail('error', `Размер файла после правки превышает лимит ${cfg.maxFileSizeKb} КБ.`);
      }
      fs.writeFileSync(target, updated, 'utf8');

      const durationMs = Math.max(1, Math.round(performance.now() - startedAt));
      const msg = `Файл обновлён (${mode}): ${target} (${current.split(/\r?\n/).length} -> ${updated.split(/\r?\n/).length} строк, ${byteSize} байт).`;
      recordAudit({
        modelAlias,
        toolName,
        argsSummary: summarizeArgs(args),
        allowed: true,
        status: 'completed',
        durationMs,
        resultPreview: msg,
      });
      return { ok: true, status: 'completed', output: msg, durationMs };
    }

    if (toolName === 'delete_file') {
      if (!cfg.allowDeleteFiles) {
        return fail('blocked', 'Удаление файлов запрещено политикой доступа.');
      }
      const target = resolveAllowedPath(String(args.path ?? ''), cfg);
      const root = path.resolve(cfg.workspaceRoot);
      if (target === root) {
        return fail('blocked', 'Нельзя удалить корневую рабочую директорию.');
      }
      if (!fs.existsSync(target)) {
        return fail('error', `Файл не найден: ${target}`);
      }
      if (fs.statSync(target).isDirectory()) {
        return fail('blocked', 'Инструмент delete_file удаляет только файлы, не директории.');
      }
      fs.unlinkSync(target);
      const durationMs = Math.max(1, Math.round(performance.now() - startedAt));
      const msg = `Файл удалён: ${target}`;
      recordAudit({
        modelAlias,
        toolName,
        argsSummary: summarizeArgs(args),
        allowed: true,
        status: 'completed',
        durationMs,
        resultPreview: msg,
      });
      return { ok: true, status: 'completed', output: msg, durationMs };
    }

    if (toolName === 'run_powershell') {
      if (!cfg.allowShell) {
        return fail('blocked', 'Выполнение команд PowerShell / терминала запрещено политикой доступа.');
      }
      const command = typeof args.command === 'string' ? args.command.trim() : '';
      if (!command) {
        return fail('error', 'Команда не может быть пустой.');
      }

      const lowerCmd = command.toLowerCase();
      for (const pattern of cfg.blockedCommandPatterns) {
        if (pattern && lowerCmd.includes(pattern.toLowerCase())) {
          return fail(
            'blocked',
            `Команда заблокирована правилом безопасности ("${pattern}").`
          );
        }
      }

      const cwd = args.cwd
        ? resolveAllowedPath(String(args.cwd), cfg)
        : path.resolve(cfg.workspaceRoot);
      if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
        return fail('error', `Рабочая директория cwd не найдена: ${cwd}`);
      }

      const envInfo = detectShellEnvironment();
      let shellBin = '';
      let shellArgs: string[] = [];
      let shellLabel = '';

      if (cfg.shellPreference === 'bash') {
        if (!envInfo.bashAvailable) {
          return fail('error', 'Оболочка bash недоступна на данной системе.');
        }
        shellBin = 'bash';
        shellArgs = ['-lc', command];
        shellLabel = 'bash';
      } else if (cfg.shellPreference === 'powershell') {
        if (!envInfo.powershellBinary) {
          return fail(
            'error',
            'PowerShell (pwsh / powershell.exe) не установлен на этой ОС. Выберите режим Auto или Bash в разделе «Доступ к ОС».'
          );
        }
        shellBin = envInfo.powershellBinary;
        shellArgs = ['-NoProfile', '-NonInteractive', '-Command', `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ${command}`];
        shellLabel = envInfo.powershellBinary;
      } else {
        if (envInfo.powershellBinary) {
          shellBin = envInfo.powershellBinary;
          shellArgs = ['-NoProfile', '-NonInteractive', '-Command', `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ${command}`];
          shellLabel = envInfo.powershellBinary;
        } else if (envInfo.bashAvailable) {
          shellBin = 'bash';
          shellArgs = ['-lc', command];
          shellLabel = 'bash (fallback: pwsh не установлен)';
        } else {
          return fail('error', 'Не найдена доступная оболочка для выполнения команды.');
        }
      }

      let exitCode = 0;
      let stdout = '';
      let stderr = '';
      try {
        const res = await execFileAsync(shellBin, shellArgs, {
          cwd,
          timeout: cfg.shellTimeoutMs,
          maxBuffer: 2 * 1024 * 1024,
          windowsHide: true,
        });
        stdout = res.stdout ?? '';
        stderr = res.stderr ?? '';
      } catch (execErr: unknown) {
        const errObj = execErr as {
          code?: number | string;
          killed?: boolean;
          stdout?: string;
          stderr?: string;
          message?: string;
        };
        exitCode = typeof errObj.code === 'number' ? errObj.code : 1;
        stdout = errObj.stdout ?? '';
        stderr = errObj.stderr ?? errObj.message ?? '';
        if (errObj.killed) {
          stderr += `\n[Процесс остановлен по таймауту ${cfg.shellTimeoutMs} мс]`;
        }
      }

      const clip = (s: string) => (s.length > 12_000 ? `${s.slice(0, 12_000)}\n... [вывод обрезан]` : s);
      const formatted = [
        `Shell: ${shellLabel}`,
        `CWD: ${cwd}`,
        `ExitCode: ${exitCode}`,
        stdout.trim() ? `STDOUT:\n${clip(stdout.trimEnd())}` : 'STDOUT: (пусто)',
        stderr.trim() ? `STDERR:\n${clip(stderr.trimEnd())}` : '',
      ]
        .filter(Boolean)
        .join('\n\n');

      const durationMs = Math.max(1, Math.round(performance.now() - startedAt));
      const status = exitCode === 0 ? 'completed' : 'error';
      recordAudit({
        modelAlias,
        toolName,
        argsSummary: summarizeArgs(args),
        allowed: true,
        status,
        durationMs,
        resultPreview: `exit=${exitCode} · ${(stdout || stderr || 'ok').trim().slice(0, 140)}`,
        ...(exitCode !== 0 ? { error: `Код выхода ${exitCode}` } : {}),
      });
      return { ok: exitCode === 0, status, output: formatted, durationMs };
    }

    return fail('error', `Неизвестный инструмент: ${toolName}`);
  } catch (err) {
    return fail('error', err instanceof Error ? err.message : String(err));
  }
}

export function getGeminiWorkspaceToolDeclarations(
  cfg: AgentPermissionsConfig
): FunctionDeclaration[] {
  if (!cfg.enabled) return [];
  const decls: FunctionDeclaration[] = [];

  if (cfg.allowReadFiles) {
    decls.push(
      {
        name: 'list_files',
        description:
          'Просмотреть список файлов и папок в рабочей директории (или указанной подпапке).',
        parameters: {
          type: Type.OBJECT,
          properties: {
            path: {
              type: Type.STRING,
              description: 'Относительный или абсолютный путь к директории (по умолчанию ".").',
            },
            recursive: {
              type: Type.BOOLEAN,
              description: 'Включить рекурсивный обход подпапок (по умолчанию false).',
            },
            maxEntries: {
              type: Type.NUMBER,
              description: 'Максимум элементов (по умолчанию 100, до 250).',
            },
          },
        },
      },
      {
        name: 'read_file',
        description: 'Прочитать содержимое текстового файла с нумерацией строк.',
        parameters: {
          type: Type.OBJECT,
          properties: {
            path: {
              type: Type.STRING,
              description: 'Путь к файлу для чтения.',
            },
            startLine: {
              type: Type.NUMBER,
              description: 'Начальная строка (с 1).',
            },
            endLine: {
              type: Type.NUMBER,
              description: 'Конечная строка.',
            },
          },
          required: ['path'],
        },
      }
    );
  }

  if (cfg.allowCreateFiles) {
    decls.push({
      name: 'create_file',
      description: 'Создать новый файл (или перезаписать существующий при overwrite=true).',
      parameters: {
        type: Type.OBJECT,
        properties: {
          path: {
            type: Type.STRING,
            description: 'Путь к создаваемому файлу.',
          },
          content: {
            type: Type.STRING,
            description: 'Полное текстовое содержимое файла.',
          },
          overwrite: {
            type: Type.BOOLEAN,
            description: 'Разрешить перезапись, если файл уже существует (по умолчанию false).',
          },
        },
        required: ['path', 'content'],
      },
    });
  }

  if (cfg.allowEditFiles) {
    decls.push({
      name: 'edit_file',
      description:
        'Отредактировать существующий файл: заменить точный фрагмент oldText на newText (mode="replace"), дописать в конец (mode="append") или полностью перезаписать (mode="overwrite").',
      parameters: {
        type: Type.OBJECT,
        properties: {
          path: {
            type: Type.STRING,
            description: 'Путь к редактируемому файлу.',
          },
          mode: {
            type: Type.STRING,
            description: 'Режим правки: "replace", "append" или "overwrite".',
          },
          oldText: {
            type: Type.STRING,
            description: 'Точный фрагмент текста для замены (обязателен для mode="replace").',
          },
          newText: {
            type: Type.STRING,
            description: 'Новый текст для вставки или замены.',
          },
          replaceAll: {
            type: Type.BOOLEAN,
            description: 'Заменить все вхождения oldText (по умолчанию false).',
          },
        },
        required: ['path', 'newText'],
      },
    });
  }

  if (cfg.allowDeleteFiles) {
    decls.push({
      name: 'delete_file',
      description: 'Удалить указанный файл.',
      parameters: {
        type: Type.OBJECT,
        properties: {
          path: {
            type: Type.STRING,
            description: 'Путь к удаляемому файлу.',
          },
        },
        required: ['path'],
      },
    });
  }

  if (cfg.allowShell) {
    decls.push({
      name: 'run_powershell',
      description:
        'Выполнить команду в PowerShell (или системном shell на Linux/macOS при настройке Auto) и вернуть stdout, stderr и exit code.',
      parameters: {
        type: Type.OBJECT,
        properties: {
          command: {
            type: Type.STRING,
            description: 'Команда PowerShell / скрипта для выполнения.',
          },
          cwd: {
            type: Type.STRING,
            description: 'Необязательная рабочая директория.',
          },
        },
        required: ['command'],
      },
    });
  }

  return decls;
}

export function getOpenAiWorkspaceTools(cfg: AgentPermissionsConfig) {
  const decls = getGeminiWorkspaceToolDeclarations(cfg);
  return decls.map((d) => ({
    type: 'function' as const,
    function: {
      name: d.name,
      description: d.description ?? '',
      parameters: convertSchemaToJsonSchema(d.parameters),
    },
  }));
}

function convertSchemaToJsonSchema(schema: unknown): Record<string, unknown> {
  if (!schema || typeof schema !== 'object') return { type: 'object', properties: {} };
  const s = schema as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  if (typeof s.type === 'string') {
    out.type = s.type.toLowerCase();
  }
  if (typeof s.description === 'string') {
    out.description = s.description;
  }
  if (Array.isArray(s.required)) {
    out.required = s.required;
  }
  if (s.properties && typeof s.properties === 'object') {
    const props: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(s.properties as Record<string, unknown>)) {
      props[k] = convertSchemaToJsonSchema(v);
    }
    out.properties = props;
  }
  return out;
}

export function buildAgentSystemGuidance(
  cfg: AgentPermissionsConfig,
  userSystemInstruction?: string
): string {
  const parts: string[] = [];
  if (userSystemInstruction?.trim()) {
    parts.push(userSystemInstruction.trim());
  }
  if (!cfg.enabled) {
    return parts.join('\n\n');
  }

  const env = detectShellEnvironment();
  const caps: string[] = [];
  if (cfg.allowReadFiles) caps.push('чтение/просмотр файлов (list_files, read_file)');
  if (cfg.allowCreateFiles) caps.push('создание файлов (create_file)');
  if (cfg.allowEditFiles) caps.push('редактирование файлов (edit_file)');
  if (cfg.allowDeleteFiles) caps.push('удаление файлов (delete_file)');
  if (cfg.allowShell) {
    caps.push(
      `выполнение команд ${env.powershellAvailable ? 'PowerShell' : 'терминала'} (run_powershell)`
    );
  }

  if (caps.length === 0) return parts.join('\n\n');

  parts.push(
    [
      `У тебя есть доступ к локальному окружению (ОС: ${env.platform}, рабочая папка: ${cfg.workspaceRoot}).`,
      `Разрешённые инструменты: ${caps.join('; ')}.`,
      cfg.restrictToWorkspace
        ? 'Все файловые операции и команды ограничены указанной рабочей папкой.'
        : 'Ограничение рабочей папкой снято пользователем (соблюдай осторожность).',
      'Если пользователь просит создать, прочитать, изменить, удалить файлы или выполнить скрипт/команду PowerShell — обязательно используй соответствующие инструменты вместо того, чтобы просто описывать шаги на словах, и сообщай только фактические результаты выполнения.',
    ].join('\n')
  );
  return parts.join('\n\n');
}
