import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash';
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('Docker worker deployment', () => {
  it('takes an exclusive kernel lock and releases it after SIGKILL', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-flock-'));
    roots.push(root);
    const first = spawn('sh', [path.resolve('infra/docker/worker-entrypoint.sh'), 'sleep', '30'], {
      env: { ...process.env, BACKTEST_WORK_ROOT: root },
      stdio: 'ignore',
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const blocked = spawnSync('sh', [
      path.resolve('infra/docker/worker-entrypoint.sh'), 'sh', '-c', 'exit 0',
    ], { env: { ...process.env, BACKTEST_WORK_ROOT: root }, encoding: 'utf8' });
    expect(blocked.status).not.toBe(0);
    expect(blocked.stderr).toContain('다른 supervisor');

    first.kill('SIGKILL');
    await new Promise<void>((resolve) => first.once('exit', () => resolve()));
    const recovered = spawnSync('sh', [
      path.resolve('infra/docker/worker-entrypoint.sh'), 'sh', '-c', 'exit 0',
    ], { env: { ...process.env, BACKTEST_WORK_ROOT: root }, encoding: 'utf8' });
    expect(recovered.status).toBe(0);
  });

  it('declares a hardened, portless singleton with enough shutdown grace', () => {
    const compose = fs.readFileSync('infra/docker/compose.worker.yaml', 'utf8');
    expect(compose).toContain('restart: unless-stopped');
    expect(compose).toContain('read_only: true');
    expect(compose).toContain('no-new-privileges:true');
    expect(compose).toContain('cap_drop:');
    expect(compose).toContain('stop_grace_period: 30s');
    expect(compose).not.toMatch(/^\s+ports:/m);
    expect(compose).not.toContain('systemd');
  });

  it('keeps checksum verification, authenticated probe, and rollback in the remote transition', () => {
    const deploy = fs.readFileSync('scripts/deploy-worker.sh', 'utf8');
    const builder = fs.readFileSync('scripts/build-worker-image.sh', 'utf8');
    const orchestrator = fs.readFileSync('scripts/deploy.mjs', 'utf8');
    expect(deploy.indexOf('checksum 불일치')).toBeLessThan(deploy.indexOf('docker image load'));
    expect(deploy).toContain('remote-backtest-supervisor.js --check');
    expect(deploy).toContain('rollback()');
    expect(deploy).toContain('compose up -d --no-build --force-recreate worker');
    expect(deploy).toContain('/opt/quant-backtest-worker/managed-paths.json');
    expect(deploy).toContain('ACTUAL_MANIFEST_SHA');
    expect(deploy).toContain('bootstrap-worker.sh를 다시 실행하세요');
    expect(deploy).toContain('QP_DEPLOY_PREFLIGHT_ONLY');
    expect(deploy).toContain('QP_WORKER_IMAGE_ARCHIVE');
    expect(deploy).toContain('QP_WORKER_IMAGE_CHECKSUM');
    expect(builder).toContain('quant-backtest-worker-${release_name}.tar');
    expect(deploy).toContain('quant-backtest-worker-${RELEASE_NAME}.tar');
    expect(orchestrator).toContain('quant-backtest-worker-${releaseName}.tar');
    expect(deploy).not.toContain('systemctl');
  });

  it('treats an already compatible running Git SHA as a no-op before building an image', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-deploy-noop-'));
    roots.push(root);
    const bin = path.join(root, 'bin');
    fs.mkdirSync(bin);
    const commandLog = path.join(root, 'commands.log');
    const gitSha = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
    fs.writeFileSync(path.join(bin, 'ssh'), String.raw`#!/bin/sh
printf 'ssh:%s\n' "$*" >> "$COMMAND_LOG"
case "$*" in
  *'org.opencontainers.image.revision'*) printf '%s\n' "$CURRENT_GIT_SHA" ;;
  *'remote-backtest-supervisor.js --check'*) echo READY ;;
esac
cat >/dev/null || true
`);
    fs.writeFileSync(path.join(bin, 'scp'), String.raw`#!/bin/sh
printf 'scp:%s\n' "$*" >> "$COMMAND_LOG"
exit 99
`);
    fs.writeFileSync(path.join(bin, 'docker'), String.raw`#!/bin/sh
printf 'docker:%s\n' "$*" >> "$COMMAND_LOG"
exit 99
`);
    for (const command of ['ssh', 'scp', 'docker']) fs.chmodSync(path.join(bin, command), 0o755);

    const result = spawnSync(bash, ['scripts/deploy-worker.sh'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        COMMAND_LOG: commandLog,
        CURRENT_GIT_SHA: gitSha,
        QP_WORKER_HOST: 'worker.example.com',
      },
    });
    const output = `${result.stdout}${result.stderr}`;
    expect(result.status, output).toBe(0);
    expect(output).toContain('no-op');
    const commands = fs.readFileSync(commandLog, 'utf8');
    expect(commands).not.toContain('scp:');
    expect(commands).not.toContain('docker:');
  });
});
