import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import net from 'node:net';
import https from 'node:https';
import { Readable } from 'node:stream';
import path from 'node:path';
import type { NextFunction, Request, Response } from 'express';
import {
  getDataDir,
  hashApiToken,
  loadOrInitConfig,
  saveConfigAtomic,
  type GatewayConfig,
} from './config.ts';
import { logger, maskSecretValue } from './logger.ts';

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'ip6-localhost',
  'ip6-loopback',
  'metadata',
  'metadata.google.internal',
  'metadata.goog',
]);

export function isPrivateOrReservedIp(rawIp: string): boolean {
  const ip = rawIp.replace(/^::ffff:/i, '');
  const version = net.isIP(ip);
  if (version === 0) return true;

  if (version === 4) {
    const octets = ip.split('.').map((n) => Number.parseInt(n, 10));
    if (octets.length !== 4 || octets.some((n) => Number.isNaN(n) || n < 0 || n > 255)) {
      return true;
    }
    const [a, b] = octets;
    if (a === 0) return true; // 0.0.0.0/8
    if (a === 10) return true; // 10.0.0.0/8
    if (a === 127) return true; // 127.0.0.0/8 loopback
    if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local & cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true; // 192.168.0.0/16
    if (a === 192 && b === 0 && octets[2] === 0) return true; // 192.0.0.0/24 protocol assignments
    if (a === 192 && b === 0 && octets[2] === 2) return true; // 192.0.2.0/24 documentation
    if (a === 192 && b === 88 && octets[2] === 99) return true; // 192.88.99.0/24 deprecated 6to4 relay
    if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 benchmarking
    if (a === 198 && b === 51 && octets[2] === 100) return true; // 198.51.100.0/24 documentation
    if (a === 203 && b === 0 && octets[2] === 113) return true; // 203.0.113.0/24 documentation
    if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
    if (a >= 224) return true; // multicast / reserved
    return false;
  }

  // IPv6 checks
  const lower = ip.toLowerCase();
  if (lower === '::' || lower === '::1') return true;
  if (lower.startsWith('fe80:')) return true; // link-local
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // ULA fc00::/7
  if (lower.startsWith('ff')) return true; // multicast
  if (lower.startsWith('2001:db8:') || lower.startsWith('2001:0:') || lower.startsWith('2002:')) return true;
  const firstHextet = Number.parseInt(lower.split(':')[0] || '0', 16);
  if ((firstHextet & 0xe000) !== 0x2000) return true; // Only global unicast 2000::/3 is routable
  return false;
}

export async function assertSafeRemoteUrl(rawUrl: string): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    throw new Error('Некорректный формат URL.');
  }

  if (parsed.protocol !== 'https:') {
    throw new Error('Разрешены только защищённые HTTPS-ссылки.');
  }
  if (parsed.username || parsed.password) {
    throw new Error('URL не должен содержать встроенные учётные данные.');
  }

  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!host || BLOCKED_HOSTNAMES.has(host) || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new Error(`Запрещённый хост (SSRF-защита): ${host}`);
  }

  if (net.isIP(host) !== 0) {
    if (isPrivateOrReservedIp(host)) {
      throw new Error(`Доступ к локальным или приватным IP запрещён (SSRF-защита): ${host}`);
    }
    return parsed;
  }

  let resolved: Array<{ address: string; family: number }>;
  try {
    resolved = await dns.lookup(host, { all: true });
  } catch {
    throw new Error(`Не удалось разрешить DNS-имя хоста: ${host}`);
  }

  if (!resolved || resolved.length === 0) {
    throw new Error(`DNS не вернул адресов для ${host}`);
  }

  for (const record of resolved) {
    if (isPrivateOrReservedIp(record.address)) {
      throw new Error(
        `Хост ${host} указывает на приватный/внутренний адрес и заблокирован SSRF-защитой.`
      );
    }
  }

  return parsed;
}

export async function safeFetch(
  rawUrl: string,
  init: RequestInit & { timeoutMs?: number; maxRedirects?: number } = {}
): Promise<globalThis.Response> {
  const maxRedirects = init.maxRedirects ?? 5;
  const timeoutMs = init.timeoutMs ?? 20_000;
  let currentUrl = rawUrl;

  for (let hop = 0; hop <= maxRedirects; hop++) {
    const safeUrl = await assertSafeRemoteUrl(currentUrl);
    const host = safeUrl.hostname.replace(/^\\[|\\]$/g, '');
    const resolved = await dns.lookup(host, { all: true, verbatim: true });
    if (!resolved.length || resolved.some((record) => isPrivateOrReservedIp(record.address))) {
      throw new Error(`DNS-адрес хоста ${host} не прошёл SSRF-проверку.`);
    }

    // Pin the socket to the exact public IP that was validated above. The TLS
    // server name remains the original hostname, preventing DNS rebinding
    // between validation and the actual TCP connection.
    const pinned = resolved[0];
    const headers = new Headers(init.headers);
    const requestHeaders: Record<string, string> = {};
    headers.forEach((value, key) => { requestHeaders[key] = value; });

    const response = await new Promise<globalThis.Response>((resolve, reject) => {
      const request = https.request({
        protocol: 'https:',
        hostname: host,
        port: safeUrl.port ? Number(safeUrl.port) : 443,
        path: `${safeUrl.pathname}${safeUrl.search}`,
        method: init.method ?? 'GET',
        headers: requestHeaders,
        servername: net.isIP(host) ? undefined : host,
        signal: init.signal ?? undefined,
        lookup: ((_hostname: string, _options: unknown, callback: (error: NodeJS.ErrnoException | null, address: string, family: number) => void) => {
          callback(null, pinned.address, pinned.family);
        }) as never,
      }, (incoming) => {
        const responseHeaders = new Headers();
        for (const [key, value] of Object.entries(incoming.headers)) {
          if (Array.isArray(value)) value.forEach((item) => responseHeaders.append(key, item));
          else if (typeof value === 'string') responseHeaders.set(key, value);
        }
        const status = incoming.statusCode ?? 502;
        const body = init.method?.toUpperCase() === 'HEAD' || status === 204 || status === 304
          ? null
          : Readable.toWeb(incoming) as ReadableStream<Uint8Array>;
        resolve(new Response(body, {
          status,
          statusText: incoming.statusMessage,
          headers: responseHeaders,
        }));
      });

      request.setTimeout(timeoutMs, () => request.destroy(new Error('Истекло время ожидания удалённого сервера.')));
      request.once('error', reject);

      const body = init.body;
      if (typeof body === 'string' || body instanceof Uint8Array) {
        request.write(body);
      } else if (body !== null && body !== undefined) {
        request.destroy(new Error('safeFetch поддерживает только строковое или бинарное тело запроса.'));
        return;
      }
      request.end();
    });

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location) {
        throw new Error(`Сервер вернул редирект ${response.status} без заголовка Location.`);
      }
      currentUrl = new URL(location, safeUrl).toString();
      continue;
    }

    return response;
  }

  throw new Error('Превышено максимальное число перенаправлений URL (SSRF-защита).');
}

export function assertSafeChildPath(baseDir: string, unsafeRelativePath: string): string {
  if (unsafeRelativePath.includes('\0')) {
    throw new Error('Недопустимый нулевой байт в пути файла.');
  }
  const resolvedBase = path.resolve(baseDir);
  const resolvedTarget = path.resolve(resolvedBase, unsafeRelativePath);
  const rel = path.relative(resolvedBase, resolvedTarget);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Попытка выхода за пределы целевой директории: ${unsafeRelativePath}`);
  }
  return resolvedTarget;
}

export function timingSafeStringsEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) {
    // Perform dummy comparison to keep timing uniform
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

const SESSION_COOKIE_NAME = 'vllm_session';

function parseCookies(cookieHeader: string | undefined): Record<string, string> {
  if (!cookieHeader) return {};
  const map: Record<string, string> = {};
  for (const part of cookieHeader.split(';')) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    try {
      map[key] = decodeURIComponent(val);
    } catch {
      // Ignore malformed cookie values instead of failing the whole request.
    }
  }
  return map;
}

export class AuthManager {
  private config: GatewayConfig;
  private dataDir: string;

  constructor(dataDir = getDataDir()) {
    this.dataDir = dataDir;
    this.config = loadOrInitConfig(dataDir);
  }

  public reload(): void {
    this.config = loadOrInitConfig(this.dataDir);
  }

  public getConfig(): GatewayConfig {
    return this.config;
  }

  public updatePagedConfig(paged: GatewayConfig['pagedAttention']): void {
    this.config.pagedAttention = paged;
    saveConfigAtomic(this.config, this.dataDir);
  }

  public hasEnvApiKey(): boolean {
    return Boolean(process.env.VLLM_API_KEY?.trim());
  }

  public isSetupRequired(): boolean {
    if (this.hasEnvApiKey()) return false;
    return !this.config.auth.setupCompleted || !this.config.auth.tokenHash;
  }

  public verifyToken(candidateToken: string): boolean {
    const clean = candidateToken.trim();
    if (!clean) return false;

    const envKey = process.env.VLLM_API_KEY?.trim();
    if (envKey) {
      return timingSafeStringsEqual(clean, envKey);
    }

    if (!this.config.auth.tokenHash || !this.config.auth.tokenSalt) {
      return false;
    }

    const { hash } = hashApiToken(clean, this.config.auth.tokenSalt);
    return timingSafeStringsEqual(hash, this.config.auth.tokenHash);
  }

  public setupInitialToken(requestedToken?: string): { token: string; prefix: string } {
    if (!this.isSetupRequired()) {
      throw new Error('Серверный токен доступа уже настроен.');
    }
    const raw =
      requestedToken && requestedToken.trim().length >= 16
        ? requestedToken.trim()
        : `sk-vllm-${crypto.randomBytes(24).toString('hex')}`;
    const { hash, salt } = hashApiToken(raw);
    const prefix = maskSecretValue(raw);

    this.config.auth.tokenHash = hash;
    this.config.auth.tokenSalt = salt;
    this.config.auth.tokenPrefix = prefix;
    this.config.auth.setupCompleted = true;
    saveConfigAtomic(this.config, this.dataDir);

    logger.info('auth', 'Первичный токен доступа к API настроен', { tokenPrefix: prefix });
    return { token: raw, prefix };
  }

  public rotateToken(newToken?: string): { token: string; prefix: string } {
    if (this.hasEnvApiKey()) {
      throw new Error('Токен задан через переменную окружения VLLM_API_KEY и не может быть изменён через API.');
    }
    const raw =
      newToken && newToken.trim().length >= 16
        ? newToken.trim()
        : `sk-vllm-${crypto.randomBytes(24).toString('hex')}`;
    const { hash, salt } = hashApiToken(raw);
    const prefix = maskSecretValue(raw);

    this.config.auth.tokenHash = hash;
    this.config.auth.tokenSalt = salt;
    this.config.auth.tokenPrefix = prefix;
    this.config.auth.sessionSecret = crypto.randomBytes(32).toString('hex');
    this.config.auth.setupCompleted = true;
    saveConfigAtomic(this.config, this.dataDir);

    logger.info('auth', 'Токен доступа к API перевыпущен', { tokenPrefix: prefix });
    return { token: raw, prefix };
  }

  public signSessionCookie(): string {
    const exp = Date.now() + 24 * 60 * 60 * 1000;
    const payload = `v1.${exp}`;
    const sig = crypto
      .createHmac('sha256', this.config.auth.sessionSecret)
      .update(payload)
      .digest('hex');
    return `${payload}.${sig}`;
  }

  public verifySessionCookie(cookieHeader: string | undefined): boolean {
    if (this.isSetupRequired()) return false;
    const cookies = parseCookies(cookieHeader);
    const raw = cookies[SESSION_COOKIE_NAME];
    if (!raw) return false;
    const parts = raw.split('.');
    if (parts.length !== 3 || parts[0] !== 'v1') return false;
    const exp = Number(parts[1]);
    if (!Number.isFinite(exp) || exp < Date.now()) return false;
    const expected = crypto
      .createHmac('sha256', this.config.auth.sessionSecret)
      .update(`${parts[0]}.${parts[1]}`)
      .digest('hex');
    return timingSafeStringsEqual(parts[2], expected);
  }

  public extractBearerOrApiKey(req: Request): string | null {
    const authHeader = req.headers.authorization;
    if (typeof authHeader === 'string' && authHeader.toLowerCase().startsWith('bearer ')) {
      return authHeader.slice(7).trim();
    }
    const apiKeyHeader = req.headers['x-api-key'];
    if (typeof apiKeyHeader === 'string' && apiKeyHeader.trim()) {
      return apiKeyHeader.trim();
    }
    return null;
  }

  public isRequestAuthenticated(req: Request): boolean {
    const bearer = this.extractBearerOrApiKey(req);
    if (bearer && this.verifyToken(bearer)) {
      return true;
    }
    return this.verifySessionCookie(req.headers.cookie);
  }

  public setSessionCookieHeader(res: Response, secure = false): void {
    const value = encodeURIComponent(this.signSessionCookie());
    res.setHeader(
      'Set-Cookie',
      `${SESSION_COOKIE_NAME}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400${secure ? '; Secure' : ''}`
    );
  }

  public clearSessionCookieHeader(res: Response, secure = false): void {
    res.setHeader(
      'Set-Cookie',
      `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`
    );
  }

  public getAuthStatus(req: Request): {
    authEnabled: boolean;
    setupRequired: boolean;
    authenticated: boolean;
    managedByEnv: boolean;
    tokenPrefix: string | null;
  } {
    const envKey = process.env.VLLM_API_KEY?.trim();
    return {
      authEnabled: true,
      setupRequired: this.isSetupRequired(),
      authenticated: this.isRequestAuthenticated(req),
      managedByEnv: Boolean(envKey),
      tokenPrefix: envKey ? maskSecretValue(envKey) : this.config.auth.tokenPrefix,
    };
  }
}

export function openAiError(
  message: string,
  type = 'invalid_request_error',
  param: string | null = null,
  code: string | null = null
) {
  return {
    error: {
      message,
      type,
      param,
      code,
    },
  };
}

export function createAuthMiddleware(authManager: AuthManager) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const bearer = authManager.extractBearerOrApiKey(req);
    const bearerAuthenticated = Boolean(bearer && authManager.verifyToken(bearer));
    const cookieAuthenticated = !bearerAuthenticated && authManager.verifySessionCookie(req.headers.cookie);

    if (bearerAuthenticated || cookieAuthenticated) {
      if (
        cookieAuthenticated &&
        !['GET', 'HEAD', 'OPTIONS'].includes(req.method.toUpperCase())
      ) {
        const origin = req.headers.origin;
        const host = req.headers.host;
        if (!origin || !host) {
          res.status(403).json(openAiError('Для cookie-сессии требуется same-origin запрос.', 'forbidden', null, 'csrf_check_failed'));
          return;
        }
        try {
          if (new URL(origin).host !== host) {
            res.status(403).json(openAiError('Cross-origin запросы с cookie-сессией запрещены.', 'forbidden', null, 'csrf_check_failed'));
            return;
          }
        } catch {
          res.status(403).json(openAiError('Некорректный заголовок Origin.', 'forbidden', null, 'csrf_check_failed'));
          return;
        }
      }
      next();
      return;
    }
    logger.warn('auth', 'Отклонён неавторизованный запрос', {
      path: req.path,
      ip: req.ip,
    });
    res.status(401).json(
      openAiError(
        'Требуется действующий API-токен (Authorization: Bearer <token>).',
        'authentication_error',
        null,
        'invalid_api_key'
      )
    );
  };
}

export function createRateLimiter(options: { windowMs: number; maxRequests: number }) {
  const hits = new Map<string, number[]>();

  return (req: Request, res: Response, next: NextFunction): void => {
    const key = req.ip || req.socket.remoteAddress || 'unknown';
    const now = Date.now();
    const cutoff = now - options.windowMs;
    const recent = (hits.get(key) ?? []).filter((ts) => ts > cutoff);

    if (recent.length >= options.maxRequests) {
      const retryAfterSec = Math.max(1, Math.ceil((recent[0] + options.windowMs - now) / 1000));
      res.setHeader('Retry-After', String(retryAfterSec));
      res.status(429).json(
        openAiError(
          'Превышен лимит частоты запросов. Повторите попытку позже.',
          'rate_limit_error',
          null,
          'rate_limit_exceeded'
        )
      );
      return;
    }

    recent.push(now);
    hits.set(key, recent);
    if (hits.size > 2000) {
      // Prune stale keys to keep memory bounded
      for (const [ipKey, list] of hits.entries()) {
        if (list.length === 0 || list[list.length - 1] <= cutoff) {
          hits.delete(ipKey);
        }
      }
    }
    next();
  };
}

export function validateAlias(alias: string): string {
  const clean = alias.trim();
  if (
    !/^[a-zA-Z0-9._:/-]{1,64}$/.test(clean) ||
    clean === '.' ||
    clean === '..' ||
    clean.includes('..') ||
    clean.startsWith('/') ||
    clean.endsWith('/')
  ) {
    throw new Error(
      'Имя модели (alias) должно содержать от 1 до 64 допустимых символов без сегментов "..".'
    );
  }
  return clean;
}

export function normalizeOpenAiMessages(rawMessages: unknown): Array<{
  role: 'system' | 'user' | 'assistant';
  content: string;
}> {
  if (!Array.isArray(rawMessages) || rawMessages.length === 0) {
    throw new Error('Поле messages должно содержать непустой массив сообщений.');
  }
  if (rawMessages.length > 200) {
    throw new Error('Превышено максимальное количество сообщений (200).');
  }

  return rawMessages.map((entry, idx) => {
    if (!entry || typeof entry !== 'object') {
      throw new Error(`Некорректный формат элемента messages[${idx}].`);
    }
    const obj = entry as Record<string, unknown>;
    const rawRole = typeof obj.role === 'string' ? obj.role : '';
    const role: 'system' | 'user' | 'assistant' =
      rawRole === 'developer' || rawRole === 'system'
        ? 'system'
        : rawRole === 'assistant'
        ? 'assistant'
        : rawRole === 'user'
        ? 'user'
        : (() => {
            throw new Error(`Неподдерживаемая роль messages[${idx}].role: "${rawRole}".`);
          })();

    let content = '';
    if (typeof obj.content === 'string') {
      content = obj.content;
    } else if (Array.isArray(obj.content)) {
      content = obj.content
        .map((part) => {
          if (typeof part === 'string') return part;
          if (part && typeof part === 'object') {
            const p = part as Record<string, unknown>;
            if (p.type === 'text' && typeof p.text === 'string') return p.text;
          }
          return '';
        })
        .join('\n');
    } else if (obj.content !== null && obj.content !== undefined) {
      throw new Error(`Поле messages[${idx}].content должно быть строкой или массивом текстовых блоков.`);
    }

    return { role, content };
  });
}
