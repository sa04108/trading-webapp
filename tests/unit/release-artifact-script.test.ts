import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash';
const roots: string[] = [];

describe('Docker 서버 업데이트 복구 경계', () => {
  it('실패한 준비 뒤 이전 이미지 시작을 막고 같은 후보의 성공 뒤에만 pin을 바꾼다', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'docker-release-'));
    roots.push(root);
    const bin = path.join(root, 'bin');
    fs.mkdirSync(bin);
    fs.mkdirSync(path.join(root, 'infra/server'), { recursive: true });
    fs.copyFileSync('server.env.example', path.join(root, 'server.env.example'));
    fs.copyFileSync('infra/server/app.env.example', path.join(root, 'infra/server/app.env.example'));
    const oldImage = `ghcr.io/example/server@sha256:${'a'.repeat(64)}`;
    const candidate = `ghcr.io/example/server@sha256:${'b'.repeat(64)}`;
    fs.writeFileSync(path.join(bin, 'docker'), `#!/bin/bash
printf '%s\\n' "$*" >> "$DOCKER_CALLS"
case "$*" in
  pull*) exit 0 ;;
  'image inspect'*) printf '%s\\n' "$CANDIDATE" ;;
  *'config --images server') echo ghcr.io/example/server:latest ;;
  *'run --rm --no-deps -T server node dist/server/cli.js db:prepare') exit "\${PREPARE_EXIT:-0}" ;;
  *'up -d --pull never --wait --wait-timeout 180') exit "\${START_EXIT:-0}" ;;
  *'ps --status running --services server') if [[ "\${SERVER_RUNNING:-0}" == 1 ]]; then echo server; fi ;;
esac
exit 0
`);
    fs.chmodSync(path.join(bin, 'docker'), 0o755);
    const log = path.join(root, 'docker.log');
    const run = (args: string[], env: Record<string, string | undefined> = {}) => spawnSync(bash,
      [path.resolve('scripts/server.sh'), ...args], {
        cwd: root, encoding: 'utf8', env: { ...process.env, QUANT_SERVER_HOME: root,
          PATH: `${bin}:${process.env.PATH}`, DOCKER_CALLS: log, CANDIDATE: candidate, ...env },
      });
    expect(run(['init']).status).toBe(0);
    const originalSecret = fs.readFileSync(path.join(root, 'app.env'), 'utf8');
    expect(run(['init']).status).toBe(0);
    expect(fs.readFileSync(path.join(root, 'app.env'), 'utf8')).toBe(originalSecret);
    fs.writeFileSync(path.join(root, '.server-image'), `${oldImage}\n`);
    expect(run(['cli', 'admin:create'], { SERVER_RUNNING: '1' }).status).not.toBe(0);
    for (const failure of [{ PREPARE_EXIT: '1' }, { START_EXIT: '1' }]) {
      expect(run(['update'], failure).status).not.toBe(0);
      expect(fs.readFileSync(path.join(root, '.server-image'), 'utf8').trim()).toBe(oldImage);
      expect(fs.readFileSync(path.join(root, '.server-update-pending'), 'utf8').trim()).toBe(candidate);
      fs.writeFileSync(log, '');
      expect(run(['up']).status).not.toBe(0);
      expect(fs.readFileSync(log, 'utf8')).not.toContain('up -d');
    }
    expect(run(['update']).status).toBe(0);
    expect(fs.existsSync(path.join(root, '.server-update-pending'))).toBe(false);
    expect(fs.readFileSync(path.join(root, '.server-image'), 'utf8').trim()).toBe(candidate);
    expect(fs.readFileSync(path.join(root, '.server-image.previous'), 'utf8').trim()).toBe(oldImage);
  });
});

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
    fs.writeFileSync(path.join(repo, 'scripts/install-agent-windows.ps1'), '# windows installer\n');
    fs.writeFileSync(path.join(repo, 'migrations', '0000.sql'), 'SELECT 1;\n');
    fs.writeFileSync(path.join(repo, 'package.json'), '{}\n');
    fs.writeFileSync(path.join(repo, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
    fs.writeFileSync(path.join(repo, 'pnpm-workspace.yaml'), 'packages: []\n');
    fs.writeFileSync(path.join(bin, 'git'), String.raw`#!/bin/sh
case "$*" in
  *'status --porcelain'*) exit 0 ;;
  *'rev-parse --short HEAD'*) exit 98 ;;
  *'rev-parse HEAD'*)
    count=0
    [ ! -f "$HEAD_CHECK_LOG" ] || count="$(wc -l < "$HEAD_CHECK_LOG")"
    printf 'head\n' >> "$HEAD_CHECK_LOG"
    if [ "$CHANGE_HEAD_AFTER_BUILD" = 1 ] && [ "$count" -gt 0 ]; then
      echo fedcba9876543210fedcba9876543210fedcba98
    else
      echo 0123456789abcdef0123456789abcdef01234567
    fi
    ;;
esac
`);
    fs.writeFileSync(path.join(bin, 'pnpm'), String.raw`#!/bin/sh
printf '%s\n' "$*" >> "$GATE_LOG"
if [ "$1" = build ]; then
  mkdir -p dist
  printf 'built\n' > dist/server.js
  mkdir -p dist/clients dist/agent-runtime
  printf 'legacy\n' > dist/clients/quant-agent-linux-x64.tar.gz
  printf 'internal\n' > dist/agent-runtime/quant-agent-runtime-linux-x64.tar.gz
fi
`);
    fs.chmodSync(path.join(bin, 'git'), 0o755);
    fs.chmodSync(path.join(bin, 'pnpm'), 0o755);
    const gateLog = path.join(root, 'gates.log');
    const headCheckLog = path.join(root, 'head-checks.log');
    const metadataFile = path.join(out, 'release-metadata.json');

    const result = spawnSync(bash, [
      path.join(repo, 'scripts/build-release.sh'),
      out,
      metadataFile,
    ], {
      cwd: repo,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        GATE_LOG: gateLog,
        HEAD_CHECK_LOG: headCheckLog,
      },
    });
    expect(`${result.stdout}${result.stderr}`).toContain('공통 release archive 생성');
    expect(result.status).toBe(0);
    expect(fs.readFileSync(gateLog, 'utf8').trim().split('\n')).toEqual([
      'install --frozen-lockfile',
      'lint',
      'typecheck',
      'test:all',
      'build',
    ]);
    expect(fs.readFileSync(headCheckLog, 'utf8').trim().split('\n')).toHaveLength(2);
    expect(JSON.parse(fs.readFileSync(metadataFile, 'utf8'))).toEqual({
      releaseName: expect.stringMatching(/^\d{8}-\d{6}-0123456$/),
      gitSha: '0123456789abcdef0123456789abcdef01234567',
    });
    const archive = fs.readdirSync(out).find((file) => file.endsWith('.tar.gz'))!;
    const checksum = fs.readFileSync(path.join(out, `${archive}.sha256`), 'utf8');
    expect(checksum).toMatch(/^[a-f0-9]{64} {2}quant-platform-/);
    const buildInfo = spawnSync('tar', ['-xOzf', path.join(out, archive), 'dist/build-info.json'], {
      encoding: 'utf8',
    });
    expect(JSON.parse(buildInfo.stdout)).toMatchObject({
      gitSha: '0123456789abcdef0123456789abcdef01234567',
    });
    const installer = spawnSync('tar', ['-xOzf', path.join(out, archive), 'scripts/install-agent-windows.ps1'], { encoding: 'utf8' });
    expect(installer.status).toBe(0);
    expect(installer.stdout).toBe('# windows installer\n');
    const entries = spawnSync('tar', ['-tzf', path.join(out, archive)], { encoding: 'utf8' });
    expect(entries.status).toBe(0);
    expect(entries.stdout).not.toMatch(/dist\/(clients|agent-runtime)\//);

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

    fs.writeFileSync(headCheckLog, '');
    const changedHead = spawnSync(bash, [
      path.join(repo, 'scripts/build-release.sh'),
      path.join(root, 'changed-head-output'),
    ], {
      cwd: repo,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        GATE_LOG: gateLog,
        HEAD_CHECK_LOG: headCheckLog,
        CHANGE_HEAD_AFTER_BUILD: '1',
      },
    });
    expect(changedHead.status).not.toBe(0);
    expect(changedHead.stderr).toContain('검증 중 HEAD가 바뀌어');
  });
});
