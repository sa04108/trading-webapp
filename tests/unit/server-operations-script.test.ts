import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash';
const roots: string[] = [];
const oldImage = `ghcr.io/example/server@sha256:${'a'.repeat(64)}`;
const candidate = `ghcr.io/example/server@sha256:${'b'.repeat(64)}`;
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
if (args[0] === 'image') console.log(process.env.CANDIDATE);
if (args[0] === 'ps' && (process.env.SERVER_RUNNING === '1' || (args.includes('--all') && process.env.SERVER_EXISTS === '1'))) console.log('server-container-id');
if (args[0] === 'logs') console.log('server log');
if (args[0] === 'compose') {
  if (args.includes('up')) process.exit(Number(process.env.START_EXIT || 0));
  if (args.includes('db:prepare')) process.exit(Number(process.env.PREPARE_EXIT || 0));
  if (args.some(s => s.includes('loadConfig();'))) process.exit(Number(process.env.VALIDATE_EXIT || 0));
}
`);
  fs.chmodSync(path.join(bin, 'docker'), 0o755);
  const run = (args: string[], env: Record<string, string | undefined> = {}) => {
    const result = spawnSync(bash, [path.resolve('scripts/server.sh'), ...args], {
      cwd: root, encoding: 'utf8', env: { ...process.env, QUANT_SERVER_HOME: root,
        PATH: `${bin}:${process.env.PATH}`, DOCKER_CALLS: log, CANDIDATE: candidate, ...env },
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
      expect(h.run(['update'], failure).status).not.toBe(0);
      expect(fs.readFileSync(h.file('.server-image'), 'utf8').trim()).toBe(oldImage);
      expect(fs.readFileSync(h.file('.server-update-pending'), 'utf8').trim()).toBe(candidate);
      h.clear();
      expect(h.run(['up']).status).not.toBe(0);
      expect(h.calls().some(call => call.args.includes('up'))).toBe(false);
    }
    h.clear();
    expect(h.run(['update'], { CANDIDATE: oldImage }).status).not.toBe(0);
    expect(h.calls().some(call => call.args.includes('db:prepare'))).toBe(false);
    // 로컬 별칭 목록보다 게시 작업에서 검증된 digest를 우선한다.
    expect(h.run(['update', candidate], { CANDIDATE: oldImage }).status).toBe(0);
    // runner checkout의 배포 구성을 사용하고 운영 폴더의 설정·상태는 보존한다.
    const composeCall = h.calls().find(call => call.args[0] === 'compose')!;
    expect(composeCall.args[composeCall.args.indexOf('-f') + 1]).toBe(path.resolve('compose.yaml'));
    expect(composeCall.args[composeCall.args.indexOf('--project-directory') + 1]).toBe(h.root);
    expect(fs.readFileSync(h.file('config.env'), 'utf8')).toBe(original);
    expect(fs.existsSync(h.file('.server-update-pending'))).toBe(false);
    expect(fs.readFileSync(h.file('.server-image'), 'utf8').trim()).toBe(candidate);
    expect(fs.readFileSync(h.file('.server-image.previous'), 'utf8').trim()).toBe(oldImage);
  });

  it('원본의 특수문자·비밀값을 실행 없이 보존하고 앱 설정만 격리하여 전달한다', () => {
    const h = harness();
    expect(h.run(['init']).status).toBe(0);
    const sentinel = h.file('must-not-execute');
    const secret = `literal $HOME \\ "quoted" '#hash' = $(touch ${sentinel})`;
    fs.appendFileSync(h.file('config.env'), `DART_API_KEY=${secret}\n`);
    const result = h.run(['validate'], { DOMAIN: 'wrong.example.com', SERVER_MEMORY: '1m' });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout + result.stderr).not.toContain(secret);
    expect(fs.existsSync(sentinel)).toBe(false);
    const validation = h.calls().find(call => call.args.some(arg => arg.includes('loadConfig();')))!;
    expect(validation.appEnv).toContain(`DART_API_KEY=${secret}\n`);
    expect(validation.appEnv).toContain('NODE_ENV=production\n');
    expect(validation.appEnv).not.toMatch(/^(DOMAIN|SERVER_|TRAEFIK_)/m);
    expect(validation.domain).toBe('trading.hyunbbai.com');
    expect(validation.memory).toBe('10g');
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
