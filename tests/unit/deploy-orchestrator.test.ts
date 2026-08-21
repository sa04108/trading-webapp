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
  const inventoryFile = path.join(root, 'inventory.json');
  const hostvars: Record<string, Record<string, string | number>> = {};
  const inventory: Record<string, unknown> = {
    _meta: { hostvars },
    all: { children: configuredTargets },
  };

  if (configuredTargets.includes('app')) {
    inventory.app = { hosts: ['app-node'] };
    hostvars['app-node'] = {
      ansible_host: 'app.example.com',
      ansible_user: 'app-user',
      ansible_port: 2222,
      ansible_ssh_common_args: '-o StrictHostKeyChecking=yes -o IdentitiesOnly=yes',
    };
  }
  if (configuredTargets.includes('worker')) {
    inventory.worker = { hosts: ['worker-node'] };
    hostvars['worker-node'] = {
      ansible_host: 'worker.example.com',
      ansible_user: 'worker-user',
      ansible_port: 2200,
      ansible_ssh_common_args: '-o StrictHostKeyChecking=accept-new -o IdentitiesOnly=yes',
    };
  }
  fs.writeFileSync(inventoryFile, JSON.stringify(inventory));

  fs.writeFileSync(path.join(bin, 'ansible-inventory'), String.raw`#!/bin/sh
printf 'ansible-inventory\n' >> "$COMMAND_LOG"
cat "$ANSIBLE_INVENTORY"
`);
  fs.writeFileSync(path.join(bin, 'ansible-playbook'), String.raw`#!/bin/sh
if [ "$1" = "--version" ]; then
  printf 'ansible-version\n' >> "$COMMAND_LOG"
  exit 0
fi
limit=''
variables=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    --limit) limit="$2"; shift 2 ;;
    --extra-vars) variables="$2"; shift 2 ;;
    *) shift ;;
  esac
done
"$REAL_NODE" -e '
  const fs = require("node:fs");
  const [target, variablesFile, logFile] = process.argv.slice(1);
  const inventory = JSON.parse(fs.readFileSync(process.env.ANSIBLE_INVENTORY, "utf8"));
  const variables = JSON.parse(fs.readFileSync(variablesFile.replace(/^@/, ""), "utf8"));
  const hostName = inventory[target].hosts[0];
  const host = inventory._meta.hostvars[hostName];
  if (!host.ansible_ssh_common_args.includes("IdentitiesOnly=yes")) {
    process.stderr.write("missing IdentitiesOnly=yes\n");
    process.exit(91);
  }
  if (target === "worker" && variables.deploy_mode === "preflight" &&
      !/^[a-f0-9]{64}$/.test(variables.worker_manifest_sha ?? "")) {
    process.stderr.write("missing worker manifest checksum\n");
    process.exit(92);
  }
  fs.appendFileSync(logFile, [
    "ansible", target, variables.deploy_mode, host.ansible_host,
    host.ansible_user ?? "", String(host.ansible_port ?? ""),
    variables.deploy_release_name ?? "",
  ].join(":") + "\n");
  if ("worker_force_deploy" in variables) process.exit(93);
' "$limit" "$variables" "$COMMAND_LOG"
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
  for (const command of ['ansible-inventory', 'ansible-playbook', 'bash', 'docker']) {
    fs.chmodSync(path.join(bin, command), 0o755);
  }

  const environment = { ...process.env };
  for (const name of Object.keys(environment)) {
    if (name.startsWith('QP_') || name.startsWith('ANSIBLE_')) delete environment[name];
  }
  Object.assign(environment, {
    PATH: `${bin}:${process.env.PATH}`,
    COMMAND_LOG: commandLog,
    REAL_NODE: process.execPath,
    ANSIBLE_INVENTORY: inventoryFile,
  });
  return { commandLog, inventoryFile, environment };
}

function execute(harness: ReturnType<typeof prepareHarness>, target?: string) {
  const args = ['scripts/deploy.mjs'];
  if (target !== undefined) args.push('--target', target);
  return spawnSync(process.execPath, args, {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: harness.environment,
  });
}

describe('Ansible deployment orchestrator', () => {
  it('defaults to app and worker when inventory contains both groups', () => {
    const harness = prepareHarness(['app', 'worker']);
    const result = execute(harness);
    const output = `${result.stdout}${result.stderr}`;
    expect(result.status, output).toBe(0);
    expect(fs.readFileSync(harness.commandLog, 'utf8').trim().split('\n')).toEqual([
      'ansible-version',
      'ansible-inventory',
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

  it('defaults to app only when inventory has no worker host', () => {
    const harness = prepareHarness(['app']);
    const result = execute(harness);
    const output = `${result.stdout}${result.stderr}`;
    expect(result.status, output).toBe(0);
    expect(fs.readFileSync(harness.commandLog, 'utf8').trim().split('\n')).toEqual([
      'ansible-version',
      'ansible-inventory',
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
      'ansible-inventory',
      'ansible:worker:preflight:worker.example.com:worker-user:2200:',
      'docker:info',
      'docker:buildx version',
      'build-release',
      'build-worker-image:20260818-120000-abcdef1',
      'ansible:worker:apply:worker.example.com:worker-user:2200:20260818-120000-abcdef1',
    ]);
  });

  it('requires a worker host when target all is explicit', () => {
    const harness = prepareHarness(['app']);
    const result = execute(harness, 'all');
    const output = String(result.stdout) + String(result.stderr);
    expect(result.status).not.toBe(0);
    expect(output).toContain('Ansible inventory의 worker 그룹에 호스트가 없습니다');
    expect(fs.readFileSync(harness.commandLog, 'utf8').trim().split('\n')).toEqual([
      'ansible-version',
      'ansible-inventory',
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
