import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { AgentSettings } from './config.js';
import { activate, downloadUpdate, fetchClientManifest, installRoot } from './install.js';

/** 설치와 자동·수동 업데이트가 같은 릴리스 경로를 동시에 교체하지 않게 한다. */
export async function withInstallLock<T>(action: () => Promise<T> | T): Promise<T> {
  const root = installRoot();
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const lock = path.join(root, 'install.pid');
  let descriptor: number;
  try {
    descriptor = fs.openSync(lock, 'wx', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const pid = Number(fs.readFileSync(lock, 'utf8'));
    let stale = false;
    if (Number.isSafeInteger(pid) && pid > 0) {
      try { process.kill(pid, 0); }
      catch (failure) { stale = (failure as NodeJS.ErrnoException).code === 'ESRCH'; }
    }
    if (!stale) throw new Error('다른 클라이언트 설치 또는 업데이트가 진행 중입니다. 완료 후 다시 시도하세요.', { cause: error });
    fs.unlinkSync(lock);
    descriptor = fs.openSync(lock, 'wx', 0o600);
  }
  try {
    fs.writeFileSync(descriptor, String(process.pid));
    return await action();
  } finally {
    fs.closeSync(descriptor);
    fs.rmSync(lock, { force: true });
  }
}

function installedVersion(): string | null {
  const metadata = path.join(installRoot(), 'current/dist/build-info.json');
  // 예전 압축 해제 폴더에서 명령을 실행해도 실제 설치된 버전을 우선한다.
  if (fs.existsSync(path.join(installRoot(), 'current/quant-agent')) && fs.existsSync(metadata)) return (JSON.parse(fs.readFileSync(metadata, 'utf8')) as { gitSha: string }).gitSha;
  return null;
}

function restartRunningService(): boolean {
  const status = spawnSync('systemctl', ['--user', 'show', 'quant-agent.service', '--property=LoadState,ActiveState'], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (status.status !== 0 || !/^LoadState=loaded$/m.test(status.stdout)
    || !/^ActiveState=(active|activating|reloading)$/m.test(status.stdout)) return false;
  const restart = spawnSync('systemctl', ['--user', 'restart', 'quant-agent.service'], { stdio: 'inherit' });
  if (restart.status !== 0) throw new Error('클라이언트 설치는 완료했지만 서비스 재시작에 실패했습니다. systemctl --user restart quant-agent를 실행하세요.');
  return true;
}

export interface AgentUpdateResult { version: string; updated: boolean; restarted: boolean }

/** 저장된 토큰으로 게시 버전을 조회하고 검증된 패키지만 현재 설치로 전환한다. */
export async function updateAgent(settings: AgentSettings, state: string, options: {
  expectedVersion?: string;
  restartService?: boolean;
} = {}): Promise<AgentUpdateResult> {
  return withInstallLock(async () => {
    const manifest = await fetchClientManifest(settings);
    const version = manifest.runnerVersion;
    if (options.expectedVersion !== undefined && version !== options.expectedVersion) {
      throw new Error('운영 서버와 게시된 클라이언트 버전이 다릅니다');
    }
    if (version === installedVersion()) return { version, updated: false, restarted: false };
    const updates = path.join(state, 'updates');
    fs.mkdirSync(updates, { recursive: true, mode: 0o700 });
    const directory = fs.mkdtempSync(path.join(updates, 'client-'));
    try {
      const unpacked = await downloadUpdate(settings, version, directory, manifest);
      activate(unpacked, version);
      const restarted = options.restartService === true && restartRunningService();
      return { version, updated: true, restarted };
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
}
