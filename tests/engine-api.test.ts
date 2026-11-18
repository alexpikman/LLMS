import assert from 'node:assert/strict';
import fs from 'node:fs';
import type http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

process.env.VLLM_NO_LISTEN = '1';
process.env.NODE_ENV = 'test';

const { createGatewayApp } = await import('../server.ts');
const { ModelServerRuntime } = await import('../server/engine.ts');
const { AuthManager } = await import('../server/security.ts');

const cleanupFns: Array<() => Promise<void> | void> = [];

async function bootTestServer() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vllm-api-test-'));
  process.env.VLLM_DATA_DIR = tmpDir;

  const engine = new ModelServerRuntime({ skipBackgroundInit: true, dataDir: tmpDir });
  const authManager = new AuthManager(tmpDir);
  const app = await createGatewayApp({ engine, authManager, enableVite: false });

  const server = await new Promise<http.Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  const baseUrl = `http://127.0.0.1:${port}`;

  cleanupFns.push(async () => {
    engine.shutdown();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    delete process.env.VLLM_DATA_DIR;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  return { baseUrl, engine, authManager };
}

afterEach(async () => {
  while (cleanupFns.length > 0) {
    const fn = cleanupFns.pop();
    if (fn) await fn();
  }
});

describe('Gateway HTTP API Security & OpenAI Compliance', () => {
  it('exposes /health and /ready publicly and protects /v1/* and /api/*', async () => {
    const { baseUrl } = await bootTestServer();

    const healthRes = await fetch(`${baseUrl}/health`);
    assert.equal(healthRes.status, 200);
    const health = (await healthRes.json()) as { status: string; version: string };
    assert.equal(health.status, 'ok');
    assert.equal(health.version, '0.1.0');

    const readyRes = await fetch(`${baseUrl}/ready`);
    assert.equal(readyRes.status, 200);
    const ready = (await readyRes.json()) as { ready: boolean; dataDirWritable: boolean };
    assert.equal(ready.ready, true);
    assert.equal(ready.dataDirWritable, true);

    const unauthModels = await fetch(`${baseUrl}/v1/models`);
    assert.equal(unauthModels.status, 401);
    const unauthJson = (await unauthModels.json()) as { error?: { code?: string } };
    assert.equal(unauthJson.error?.code, 'invalid_api_key');

    const unauthState = await fetch(`${baseUrl}/api/engine/state`);
    assert.equal(unauthState.status, 401);
    const unauthConfig = await fetch(`${baseUrl}/api/server/config`);
    assert.equal(unauthConfig.status, 401);
  });

  it('completes setup once, authenticates via Bearer token & session cookie, and validates OpenAI payloads', async () => {
    const { baseUrl } = await bootTestServer();

    const statusBefore = (await (await fetch(`${baseUrl}/api/auth/status`)).json()) as {
      setupRequired: boolean;
      authenticated: boolean;
    };
    assert.equal(statusBefore.setupRequired, true);
    assert.equal(statusBefore.authenticated, false);

    const setupRes = await fetch(`${baseUrl}/api/auth/setup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(setupRes.status, 201);
    const setupJson = (await setupRes.json()) as { token: string };
    assert.ok(setupJson.token.startsWith('sk-vllm-'));

    // Second setup attempt must fail with 409
    const secondSetup = await fetch(`${baseUrl}/api/auth/setup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(secondSetup.status, 409);

    // Bearer access works on /v1/models
    const modelsRes = await fetch(`${baseUrl}/v1/models`, {
      headers: { Authorization: `Bearer ${setupJson.token}` },
    });
    assert.equal(modelsRes.status, 200);
    const modelsJson = (await modelsRes.json()) as { data: Array<{ id: string }> };
    assert.ok(modelsJson.data.some((m) => m.id === 'hydrogen-chat'));

    // Cookie login flow
    const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: setupJson.token }),
    });
    assert.equal(loginRes.status, 200);
    const cookie = loginRes.headers.get('set-cookie')?.split(';')[0] ?? '';
    assert.ok(cookie.startsWith('vllm_session='));

    const cookieModels = await fetch(`${baseUrl}/v1/models`, {
      headers: { Cookie: cookie },
    });
    assert.equal(cookieModels.status, 200);

    const csrfBlocked = await fetch(`${baseUrl}/api/engine/cache/clear`, {
      method: 'POST',
      headers: { Cookie: cookie },
    });
    assert.equal(csrfBlocked.status, 403);

    const csrfAllowed = await fetch(`${baseUrl}/api/engine/cache/clear`, {
      method: 'POST',
      headers: { Cookie: cookie, Origin: baseUrl },
    });
    assert.equal(csrfAllowed.status, 200);

    const protectedConfig = await fetch(`${baseUrl}/api/server/config`, {
      headers: { Authorization: `Bearer ${setupJson.token}` },
    });
    assert.equal(protectedConfig.status, 200);

    // OpenAI parameter validation (400 / 404)
    const emptyMsgs = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${setupJson.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model: 'hydrogen-chat', messages: [] }),
    });
    assert.equal(emptyMsgs.status, 400);

    const badTemp = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${setupJson.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'hydrogen-chat',
        temperature: 4.5,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    assert.equal(badTemp.status, 400);

    const badN = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${setupJson.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'hydrogen-chat',
        n: 2,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    assert.equal(badN.status, 400);

    const unknownModel = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${setupJson.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'non-existent-model',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    assert.equal(unknownModel.status, 404);

    // Diagnostics never leaks raw token
    const diagRes = await fetch(`${baseUrl}/api/diagnostics`, {
      headers: { Authorization: `Bearer ${setupJson.token}` },
    });
    assert.equal(diagRes.status, 200);
    const diagText = await diagRes.text();
    assert.equal(diagText.includes(setupJson.token), false);
    assert.equal(diagText.includes('tokenHash'), false);
    assert.equal(diagText.includes('sessionSecret'), false);

    const rotateRes = await fetch(`${baseUrl}/api/auth/rotate`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${setupJson.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    });
    assert.equal(rotateRes.status, 200);
    const rotated = (await rotateRes.json()) as { token: string };
    assert.ok(rotated.token.startsWith('sk-vllm-'));
    const oldTokenRes = await fetch(`${baseUrl}/v1/models`, {
      headers: { Authorization: `Bearer ${setupJson.token}` },
    });
    assert.equal(oldTokenRes.status, 401);
  });

  it('enforces ModelServerRuntime scheduler queue, SHA-256 RAM cache, and PagedAttention slot lifecycle', async () => {
    const { engine } = await bootTestServer();
    const dep = engine.findDeploymentByModel('hydrogen-chat');
    assert.ok(dep);

    // Restrict concurrency to 1 and verify second waiter blocks until releaseSlot
    engine.updatePagedConfig({ maxNumSeqs: 1 });
    const req1 = engine.createRequestRecord({
      deployment: dep,
      endpoint: '/v1/chat/completions',
      stream: false,
      promptPreview: 'First prompt',
      systemPrompt: 'System prefix',
    });
    const req2 = engine.createRequestRecord({
      deployment: dep,
      endpoint: '/v1/chat/completions',
      stream: false,
      promptPreview: 'Second prompt',
      systemPrompt: 'System prefix',
    });

    await engine.acquireSlot(dep.id, req1);
    let secondAcquired = false;
    const secondPromise = engine.acquireSlot(dep.id, req2).then(() => {
      secondAcquired = true;
    });

    await new Promise((r) => setTimeout(r, 20));
    assert.equal(secondAcquired, false);
    assert.equal(engine.getSnapshot().queuedRequestsCount, 1);

    engine.markRequestCompleted(dep.id, req1, {
      cacheHit: false,
      promptTokens: 16,
      completionTokens: 10,
      totalTokens: 26,
      ttftMs: 12,
      durationMs: 50,
    });
    engine.releaseSlot(dep.id);
    await secondPromise;
    assert.equal(secondAcquired, true);
    engine.releaseSlot(dep.id);

    // Verify RAM response cache
    const key = engine.computeCacheKey(dep, { messages: [{ role: 'user', content: 'ping' }] });
    engine.storeCache(dep, key, {
      text: 'pong',
      promptTokens: 4,
      completionTokens: 1,
      totalTokens: 5,
    });
    const hit = engine.lookupCache(dep, key);
    assert.equal(hit?.text, 'pong');
    assert.equal(engine.getSnapshot().cacheHitsTotal, 1);
  });
});
