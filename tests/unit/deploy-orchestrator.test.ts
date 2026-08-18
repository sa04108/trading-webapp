import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function prepareHarness(deployWorker: boolean) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-orchestrator-'));
  roots.push(root);
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  const commandLog = path.join(root, 'commands.log');
  const envFile = path.join(root, 'deploy.env');
  fs.writeFileSync(envFile, [
    `QP_DEPLOY_WORKER=${deployWorker ? '1' : '0'}`,
    'QP_SERVER_HOST=server.example.com',
    'QP_SERVER_SSH_USER=server-user',
    'QP_SERVER_SSH_KEY=/keys/server.pem',
    'QP_SERVER_SSH_PORT=2222',
    'QP_SERVER_SSH_HOST_KEY=yes',
    'QP_WORKER_HOST=worker.example.com',
    'QP_WORKER_SSH_USER=worker-user',
    'QP_WORKER_SSH_KEY=/keys/worker.pem',
    'QP_WORKER_SSH_PORT=2200',
    'QP_WORKER_SSH_HOST_KEY=accept-new',
    'QP_FORCE_WORKER_DEPLOY=0',
    '',
  ].join('\n'));

  fs.writeFileSync(path.join(bin, 'bash'), String.raw`#!/bin/sh
script_name="$(basename "$1")"
case "$script_name" in
  deploy-server.sh)
    if [ "$QP_DEPLOY_PREFLIGHT_ONLY" = 1 ]; then
      printf 'server-preflight:%s:%s:%s:%s\n' "$QP_HOST" "$QP_SSH_USER" "$SSH_KEY" "$QP_SSH_PORT" >> "$COMMAND_LOG"
    else
      printf 'server-deploy:%s:%s\n' "$QP_RELEASE_ARCHIVE" "$QP_RELEASE_CHECKSUM" >> "$COMMAND_LOG"
    fi
    ;;
  deploy-worker.sh)
    if [ "$QP_DEPLOY_PREFLIGHT_ONLY" = 1 ]; then
      printf 'worker-preflight:%s:%s:%s:%s\n' "$QP_WORKER_HOST" "$QP_SSH_USER" "$SSH_KEY" "$QP_SSH_PORT" >> "$COMMAND_LOG"
    else
      printf 'worker-deploy:%s:%s:%s\n' "$QP_RELEASE_ARCHIVE" "$QP_WORKER_IMAGE_ARCHIVE" "$QP_WORKER_IMAGE_CHECKSUM" >> "$COMMAND_LOG"
    fi
    ;;
  build-release.sh)
    output_dir="$2"
    mkdir -p "$output_dir"
    : > "$output_dir/quant-platform-20260818-120000-abcdef1.tar.gz"
    : > "$output_dir/quant-platform-20260818-120000-abcdef1.tar.gz.sha256"
    printf 'build-release\n' >> "$COMMAND_LOG"
    ;;
  build-worker-image.sh)
    output_dir="$5"
    release_name="$4"
    : > "$output_dir/quant-platform-backtest-worker-$release_name.tar"
    : > "$output_dir/quant-platform-backtest-worker-$release_name.tar.sha256"
    printf 'build-worker-image:%s\n' "$release_name" >> "$COMMAND_LOG"
    ;;
  *)
    printf 'unexpected-bash:%s\n' "$*" >> "$COMMAND_LOG"
    exit 90
    ;;
esac
`);
  fs.writeFileSync(path.join(bin, 'docker'), String.raw`#!/bin/sh
printf 'docker:%s\n' "$*" >> "$COMMAND_LOG"
`);
  fs.chmodSync(path.join(bin, 'bash'), 0o755);
  fs.chmodSync(path.join(bin, 'docker'), 0o755);

  const environment = { ...process.env };
  for (const name of Object.keys(environment)) {
    if (name.startsWith('QP_') || name === 'SSH_KEY') delete environment[name];
  }
  Object.assign(environment, {
    PATH: `${bin}:${process.env.PATH}`,
    COMMAND_LOG: commandLog,
  });
  return { commandLog, envFile, environment };
}

describe('unified deployment orchestrator', () => {
  it('builds one shared release and one image before deploying server and Worker', () => {
    const harness = prepareHarness(true);
    const result = spawnSync(process.execPath, [
      'scripts/deploy.mjs',
      '--env-file',
      harness.envFile,
    ], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: harness.environment,
    });
    const output = `${result.stdout}${result.stderr}`;
    expect(result.status, output).toBe(0);
    expect(fs.readFileSync(harness.commandLog, 'utf8').trim().split('\n')).toEqual([
      'server-preflight:server.example.com:server-user:/keys/server.pem:2222',
      'worker-preflight:worker.example.com:worker-user:/keys/worker.pem:2200',
      'docker:info',
      'docker:buildx version',
      'build-release',
      'build-worker-image:20260818-120000-abcdef1',
      expect.stringMatching(/^server-deploy:.*quant-platform-20260818-120000-abcdef1\.tar\.gz:.*\.sha256$/),
      expect.stringMatching(/^worker-deploy:.*quant-platform-20260818-120000-abcdef1\.tar\.gz:.*backtest-worker-20260818-120000-abcdef1\.tar:.*\.sha256$/),
    ]);
  });

  it('does not require Docker or Worker configuration for a server-only deployment', () => {
    const harness = prepareHarness(false);
    const result = spawnSync(process.execPath, [
      'scripts/deploy.mjs',
      `--env-file=${harness.envFile}`,
    ], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: harness.environment,
    });
    const output = `${result.stdout}${result.stderr}`;
    expect(result.status, output).toBe(0);
    expect(fs.readFileSync(harness.commandLog, 'utf8').trim().split('\n')).toEqual([
      'server-preflight:server.example.com:server-user:/keys/server.pem:2222',
      'build-release',
      expect.stringMatching(/^server-deploy:.*quant-platform-20260818-120000-abcdef1\.tar\.gz:.*\.sha256$/),
    ]);
    expect(output).toContain('Worker 배포: 비활성');
  });
});
