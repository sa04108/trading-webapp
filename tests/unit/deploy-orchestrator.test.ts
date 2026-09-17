import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const roots: string[] = [];
const releaseGitSha = 'a'.repeat(40);

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function writeExecutable(file: string, content: string) {
  fs.writeFileSync(file, content);
  fs.chmodSync(file, 0o755);
}

function prepareHarness(configured = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-orchestrator-'));
  roots.push(root);
  const bin = path.join(root, 'bin');
  const scripts = path.join(root, 'scripts');
  fs.mkdirSync(bin);
  fs.mkdirSync(scripts);
  fs.copyFileSync('scripts/deploy.mjs', path.join(scripts, 'deploy.mjs'));
  fs.writeFileSync(path.join(scripts, 'deploy-app.sh'), '#!/bin/bash\n');
  const commandLog = path.join(root, 'commands.log');
  const appKey = path.join(root, 'app.pem');
  fs.writeFileSync(appKey, 'app-key');

  const settings: string[] = [];
  if (configured) {
    settings.push(
      'APP_HOST=app.example.com',
      'APP_SSH_USER=app-user',
      `APP_SSH_KEY=${appKey}`,
      'APP_SSH_PORT=2222',
      'APP_SSH_HOST_KEY=yes',
      'APP_SSH_JUMP=app-jump.example.com',
      'APP_SSH_OPTS="-o ServerAliveInterval=30 -o \'SetEnv=TEST=value with spaces\'"',
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
if (!target.includes('app.example.com')) process.exit(90);
const component = 'app';
const required = [process.env.APP_KEY, 'Port=2222', 'ProxyJump=app-jump.example.com',
    'StrictHostKeyChecking=yes', 'ServerAliveInterval=30', 'SetEnv=TEST=value with spaces'];
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
} else if (command.includes('mktemp -d /tmp/quant-app-deploy.')) {
  event = 'ssh:app:mktemp';
} else if (command.includes('/deploy-app.sh')) {
  for (const phase of ['prepare', 'verify', 'commit', 'finalize', 'rollback']) {
    if (command.includes("'" + phase + "'")) event = 'ssh:app:' + phase;
  }
  if (!event) process.exit(99);
} else if (command.includes('/bin/rm -rf --')) {
  event = 'ssh:' + component + ':cleanup';
} else {
  process.stderr.write('unexpected ssh command: ' + command + '\\n');
  process.exit(95);
}
fs.appendFileSync(process.env.COMMAND_LOG, event + '\\n');
if (event === 'ssh:app:mktemp') process.stdout.write('/tmp/quant-app-deploy.fakeapp\\n');
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
if (!destination.includes('app.example.com')) process.exit(90);
const component = 'app';
const required = [process.env.APP_KEY, 'Port=2222', 'ProxyJump=app-jump.example.com',
    'StrictHostKeyChecking=yes', 'ServerAliveInterval=30', 'SetEnv=TEST=value with spaces'];
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
    COMMAND_LOG: commandLog,
    RELEASE_GIT_SHA: releaseGitSha,
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

describe('앱과 다운로드 파일 배포', () => {
  it('앱 SSH 설정만으로 릴리스를 게시한다', () => {
    const harness = prepareHarness();
    const result = execute(harness);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(readCommands(harness)).toEqual([
      'ssh:app:preflight', 'build-release', 'ssh:app:mktemp',
      'scp:app:quant-platform-20260818-120000-abcdef1.tar.gz,quant-platform-20260818-120000-abcdef1.tar.gz.sha256,deploy-app.sh',
      'ssh:app:prepare', 'ssh:app:verify', 'ssh:app:commit', 'ssh:app:finalize', 'ssh:app:cleanup',
    ]);
    expect(result.stdout).toContain('다운로드 클라이언트 게시 완료');
  });

  it('앱 호스트가 없으면 빌드나 SSH를 실행하지 않는다', () => {
    const harness = prepareHarness(false);
    const result = execute(harness);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('APP_HOST');
    expect(readCommands(harness)).toEqual([]);
  });

  it.each(['prepare', 'verify', 'commit'])('%s 실패 시 앱과 DB를 복원한다', (phase) => {
    const harness = prepareHarness();
    const result = execute(harness, { FAIL_EVENTS: `ssh:app:${phase}` });
    expect(result.status).toBe(42);
    expect(readCommands(harness)).toContain('ssh:app:rollback');
    expect(readCommands(harness)).not.toContain('ssh:app:finalize');
    expect(readCommands(harness).at(-1)).toBe('ssh:app:cleanup');
  });

  it('복원도 실패하면 원래 실패와 복원 실패를 함께 알린다', () => {
    const harness = prepareHarness();
    const result = execute(harness, { FAIL_EVENTS: 'ssh:app:prepare,ssh:app:rollback' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('앱·DB 복원 실패');
    expect(result.stderr).toContain('42');
  });

  it('commit 후 정리 실패는 운영 버전을 다시 되돌리지 않는다', () => {
    const harness = prepareHarness();
    const result = execute(harness, { FAIL_EVENTS: 'ssh:app:finalize' });
    expect(result.status).toBe(42);
    expect(readCommands(harness)).not.toContain('ssh:app:rollback');
    expect(readCommands(harness).at(-1)).toBe('ssh:app:cleanup');
  });

  it('잘못된 릴리스 경로를 업로드 전에 거부한다', () => {
    const harness = prepareHarness();
    const result = execute(harness, { RELEASE_METADATA: JSON.stringify({ releaseName: '../outside', gitSha: releaseGitSha }) });
    expect(result.status).not.toBe(0);
    expect(readCommands(harness)).toEqual(['ssh:app:preflight', 'build-release']);
  });

  it('프로젝트 루트 deploy.env가 필요하다', () => {
    const harness = prepareHarness();
    fs.rmSync(path.join(harness.root, 'deploy.env'));
    const result = execute(harness);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('배포 환경 파일이 없습니다');
    expect(readCommands(harness)).toEqual([]);
  });
});
