import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash';
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('shared release artifact builder', () => {
  it('runs every verification gate and emits a checksummed archive with build identity', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-builder-'));
    roots.push(root);
    const repo = path.join(root, 'repo');
    const bin = path.join(root, 'bin');
    const out = path.join(root, 'out');
    fs.mkdirSync(path.join(repo, 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(repo, 'migrations'), { recursive: true });
    fs.mkdirSync(bin);
    fs.copyFileSync(path.resolve('scripts/build-release.sh'), path.join(repo, 'scripts/build-release.sh'));
    fs.writeFileSync(path.join(repo, 'migrations', '0000.sql'), 'SELECT 1;\n');
    fs.writeFileSync(path.join(repo, 'package.json'), '{}\n');
    fs.writeFileSync(path.join(repo, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
    fs.writeFileSync(path.join(repo, 'pnpm-workspace.yaml'), 'packages: []\n');
    fs.writeFileSync(path.join(bin, 'git'), String.raw`#!/bin/sh
case "$*" in
  *'status --porcelain'*) exit 0 ;;
  *'rev-parse --short HEAD'*) echo 0123456 ;;
  *'rev-parse HEAD'*) echo 0123456789abcdef0123456789abcdef01234567 ;;
esac
`);
    fs.writeFileSync(path.join(bin, 'pnpm'), String.raw`#!/bin/sh
printf '%s\n' "$*" >> "$GATE_LOG"
if [ "$1" = build ]; then
  mkdir -p dist
  printf 'built\n' > dist/server.js
fi
`);
    fs.chmodSync(path.join(bin, 'git'), 0o755);
    fs.chmodSync(path.join(bin, 'pnpm'), 0o755);
    const gateLog = path.join(root, 'gates.log');

    const result = spawnSync(bash, [path.join(repo, 'scripts/build-release.sh'), out], {
      cwd: repo,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, GATE_LOG: gateLog },
    });
    expect(`${result.stdout}${result.stderr}`).toContain('공통 release archive 생성');
    expect(result.status).toBe(0);
    expect(fs.readFileSync(gateLog, 'utf8').trim().split('\n')).toEqual([
      'install --frozen-lockfile',
      'lint',
      'typecheck',
      'test',
      'build',
    ]);
    const archive = fs.readdirSync(out).find((file) => file.endsWith('.tar.gz'))!;
    const checksum = fs.readFileSync(path.join(out, `${archive}.sha256`), 'utf8');
    expect(checksum).toMatch(/^[a-f0-9]{64} {2}quant-platform-/);
    const buildInfo = spawnSync('tar', ['-xOzf', path.join(out, archive), 'dist/build-info.json'], {
      encoding: 'utf8',
    });
    expect(JSON.parse(buildInfo.stdout)).toMatchObject({
      gitSha: '0123456789abcdef0123456789abcdef01234567',
    });

    const verified = spawnSync(bash, ['-c', 'source "$1"; verify_release_checksum "$2" "$3"', '_',
      path.join(repo, 'scripts/build-release.sh'),
      path.join(out, archive),
      path.join(out, `${archive}.sha256`),
    ], { encoding: 'utf8' });
    expect(verified.status, verified.stderr).toBe(0);
    fs.appendFileSync(path.join(out, archive), 'tampered');
    const rejected = spawnSync(bash, ['-c', 'source "$1"; verify_release_checksum "$2" "$3"', '_',
      path.join(repo, 'scripts/build-release.sh'),
      path.join(out, archive),
      path.join(out, `${archive}.sha256`),
    ], { encoding: 'utf8' });
    expect(rejected.status).not.toBe(0);
    expect(rejected.stderr).toContain('checksum이 일치하지 않습니다');
  });
});
