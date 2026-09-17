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

function prepareHarness(configured = true, prefix = 'deploy-orchestrator-') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(root);
  const bin = path.join(root, 'bin');
  const scripts = path.join(root, 'scripts');
  fs.mkdirSync(bin);
  fs.mkdirSync(scripts);
  fs.symlinkSync(process.execPath, path.join(bin, 'node'));
  fs.copyFileSync('scripts/deploy.sh', path.join(scripts, 'deploy.sh'));
  const commandLog = path.join(root, 'commands.log');
  const sshKey = path.join(root, 'deploy.pem');
  fs.writeFileSync(sshKey, 'ssh-key');

  const settings: string[] = [];
  if (configured) {
    settings.push(
      'HOST=server.example.com',
      'SSH_USER=deploy-user',
      `SSH_KEY=${sshKey}`,
      'SSH_PORT=2222',
      'SSH_HOST_KEY=yes',
      'SSH_JUMP=jump.example.com',
      'SSH_OPTS="-o ServerAliveInterval=30 -o \'SetEnv=TEST=value with spaces\'"',
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
if (!target.includes('server.example.com')) process.exit(90);
const required = [process.env.DEPLOY_TEST_KEY, 'Port=2222', 'ProxyJump=jump.example.com',
    'StrictHostKeyChecking=yes', 'ServerAliveInterval=30', 'SetEnv=TEST=value with spaces'];
for (const value of required) {
  if (!options.includes(value)) {
    process.stderr.write('missing SSH option: ' + value + '\\n');
    process.exit(91);
  }
}
let event = '';
if (command.includes('/etc/quant-platform/app.env')) {
  event = 'ssh:preflight';
  if (!options.includes('BatchMode=yes') || !options.includes('ConnectTimeout=15')) process.exit(92);
} else if (command.includes('mktemp -d /tmp/quant-deploy.')) {
  event = 'ssh:mktemp';
} else if (command.includes('/deploy.sh')) {
  if (!command.includes('--remote')) process.exit(98);
  for (const phase of ['prepare', 'verify', 'commit', 'finalize', 'rollback']) {
    if (command.includes("'" + phase + "'")) event = 'ssh:' + phase;
  }
  if (!event) process.exit(99);
} else if (command.includes('/bin/rm -rf --')) {
  event = 'ssh:cleanup';
} else {
  process.stderr.write('unexpected ssh command: ' + command + '\\n');
  process.exit(95);
}
fs.appendFileSync(process.env.COMMAND_LOG, event + '\\n');
if (event === 'ssh:mktemp') process.stdout.write((process.env.REMOTE_DIRECTORY ?? '/tmp/quant-deploy.fixture') + '\\n');
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
if (!destination.includes('server.example.com')) process.exit(90);
const required = [process.env.DEPLOY_TEST_KEY, 'Port=2222', 'ProxyJump=jump.example.com',
    'StrictHostKeyChecking=yes', 'ServerAliveInterval=30', 'SetEnv=TEST=value with spaces'];
for (const value of required) {
  if (!options.includes(value)) process.exit(96);
}
const files = operands.slice(0, -1).map((file) => path.basename(file)).join(',');
const event = 'scp:' + files;
fs.appendFileSync(process.env.COMMAND_LOG, event + '\\n');
if (event.startsWith(process.env.FAIL_EVENT ?? 'never:')) process.exit(43);
`);
  writeExecutable(path.join(bin, 'bash'), `${nodeShebang}
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const script = path.basename(args[0]);
if (script === 'build-release.sh') {
  if (process.env.READ_STDIN && fs.readFileSync(0, 'utf8') !== 'stdin preserved\\n') process.exit(94);
  if (process.env.FAIL_BUILD) process.exit(41);
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
    DEPLOY_TEST_KEY: sshKey,
    COMMAND_LOG: commandLog,
    RELEASE_GIT_SHA: releaseGitSha,
  };
  return { commandLog, environment, root };
}

function execute(
  harness: ReturnType<typeof prepareHarness>,
  environmentOverrides: Record<string, string> = {},
) {
  return spawnSync('/bin/bash', [path.join(harness.root, 'scripts', 'deploy.sh')], {
    input: environmentOverrides.READ_STDIN ? 'stdin preserved\n' : undefined,
    cwd: harness.root,
    encoding: 'utf8',
    env: { ...harness.environment, ...environmentOverrides },
  });
}

function readCommands(harness: ReturnType<typeof prepareHarness>) {
  if (!fs.existsSync(harness.commandLog)) return [];
  return fs.readFileSync(harness.commandLog, 'utf8').trim().split('\n');
}

describe('서버와 다운로드 파일 배포', () => {
  it('SSH 설정만으로 릴리스를 게시한다', () => {
    const harness = prepareHarness();
    const result = execute(harness);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(readCommands(harness)).toEqual([
      'ssh:preflight', 'build-release', 'ssh:mktemp',
      'scp:quant-platform-20260818-120000-abcdef1.tar.gz,quant-platform-20260818-120000-abcdef1.tar.gz.sha256,deploy.sh',
      'ssh:prepare', 'ssh:verify', 'ssh:commit', 'ssh:finalize', 'ssh:cleanup',
    ]);
    expect(result.stdout).toContain('다운로드 클라이언트 게시 완료');
  });

  it('호스트가 없으면 빌드나 SSH를 실행하지 않는다', () => {
    const harness = prepareHarness(false);
    const result = execute(harness);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('HOST');
    expect(readCommands(harness)).toEqual([]);
  });

  it.each(['prepare', 'verify', 'commit'])('%s 실패 시 서버와 DB를 복원한다', (phase) => {
    const harness = prepareHarness();
    const result = execute(harness, { FAIL_EVENTS: `ssh:${phase}` });
    expect(result.status).toBe(42);
    expect(readCommands(harness)).toContain('ssh:rollback');
    expect(readCommands(harness)).not.toContain('ssh:finalize');
    expect(readCommands(harness).at(-1)).toBe('ssh:cleanup');
  });

  it('복원도 실패하면 원래 실패와 복원 실패를 함께 알린다', () => {
    const harness = prepareHarness();
    const result = execute(harness, { FAIL_EVENTS: 'ssh:prepare,ssh:rollback' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('서버·DB 복원 실패');
    expect(result.stderr).toContain('42');
  });

  it('commit 후 정리 실패는 운영 버전을 다시 되돌리지 않는다', () => {
    const harness = prepareHarness();
    const result = execute(harness, { FAIL_EVENTS: 'ssh:finalize' });
    expect(result.status).toBe(42);
    expect(readCommands(harness)).not.toContain('ssh:rollback');
    expect(readCommands(harness).at(-1)).toBe('ssh:cleanup');
  });

  it('잘못된 릴리스 경로를 업로드 전에 거부한다', () => {
    const harness = prepareHarness();
    const result = execute(harness, { RELEASE_METADATA: JSON.stringify({ releaseName: '../outside', gitSha: releaseGitSha }) });
    expect(result.status).not.toBe(0);
    expect(readCommands(harness)).toEqual(['ssh:preflight', 'build-release']);
  });

  it('프로젝트 루트 deploy.env가 필요하다', () => {
    const harness = prepareHarness();
    fs.rmSync(path.join(harness.root, 'deploy.env'));
    const result = execute(harness);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('배포 환경 파일이 없습니다');
    expect(readCommands(harness)).toEqual([]);
  });
  it('공백과 작은따옴표가 있는 저장소 경로에서도 같은 파일을 배포한다', () => {
    const harness = prepareHarness(true, "deploy path 'quoted-");
    const result = execute(harness);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(readCommands(harness)).toContain('ssh:finalize');
  });

  it('셸 진입점이 빌드 명령의 표준 입력을 소비하지 않는다', () => {
    const harness = prepareHarness();
    const result = execute(harness, { READ_STDIN: '1' });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(readCommands(harness)).toContain('ssh:finalize');
  });

  it('사전 점검 실패는 빌드·전송·rollback을 시작하지 않는다', () => {
    const harness = prepareHarness();
    const result = execute(harness, { FAIL_EVENTS: 'ssh:preflight' });
    expect(result.status).toBe(42);
    expect(readCommands(harness)).toEqual(['ssh:preflight']);
  });

  it('빌드 실패는 원격 transaction을 시작하지 않는다', () => {
    const harness = prepareHarness();
    const result = execute(harness, { FAIL_BUILD: '1' });
    expect(result.status).toBe(41);
    expect(readCommands(harness)).toEqual(['ssh:preflight']);
  });

  it('업로드 실패는 임시 경로만 정리하고 rollback하지 않는다', () => {
    const harness = prepareHarness();
    const result = execute(harness, { FAIL_EVENT: 'scp:' });
    expect(result.status).toBe(43);
    expect(readCommands(harness).at(-1)).toBe('ssh:cleanup');
    expect(readCommands(harness)).not.toContain('ssh:prepare');
    expect(readCommands(harness)).not.toContain('ssh:rollback');
  });

  it('정리 실패는 완료된 배포를 rollback하지 않는다', () => {
    const harness = prepareHarness();
    const result = execute(harness, { FAIL_EVENTS: 'ssh:cleanup' });
    expect(result.status).toBe(0);
    expect(result.stderr).toContain('배포 임시 파일 정리 실패');
    expect(readCommands(harness)).not.toContain('ssh:rollback');
  });

  it.each(['/tmp/outside', '/tmp/quant-deploy.fixture/../outside'])('허용되지 않은 원격 경로 %s를 거부한다', (directory) => {
    const harness = prepareHarness();
    const result = execute(harness, { REMOTE_DIRECTORY: directory });
    expect(result.status).not.toBe(0);
    expect(readCommands(harness)).toEqual(['ssh:preflight', 'build-release', 'ssh:mktemp']);
  });

  it.each([
    ['HOST', '-oProxyCommand=bad'],
    ['SSH_USER', 'invalid user'],
    ['SSH_PORT', '0'],
    ['SSH_PORT', '65536'],
    ['SSH_JUMP', '-invalid'],
    ['SSH_HOST_KEY', 'invalid'],
    ['SSH_OPTS', '-o "unterminated'],
  ])('%s의 잘못된 값은 SSH 전에 거부한다', (name, value) => {
    const harness = prepareHarness();
    fs.appendFileSync(path.join(harness.root, 'deploy.env'), `${name}=${value}\n`);
    const result = execute(harness);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(name);
    expect(readCommands(harness)).toEqual([]);
  });

  it('호스트에 포함된 사용자와 별도 사용자가 충돌하면 거부한다', () => {
    const harness = prepareHarness();
    fs.appendFileSync(path.join(harness.root, 'deploy.env'), 'HOST=other@server.example.com\n');
    const result = execute(harness);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('HOST 사용자와 SSH_USER가 다릅니다');
    expect(readCommands(harness)).toEqual([]);
  });

  it('deploy.env를 셸 코드로 실행하지 않는다', () => {
    const harness = prepareHarness();
    const marker = path.join(harness.root, 'unexpected-execution');
    fs.appendFileSync(path.join(harness.root, 'deploy.env'), `UNUSED=$(touch ${marker})\n`);
    const result = execute(harness);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(fs.existsSync(marker)).toBe(false);
  });

});
