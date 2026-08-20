// deploy orchestrator tests
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function prepareHarness(configuredTargets: Array<'app' | 'worker'>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-orchestrator-'));
  roots.push(root);
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  const commandLog = path.join(root, 'commands.log');
  const envFile = path.join(root, 'deploy.env');
  const appKey = path.join(root, 'app.pem');
  const workerKey = path.join(root, 'worker.pem');
  fs.writeFileSync(appKey, 'app-key');
  fs.writeFileSync(workerKey, 'worker-key');

  const settings: string[] = [];
  if (configuredTargets.includes('app')) {
    settings.push(
      'QP_APP_HOST=app.example.com',
      'QP_APP_SSH_USER=app-user',
      `QP_APP_SSH_KEY=${appKey}`,
      'QP_APP_SSH_PORT=2222',
      'QP_APP_SSH_HOST_KEY=yes',
    );
  }
  if (configuredTargets.includes('worker')) {
    settings.push(
      'QP_WORKER_HOST=worker.example.com',
      'QP_WORKER_SSH_USER=worker-user',
      `QP_WORKER_SSH_KEY=${workerKey}`,
      'QP_WORKER_SSH_PORT=2200',
      'QP_WORKER_SSH_HOST_KEY=accept-new',
      'QP_FORCE_WORKER_DEPLOY=0',
    );
  }
  fs.writeFileSync(envFile, `${settings.join('\n')}\n`);

  fs.writeFileSync(path.join(bin, 'ansible-playbook'), String.raw`#!/bin/sh
if [ "$1" = "--version" ]; then
  printf 'ansible-version\n' >> "$COMMAND_LOG"
  exit 0
fi
inventory=''
limit=''
variables=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    --inventory) inventory="$2"; shift 2 ;;
    --limit) limit="$2"; shift 2 ;;
    --extra-vars) variables="$2"; shift 2 ;;
    *) shift ;;
  esac
done
"$REAL_NODE" -e '
  const fs = require("node:fs");
  const [inventoryFile, target, variablesFile, logFile] = process.argv.slice(1);
  const inventory = JSON.parse(fs.readFileSync(inventoryFile, "utf8"));
  const variables = JSON.parse(fs.readFileSync(variablesFile.replace(/^@/, ""), "utf8"));
  const host = inventory.all.children[target].hosts[target];
  if (!host.ansible_ssh_common_args.includes("IdentitiesOnly=yes")) {
    process.stderr.write("missing IdentitiesOnly=yes\n");
    process.exit(91);
  }
  fs.appendFileSync(logFile, [
    "ansible", target, variables.deploy_mode, host.ansible_host,
    host.ansible_user ?? "", String(host.ansible_port ?? ""),
    variables.deploy_release_name ?? "",
  ].join(":") + "\n");
' "$inventory" "$limit" "$variables" "$COMMAND_LOG"
`);
  fs.writeFileSync(path.join(bin, 'bash'), String.raw`#!/bin/sh
script_name="$(basename "$1")"
case "$script_name" in
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
    : > "$output_dir/quant-backtest-worker-$release_name.tar"
    : > "$output_dir/quant-backtest-worker-$release_name.tar.sha256"
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
  for (const command of ['ansible-playbook', 'bash', 'docker']) {
    fs.chmodSync(path.join(bin, command), 0o755);
  }

  const environment = { ...process.env };
  for (const name of Object.keys(environment)) {
    if (name.startsWith('QP_') || name === 'ANSIBLE_CONFIG') delete environment[name];
  }
  Object.assign(environment, {
    PATH: `${bin}:${process.env.PATH}`,
    COMMAND_LOG: commandLog,
    REAL_NODE: process.execPath,
  });
  return { commandLog, envFile, environment };
}

function execute(harness: ReturnType<typeof prepareHarness>, target: string) {
  return spawnSync(process.execPath, [
    'scripts/deploy.mjs',
    '--env-file',
    harness.envFile,
    '--target',
    target,
  ], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: harness.environment,
  });
}

describe('Ansible deployment orchestrator', () => {
  it('deploys app and worker sequentially from one shared release for target all', () => {
    const harness = prepareHarness(['app', 'worker']);
    const result = execute(harness, 'all');
    const output = `${result.stdout}${result.stderr}`;
    expect(result.status, output).toBe(0);
    expect(fs.readFileSync(harness.commandLog, 'utf8').trim().split('\n')).toEqual([
      'ansible-version',
      'ansible:app:preflight:app.example.com:app-user:2222:',
      'ansible:worker:preflight:worker.example.com:worker-user:2200:',
      'docker:info',
      'docker:buildx version',
      'build-release',
      'build-worker-image:20260818-120000-abcdef1',
      'ansible:app:apply:app.example.com:app-user:2222:20260818-120000-abcdef1',
      'ansible:worker:apply:worker.example.com:worker-user:2200:20260818-120000-abcdef1',
    ]);
  });

  it('requires only app configuration and no Docker for target app', () => {
    const harness = prepareHarness(['app']);
    const result = execute(harness, 'app');
    const output = `${result.stdout}${result.stderr}`;
    expect(result.status, output).toBe(0);
    expect(fs.readFileSync(harness.commandLog, 'utf8').trim().split('\n')).toEqual([
      'ansible-version',
      'ansible:app:preflight:app.example.com:app-user:2222:',
      'build-release',
      'ansible:app:apply:app.example.com:app-user:2222:20260818-120000-abcdef1',
    ]);
    expect(output).toContain('배포 대상: app');
  });

  it('requires only worker configuration for target worker', () => {
    const harness = prepareHarness(['worker']);
    const result = execute(harness, 'worker');
    const output = `${result.stdout}${result.stderr}`;
    expect(result.status, output).toBe(0);
    expect(fs.readFileSync(harness.commandLog, 'utf8').trim().split('\n')).toEqual([
      'ansible-version',
      'ansible:worker:preflight:worker.example.com:worker-user:2200:',
      'docker:info',
      'docker:buildx version',
      'build-release',
      'build-worker-image:20260818-120000-abcdef1',
      'ansible:worker:apply:worker.example.com:worker-user:2200:20260818-120000-abcdef1',
    ]);
  });

  it('rejects infrastructure-oriented and unknown target names', () => {
    const harness = prepareHarness(['app']);
    const result = execute(harness, 'server');
    const output = `${result.stdout}${result.stderr}`;
    expect(result.status).not.toBe(0);
    expect(output).toContain('--target은 app | worker | all 중 하나여야 합니다');
    expect(existsSyncOrFalse(harness.commandLog)).toBe(false);
  });
});

function existsSyncOrFalse(file: string) {
  return fs.existsSync(file);
}
