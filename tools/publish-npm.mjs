#!/usr/bin/env node
// 发布 dsh-hud-capsule 到 npm。
// 用法：node tools/publish-npm.mjs <token-file>
// token 只用于临时 npmrc（落在 %TEMP%），发布结束立即删除。
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const tokenFile = process.argv[2] || join(root, 'npm-token.txt');
const token = readFileSync(tokenFile, 'utf8').trim();
if (!token) throw new Error(`empty token file: ${tokenFile}`);

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const pnpm = process.env.DSH_PNPM_CJS || 'C:/Users/35263/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/pnpm/bin/pnpm.cjs';
const nodeExe = process.execPath;

const dir = mkdtempSync(join(tmpdir(), 'npmrc-'));
const npmrc = join(dir, '.npmrc');
writeFileSync(npmrc, `//registry.npmjs.org/:_authToken=${token}\nregistry=https://registry.npmjs.org/\n`);

try {
  console.log(`publishing ${pkg.name}@${pkg.version} …`);
  const res = spawnSync(
    nodeExe,
    [pnpm, 'publish', '--access', 'public', '--no-git-checks', '--publish-branch', 'main', '--reporter', 'append-only'],
    {
      cwd: root,
      stdio: 'inherit',
      env: { ...process.env, npm_config_userconfig: npmrc, npm_config_registry: 'https://registry.npmjs.org/' },
    }
  );
  if (res.status !== 0) process.exitCode = res.status ?? 1;
  else console.log(`published ${pkg.name}@${pkg.version}`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
