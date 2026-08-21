import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

type DeployTarget = 'app' | 'worker';

const roots: string[] = [];
const releaseGitSha = 'a'.repeat(40);

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function writeExecutable(file: string, content: string) {
  fs.writeFileSync(file, content);
  fs.chmodSync(file, 0o755);
}

function prepareHarness(configuredTargets: DeployTarget[]) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-orchestrator-'));
  roots.push(root);
  const bin = path.join(root, 'bin');
  const scripts = path.join(root, 'scripts');
  const dockerInfra = path.join(root, 'infra', 'docker');
  fs.mkdirSync(bin);
  fs.mkdirSync(scripts);
  fs.mkdirSync(dockerInfra, { recursive: true });
  fs.copyFileSync('scripts/deploy.mjs', path.join(scripts, 'deploy.mjs'));
  fs.writeFileSync(path.join(scripts, 'deploy-app.sh'), '#!/bin/bash\n');
  fs.writeFileSync(path.join(scripts, 'deploy-worker.sh'), '#!/bin/bash\n');
  fs.writeFileSync(path.join(dockerInfra, 'compose.worker.yaml'), 'services: {}\n');
  const manifest = '{"managedPaths":[]}\n';
  fs.writeFileSync(path.join(root, 'infra', 'worker-host-manifest.json'), manifest);

  const commandLog = path.join(root, 'commands.log');
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
      'QP_APP_SSH_JUMP=app-jump.example.com',
      'QP_APP_SSH_OPTS="-o ServerAliveInterval=30 -o \'SetEnv=QP_TEST=value with spaces\'"',
    );
  }
  if (configuredTargets.includes('worker')) {
    settings.push(
      'QP_WORKER_HOST=worker-user@worker.example.com',
      'QP_WORKER_SSH_USER=worker-user',
      `QP_WORKER_SSH_KEY=${workerKey}`,
      'QP_WORKER_SSH_PORT=2200',
      'QP_WORKER_SSH_HOST_KEY=accept-new',
      'QP_WORKER_SSH_JUMP=',
      'QP_WORKER_SSH_OPTS=',
    );
  }
  fs.writeFileSync(path.join(root, 'deploy.env'), `${settings.join('\n')}\n`);

  const nodeShebang = `#!${process.execPath}`;
  writeExecutable(path.join(bin, 'ssh'), `${nodeShebang}
const fs = require('node:fs');
const args = process.argv.slice(2);
const optionsWithValues = new Set([
  '-b', '-c', '-D', '-E', '-e', '-F', '-I', '-i', '-J', '-L', '-l', '-m', '-O',
  '-o', '-p', '-Q', '-R', '-S', '-W', '-w',
]);
let index = 0;
const options = [];
while (index < args.length && args[index].startsWith('-')) {
  const option = args[index];
  options.push(option);
  index += 1;
  if (optionsWithValues.has(option)) {
    options.push(args[index]);
    index += 1;
  }
}
const target = args[index];
const command = args.slice(index + 1).join(' ');
const component = target.includes('app.example.com') ? 'app' : 'worker';
const required = component === 'app'
  ? [process.env.APP_KEY, 'Port=2222', 'ProxyJump=app-jump.example.com',
    'StrictHostKeyChecking=yes', 'ServerAliveInterval=30', 'SetEnv=QP_TEST=value with spaces']
  : [process.env.WORKER_KEY, 'Port=2200', 'StrictHostKeyChecking=accept-new'];
for (const value of required) {
  if (!options.includes(value)) {
    process.stderr.write('missing SSH option: ' + value + '\\n');
    process.exit(91);
  }
}
let event = '';
if (command.includes('/etc/quant-platform/app.env')) {
  event = 'ssh:app:preflight';
  if (!options.includes('BatchMode=yes') || !options.includes('ConnectTimeout=15')) process.exit(92);
} else if (command.includes('/etc/quant-platform/worker.env')) {
  event = 'ssh:worker:preflight';
  if (!options.includes('BatchMode=yes') || !options.includes('ConnectTimeout=15')) process.exit(92);
  if (!command.includes(process.env.MANIFEST_SHA)) process.exit(93);
} else if (command.includes('mktemp -d /tmp/quant-app-deploy.')) {
  event = 'ssh:app:mktemp';
} else if (command.includes('mktemp -d /tmp/quant-worker-deploy.')) {
  event = 'ssh:worker:mktemp';
} else if (command.includes('/deploy-app.sh')) {
  for (const phase of ['prepare', 'verify', 'commit', 'finalize', 'rollback']) {
    if (command.includes("'" + phase + "'")) event = 'ssh:app:' + phase;
  }
  if (!event) process.exit(99);
} else if (command.includes('/deploy-worker.sh')) {
  for (const phase of ['prepare', 'verify', 'commit', 'finalize', 'rollback']) {
    if (command.includes("'" + phase + "'")) event = 'ssh:worker:' + phase;
  }
  if (!event) process.exit(99);
  if (!command.includes('sudo -n /bin/bash')) process.exit(94);
  if (event === 'ssh:worker:prepare' && !command.includes(process.env.RELEASE_GIT_SHA)) process.exit(98);
} else if (command.includes('/bin/rm -rf --')) {
  event = 'ssh:' + component + ':cleanup';
} else {
  process.stderr.write('unexpected ssh command: ' + command + '\\n');
  process.exit(95);
}
fs.appendFileSync(process.env.COMMAND_LOG, event + '\\n');
if (event === 'ssh:app:mktemp') process.stdout.write('/tmp/quant-app-deploy.fakeapp\\n');
if (event === 'ssh:worker:mktemp') process.stdout.write('/tmp/quant-worker-deploy.fakeworker\\n');
const failEvents = (process.env.FAIL_EVENTS ?? '').split(',').filter(Boolean);
if (failEvents.includes(event)) process.exit(42);
`);
  writeExecutable(path.join(bin, 'scp'), `${nodeShebang}
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const optionsWithValues = new Set(['-F', '-i', '-J', '-o', '-P', '-S']);
let index = 0;
const options = [];
while (index < args.length && args[index].startsWith('-')) {
  const option = args[index];
  options.push(option);
  index += 1;
  if (optionsWithValues.has(option)) {
    options.push(args[index]);
    index += 1;
  }
}
const operands = args.slice(index);
const destination = operands.at(-1);
const component = destination.includes('app.example.com') ? 'app' : 'worker';
const required = component === 'app'
  ? [process.env.APP_KEY, 'Port=2222', 'ProxyJump=app-jump.example.com',
    'StrictHostKeyChecking=yes', 'ServerAliveInterval=30', 'SetEnv=QP_TEST=value with spaces']
  : [process.env.WORKER_KEY, 'Port=2200', 'StrictHostKeyChecking=accept-new'];
for (const value of required) {
  if (!options.includes(value)) process.exit(96);
}
const files = operands.slice(0, -1).map((file) => path.basename(file)).join(',');
const event = 'scp:' + component + ':' + files;
fs.appendFileSync(process.env.COMMAND_LOG, event + '\\n');
if (event.startsWith(process.env.FAIL_EVENT ?? 'never:')) process.exit(43);
`);
  writeExecutable(path.join(bin, 'bash'), `${nodeShebang}
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const script = path.basename(args[0]);
if (script === 'build-release.sh') {
  const output = args[1];
  const metadataFile = args[2];
  fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(output, 'quant-platform-20260818-120000-abcdef1.tar.gz'), 'release');
  fs.writeFileSync(path.join(output, 'quant-platform-20260818-120000-abcdef1.tar.gz.sha256'), 'checksum');
  fs.writeFileSync(metadataFile, process.env.RELEASE_METADATA ?? JSON.stringify({
    releaseName: '20260818-120000-abcdef1',
    gitSha: process.env.RELEASE_GIT_SHA,
  }));
  fs.appendFileSync(process.env.COMMAND_LOG, 'build-release\\n');
} else if (script === 'build-worker-image.sh') {
  const releaseName = args[3];
  const output = args[4];
  fs.writeFileSync(path.join(output, 'quant-backtest-worker-' + releaseName + '.tar'), 'image');
  fs.writeFileSync(path.join(output, 'quant-backtest-worker-' + releaseName + '.tar.sha256'), 'checksum');
  fs.appendFileSync(process.env.COMMAND_LOG, 'build-worker-image:' + releaseName + '\\n');
} else {
  process.exit(97);
}
`);
  writeExecutable(path.join(bin, 'docker'), `${nodeShebang}
const fs = require('node:fs');
fs.appendFileSync(process.env.COMMAND_LOG, 'docker:' + process.argv.slice(2).join(' ') + '\\n');
`);
  const environment = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    APP_KEY: appKey,
    WORKER_KEY: workerKey,
    COMMAND_LOG: commandLog,
    RELEASE_GIT_SHA: releaseGitSha,
    MANIFEST_SHA: createHash('sha256').update(manifest).digest('hex'),
  };
  return { commandLog, environment, root };
}

function execute(
  harness: ReturnType<typeof prepareHarness>,
  environmentOverrides: Record<string, string> = {},
) {
  return spawnSync(process.execPath, [path.join(harness.root, 'scripts', 'deploy.mjs')], {
    cwd: harness.root,
    encoding: 'utf8',
    env: { ...harness.environment, ...environmentOverrides },
  });
}

function readCommands(harness: ReturnType<typeof prepareHarness>) {
  if (!fs.existsSync(harness.commandLog)) return [];
  return fs.readFileSync(harness.commandLog, 'utf8').trim().split('\n');
}

describe('direct SSH deployment orchestrator', () => {
  it('deploys app and worker together with the only supported command', () => {
    const harness = prepareHarness(['app', 'worker']);
    const result = execute(harness);
    const output = `${result.stdout}${result.stderr}`;
    expect(result.status, output).toBe(0);
    expect(readCommands(harness)).toEqual([
      'ssh:app:preflight',
      'ssh:worker:preflight',
      'docker:info',
      'docker:buildx version',
      'build-release',
      'build-worker-image:20260818-120000-abcdef1',
      'ssh:app:mktemp',
      'scp:app:quant-platform-20260818-120000-abcdef1.tar.gz,quant-platform-20260818-120000-abcdef1.tar.gz.sha256,deploy-app.sh',
      'ssh:worker:mktemp',
      'scp:worker:quant-backtest-worker-20260818-120000-abcdef1.tar,quant-backtest-worker-20260818-120000-abcdef1.tar.sha256,compose.worker.yaml,deploy-worker.sh',
      'ssh:app:prepare',
      'ssh:worker:prepare',
      'ssh:app:verify',
      'ssh:worker:verify',
      'ssh:app:commit',
      'ssh:worker:commit',
      'ssh:app:finalize',
      'ssh:worker:finalize',
      'ssh:worker:cleanup',
      'ssh:app:cleanup',
    ]);
    expect(output).toContain('배포 순서: app -> worker');
  });

  it('requires both app and worker hosts', () => {
    for (const [configuredTargets, missingHost] of [
      [['app'] as DeployTarget[], 'QP_WORKER_HOST'],
      [['worker'] as DeployTarget[], 'QP_APP_HOST'],
    ] as const) {
      const harness = prepareHarness(configuredTargets);
      const result = execute(harness);
      const output = `${result.stdout}${result.stderr}`;
      expect(result.status).not.toBe(0);
      expect(output).toContain(`deploy.env의 ${missingHost}가 필요합니다`);
      expect(readCommands(harness)).toEqual([]);
    }
  });

  it('rolls app back without touching worker when app preparation fails', () => {
    const harness = prepareHarness(['app', 'worker']);
    const result = execute(harness, { FAIL_EVENTS: 'ssh:app:prepare' });
    expect(result.status).toBe(42);
    expect(readCommands(harness)).toContain('ssh:app:rollback');
    expect(readCommands(harness)).not.toContain('ssh:worker:prepare');
    expect(readCommands(harness)).not.toContain('ssh:worker:rollback');
  });

  it('rolls worker and app back when worker preparation fails', () => {
    const harness = prepareHarness(['app', 'worker']);
    const result = execute(harness, { FAIL_EVENTS: 'ssh:worker:prepare' });
    const output = `${result.stdout}${result.stderr}`;
    expect(result.status).toBe(42);
    expect(readCommands(harness).slice(-5)).toEqual([
      'ssh:worker:prepare',
      'ssh:worker:rollback',
      'ssh:app:rollback',
      'ssh:worker:cleanup',
      'ssh:app:cleanup',
    ]);
    expect(output).toContain('worker 통합 롤백');
    expect(output).toContain('app 통합 롤백');
  });

  it('rolls both prepared components back when final readiness fails', () => {
    const harness = prepareHarness(['app', 'worker']);
    const result = execute(harness, { FAIL_EVENTS: 'ssh:worker:verify' });
    expect(result.status).toBe(42);
    expect(readCommands(harness)).toContain('ssh:worker:rollback');
    expect(readCommands(harness)).toContain('ssh:app:rollback');
    expect(readCommands(harness)).not.toContain('ssh:app:finalize');
  });

  it('rolls both components back when either commit fails', () => {
    const harness = prepareHarness(['app', 'worker']);
    const result = execute(harness, { FAIL_EVENTS: 'ssh:worker:commit' });
    expect(result.status).toBe(42);
    expect(readCommands(harness)).toContain('ssh:app:commit');
    expect(readCommands(harness)).toContain('ssh:worker:rollback');
    expect(readCommands(harness)).toContain('ssh:app:rollback');
    expect(readCommands(harness)).not.toContain('ssh:app:finalize');
  });

  it('reports rollback failure together with the deployment failure', () => {
    const harness = prepareHarness(['app', 'worker']);
    const result = execute(harness, {
      FAIL_EVENTS: 'ssh:worker:prepare,ssh:app:rollback',
    });
    const output = `${result.stdout}${result.stderr}`;
    expect(result.status).toBe(42);
    expect(output).toContain('통합 롤백 실패');
    expect(output).toContain('app: ssh가 종료 코드 42로 실패했습니다');
  });

  it('rejects invalid builder metadata before uploading artifacts', () => {
    const harness = prepareHarness(['app', 'worker']);
    const result = execute(harness, {
      RELEASE_METADATA: JSON.stringify({
        releaseName: '../outside',
        gitSha: releaseGitSha,
      }),
    });
    const output = `${result.stdout}${result.stderr}`;
    expect(result.status).not.toBe(0);
    expect(output).toContain('release metadata의 releaseName이 올바르지 않습니다');
    expect(readCommands(harness)).toEqual([
      'ssh:app:preflight',
      'ssh:worker:preflight',
      'docker:info',
      'docker:buildx version',
      'build-release',
    ]);
  });

  it('requires the fixed project-root deploy.env', () => {
    const harness = prepareHarness(['app', 'worker']);
    fs.rmSync(path.join(harness.root, 'deploy.env'));
    const result = execute(harness);
    const output = `${result.stdout}${result.stderr}`;
    expect(result.status).not.toBe(0);
    expect(output).toContain('배포 환경 파일이 없습니다');
    expect(output).toContain('cp deploy.env.example deploy.env');
    expect(readCommands(harness)).toEqual([]);
  });
});
