import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runAgentCli } from '../../src/agent/cli.js';
import { readEnvironmentSettings, writeSettings } from '../../src/agent/config.js';

const mocks = vi.hoisted(() => ({ start: vi.fn(), stop: vi.fn(), construct: vi.fn(), update: vi.fn() }));
vi.mock('../../src/agent/client.js', () => ({
  AgentClient: class {
    start = mocks.start;
    stop = mocks.stop;
    constructor(...args: unknown[]) { mocks.construct(...args); }
  },
}));
vi.mock('../../src/agent/update.js', () => ({ updateAgent: mocks.update, withInstallLock: vi.fn() }));
let directory: string;
const settings = { serverUrl: 'https://quant.example.com', token: 't'.repeat(48) };

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-container-'));
  vi.stubEnv('QUANT_AGENT_CONTAINER', '1');
  vi.stubEnv('QUANT_AGENT_SERVER_URL', settings.serverUrl);
  vi.stubEnv('QUANT_AGENT_TOKEN', settings.token);
  if (process.getuid) vi.spyOn(process, 'getuid').mockReturnValue(1000);
  vi.spyOn(process, 'once').mockReturnValue(process);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.clearAllMocks();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(directory, { recursive: true, force: true });
});

describe('컨테이너 Agent 설정과 업데이트', () => {
  it('환경변수로 비대화형 실행하고 토큰을 상태 볼륨에 기록하지 않는다', async () => {
    await runAgentCli(['run', '--state', directory]);
    expect(mocks.construct).toHaveBeenCalledWith(settings, directory, expect.any(Function));
    expect(mocks.start).toHaveBeenCalledOnce();
    expect(fs.readdirSync(directory)).toEqual([]);
  });

  it('볼륨에 남은 설정 대신 이번 실행에 주입된 토큰을 사용한다', async () => {
    writeSettings(directory, { serverUrl: 'https://old.example.com', token: 'o'.repeat(48) });
    const before = fs.readFileSync(path.join(directory, 'settings.json'), 'utf8');
    await runAgentCli(['run', '--state', directory]);
    expect(mocks.construct.mock.calls[0]?.[0]).toEqual(settings);
    expect(fs.readFileSync(path.join(directory, 'settings.json'), 'utf8')).toBe(before);
  });

  it.each(['QUANT_AGENT_SERVER_URL', 'QUANT_AGENT_TOKEN'])('필수 환경변수 %s가 없으면 실행하지 않는다', async (name) => {
    vi.stubEnv(name, undefined);
    await expect(runAgentCli(['run', '--state', directory])).rejects.toThrow('QUANT_AGENT_SERVER_URL');
    expect(mocks.start).not.toHaveBeenCalled();
  });

  it('서버가 업데이트를 요구해도 컨테이너의 실행 파일을 교체하지 않는다', async () => {
    await runAgentCli(['run', '--state', directory]);
    const onUpdate = mocks.construct.mock.calls[0]?.[2] as (version: string) => Promise<void>;
    await onUpdate('a'.repeat(64));
    expect(mocks.update).not.toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Windows 설치 파일을 다시 실행'));
  });

  it.each(['install', 'setup', 'update'])('컨테이너의 %s 명령은 거부한다', async (command) => {
    await expect(runAgentCli([command, '--state', directory])).rejects.toThrow('Docker에서는 run 명령만');
    expect(mocks.construct).not.toHaveBeenCalled();
  });

  it('잘못된 서버 주소와 토큰을 포함하지 않는 오류를 반환한다', () => {
    expect(() => readEnvironmentSettings({ QUANT_AGENT_SERVER_URL: 'https://user:secret@example.com', QUANT_AGENT_TOKEN: settings.token })).toThrow('HTTPS 서버 주소');
    expect(() => readEnvironmentSettings({ QUANT_AGENT_SERVER_URL: settings.serverUrl, QUANT_AGENT_TOKEN: 'bad' })).toThrow('Agent 토큰');
  });
});
