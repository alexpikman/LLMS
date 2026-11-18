import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import {
  CURRENT_CONFIG_SCHEMA_VERSION,
  loadOrInitConfig,
  migrateConfig,
} from '../server/config.ts';
import { installLlamaServerFromArchive } from '../server/downloader.ts';
import { assessModelCompatibility } from '../server/hardware.ts';
import type { HardwareProfile } from '../src/types/engine.ts';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vllm-cfg-test-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  delete process.env.VLLM_DATA_DIR;
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('Config Schema Migrations & Recovery', () => {
  it('migrates legacy v0 config to v1 and creates backup file', () => {
    const dir = makeTempDir();
    const cfgPath = path.join(dir, 'config.json');
    fs.writeFileSync(
      cfgPath,
      JSON.stringify({
        pagedAttention: {
          blockSize: 32,
          totalBlocks: 96,
          max_num_seqs: 12,
        },
      }),
      'utf8'
    );

    const { config, migrated, backupPath } = migrateConfig(
      JSON.parse(fs.readFileSync(cfgPath, 'utf8')) as Record<string, unknown>,
      cfgPath
    );

    assert.equal(migrated, true);
    assert.equal(config.schemaVersion, CURRENT_CONFIG_SCHEMA_VERSION);
    assert.equal(config.pagedAttention.blockSize, 32);
    assert.equal(config.pagedAttention.maxNumSeqs, 12);
    assert.ok(backupPath && fs.existsSync(backupPath));
  });

  it('recovers gracefully when config.json is corrupted', () => {
    const dir = makeTempDir();
    const cfgPath = path.join(dir, 'config.json');
    fs.writeFileSync(cfgPath, '{ invalid json !!!', 'utf8');

    const loaded = loadOrInitConfig(dir);
    assert.equal(loaded.schemaVersion, CURRENT_CONFIG_SCHEMA_VERSION);
    assert.equal(loaded.auth.setupCompleted, false);

    const files = fs.readdirSync(dir);
    assert.ok(files.some((f) => f.startsWith('config.json.corrupt.')));
  });
});

describe('Hardware Compatibility Assessment', () => {
  const baseHw: HardwareProfile = {
    hostname: 'test-pc',
    osPlatform: 'linux',
    osRelease: '6.8.0',
    arch: 'x64',
    cpuModel: 'Test Ryzen 9',
    cpuCores: 8,
    cpuThreads: 16,
    totalRamBytes: 32 * 1024 ** 3,
    freeRamBytes: 24 * 1024 ** 3,
    unifiedMemory: false,
    gpus: [
      {
        index: 0,
        name: 'NVIDIA RTX 4070',
        vendor: 'nvidia',
        vramTotalBytes: 12 * 1024 ** 3,
        vramFreeBytes: 10 * 1024 ** 3,
        driverVersion: '550.0',
      },
    ],
    totalVramBytes: 12 * 1024 ** 3,
    freeVramBytes: 10 * 1024 ** 3,
    diskFreeBytes: 100 * 1024 ** 3,
    diskTotalBytes: 500 * 1024 ** 3,
    modelsDir: '/tmp/models',
    binDir: '/tmp/bin',
    archivesDir: '/tmp/archives',
    vendorArchivesDir: '/tmp/vendor',
    llamaServerPath: null,
    llamaServerAvailable: false,
    llamaServerVersion: null,
    localArchives: [],
    detectedAtMs: Date.now(),
  };

  it('assigns gpu_full when model + KV fit in free VRAM', () => {
    const res = assessModelCompatibility(baseHw, 4 * 1024 ** 3, 2048);
    assert.equal(res.verdict, 'gpu_full');
    assert.equal(res.fitsInVram, true);
    assert.equal(res.recommendedGpuLayers, res.totalEstimatedLayers);
  });

  it('assigns gpu_partial when model exceeds VRAM but fits combined VRAM + RAM', () => {
    const res = assessModelCompatibility(baseHw, 14 * 1024 ** 3, 2048);
    assert.equal(res.verdict, 'gpu_partial');
    assert.equal(res.fitsInVram, false);
    assert.ok(res.recommendedGpuLayers > 0 && res.recommendedGpuLayers < res.totalEstimatedLayers);
  });

  it('assigns cpu_only when there is no GPU and model fits free RAM', () => {
    const cpuHw: HardwareProfile = {
      ...baseHw,
      gpus: [],
      totalVramBytes: 0,
      freeVramBytes: 0,
    };
    const res = assessModelCompatibility(cpuHw, 4 * 1024 ** 3, 2048);
    assert.equal(res.verdict, 'cpu_only');
    assert.equal(res.fitsInRam, true);
    assert.equal(res.recommendedGpuLayers, 0);
  });

  it('assigns insufficient when disk or memory is too small', () => {
    const res = assessModelCompatibility(baseHw, 60 * 1024 ** 3, 2048);
    assert.equal(res.verdict, 'insufficient');
  });
});

describe('Local Archive Installer (tar.gz)', () => {
  it('installs llama-server binary from a local tar.gz archive and rejects paths outside allowed roots', async () => {
    if (process.platform === 'win32') return;

    const dataDir = makeTempDir();
    process.env.VLLM_DATA_DIR = dataDir;
    const archivesDir = path.join(dataDir, 'archives');
    const staging = path.join(dataDir, 'staging');
    fs.mkdirSync(archivesDir, { recursive: true });
    fs.mkdirSync(staging, { recursive: true });

    const fakeBin = path.join(staging, 'llama-server');
    fs.writeFileSync(fakeBin, '#!/usr/bin/env bash\necho "version: b9999-test"\n', { mode: 0o755 });
    const archivePath = path.join(archivesDir, 'llama-test-bin.tar.gz');
    execFileSync('tar', ['-czf', archivePath, '-C', staging, 'llama-server']);

    const installed = await installLlamaServerFromArchive({ archivePath });
    assert.equal(fs.existsSync(installed.installedPath), true);
    assert.equal(installed.assetName, 'llama-test-bin.tar.gz');

    await assert.rejects(() =>
      installLlamaServerFromArchive({ archivePath: '/etc/passwd' })
    );
  });
});
