import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

type DeployTarget = 'app' | 'worker';

const roots: string[] = [];
const deployGitSha = 'a'.repeat(40);

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
  event = 'ssh:app:apply';
} else if (command.includes('/deploy-worker.sh')) {
  event = 'ssh:worker:apply';
  if (!command.includes('sudo -n /bin/bash')) process.exit(94);
} else if (command.includes('/bin/rm -rf --')) {
  event = 'ssh:' + component + ':cleanup';
} else {
  process.stderr.write('unexpected ssh command: ' + command + '\\n');
  process.exit(95);
}
fs.appendFileSync(process.env.COMMAND_LOG, event + '\\n');
if (event === 'ssh:app:mktemp') process.stdout.write('/tmp/quant-app-deploy.fakeapp\\n');
if (event === 'ssh:worker:mktemp') process.stdout.write('/tmp/quant-worker-deploy.fakeworker\\n');
if (event === process.env.FAIL_EVENT) process.exit(42);
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
  fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(output, 'quant-platform-20260818-120000-abcdef1.tar.gz'), 'release');
  fs.writeFileSync(path.join(output, 'quant-platform-20260818-120000-abcdef1.tar.gz.sha256'), 'checksum');
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
  writeExecutable(path.join(bin, 'git'), `${nodeShebang}
const fs = require('node:fs');
fs.appendFileSync(process.env.COMMAND_LOG, 'git:' + process.argv.slice(2).join(' ') + '\\n');
process.stdout.write(process.env.DEPLOY_GIT_SHA + '\\n');
`);

  const environment = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    APP_KEY: appKey,
    WORKER_KEY: workerKey,
    COMMAND_LOG: commandLog,
    DEPLOY_GIT_SHA: deployGitSha,
    MANIFEST_SHA: createHash('sha256').update(manifest).digest('hex'),
  };
  return { commandLog, environment, root };
}

function execute(
  harness: ReturnType<typeof prepareHarness>,
  target?: string,
  environmentOverrides: Record<string, string> = {},
) {
  const args = [path.join(harness.root, 'scripts', 'deploy.mjs')];
  if (target !== undefined) args.push('--target', target);
  return spawnSync(process.execPath, args, {
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
  it('defaults to app and worker when deploy.env configures both targets', () => {
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
      'git:rev-parse HEAD',
      'build-worker-image:20260818-120000-abcdef1',
      'ssh:app:mktemp',
      'scp:app:quant-platform-20260818-120000-abcdef1.tar.gz,quant-platform-20260818-120000-abcdef1.tar.gz.sha256,deploy-app.sh',
      'ssh:app:apply',
      'ssh:app:cleanup',
      'ssh:worker:mktemp',
      'scp:worker:quant-backtest-worker-20260818-120000-abcdef1.tar,quant-backtest-worker-20260818-120000-abcdef1.tar.sha256,compose.worker.yaml,deploy-worker.sh',
      'ssh:worker:apply',
      'ssh:worker:cleanup',
    ]);
    expect(output).toContain('배포 대상: all');
  });

  it('defaults to app only when QP_WORKER_HOST is absent', () => {
    const harness = prepareHarness(['app']);
    const result = execute(harness);
    const output = `${result.stdout}${result.stderr}`;
    expect(result.status, output).toBe(0);
    expect(readCommands(harness)).toEqual([
      'ssh:app:preflight',
      'build-release',
      'git:rev-parse HEAD',
      'ssh:app:mktemp',
      'scp:app:quant-platform-20260818-120000-abcdef1.tar.gz,quant-platform-20260818-120000-abcdef1.tar.gz.sha256,deploy-app.sh',
      'ssh:app:apply',
      'ssh:app:cleanup',
    ]);
    expect(output).toContain('배포 대상: app');
  });

  it('requires only worker configuration for an explicit worker target', () => {
    const harness = prepareHarness(['worker']);
    const result = execute(harness, 'worker');
    const output = `${result.stdout}${result.stderr}`;
    expect(result.status, output).toBe(0);
    expect(readCommands(harness)).toEqual([
      'ssh:worker:preflight',
      'docker:info',
      'docker:buildx version',
      'build-release',
      'git:rev-parse HEAD',
      'build-worker-image:20260818-120000-abcdef1',
      'ssh:worker:mktemp',
      'scp:worker:quant-backtest-worker-20260818-120000-abcdef1.tar,quant-backtest-worker-20260818-120000-abcdef1.tar.sha256,compose.worker.yaml,deploy-worker.sh',
      'ssh:worker:apply',
      'ssh:worker:cleanup',
    ]);
  });

  it('requires both target hosts when all is explicit', () => {
    const harness = prepareHarness(['app']);
    const result = execute(harness, 'all');
    const output = `${result.stdout}${result.stderr}`;
    expect(result.status).not.toBe(0);
    expect(output).toContain('deploy.env의 QP_WORKER_HOST가 필요합니다');
    expect(readCommands(harness)).toEqual([]);
  });

  it('rejects --env-file and unknown target names before running commands', () => {
    const harness = prepareHarness(['app']);
    const envFileResult = spawnSync(process.execPath, [
      path.join(harness.root, 'scripts', 'deploy.mjs'),
      `--env-file=${path.join(harness.root, 'deploy.env')}`,
    ], {
      cwd: harness.root,
      encoding: 'utf8',
      env: harness.environment,
    });
    expect(envFileResult.status).not.toBe(0);
    expect(`${envFileResult.stdout}${envFileResult.stderr}`).toContain('알 수 없는 배포 인자');

    const targetResult = execute(harness, 'server');
    expect(targetResult.status).not.toBe(0);
    expect(`${targetResult.stdout}${targetResult.stderr}`).toContain(
      '--target은 app | worker | all 중 하나여야 합니다',
    );
    expect(readCommands(harness)).toEqual([]);
  });

  it('always removes the remote upload directory and reports a partial all deployment', () => {
    const harness = prepareHarness(['app', 'worker']);
    const result = execute(harness, undefined, { FAIL_EVENT: 'ssh:worker:apply' });
    const output = `${result.stdout}${result.stderr}`;
    expect(result.status).toBe(42);
    expect(readCommands(harness).slice(-2)).toEqual([
      'ssh:worker:apply',
      'ssh:worker:cleanup',
    ]);
    expect(output).toContain(
      'app 배포는 완료됐지만 worker 배포가 실패했습니다. 같은 commit에서 --target worker로 다시 실행하세요.',
    );
  });

  it('requires the fixed project-root deploy.env', () => {
    const harness = prepareHarness(['app']);
    fs.rmSync(path.join(harness.root, 'deploy.env'));
    const result = execute(harness);
    const output = `${result.stdout}${result.stderr}`;
    expect(result.status).not.toBe(0);
    expect(output).toContain('배포 환경 파일이 없습니다');
    expect(output).toContain('cp deploy.env.example deploy.env');
    expect(readCommands(harness)).toEqual([]);
  });
});
