import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { afterEach, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { URL } from 'node:url';

const source = fs.readFileSync(new URL('../../scripts/deploy.sh', import.meta.url), 'utf8');
const release = '20260917-120000-abcdef1';
const fixtures = [];
const executable = (file, content) => { fs.writeFileSync(file, content); fs.chmodSync(file, 0o755); };

// 모든 절대 운영 경로를 임시 디렉터리로 치환하고 네트워크·권한·DB CLI를 대체한다.
// 배포 Bash와 파일 조작·체크섬·압축·잠금 자체는 실제 프로세스로 실행한다.
function fixture({ first = false, quotedPath = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deploytest-'));
  fixtures.push(root);
  const repo = path.join(root, quotedPath ? "repo with 'quote" : 'repo');
  const bin = path.join(root, 'bin');
  const opt = path.join(root, 'opt');
  const data = path.join(root, 'data');
  for (const dir of [repo, bin, opt, data, `${repo}/scripts`, `${opt}/releases`, `${data}/backups`, `${root}/locks`]) fs.mkdirSync(dir, { recursive: true });
  const old = `${opt}/releases/old-release`;
  if (!first) {
    fs.mkdirSync(old);
    fs.symlinkSync(old, `${opt}/current`);
    fs.writeFileSync(`${data}/app.sqlite`, 'old-operations');
    fs.writeFileSync(`${data}/app.data.sqlite`, 'old-data');
    fs.writeFileSync(`${root}/active`, '1');
  }
  const sanitized = source
    .replaceAll('/opt/quant-platform', opt)
    .replaceAll('/var/lib/quant-platform', data)
    .replaceAll('/run/lock', `${root}/locks`)
    .replaceAll('/usr/local/bin/node', `${bin}/runtime-node`);
  executable(`${repo}/scripts/deploy.sh`, sanitized);
  executable(`${repo}/scripts/build-release.sh`, `#!/bin/bash
set -eu
printf 'build stdout\\n'
printf 'build stderr\\n' >&2
printf 'build\\n' >> "$ROOT/build-events"
if [ "\${FAIL:-}" = build ]; then exit 41; fi
if [ "\${READ_STDIN:-}" = 1 ]; then read -r line; [ "$line" = input-preserved ]; fi
mkdir -p "$1/contents/dist/server"
printf 'fixture\\n' > "$1/contents/dist/server/cli.js"
archive="$1/quant-platform-${release}.tar.gz"
tar -czf "$archive" -C "$1/contents" .
sha256sum "$archive" > "$archive.sha256"
if [ "\${FAIL:-}" = checksum ]; then printf corrupt >> "$archive"; fi
if [ "\${FAIL:-}" = missing-checksum ]; then rm "$archive.sha256"; fi
`);
  const key = `${root}/key with spaces.pem`;
  fs.writeFileSync(key, 'test-key');
  const settings = `HOST=server.example.com\nSSH_USER=deployer\nSSH_KEY="${key}"\nSSH_PORT=2222\nSSH_JUMP=bastion.example.com\nSSH_HOST_KEY=yes\nSSH_OPTS="-o ServerAliveInterval=30 -o 'SetEnv=TEST=value with spaces'"\n`;
  fs.writeFileSync(`${repo}/deploy.env`, settings);
  const mock = `#!${process.execPath}\n` + String.raw`
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = process.env.ROOT, opt = root + '/opt', data = root + '/data';
const command = path.basename(process.argv[1]);
let args = process.argv.slice(2);
fs.appendFileSync(root + '/trace', JSON.stringify({command, args}) + '\n');
const failed = () => fs.existsSync(root + '/failed');
const failure = (phase) => {
  if (process.env.FAIL === phase && !failed()) {
    fs.writeFileSync(root + '/failed', phase);
    console.error('injected failure: ' + phase);
    process.exit(42);
  }
};
const run = (cmd, argv) => {
  const result = spawnSync(cmd, argv, { stdio: 'inherit' });
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
};
const operands = () => {
  let i = 0;
  while (args[i]?.startsWith('-')) {
    const option = args[i++];
    if (['-i', '-o', '-p', '-P', '-J', '-F'].includes(option)) i++;
  }
  return args.slice(i);
};
if (command === 'ssh') {
  const [target, text] = operands();
  if (target !== 'deployer@server.example.com') process.exit(90);
  if (text.includes('set -eu')) { failure('preflight'); process.exit(0); }
  if (text.startsWith('mktemp ')) {
    failure('mktemp');
    if (process.env.REMOTE_DIRECTORY) { console.log(process.env.REMOTE_DIRECTORY); process.exit(0); }
    const dir = fs.mkdtempSync('/tmp/quant-deploy.');
    fs.appendFileSync(root + '/uploads', dir + '\n');
    console.log(dir); process.exit(0);
  }
  if (text.startsWith('rm -rf ')) {
    failure('cleanup-upload');
    const dir = text.split("'")[1];
    const owned = fs.readFileSync(root + '/uploads', 'utf8').split('\n');
    if (!owned.includes(dir)) process.exit(91);
    fs.rmSync(dir, { recursive: true, force: true }); process.exit(0);
  }
  if (text.includes('--remote')) { failure('connection'); run('/bin/bash', ['-c', text]); }
  process.exit(92);
}
if (command === 'scp') {
  const files = operands(), target = files.pop();
  failure('upload');
  const dir = target.slice(target.indexOf(':') + 1);
  if (!fs.readFileSync(root + '/uploads', 'utf8').split('\n').includes(dir.replace(/\/$/, ''))) process.exit(93);
  for (const file of files) fs.copyFileSync(file, path.join(dir, path.basename(file)));
  process.exit(0);
}
if (command === 'sudo') {
  if (args[0] === '-n') args.shift();
  if (['chown', 'chmod'].includes(args[0])) process.exit(0);
  if (args[0] === 'ln') failure('switch');
  if (args[0] === 'rm' && args.includes(opt + '/releases/' + process.env.RELEASE + '/.deploy-in-progress')) failure('commit');
  if (args[0] === 'rm' && args.includes(data + '/backups/pre-deploy-' + process.env.RELEASE + '.sqlite') && process.env.FAIL_CLEANUP === '1') process.exit(44);
  if (!['true', 'test', 'mkdir', 'touch', 'tar', 'corepack', 'systemctl', 'systemd-run', 'env', 'mv', 'ln', 'rm', 'find', 'journalctl'].includes(args[0])) process.exit(94);
  run(args[0], args.slice(1));
}
if (command === 'runtime-node') {
  const [cli, action, snapshot] = args;
  if (!cli.includes('/dist/server/cli.js')) process.exit(95);
  if (action === 'db:backup') {
    fs.copyFileSync(data + '/app.sqlite', snapshot);
    failure('backup');
    fs.copyFileSync(data + '/app.data.sqlite', snapshot + '.data');
    fs.writeFileSync(snapshot + '.json', 'backup-manifest');
  } else if (action === 'db:restore') {
    if (process.env.FAIL_RECOVERY === 'restore') process.exit(43);
    fs.copyFileSync(snapshot, data + '/app.sqlite');
    fs.copyFileSync(snapshot + '.data', data + '/app.data.sqlite');
  } else process.exit(96);
  process.exit(0);
}
if (command === 'systemd-run') {
  fs.writeFileSync(data + '/app.sqlite', 'new-operations');
  fs.writeFileSync(data + '/app.data.sqlite', 'new-data');
  failure('prepare');
  if (process.env.SIGNAL === 'TERM') process.kill(process.ppid, 'SIGTERM');
  process.exit(0);
}
if (command === 'systemctl') {
  if (args[0] === 'stop') { failure('stop'); fs.rmSync(root + '/active', {force: true}); }
  if (args[0] === 'start') {
    failure('start');
    if (failed() && process.env.FAIL_RECOVERY === 'start') process.exit(43);
    fs.writeFileSync(root + '/active', '1');
  }
  process.exit(0);
}
if (command === 'corepack') { failure('install'); process.exit(0); }
if (command === 'curl') {
  if (process.env.FAIL === 'readiness' && fs.readlinkSync(opt + '/current') !== opt + '/releases/old-release') {
    fs.writeFileSync(root + '/failed', 'readiness'); process.exit(42);
  }
  if (failed() && process.env.FAIL_RECOVERY === 'readiness') process.exit(43);
  process.exit(0);
}
if (command === 'sleep' || command === 'journalctl') process.exit(0);
process.exit(97);
`;
  for (const command of ['ssh', 'scp', 'sudo', 'corepack', 'systemctl', 'systemd-run', 'runtime-node', 'curl', 'sleep', 'journalctl']) executable(`${bin}/${command}`, mock);
  const environment = { ...process.env, ROOT: root, RELEASE: release, PATH: `${bin}:${process.env.PATH}`, LOG: `${root}/deploy.log`, TMPDIR: root, FAIL: '', FAIL_RECOVERY: '', FAIL_CLEANUP: '', REMOTE_DIRECTORY: '', READ_STDIN: '', SIGNAL: '' };
  const execute = (overrides = {}, args = []) => {
    const result = spawnSync('/bin/bash', [`${repo}/scripts/deploy.sh`, ...args], {
      cwd: repo, env: { ...environment, ...overrides }, encoding: 'utf8', input: 'input-preserved\n', timeout: 15_000,
    });
    if (result.error) throw result.error;
    return { ...result, output: result.stdout + result.stderr };
  };
  const trace = () => fs.existsSync(`${root}/trace`) ? fs.readFileSync(`${root}/trace`, 'utf8').trim().split('\n').map(JSON.parse) : [];
  return { root, repo, opt, data, old, settings, environment, execute, trace, snapshot: `${data}/backups/pre-deploy-${release}.sqlite`, current: `${opt}/current`, next: `${opt}/releases/${release}` };
}

afterEach(() => {
  for (const root of fixtures.splice(0)) {
    if (fs.existsSync(`${root}/uploads`)) for (const dir of fs.readFileSync(`${root}/uploads`, 'utf8').trim().split('\n')) fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

const assertOld = (f) => {
  assert.equal(fs.readlinkSync(f.current), f.old);
  assert.equal(fs.readFileSync(`${f.data}/app.sqlite`, 'utf8'), 'old-operations');
  assert.equal(fs.readFileSync(`${f.data}/app.data.sqlite`, 'utf8'), 'old-data');
};

test('Node 조정 코드 없이 source와 Bash 문법 검사를 지원한다', () => {
  assert.doesNotMatch(source, /spawnSync|parseEnv|DEPLOY_LOCAL_NODE|--eval|--input-type|stageAppDeployment|runAppPhase/);
  const result = spawnSync('/bin/bash', ['-c', 'bash -n scripts/deploy.sh; source scripts/deploy.sh; declare -F local_deploy; declare -F remote_deploy'], {encoding: 'utf8'});
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /local_deploy/);
});

test('한 번의 원격 실행으로 배포하고 SSH 옵션·로그·현재 릴리스를 보존한다', () => {
  const f = fixture();
  const result = f.execute();
  assert.equal(result.status, 0, result.output);
  assert.equal(fs.readlinkSync(f.current), f.next);
  assert.equal(fs.readFileSync(`${f.data}/app.sqlite`, 'utf8'), 'new-operations');
  assert.equal(fs.readFileSync(`${f.data}/app.data.sqlite`, 'utf8'), 'new-data');
  assert.equal(fs.existsSync(f.old), false);
  assert.equal(fs.existsSync(f.snapshot), false);
  const ssh = f.trace().filter(e => e.command === 'ssh');
  assert.equal(ssh.filter(e => e.args.at(-1).includes('--remote')).length, 1);
  for (const {args} of [...ssh, ...f.trace().filter(e => e.command === 'scp')]) {
    for (const option of ['Port=2222', 'ProxyJump=bastion.example.com', 'StrictHostKeyChecking=yes', 'ServerAliveInterval=30', 'SetEnv=TEST=value with spaces']) assert.ok(args.includes(option), option);
  }
  const log = fs.readFileSync(`${f.root}/deploy.log`, 'utf8');
  for (const text of ['build stdout', 'build stderr', '이전 릴리스:', 'DB 백업:', `release ${release} live`, '==> 완료:']) assert.ok(log.includes(text), text);
  assert.equal(log, result.stdout);
  assert.equal(fs.readdirSync(f.root).some(n => n.startsWith('quant-build.')), false);
  for (const dir of fs.readFileSync(`${f.root}/uploads`, 'utf8').trim().split('\n')) assert.equal(fs.existsSync(dir), false);
});

test('최초 배포도 이전 코드와 DB 없이 완료한다', () => {
  const f = fixture({first: true});
  const result = f.execute();
  assert.equal(result.status, 0, result.output);
  assert.equal(fs.readlinkSync(f.current), f.next);
  assert.equal(fs.existsSync(f.snapshot), false);
});

for (const phase of ['preflight', 'build', 'mktemp', 'upload', 'connection', 'checksum', 'install', 'stop', 'backup', 'switch', 'prepare', 'start', 'readiness', 'commit']) {
  test(`${phase} 실패 시 기존 코드·두 DB를 유지하거나 복원하고 오류를 로그에 남긴다`, () => {
    const f = fixture();
    const result = f.execute({FAIL: phase});
    assert.notEqual(result.status, 0, result.output);
    assertOld(f);
    assert.equal(fs.existsSync(f.next), false);
    assert.equal(fs.existsSync(f.snapshot), false);
    assert.match(fs.readFileSync(`${f.root}/deploy.log`, 'utf8'), /실패 \(exit/);
    if (['preflight', 'build', 'mktemp', 'upload', 'connection', 'checksum', 'install'].includes(phase)) assert.equal(f.trace().some(e => e.command === 'systemctl' && e.args[0] === 'stop'), false);
  });
}

for (const recovery of ['restore', 'start', 'readiness']) {
  test(`rollback ${recovery} 실패 시 복구 코드와 백업 세트를 보존한다`, () => {
    const f = fixture();
    const result = f.execute({FAIL: 'prepare', FAIL_RECOVERY: recovery});
    assert.notEqual(result.status, 0, result.output);
    for (const name of [f.next, `${f.next}/.deploy-failed`, f.snapshot, `${f.snapshot}.data`, `${f.snapshot}.json`, `${f.snapshot}.deploy-failed`]) assert.ok(fs.existsSync(name), name);
    assert.match(result.output, /복원 또는 정리 실패/);
  });
}

test('최초 배포 실패는 새 DB·current를 제거하고 서비스를 중지 상태로 둔다', () => {
  const f = fixture({first: true});
  const result = f.execute({FAIL: 'prepare'});
  assert.notEqual(result.status, 0, result.output);
  for (const name of [f.current, f.next, `${f.data}/app.sqlite`, `${f.data}/app.data.sqlite`, `${f.root}/active`]) assert.equal(fs.existsSync(name), false, name);
});

test('성공 이후 이력 정리 실패는 새 버전을 롤백하지 않고 이전 코드·백업을 보존한다', () => {
  const f = fixture();
  const result = f.execute({FAIL_CLEANUP: '1'});
  assert.equal(result.status, 0, result.output);
  assert.equal(fs.readlinkSync(f.current), f.next);
  assert.ok(fs.existsSync(f.old));
  assert.ok(fs.existsSync(f.snapshot));
  assert.match(result.output, /정상 snapshot\/release 정리/);
});

test('실패 후 백업 정리가 실패하면 대응 코드도 지우지 않는다', () => {
  const f = fixture();
  const result = f.execute({FAIL: 'prepare', FAIL_CLEANUP: '1'});
  assert.notEqual(result.status, 0, result.output);
  assertOld(f);
  assert.ok(fs.existsSync(f.next));
  assert.ok(fs.existsSync(f.snapshot));
});

test('업로드 임시파일 정리 실패는 이미 완료된 배포 결과를 바꾸지 않는다', () => {
  const f = fixture();
  const result = f.execute({FAIL: 'cleanup-upload'});
  assert.equal(result.status, 0, result.output);
  assert.equal(fs.readlinkSync(f.current), f.next);
  assert.match(result.output, /임시파일 정리에 실패/);
});

for (const [key, value] of [['HOST', ''], ['HOST', '-oProxyCommand=bad'], ['HOST', 'user@-bad'], ['SSH_USER', 'invalid user'], ['SSH_PORT', '0'], ['SSH_PORT', '65536'], ['SSH_JUMP', '-invalid'], ['SSH_HOST_KEY', 'bad'], ['SSH_OPTS', '-o "unterminated'], ['HOST', 'other@server.example.com']]) {
  test(`${key}=${value}는 빌드나 SSH 전에 거부한다`, () => {
    const f = fixture();
    fs.appendFileSync(`${f.repo}/deploy.env`, `${key}=${value}\n`);
    const result = f.execute();
    assert.notEqual(result.status, 0, result.output);
    assert.equal(f.trace().length, 0);
  });
}

test('설정 파일은 필수이며 부모 환경의 HOST로 대체하지 않는다', () => {
  const f = fixture();
  fs.rmSync(`${f.repo}/deploy.env`);
  const result = f.execute({HOST: 'server.example.com'});
  assert.notEqual(result.status, 0);
  assert.equal(f.trace().length, 0);
});

for (const directory of ['/tmp/outside', '/tmp/quant-deploy.fixture/../outside']) {
  test(`검증되지 않은 원격 임시 경로 ${directory}를 업로드·삭제하지 않는다`, () => {
    const f = fixture();
    const result = f.execute({REMOTE_DIRECTORY: directory});
    assert.notEqual(result.status, 0);
    assert.equal(f.trace().some(e => e.command === 'scp' || (e.command === 'ssh' && e.args.at(-1).startsWith('rm '))), false);
  });
}

test('설정의 명령 치환은 실행하지 않고 따옴표·CRLF·주석을 읽는다', () => {
  const f = fixture();
  fs.writeFileSync(`${f.repo}/deploy.env`, f.settings.replaceAll('\n', '\r\n') + `UNUSED=$(touch ${f.root}/unexpected)\r\nexport SSH_PORT = "2222" # port\r\n`);
  const result = f.execute();
  assert.equal(result.status, 0, result.output);
  assert.equal(fs.existsSync(`${f.root}/unexpected`), false);
});

test('공백·작은따옴표가 있는 저장소 경로와 빌드 표준 입력을 보존한다', () => {
  const f = fixture({quotedPath: true});
  const result = f.execute({READ_STDIN: '1'});
  assert.equal(result.status, 0, result.output);
});

test('과거 transaction이나 현재 릴리스 복구 마커가 있으면 서비스를 변경하지 않는다', () => {
  for (const marker of ['state', 'progress']) {
    const f = fixture();
    if (marker === 'state') { fs.mkdirSync(`${f.data}/deploy-transactions`); fs.writeFileSync(`${f.data}/deploy-transactions/old.state`, 'unfinished'); }
    else fs.writeFileSync(`${f.old}/.deploy-in-progress`, '');
    const result = f.execute();
    assert.equal(result.status, 75, result.output);
    assertOld(f);
    assert.equal(f.trace().some(e => e.command === 'systemctl' && e.args[0] === 'stop'), false);
  }
});

test('이미 존재하는 배포 경로는 덮거나 삭제하지 않는다', () => {
  const f = fixture();
  fs.mkdirSync(f.next); fs.writeFileSync(`${f.next}/keep`, 'owned-by-other');
  const result = f.execute();
  assert.notEqual(result.status, 0);
  assert.equal(fs.readFileSync(`${f.next}/keep`, 'utf8'), 'owned-by-other');
  assertOld(f);
});

test('깨진 current 심볼릭 링크는 빈 최초 배포로 취급하지 않는다', () => {
  const f = fixture();
  fs.unlinkSync(f.current); fs.symlinkSync(`${f.opt}/releases/missing`, f.current);
  const result = f.execute();
  assert.notEqual(result.status, 0);
  assert.equal(fs.readlinkSync(f.current), `${f.opt}/releases/missing`);
  assert.match(result.output, /안전하게 해석/);
});

test('복구 마커가 있는 과거 코드·백업은 정상 정리에서 제외한다', () => {
  const f = fixture();
  const failedRelease = `${f.opt}/releases/failed-release`, failedSnapshot = `${f.data}/backups/pre-deploy-failed.sqlite`;
  fs.mkdirSync(failedRelease); fs.writeFileSync(`${failedRelease}/.deploy-failed`, '');
  fs.writeFileSync(failedSnapshot, 'recovery'); fs.writeFileSync(`${failedSnapshot}.deploy-failed`, '');
  const result = f.execute();
  assert.equal(result.status, 0, result.output);
  assert.ok(fs.existsSync(failedRelease)); assert.ok(fs.existsSync(failedSnapshot));
});

test('원격 배포 잠금 충돌은 75로 종료하고 서비스를 변경하지 않는다', async () => {
  const f = fixture();
  const lock = `${f.root}/locks/quant-platform-deploy.lock`, ready = `${f.root}/lock-ready`;
  const holder = spawn('flock', ['-n', '-F', lock, '/bin/sh', '-c', `touch '${ready}'; exec /bin/sleep 20`]);
  try {
    for (let i=0; i<100 && !fs.existsSync(ready); i++) await delay(10);
    assert.ok(fs.existsSync(ready));
    const result = f.execute();
    assert.equal(result.status, 75, result.output);
    assertOld(f);
  } finally {
    holder.kill('SIGKILL');
    await new Promise(resolve => holder.once('exit', resolve));
  }
  assert.equal(f.execute().status, 0);
});

test('내부 호출 인자·경로 오류는 64로 종료하고 로컬 배포를 시작하지 않는다', () => {
  const f = fixture();
  for (const args of [['--remote', 'unknown'], ['--remote', '/tmp/outside', '/tmp/outside.sha256', release]]) {
    const result = f.execute({}, args);
    assert.equal(result.status, 64, result.output);
    assert.equal(f.trace().length, 0);
  }
});

test('운영 DB 없이 계산 DB만 있으면 파일을 삭제하거나 서비스를 중지하지 않는다', () => {
  const f = fixture();
  fs.unlinkSync(`${f.data}/app.sqlite`);
  const result = f.execute();
  assert.notEqual(result.status, 0);
  assert.equal(fs.readFileSync(`${f.data}/app.data.sqlite`, 'utf8'), 'old-data');
  assert.equal(f.trace().some(e => e.command === 'systemctl' && e.args[0] === 'stop'), false);
});

test('마이그레이션 명령이 시그널로 종료되면 코드·DB를 복원한다', () => {
  const f = fixture();
  const result = f.execute({SIGNAL: 'TERM'});
  assert.notEqual(result.status, 0, result.output);
  assertOld(f);
});

test('checksum 파일이 없으면 업로드를 시작하지 않는다', () => {
  const f = fixture();
  const result = f.execute({FAIL: 'missing-checksum'});
  assert.notEqual(result.status, 0);
  assert.equal(f.trace().some(e => e.command === 'scp'), false);
});
