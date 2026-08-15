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

describe('Docker worker bootstrap', () => {
  it('uploads a protected env without printing its token and installs no app systemd unit', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-bootstrap-'));
    roots.push(root);
    const bin = path.join(root, 'bin');
    fs.mkdirSync(bin);
    const commandLog = path.join(root, 'commands.log');
    fs.writeFileSync(path.join(bin, 'ssh'), String.raw`#!/bin/sh
printf 'ssh:%s\n' "$*" >> "$COMMAND_LOG"
case "$*" in
  *'mktemp -d /tmp/quant-worker-bootstrap.XXXXXX'*) echo /tmp/quant-worker-bootstrap.ABC123 ;;
esac
cat >/dev/null || true
`);
    fs.writeFileSync(path.join(bin, 'scp'), String.raw`#!/bin/sh
printf 'scp:%s\n' "$*" >> "$COMMAND_LOG"
`);
    fs.chmodSync(path.join(bin, 'ssh'), 0o755);
    fs.chmodSync(path.join(bin, 'scp'), 0o755);
    const token = 'do-not-print-this-worker-token-1234567890';
    const envFile = path.join(root, 'worker.env');
    fs.writeFileSync(envFile, [
      'NODE_ENV=production',
      'BACKTEST_SERVER_URL=https://quant.example.com',
      `BACKTEST_WORKER_TOKEN=${token}`,
      'BACKTEST_WORKER_ID=worker-pc-1',
      'BACKTEST_WORKER_CONCURRENCY=1',
      'BACKTEST_WORK_ROOT=/var/lib/quant-backtest-worker',
      'BACKTEST_CLAIM_WAIT_SECONDS=25',
      'BACKTEST_HEARTBEAT_SECONDS=5',
      'LOG_LEVEL=info',
      '',
    ].join('\n'), { mode: 0o600 });

    const result = spawnSync(bash, ['scripts/bootstrap-worker.sh'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        COMMAND_LOG: commandLog,
        QP_WORKER_HOST: 'worker.example.com',
        QP_WORKER_ENV_FILE: envFile,
      },
    });
    const output = `${result.stdout}${result.stderr}`;
    expect(output, output).toContain('Docker Worker 부트스트랩 완료');
    expect(result.status).toBe(0);
    expect(output).not.toContain(token);
    const commands = fs.readFileSync(commandLog, 'utf8');
    expect(commands).toContain('provision-worker.sh');
    expect(commands).toContain('compose.worker.yaml');
    expect(commands).not.toContain('quant-backtest-worker.service');
  });

  it('rejects a group-readable worker env before connecting', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-bootstrap-mode-'));
    roots.push(root);
    const envFile = path.join(root, 'worker.env');
    fs.writeFileSync(envFile, 'NODE_ENV=production\n', { mode: 0o640 });
    fs.chmodSync(envFile, 0o640);
    const result = spawnSync(bash, ['scripts/bootstrap-worker.sh'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        ...process.env,
        QP_WORKER_HOST: 'worker.example.com',
        QP_WORKER_ENV_FILE: envFile,
      },
    });
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain('권한은 600 또는 400');
  });

  it('provisions Docker and atomically preserves worker env without installing Node or an app unit', () => {
    const provision = fs.readFileSync('infra/provision-worker.sh', 'utf8');
    expect(provision).toContain('docker-ce docker-ce-cli containerd.io');
    expect(provision).toContain('docker-compose-plugin');
    expect(provision).toContain('install_worker_env');
    expect(provision).toContain('mv "${env_tmp}" /etc/quant-platform/worker.env');
    expect(provision).toContain('QP_REPLACE_WORKER_ENV=1');
    expect(provision).not.toContain('quant-backtest-worker.service');
    expect(provision).not.toContain('nodejs.org');
    expect(provision).not.toContain(' caddy');
  });
});
