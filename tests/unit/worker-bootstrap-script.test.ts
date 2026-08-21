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
      'BACKTEST_APP_URL=https://quant.example.com',
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
    expect(commands).toContain('worker-host-manifest.json');
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

  it('rejects a zero claim wait before connecting', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-bootstrap-claim-wait-'));
    roots.push(root);
    const envFile = path.join(root, 'worker.env');
    fs.writeFileSync(envFile, [
      'NODE_ENV=production',
      'BACKTEST_APP_URL=https://quant.example.com',
      'BACKTEST_WORKER_TOKEN=worker-token-long-enough-for-validation',
      'BACKTEST_WORKER_ID=worker-pc-1',
      'BACKTEST_WORKER_CONCURRENCY=1',
      'BACKTEST_WORK_ROOT=/var/lib/quant-backtest-worker',
      'BACKTEST_CLAIM_WAIT_SECONDS=0',
      'BACKTEST_HEARTBEAT_SECONDS=5',
      'LOG_LEVEL=info',
      '',
    ].join('\n'), { mode: 0o600 });
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
    expect(`${result.stdout}${result.stderr}`).toContain('1~25 정수');
  });

  it('provisions Docker and atomically preserves worker env without installing Node or an app unit', () => {
    const provision = fs.readFileSync('infra/provision-worker.sh', 'utf8');
    expect(provision).toContain('docker-ce docker-ce-cli containerd.io');
    expect(provision).toContain('docker-compose-plugin');
    expect(provision).toContain('install_worker_env');
    expect(provision).toContain('install_worker_manifest');
    expect(provision).toContain('mv "${env_tmp}" /etc/quant-platform/worker.env');
    expect(provision).toContain('backup_worker_env');
    expect(provision).toContain('mv "${backup_tmp}" /etc/quant-platform/worker.env.bak');
    expect(provision).toContain("-name 'worker.env.*.bak' -delete");
    expect(provision).not.toContain('date -u +%Y%m%d-%H%M%S');
    expect(provision).toContain('QP_REPLACE_WORKER_ENV=1');
    expect(provision).not.toContain('quant-backtest-worker.service');
    expect(provision).not.toContain('nodejs.org');
    expect(provision).not.toContain(' caddy');
  });

  it('tracks persistent, transient, and shared dependency paths in the host manifest', () => {
    const manifest = JSON.parse(fs.readFileSync('infra/worker-host-manifest.json', 'utf8')) as {
      schemaVersion: number;
      manifestPath: string;
      managedPaths: Array<{ path: string; cleanupPolicy: string }>;
      transientPathPatterns: string[];
      legacyPathPatterns: string[];
      hostDependencies: { paths: string[]; packages: string[]; cleanupPolicy: string };
    };
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.manifestPath).toBe('/opt/quant-backtest-worker/managed-paths.json');
    const managed = new Map(manifest.managedPaths.map((entry) => [entry.path, entry.cleanupPolicy]));
    expect([...managed.keys()].sort()).toEqual([
      '/etc/quant-platform',
      '/etc/quant-platform/worker.env',
      '/etc/quant-platform/worker.env.bak',
      '/opt/quant-backtest-worker',
      '/opt/quant-backtest-worker/compose.env',
      '/opt/quant-backtest-worker/compose.yaml',
      '/opt/quant-backtest-worker/managed-paths.json',
      '/var/lib/quant-backtest-worker',
    ].sort());
    expect(Object.fromEntries(managed)).toMatchObject({
      '/opt/quant-backtest-worker/compose.yaml': 'remove',
      '/opt/quant-backtest-worker/compose.env': 'remove',
      '/etc/quant-platform/worker.env': 'purge-config',
      '/etc/quant-platform/worker.env.bak': 'purge-config',
      '/var/lib/quant-backtest-worker': 'confirm-purge-data',
      '/opt/quant-backtest-worker/managed-paths.json': 'remove-last',
    });
    expect(manifest.transientPathPatterns).toEqual(expect.arrayContaining([
      '/etc/quant-platform/worker.env.XXXXXX',
      '/opt/quant-backtest-worker/compose.env.XXXXXX',
      '/opt/quant-backtest-worker/managed-paths.json.XXXXXX',
      '/tmp/quant-worker-docker-key.XXXXXX',
      '/tmp/quant-worker-docker-source.XXXXXX',
      '/tmp/quant-worker-bootstrap.XXXXXX',
      '/tmp/quant-worker-deploy.XXXXXX',
      '/tmp/quant-worker-rollback.XXXXXX',
    ]));
    expect(manifest.legacyPathPatterns).toEqual(['/etc/quant-platform/worker.env.*.bak']);
    expect(manifest.hostDependencies.paths).toEqual(expect.arrayContaining([
      '/etc/apt/keyrings',
      '/etc/apt/keyrings/docker.asc',
      '/etc/apt/sources.list.d/docker.sources',
    ]));
    expect(manifest.hostDependencies.packages).toContain('docker-compose-plugin');
    expect(manifest.hostDependencies.cleanupPolicy).toBe('retain-shared');
  });
});
