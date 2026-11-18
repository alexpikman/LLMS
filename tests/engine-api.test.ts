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
const { executeWorkspaceTool, updateAccessConfig } = await import('../server/workspaceTools.ts');

const cleanupFns: Array<() => Promise<void> | void> = [];

async function bootTestServer() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vllm-api-test-'));
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vllm-work-test-'));
  process.env.VLLM_DATA_DIR = tmpDir;

  const engine = new ModelServerRuntime({ skipBackgroundInit: true, dataDir: tmpDir });
  const app = await createGatewayApp({ engine, enableVite: false });

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
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  return { baseUrl, engine, tmpDir, workDir };
}

afterEach(async () => {
  while (cleanupFns.length > 0) {
    const fn = cleanupFns.pop();
    if (fn) await fn();
  }
});

describe('Tokenless Gateway HTTP API, OpenAI Validation & Diagnostics', () => {
  it('exposes /health, /ready, /v1/models, /api/engine/state and /api/diagnostics without tokens', async () => {
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

    const modelsRes = await fetch(`${baseUrl}/v1/models`);
    assert.equal(modelsRes.status, 200);
    const modelsJson = (await modelsRes.json()) as { data: Array<{ id: string }> };
    assert.ok(modelsJson.data.some((m) => m.id === 'hydrogen-chat'));

    const stateRes = await fetch(`${baseUrl}/api/engine/state`);
    assert.equal(stateRes.status, 200);

    const diagRes = await fetch(`${baseUrl}/api/diagnostics`);
    assert.equal(diagRes.status, 200);
    const diag = (await diagRes.json()) as { version: string; config: { schemaVersion: number } };
    assert.equal(diag.version, '0.1.0');
    assert.ok(diag.config.schemaVersion >= 2);
  });

  it('validates OpenAI parameters and rejects SSRF download targets cleanly', async () => {
    const { baseUrl } = await bootTestServer();

    const emptyMsgs = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'hydrogen-chat', messages: [] }),
    });
    assert.equal(emptyMsgs.status, 400);

    const badTemp = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'hydrogen-chat',
        temperature: 4.5,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    assert.equal(badTemp.status, 400);

    const badN = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'hydrogen-chat',
        n: 2,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    assert.equal(badN.status, 400);

    const unknownModel = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'non-existent-model',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    assert.equal(unknownModel.status, 404);

    // SSRF target rejection on POST /api/downloads must return 400 asynchronously
    const ssrfRes = await fetch(`${baseUrl}/api/downloads`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        source: 'url',
        fileName: 'evil.gguf',
        downloadUrl: 'http://127.0.0.1:8080/evil.gguf',
      }),
    });
    assert.equal(ssrfRes.status, 400);
  });

  it('enforces ModelServerRuntime scheduler queue, SHA-256 RAM cache, and PagedAttention slot lifecycle', async () => {
    const { engine } = await bootTestServer();
    const dep = engine.findDeploymentByModel('hydrogen-chat');
    assert.ok(dep);

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

describe('Model OS Access Settings & Workspace Tools Execution', () => {
  it('persists access settings via /api/access/config and executes file + shell tools safely', async () => {
    const { baseUrl, tmpDir, workDir } = await bootTestServer();

    // Configure workspace root via HTTP API
    const putRes = await fetch(`${baseUrl}/api/access/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        enabled: true,
        workspaceRoot: workDir,
        restrictToWorkspace: true,
        allowReadFiles: true,
        allowCreateFiles: true,
        allowEditFiles: true,
        allowDeleteFiles: false,
        allowShell: true,
      }),
    });
    assert.equal(putRes.status, 200);
    const putJson = (await putRes.json()) as { config: { workspaceRoot: string; allowDeleteFiles: boolean } };
    assert.equal(putJson.config.workspaceRoot, path.resolve(workDir));
    assert.equal(putJson.config.allowDeleteFiles, false);

    // 1. Create file
    const created = await executeWorkspaceTool({
      toolName: 'create_file',
      args: { path: 'notes/demo.txt', content: 'line one\nline two\n' },
      modelAlias: 'hydrogen-chat',
      dataDir: tmpDir,
    });
    assert.equal(created.ok, true);
    assert.equal(fs.existsSync(path.join(workDir, 'notes/demo.txt')), true);

    // 2. Edit file (replace)
    const edited = await executeWorkspaceTool({
      toolName: 'edit_file',
      args: { path: 'notes/demo.txt', mode: 'replace', oldText: 'line two', newText: 'line TWO updated' },
      modelAlias: 'hydrogen-chat',
      dataDir: tmpDir,
    });
    assert.equal(edited.ok, true);
    assert.ok(fs.readFileSync(path.join(workDir, 'notes/demo.txt'), 'utf8').includes('line TWO updated'));

    // 3. Read file & list_files
    const readRes = await executeWorkspaceTool({
      toolName: 'read_file',
      args: { path: 'notes/demo.txt' },
      modelAlias: 'hydrogen-chat',
      dataDir: tmpDir,
    });
    assert.equal(readRes.ok, true);
    assert.ok(readRes.output.includes('line TWO updated'));

    const listRes = await executeWorkspaceTool({
      toolName: 'list_files',
      args: { path: '.', recursive: true },
      modelAlias: 'hydrogen-chat',
      dataDir: tmpDir,
    });
    assert.equal(listRes.ok, true);
    assert.ok(listRes.output.includes('notes/demo.txt'));

    // 4. Delete blocked when allowDeleteFiles === false
    const blockedDelete = await executeWorkspaceTool({
      toolName: 'delete_file',
      args: { path: 'notes/demo.txt' },
      modelAlias: 'hydrogen-chat',
      dataDir: tmpDir,
    });
    assert.equal(blockedDelete.ok, false);
    assert.equal(blockedDelete.status, 'blocked');

    // 5. Path traversal outside workspace blocked
    const escapeRes = await executeWorkspaceTool({
      toolName: 'read_file',
      args: { path: '../outside-secret.txt' },
      modelAlias: 'hydrogen-chat',
      dataDir: tmpDir,
    });
    assert.equal(escapeRes.ok, false);

    // 6. Shell command execution & blocked pattern enforcement
    const shellOk = await executeWorkspaceTool({
      toolName: 'run_powershell',
      args: { command: 'echo vllm-shell-ok' },
      modelAlias: 'hydrogen-chat',
      dataDir: tmpDir,
    });
    assert.equal(shellOk.ok, true);
    assert.ok(shellOk.output.includes('vllm-shell-ok'));

    const shellBlocked = await executeWorkspaceTool({
      toolName: 'run_powershell',
      args: { command: 'rm -rf /' },
      modelAlias: 'hydrogen-chat',
      dataDir: tmpDir,
    });
    assert.equal(shellBlocked.ok, false);
    assert.equal(shellBlocked.status, 'blocked');

    // 7. Enable delete and verify delete_file works
    updateAccessConfig({ allowDeleteFiles: true }, tmpDir);
    const deleteOk = await executeWorkspaceTool({
      toolName: 'delete_file',
      args: { path: 'notes/demo.txt' },
      modelAlias: 'hydrogen-chat',
      dataDir: tmpDir,
    });
    assert.equal(deleteOk.ok, true);
    assert.equal(fs.existsSync(path.join(workDir, 'notes/demo.txt')), false);

    // 8. Audit logs captured
    const logsRes = await fetch(`${baseUrl}/api/access/logs`);
    assert.equal(logsRes.status, 200);
    const logsJson = (await logsRes.json()) as { logs: Array<{ toolName: string }> };
    assert.ok(logsJson.logs.some((l) => l.toolName === 'create_file'));
    assert.ok(logsJson.logs.some((l) => l.toolName === 'run_powershell'));
  });
});
