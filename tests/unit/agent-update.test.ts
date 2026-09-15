import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runAgentCli } from '../../src/agent/cli.js';
import { writeSettings } from '../../src/agent/config.js';
import { activate, installRoot, type ClientManifest } from '../../src/agent/install.js';
import { updateAgent, withInstallLock } from '../../src/agent/update.js';

const oldVersion = 'a'.repeat(64);
const newVersion = 'b'.repeat(64);
const settings = { serverUrl: 'https://quant.example.com', token: 't'.repeat(48) };
let directory: string;
let state: string;
const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'quant-agent-update-test-'));
  state = path.join(directory, 'state');
  vi.stubEnv('XDG_DATA_HOME', path.join(directory, 'data'));
  vi.stubEnv('BUILD_GIT_SHA', oldVersion);
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  if (process.getuid) vi.spyOn(process, 'getuid').mockReturnValue(1000);
  fakeService('inactive');
  writeSettings(state, settings);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  fs.rmSync(directory, { recursive: true, force: true });
});

function fakeService(active: 'active' | 'inactive', restartExit = 0): void {
  const bin = path.join(directory, 'commands');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'systemctl'), `#!/bin/sh
case "$*" in
  *show*) printf 'LoadState=loaded\\nActiveState=${active}\\n' ;;
  *restart*) printf '%s\\n' "$*" >> '${directory}/service.log'; exit ${restartExit} ;;
esac
`, { mode: 0o755 });
  if (!process.env.PATH?.startsWith(bin)) vi.stubEnv('PATH', `${bin}:${process.env.PATH}`);
}

function packageDirectory(version: string, checkExit = 0): string {
  const source = fs.mkdtempSync(path.join(directory, 'package-'));
  fs.mkdirSync(path.join(source, 'bin'));
  fs.mkdirSync(path.join(source, 'dist/agent'), { recursive: true });
  fs.writeFileSync(path.join(source, 'bin/node'), `#!/bin/sh\nexit ${checkExit}\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(source, 'quant-agent'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(path.join(source, 'dist/agent/main.js'), '');
  fs.writeFileSync(path.join(source, 'dist/build-info.json'), JSON.stringify({ gitSha: 'd'.repeat(40) }));
  fs.writeFileSync(path.join(source, 'dist/runtime-versions.json'), JSON.stringify({ schemaVersion: 1, agentVersion: version, collectionVersion: version, previewVersion: version, executionVersion: version, validationVersion: version }));
  return source;
}

function publishedPackage(options: { version?: string; packageVersion?: string; hash?: string; checkExit?: number; bytesDelta?: number } = {}): ClientManifest {
  const version = options.version ?? newVersion;
  const source = packageDirectory(options.packageVersion ?? version, options.checkExit);
  const archive = spawnSync('tar', ['-czf', '-', '-C', source, '.']);
  expect(archive.status).toBe(0);
  const manifest: ClientManifest = { runnerVersion: version, clients: [{
    arch: process.arch as 'x64' | 'arm64', file: `quant-agent-linux-${process.arch}.tar.gz`,
    sha256: options.hash ?? createHash('sha256').update(archive.stdout).digest('hex'),
    bytes: archive.stdout.length + (options.bytesDelta ?? 0),
  }] };
  fetchMock.mockResolvedValueOnce(Response.json(manifest));
  fetchMock.mockResolvedValueOnce(new Response(new Uint8Array(archive.stdout)));
  return manifest;
}

function current(): string {
  return fs.realpathSync(path.join(installRoot(), 'current'));
}

function expectUntouched(previous: string): void {
  expect(current()).toBe(previous);
  expect(fs.existsSync(path.join(directory, 'service.log'))).toBe(false);
  expect(fs.existsSync(path.join(installRoot(), 'install.pid'))).toBe(false);
  const updates = path.join(state, 'updates');
  expect(fs.existsSync(updates) ? fs.readdirSync(updates) : []).toEqual([]);
}

describe('agent 수동 업데이트', () => {
  it('저장한 토큰으로 명세와 파일을 받아 설치하고 실행 중인 서비스를 재시작한다', async () => {
    activate(packageDirectory(oldVersion), oldVersion);
    const previous = current();
    fakeService('active');
    publishedPackage();
    const before = fs.readFileSync(path.join(state, 'settings.json'), 'utf8');

    await runAgentCli(['update', '--state', state]);

    expect(current()).toBe(path.join(installRoot(), 'releases', newVersion));
    expect(fs.existsSync(previous)).toBe(true);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      `${settings.serverUrl}/api/agents/client/latest`,
      `${settings.serverUrl}/api/agents/client/quant-agent-linux-${process.arch}.tar.gz`,
    ]);
    for (const [, options] of fetchMock.mock.calls) {
      expect(options).toMatchObject({ headers: { authorization: `Bearer ${settings.token}` }, redirect: 'error' });
    }
    expect(fs.readFileSync(path.join(directory, 'service.log'), 'utf8')).toBe('--user restart quant-agent.service\n');
    expect(fs.readFileSync(path.join(state, 'settings.json'), 'utf8')).toBe(before);
    expect(fs.readdirSync(path.join(state, 'updates'))).toEqual([]);
    expect(fs.existsSync(path.join(installRoot(), 'install.pid'))).toBe(false);
  });

  it('예전 실행 파일에서 호출해도 설치된 버전이 최신이면 다운로드와 재시작을 생략한다', async () => {
    activate(packageDirectory(newVersion), newVersion);
    fakeService('active');
    fetchMock.mockResolvedValueOnce(Response.json({ runnerVersion: newVersion, clients: [] }));
    await runAgentCli(['update', '--state', state]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(console.log).toHaveBeenCalledWith(`이미 게시된 최신 클라이언트입니다: ${newVersion}`);
    expect(fs.existsSync(path.join(directory, 'service.log'))).toBe(false);
  });

  it('최신 패키지 폴더에서 실행해도 설치 경로가 없으면 실제 설치를 진행한다', async () => {
    publishedPackage({ version: oldVersion });
    await expect(updateAgent(settings, state)).resolves.toEqual({ version: oldVersion, updated: true, restarted: false });
    expect(current()).toBe(path.join(installRoot(), 'releases', oldVersion));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('내용 버전이 같으면 재게시된 커밋이 달라도 설치를 바꾸지 않는다', async () => {
    const source = packageDirectory(newVersion);
    fs.rmSync(path.join(source, 'dist/build-info.json'));
    activate(source, newVersion);
    const previous = current();
    fetchMock.mockResolvedValueOnce(Response.json({ runnerVersion: newVersion, buildGitSha: 'e'.repeat(40), clients: [] }));
    await expect(updateAgent(settings, state)).resolves.toMatchObject({ updated: false });
    expectUntouched(previous);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('필수 내용 버전 메타데이터가 없으면 설치를 거부한다', () => {
    const source = packageDirectory(newVersion);
    fs.rmSync(path.join(source, 'dist/runtime-versions.json'));
    expect(() => activate(source, newVersion)).toThrow();
    expect(fs.existsSync(path.join(installRoot(), 'current'))).toBe(false);
  });

  it('설정이 없으면 토큰 입력 안내를 내고 서버에 요청하지 않는다', async () => {
    await expect(runAgentCli(['update', '--state', path.join(directory, 'missing')])).rejects.toThrow('quant-agent setup');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('systemd 서비스가 실행 중이 아니면 설치만 하고 새 실행 경로를 안내한다', async () => {
    publishedPackage();
    await runAgentCli(['update', '--state', state]);
    expect(current()).toBe(path.join(installRoot(), 'releases', newVersion));
    expect(fs.existsSync(path.join(directory, 'service.log'))).toBe(false);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining(path.join(installRoot(), 'current/quant-agent')));
  });

  it('서비스 재시작 실패를 설치 실패와 구분하고 새 패키지와 이전 패키지를 보존한다', async () => {
    activate(packageDirectory(oldVersion), oldVersion);
    fakeService('active', 1);
    publishedPackage();
    await expect(runAgentCli(['update', '--state', state])).rejects.toThrow('설치는 완료했지만 서비스 재시작에 실패');
    expect(current()).toBe(path.join(installRoot(), 'releases', newVersion));
    expect(fs.existsSync(path.join(installRoot(), 'releases', oldVersion))).toBe(true);
    expect(fs.existsSync(path.join(installRoot(), 'install.pid'))).toBe(false);
  });

  it.each([401, 503])('명세 조회 HTTP %i 오류가 나면 기존 설치를 보존한다', async (status) => {
    activate(packageDirectory(oldVersion), oldVersion);
    const previous = current();
    fetchMock.mockResolvedValueOnce(new Response(null, { status }));
    await expect(updateAgent(settings, state)).rejects.toThrow(`HTTP ${status}`);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expectUntouched(previous);
  });

  it.each([
    { hash: '0'.repeat(64), error: '무결성 검사 실패' },
    { bytesDelta: 1, error: '무결성 검사 실패' },
    { bytesDelta: -1, error: '파일 크기 초과' },
    { packageVersion: 'c'.repeat(64), error: '패키지의 버전이 다릅니다' },
    { checkExit: 1, error: '실행 실패' },
  ])('패키지 검증 실패 시 기존 설치를 보존한다: $error', async ({ error, ...options }) => {
    activate(packageDirectory(oldVersion), oldVersion);
    const previous = current();
    publishedPackage(options);
    await expect(updateAgent(settings, state, { restartService: true })).rejects.toThrow(error);
    expectUntouched(previous);
  });

  it('현재 아키텍처의 패키지가 없으면 기존 설치를 보존한다', async () => {
    activate(packageDirectory(oldVersion), oldVersion);
    const previous = current();
    fetchMock.mockResolvedValueOnce(Response.json({ runnerVersion: newVersion, clients: [] }));
    await expect(updateAgent(settings, state)).rejects.toThrow('CPU 아키텍처');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expectUntouched(previous);
  });

  it('자동 업데이트는 서버가 요구한 버전과 게시 버전이 같아야 한다', async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ runnerVersion: newVersion, clients: [] }));
    await expect(updateAgent(settings, state, { expectedVersion: oldVersion })).rejects.toThrow('운영 서버와 게시된 클라이언트 버전이 다릅니다');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('자동 업데이트에서도 같은 검증·설치 절차를 사용하고 서비스 제어는 호출자에게 맡긴다', async () => {
    fakeService('active');
    publishedPackage();
    await expect(updateAgent(settings, state, { expectedVersion: newVersion })).resolves.toEqual({ version: newVersion, updated: true, restarted: false });
    expect(fs.existsSync(path.join(directory, 'service.log'))).toBe(false);
  });

  it('설치와 자동·수동 업데이트가 겹치면 두 번째 요청은 실행하지 않는다', async () => {
    await withInstallLock(async () => {
      await expect(updateAgent(settings, state)).rejects.toThrow('다른 클라이언트 설치 또는 업데이트');
      expect(fetchMock).not.toHaveBeenCalled();
    });
    expect(fs.existsSync(path.join(installRoot(), 'install.pid'))).toBe(false);
  });

  it('종료된 업데이트 프로세스의 잠금은 회수한다', async () => {
    fs.mkdirSync(installRoot(), { recursive: true });
    fs.writeFileSync(path.join(installRoot(), 'install.pid'), '2147483647');
    await expect(withInstallLock(() => 'recovered')).resolves.toBe('recovered');
    expect(fs.existsSync(path.join(installRoot(), 'install.pid'))).toBe(false);
  });
});
