import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { build } from 'esbuild';

const rootDir = process.cwd();
const modeSea = process.argv.includes('--sea');
const distDir = path.join(rootDir, 'dist');
const serverOutDir = path.join(rootDir, 'dist-server');
const releaseDir = path.join(rootDir, 'release-build');

function run(cmd, args, opts = {}) {
  console.log(`> ${cmd} ${args.join(' ')}`);
  execFileSync(cmd, args, {
    stdio: 'inherit',
    cwd: rootDir,
    // Windows command shims (.cmd) must be launched through cmd.exe.
    shell: process.platform === 'win32' && cmd.toLowerCase().endsWith('.cmd'),
    ...opts,
  });
}

async function main() {
  console.log('[1/3] Building frontend assets via Vite...');
  run(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['vite', 'build']);

  if (!fs.existsSync(serverOutDir)) {
    fs.mkdirSync(serverOutDir, { recursive: true });
  }

  const bundlePath = path.join(serverOutDir, 'server.cjs');
  console.log('[2/3] Bundling server.ts via esbuild...');
  await build({
    entryPoints: [path.join(rootDir, 'server.ts')],
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'cjs',
    outfile: bundlePath,
    external: ['vite', '@vitejs/plugin-react', 'esbuild'],
    banner: {
      js: 'if (!process.env.NODE_ENV) { process.env.NODE_ENV = "production"; }',
    },
    logLevel: 'info',
  });

  if (!modeSea) {
    console.log(`Server bundle ready: ${bundlePath}`);
    return;
  }

  console.log('[3/3] Packaging standalone Node.js SEA binary...');
  fs.rmSync(releaseDir, { recursive: true, force: true });
  fs.mkdirSync(releaseDir, { recursive: true });

  const seaConfigPath = path.join(releaseDir, 'sea-config.json');
  const seaBlobPath = path.join(releaseDir, 'sea-prep.blob');
  const exeName = process.platform === 'win32' ? 'vllm-gateway.exe' : 'vllm-gateway';
  const targetBinPath = path.join(releaseDir, exeName);

  fs.writeFileSync(
    seaConfigPath,
    JSON.stringify(
      {
        main: bundlePath,
        output: seaBlobPath,
        disableExperimentalSEAWarning: true,
        useCodeCache: false,
      },
      null,
      2
    ),
    'utf8'
  );

  run(process.execPath, ['--experimental-sea-config', seaConfigPath]);
  fs.copyFileSync(process.execPath, targetBinPath);

  if (process.platform === 'darwin') {
    try {
      run('codesign', ['--remove-signature', targetBinPath]);
    } catch {
      // Ignore if not signed
    }
  }

  const postjectArgs = [
    'postject',
    targetBinPath,
    'NODE_SEA_BLOB',
    seaBlobPath,
    '--sentinel-fuse',
    'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
  ];
  if (process.platform === 'darwin') {
    postjectArgs.push('--macho-segment-name', 'NODE_SEA');
  }

  run(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['--yes', 'postject@1.0.0-alpha.6', ...postjectArgs]);

  if (process.platform === 'darwin') {
    run('codesign', ['--sign', '-', targetBinPath]);
  } else if (process.platform !== 'win32') {
    fs.chmodSync(targetBinPath, 0o755);
  }

  // Copy dist/ alongside the standalone binary
  fs.cpSync(distDir, path.join(releaseDir, 'dist'), { recursive: true });
  fs.rmSync(seaConfigPath, { force: true });
  fs.rmSync(seaBlobPath, { force: true });

  console.log(`Standalone binary package ready in: ${releaseDir}`);
}

main().catch((err) => {
  console.error('Build release failed:', err);
  process.exit(1);
});
