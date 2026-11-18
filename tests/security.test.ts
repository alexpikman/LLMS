import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { maskSecretsInText, sanitizeLogMeta } from '../server/logger.ts';
import {
  AuthManager,
  assertSafeChildPath,
  assertSafeRemoteUrl,
  isPrivateOrReservedIp,
  normalizeOpenAiMessages,
  validateAlias,
} from '../server/security.ts';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vllm-sec-test-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('SSRF and Path Traversal Security', () => {
  it('detects private, loopback, link-local, and metadata IPs', () => {
    for (const ip of [
      '127.0.0.1',
      '10.0.0.5',
      '172.16.0.1',
      '192.168.1.42',
      '169.254.169.254',
      '100.64.0.10',
      '0.0.0.0',
      '::1',
      'fc00::1',
      'fe80::1',
    ]) {
      assert.equal(isPrivateOrReservedIp(ip), true, `Expected ${ip} to be blocked`);
    }

    assert.equal(isPrivateOrReservedIp('1.1.1.1'), false);
    assert.equal(isPrivateOrReservedIp('8.8.8.8'), false);
  });

  it('blocks unsafe remote URLs (SSRF)', async () => {
    await assert.rejects(() => assertSafeRemoteUrl('http://example.com/model.gguf'));
    await assert.rejects(() => assertSafeRemoteUrl('https://user:pass@1.1.1.1/model.gguf'));
    await assert.rejects(() => assertSafeRemoteUrl('https://localhost:3000/secret'));
    await assert.rejects(() => assertSafeRemoteUrl('https://127.0.0.1/secret'));
    await assert.rejects(() => assertSafeRemoteUrl('https://169.254.169.254/latest/meta-data/'));
    await assert.rejects(() => assertSafeRemoteUrl('https://metadata.google.internal/computeMetadata/v1/'));
    await assert.rejects(() => assertSafeRemoteUrl('https://my-host.local/file.gguf'));

    const allowed = await assertSafeRemoteUrl('https://1.1.1.1/model.gguf');
    assert.equal(allowed.hostname, '1.1.1.1');
  });

  it('prevents path traversal outside target base directory', () => {
    const base = makeTempDir();
    const ok = assertSafeChildPath(base, 'models/qwen.gguf');
    assert.equal(ok, path.join(base, 'models', 'qwen.gguf'));

    assert.throws(() => assertSafeChildPath(base, '../outside.gguf'));
    assert.throws(() => assertSafeChildPath(base, '/etc/passwd'));
    assert.throws(() => assertSafeChildPath(base, 'bad\0file.gguf'));
    assert.throws(() => assertSafeChildPath(base, '.'));
  });
});

describe('Log Redaction & OpenAI Input Validation', () => {
  it('masks bearer tokens, API keys, and sensitive log fields', () => {
    const text = 'Auth Bearer sk-vllm-1234567890abcdef and key AIzaSyD1234567890abcdefg plus hf_abcdefghijklm';
    const masked = maskSecretsInText(text);
    assert.equal(masked.includes('1234567890abcdef'), false);
    assert.equal(masked.includes('AIzaSyD1234567890abcdefg'), false);
    assert.equal(masked.includes('hf_abcdefghijklm'), false);

    const meta = sanitizeLogMeta({
      authorization: 'Bearer topsecret12345678',
      token: 'sk-vllm-9999888877776666',
      safeField: 'hello',
    }) as Record<string, unknown>;
    assert.equal(meta.safeField, 'hello');
    assert.equal(String(meta.authorization).includes('topsecret12345678'), false);
    assert.equal(String(meta.token).includes('9999888877776666'), false);
  });

  it('normalizes OpenAI messages including developer role and multi-part arrays', () => {
    const msgs = normalizeOpenAiMessages([
      { role: 'developer', content: 'Be concise' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Part 1' },
          { type: 'text', text: 'Part 2' },
        ],
      },
    ]);
    assert.deepEqual(msgs, [
      { role: 'system', content: 'Be concise' },
      { role: 'user', content: 'Part 1\nPart 2' },
    ]);

    assert.throws(() => normalizeOpenAiMessages([]));
    assert.throws(() => normalizeOpenAiMessages([{ role: 'tool_invalid', content: 'x' }]));
  });

  it('validates deployment alias strictly', () => {
    assert.equal(validateAlias(' qwen2.5:7b-instruct '), 'qwen2.5:7b-instruct');
    assert.throws(() => validateAlias('../bad-alias'));
    assert.throws(() => validateAlias('bad alias with spaces'));
  });
});

describe('AuthManager Token Lifecycle & Session Cookies', () => {
  it('supports one-time setup, scrypt verification, session cookie, and rotation', () => {
    const dir = makeTempDir();
    const auth = new AuthManager(dir);

    assert.equal(auth.isSetupRequired(), true);
    const { token: initialToken } = auth.setupInitialToken();
    assert.equal(auth.isSetupRequired(), false);
    assert.equal(auth.verifyToken(initialToken), true);
    assert.equal(auth.verifyToken('wrong-token-value'), false);

    // Subsequent setup should throw
    assert.throws(() => auth.setupInitialToken('another-token-value-1234'));

    // Signed session cookie works before rotation
    const cookieVal = auth.signSessionCookie();
    const cookieHeader = `vllm_session=${encodeURIComponent(cookieVal)}`;
    assert.equal(auth.verifySessionCookie(cookieHeader), true);

    // Rotation invalidates previous token and previous session cookie
    const { token: rotated } = auth.rotateToken();
    assert.notEqual(rotated, initialToken);
    assert.equal(auth.verifyToken(initialToken), false);
    assert.equal(auth.verifyToken(rotated), true);
    assert.equal(auth.verifySessionCookie(cookieHeader), false);
  });
});
