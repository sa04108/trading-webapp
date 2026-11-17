import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash';
const roots: string[] = [];
const oldImage = `ghcr.io/example/server@sha256:${'a'.repeat(64)}`;
const candidate = `sha256:${'b'.repeat(64)}`;
const oldId = `sha256:${'a'.repeat(64)}`;
const oldPending = `ghcr.io/example/server@sha256:${'c'.repeat(64)}`;
interface Call {
  args: string[];
  appEnv?: string;
  mode?: number;
  directoryMode?: number;
  domain?: string;
  memory?: string;
  trusted?: string;
}
function harness() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'docker-server-'));
  roots.push(root);
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  const log = path.join(root, 'docker.jsonl');
  fs.writeFileSync(path.join(bin, 'docker'), String.raw`#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const file = process.env.APP_ENV_FILE;
fs.appendFileSync(process.env.DOCKER_CALLS, JSON.stringify({ args,
  ...(file ? {appEnv:fs.readFileSync(file,'utf8'),mode:fs.statSync(file).mode & 0o777,
    directoryMode:fs.statSync(path.dirname(file)).mode & 0o777} : {}),
  domain:process.env.DOMAIN,memory:process.env.SERVER_MEMORY,trusted:process.env.TRAEFIK_TRUSTED_IPS })+'\n');
if (args[0] === 'pull') process.exit(Number(process.env.PULL_EXIT || 0));
if (args[0] === 'image' && args[1] === 'inspect') {
  if (process.env.MISSING_IMAGE === '1' || args[args.length - 1] === process.env.BAD_PIN) process.exit(1);
  const ref = args[args.length - 1];
  console.log((JSON.parse(process.env.IMAGE_IDS || '{}'))[ref] || (ref === process.env.OLD_IMAGE ? process.env.OLD_ID : process.env.CANDIDATE));
}
if (args[0] === 'image' && args[1] === 'ls') console.log(args.includes('--quiet') ? (process.env.DANGLING_IMAGES || '') : (process.env.TAGGED_IMAGES || ''));
if (args[0] === 'image' && args[1] === 'rm') process.exit(Number(process.env.CLEANUP_EXIT || 0));
if (args[0] === 'ps' && args.includes('--quiet')) console.log(process.env.CONTAINERS || '');
else if (args[0] === 'ps' && (process.env.SERVER_RUNNING === '1' || (args.includes('--all') && process.env.SERVER_EXISTS === '1'))) console.log('server-container-id');
if (args[0] === 'inspect') console.log(process.env.CONTAINER_IMAGES || '');
if (args[0] === 'buildx' && args[1] === 'inspect') process.exit(args[2] === process.env.REGISTERED_BUILDER ? 0 : 1);
if (args[0] === 'buildx' && args[1] === 'prune') process.exit(Number(process.env.CLEANUP_EXIT || 0));
if (args[0] === 'volume' && args[1] === 'inspect') process.exit(args[2] === process.env.EXISTING_VOLUME ? 0 : 1);
if (args[0] === 'volume' && args[1] === 'rm') process.exit(Number(process.env.CLEANUP_EXIT || 0));
if (args[0] === 'logs') console.log('server log');
if (args[0] === 'compose') {
  if (args.includes('up')) process.exit(Number(process.env.START_EXIT || 0));
  if (args.includes('db:prepare')) process.exit(Number(process.env.PREPARE_EXIT || 0));
  if (args.some(s => s.includes('loadConfig();'))) process.exit(Number(process.env.VALIDATE_EXIT || 0));
}
`);
  fs.chmodSync(path.join(bin, 'docker'), 0o755);
  const run = (args: string[], env: Record<string, string | undefined> = {}, holdBuildLock = false) => {
    const command = [path.resolve('scripts/server.sh'), ...args];
    const bashArgs = holdBuildLock
      ? ['-c', 'exec 8>"$1"; flock 8; shift; "$@"; status=$?; exit "$status"', 'lock', path.join(root, '.server-build.lock'), ...command]
      : command;
    const result = spawnSync(bash, bashArgs, {
      cwd: root, encoding: 'utf8', env: { ...process.env, DEPLOY_PATH: root,
        PATH: `${bin}:${process.env.PATH}`, DOCKER_CALLS: log, CANDIDATE: candidate, OLD_IMAGE: oldImage, OLD_ID: oldId, ...env },
    });
    const generated = path.join(root, '.server-runtime');
    if (fs.existsSync(generated)) expect(fs.readdirSync(generated)).toEqual([]);
    return result;
  };
  const calls = (): Call[] => fs.existsSync(log)
    ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as Call) : [];
  return { root, run, calls, clear: () => fs.writeFileSync(log, ''),
    file: (name: string) => path.join(root, name) };
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('Docker 서버 설정과 업데이트', () => {
  it('정리는 핀과 정지 컨테이너 및 다른 서비스 이미지를 보호한다', () => {
    const h = harness();
    const previous = `sha256:${'c'.repeat(64)}`;
    const pending = `sha256:${'d'.repeat(64)}`;
    const container = `sha256:${'e'.repeat(64)}`;
    const stale = `sha256:${'f'.repeat(64)}`;
    const dangling = `sha256:${'1'.repeat(64)}`;
    const buildCandidate = `sha256:${'2'.repeat(64)}`;
    const untagged = `sha256:${'3'.repeat(64)}`;
    const secondCandidate = `sha256:${'4'.repeat(64)}`;
    fs.writeFileSync(h.file('.server-image'), `${candidate}\n`);
    fs.writeFileSync(h.file('.server-image.previous'), 'invalid-legacy-pin\n');
    fs.writeFileSync(h.file('.server-update-pending'), `${pending}\n`);
    fs.mkdirSync(h.file('.server-build-candidates'));
    fs.writeFileSync(h.file('.server-build-candidates/first'), `${buildCandidate}\n`);
    fs.writeFileSync(h.file('.server-build-candidates/second'), `${secondCandidate}\n`);
    const env = {
      IMAGE_IDS: JSON.stringify({ [candidate]: candidate, [previous]: previous, [pending]: pending, [buildCandidate]: buildCandidate, [secondCandidate]: secondCandidate }),
      CONTAINERS: 'stopped-container', CONTAINER_IMAGES: container,
      BAD_PIN: 'invalid-legacy-pin',
      TAGGED_IMAGES: [
        `${candidate} quant-platform:current`, `${previous} quant-platform:previous`,
        `${pending} quant-platform:pending`, `${container} quant-platform:in-use`,
        `${buildCandidate} quant-platform:building`, `${secondCandidate} quant-platform:building-other`, `${untagged} quant-platform:<none>`,
        `${stale} quant-platform:stale`, `${stale} ghcr.io/sa04108/quant-platform:stale`,
        `${stale} other-service:latest`,
      ].join('\n'),
      DANGLING_IMAGES: dangling,
    };
    expect(h.run(['cleanup'], env).status).toBe(0);
    expect(fs.existsSync(h.file('.server-image.previous'))).toBe(false);
    expect(h.calls().filter(call => call.args[0] === 'image' && call.args[1] === 'rm').map(call => call.args)).toEqual([
      ['image', 'rm', '--no-prune', 'quant-platform:previous'],
      ['image', 'rm', '--no-prune', untagged],
      ['image', 'rm', '--no-prune', 'quant-platform:stale'],
      ['image', 'rm', '--no-prune', 'ghcr.io/sa04108/quant-platform:stale'],
      ['image', 'rm', '--no-prune', dangling],
    ]);
    const danglingQuery = h.calls().find(call => call.args[0] === 'image' && call.args.includes('dangling=true'))!;
    expect(danglingQuery.args.join(' ')).toContain('label=org.opencontainers.image.source=https://github.com/sa04108/trading-webapp');
    expect(danglingQuery.args.join(' ')).toContain('label=org.opencontainers.image.title=Quant Platform');
  });

  it('현재 핀이 없거나 진행 중인 핀이 끊어진 링크면 이미지 삭제를 건너뛴다', () => {
    const h = harness();
    const env = { TAGGED_IMAGES: `${candidate} quant-platform:stale` };
    expect(h.run(['cleanup'], env).status).toBe(0);
    expect(h.calls().some(call => call.args[0] === 'image' && call.args[1] === 'rm')).toBe(false);
    fs.writeFileSync(h.file('.server-image'), `${candidate}\n`);
    fs.symlinkSync('missing-image-pin', h.file('.server-update-pending'));
    h.clear();
    expect(h.run(['cleanup'], env).status).toBe(0);
    expect(h.calls().some(call => call.args[0] === 'image' && call.args[1] === 'rm')).toBe(false);
  });

  it('빌드 잠금을 다른 프로세스가 보유하면 모든 정리를 건너뛴다', () => {
    const h = harness();
    fs.writeFileSync(h.file('.server-image'), `${candidate}\n`);
    const result = h.run(['cleanup'], {
      TAGGED_IMAGES: `sha256:${'f'.repeat(64)} quant-platform:stale`,
      REGISTERED_BUILDER: 'quant-server-build', EXISTING_VOLUME: 'buildx_buildkit_quant-server-manual0_state',
    }, true);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain('빌드 중');
    expect(h.calls().some(call =>
      (call.args[0] === 'image' && call.args[1] === 'rm') ||
      (call.args[0] === 'buildx' && call.args[1] === 'prune') ||
      (call.args[0] === 'volume' && call.args[1] === 'rm'))).toBe(false);
  });

  it('복구 핀을 확인하지 못하면 모든 이미지 삭제를 건너뛴다', () => {
    const h = harness();
    fs.writeFileSync(h.file('.server-image'), 'missing-pin\n');
    const result = h.run(['cleanup'], { BAD_PIN: 'missing-pin', TAGGED_IMAGES: `${candidate} quant-platform:stale` });
    expect(result.status).toBe(0);
    expect(result.stderr).toContain('이미지 정리');
    expect(h.calls().some(call => call.args[0] === 'image' && call.args[1] === 'rm')).toBe(false);
  });

  it('업데이트와 정리는 빌더 캐시를 보존하고 이미지 정리 실패에도 배포를 유지한다', () => {
    const h = harness();
    expect(h.run(['init']).status).toBe(0);
    fs.writeFileSync(h.file('.server-image'), `${oldImage}\n`);
    fs.writeFileSync(h.file('.server-image.previous'), 'invalid-legacy-pin\n');
    h.clear();
    const env = {
      REGISTERED_BUILDER: 'quant-server-build', EXISTING_VOLUME: 'buildx_buildkit_quant-server-manual0_state',
      CLEANUP_EXIT: '1', TAGGED_IMAGES: `sha256:${'f'.repeat(64)} quant-platform:stale`,
    };
    const result = h.run(['update', 'quant-platform:release'], env);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain('정리 실패');
    expect(fs.readFileSync(h.file('.server-image'), 'utf8').trim()).toBe(candidate);
    expect(fs.existsSync(h.file('.server-image.previous'))).toBe(false);
    expect(fs.existsSync(h.file('.server-update-pending'))).toBe(false);
    expect(h.run(['cleanup'], env).status).toBe(0);
    expect(h.calls().some(call => call.args[0] === 'buildx' && call.args[1] === 'prune')).toBe(false);
    expect(h.calls().some(call => call.args[0] === 'volume' && call.args[1] === 'rm')).toBe(false);
  });

  it('설정 실패는 기존 서버를 유지하고 DB 준비·기동 실패는 같은 후보로만 복구한다', () => {
    const h = harness();
    expect(h.run(['init']).status).toBe(0);
    const original = fs.readFileSync(h.file('config.env'), 'utf8');
    expect(h.run(['init']).status).toBe(0);
    expect(fs.readFileSync(h.file('config.env'), 'utf8')).toBe(original);
    expect(fs.statSync(h.file('config.env')).mode & 0o777).toBe(0o600);
    fs.writeFileSync(h.file('.server-image'), `${oldImage}\n`);
    expect(h.run(['cli', 'admin:create'], { SERVER_RUNNING: '1' }).status).not.toBe(0);
    h.clear();
    expect(h.run(['update'], { VALIDATE_EXIT: '1', SERVER_RUNNING: '1' }).status).not.toBe(0);
    expect(h.calls().some(call => call.args[0] === 'stop')).toBe(false);
    expect(fs.existsSync(h.file('.server-update-pending'))).toBe(false);
    for (const failure of [{ PREPARE_EXIT: '1' }, { START_EXIT: '1' }]) {
      h.clear();
      expect(h.run(['update'], failure).status).not.toBe(0);
      expect(h.calls().some(call => call.args[0] === 'buildx' && call.args[1] === 'prune')).toBe(false);
      expect(h.calls().some(call => call.args[0] === 'image' && call.args[1] === 'rm')).toBe(false);
      expect(h.calls().some(call => call.args[0] === 'volume' && call.args[1] === 'rm')).toBe(false);
      expect(fs.readFileSync(h.file('.server-image'), 'utf8').trim()).toBe(oldImage);
      expect(fs.readFileSync(h.file('.server-update-pending'), 'utf8').trim()).toBe(candidate);
      h.clear();
      expect(h.run(['up']).status).not.toBe(0);
      expect(h.calls().some(call => call.args.includes('up'))).toBe(false);
    }
    h.clear();
    expect(h.run(['update', oldImage]).status).not.toBe(0);
    expect(h.calls().some(call => call.args.includes('db:prepare'))).toBe(false);
    // 이전 배포에서 남긴 digest도 같은 로컬 이미지면 재시도할 수 있다.
    fs.writeFileSync(h.file('.server-update-pending'), `${oldPending}\n`);
    expect(h.run(['update', 'quant-platform:release']).status).toBe(0);
    // runner checkout의 배포 구성을 사용하고 운영 폴더의 설정·상태는 보존한다.
    const composeCall = h.calls().find(call => call.args[0] === 'compose')!;
    expect(composeCall.args[composeCall.args.indexOf('-f') + 1]).toBe(path.resolve('compose.yaml'));
    expect(composeCall.args[composeCall.args.indexOf('--project-directory') + 1]).toBe(h.root);
    expect(fs.readFileSync(h.file('config.env'), 'utf8')).toBe(original);
    expect(fs.existsSync(h.file('.server-update-pending'))).toBe(false);
    expect(fs.readFileSync(h.file('.server-image'), 'utf8').trim()).toBe(candidate);
    expect(fs.existsSync(h.file('.server-image.previous'))).toBe(false);
  });

  it('없는 로컬 이미지는 서버를 유지하고 태그는 이미지 ID로 고정하며 내려받지 않는다', () => {
    const h = harness();
    expect(h.run(['init']).status).toBe(0);
    fs.writeFileSync(h.file('.server-image'), `${oldImage}\n`);
    h.clear();
    expect(h.run(['update', 'quant-platform:release'], { MISSING_IMAGE: '1', SERVER_RUNNING: '1' }).status).not.toBe(0);
    expect(h.calls().some(call => call.args[0] === 'stop')).toBe(false);
    expect(fs.existsSync(h.file('.server-update-pending'))).toBe(false);
    h.clear();
    expect(h.run(['update', 'quant-platform:release']).status).toBe(0);
    expect(fs.readFileSync(h.file('.server-image'), 'utf8').trim()).toBe(candidate);
    expect(fs.existsSync(h.file('.server-image.previous'))).toBe(false);
    expect(h.calls().some(call => call.args[0] === 'pull')).toBe(false);
    const runs = h.calls().filter(call => call.args[0] === 'compose' && (call.args.includes('run') || call.args.includes('up')));
    expect(runs.length).toBeGreaterThan(0);
    expect(runs.every(call => call.args.includes('--pull') && call.args.includes('never'))).toBe(true);
  });

  it('원본의 특수문자·비밀값을 실행 없이 보존하고 앱 설정만 격리하여 전달한다', () => {
    const h = harness();
    expect(h.run(['init']).status).toBe(0);
    const sentinel = h.file('must-not-execute');
    const secret = `literal $HOME \\ "quoted" '#hash' = $(touch ${sentinel})`;
    fs.appendFileSync(h.file('config.env'), `DART_API_KEY=${secret}\nAGENT_DATASET_BYTES_PER_SECOND=524288\n`);
    const result = h.run(['validate'], { DOMAIN: 'wrong.example.com', SERVER_MEMORY: '1m' });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout + result.stderr).not.toContain(secret);
    expect(fs.existsSync(sentinel)).toBe(false);
    const validation = h.calls().find(call => call.args.some(arg => arg.includes('loadConfig();')))!;
    expect(validation.appEnv).toContain(`DART_API_KEY=${secret}\n`);
    expect(validation.appEnv).toContain('NODE_ENV=production\n');
    expect(validation.appEnv).toContain('AGENT_DATASET_BYTES_PER_SECOND=524288\n');
    expect(validation.appEnv).not.toMatch(/^(DOMAIN|SERVER_|TRAEFIK_)/m);
    expect(validation.domain).toBe('trading.hyunbbai.com');
    expect(validation.memory).toBe('12g');
    expect(validation.args).not.toContain(secret);
    // 일회성 설정 검사에 운영 라우터가 연결되면 정상 앱의 요청도 실패한다.
    expect(validation.args).toContain('traefik.enable=false');
    expect(validation.mode).toBe(0o600);
    expect(validation.directoryMode).toBe(0o700);
  });

  it('중복·폐기된 키는 적용 전에 거부하며 잘못된 설정에서도 상태·로그·중지는 가능하다', () => {
    const h = harness();
    expect(h.run(['init']).status).toBe(0);
    const valid = fs.readFileSync(h.file('config.env'), 'utf8');
    for (const invalid of ['DOMAIN=other.example.com', 'SSH_KEY=must-not-be-logged', 'SERVER_CPUS=0']) {
      fs.writeFileSync(h.file('config.env'), `${valid}\n${invalid}\n`);
      const result = h.run(['up']);
      expect(result.status).not.toBe(0);
      expect(result.stdout + result.stderr).not.toContain('must-not-be-logged');
      expect(h.calls()).toEqual([]);
    }
    for (const command of ['status', 'logs', 'stop']) expect(h.run([command], { SERVER_EXISTS: '1' }).status).toBe(0);
    expect(h.calls().some(call => call.args[0] === 'stop')).toBe(true);
  });

  it('이전 설정이 있으면 새 SESSION_SECRET을 만들어 기존 세션을 교체하지 않는다', () => {
    const h = harness();
    fs.writeFileSync(h.file('app.env'), 'SESSION_SECRET=existing-secret-must-stay\n');
    expect(h.run(['init']).status).not.toBe(0);
    expect(fs.existsSync(h.file('config.env'))).toBe(false);
    expect(fs.readFileSync(h.file('app.env'), 'utf8')).toBe('SESSION_SECRET=existing-secret-must-stay\n');
  });
});
