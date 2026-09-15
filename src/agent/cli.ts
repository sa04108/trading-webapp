import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { defaultStateDirectory, readSettings, writeSettings } from './config.js';
import { installRoot, installService } from './install.js';
import { updateAgent, withInstallLock } from './update.js';
import { readGitCommitSha } from '../server/shared/build-info.js';

export async function runAgentCli(args: string[] = process.argv.slice(2)): Promise<void> {
  if (process.platform !== 'linux') throw new Error('Linux 또는 WSL2에서 실행하세요');
  if (args[0] === '--check') {
    await import('./client.js');
    console.log(`quant-agent ${readGitCommitSha()} linux-${process.arch}`);
    return;
  }
  if (process.getuid?.() === 0) throw new Error('에이전트는 root 대신 일반 사용자로 실행하세요');
  const index = args.indexOf('--state');
  const state = path.resolve(index >= 0 ? args[index + 1] ?? defaultStateDirectory() : defaultStateDirectory());
  const command = args[0] ?? 'install';
  if (!['install', 'run', 'setup', 'update'].includes(command)) throw new Error('사용법: quant-agent [install|run|setup|update] [--state 경로]');
  if (command === 'update' && !fs.existsSync(path.join(state, 'settings.json'))) {
    throw new Error('먼저 quant-agent setup으로 서버 주소와 Agent 토큰을 설정하세요');
  }
  if (command === 'setup' || !fs.existsSync(path.join(state, 'settings.json'))) {
    if (!process.stdin.isTTY) throw new Error('먼저 quant-agent setup으로 서버 주소와 Agent 토큰을 설정하세요');
    const prompt = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    try {
      const serverUrl = (await prompt.question('운영 서버 주소: ')).trim();
      const token = (await prompt.question('운영 화면에서 발급한 Agent 토큰: ')).trim();
      writeSettings(state, { serverUrl, token });
    } finally { prompt.close(); }
  }
  if (command === 'setup') return;
  if (command === 'install') {
    await withInstallLock(() => installService(fileURLToPath(new URL('../../', import.meta.url)), readGitCommitSha(), state));
    console.log('백그라운드 에이전트를 시작했습니다. 상태: systemctl --user status quant-agent');
    return;
  }
  const settings = readSettings(state);
  if (command === 'update') {
    const result = await updateAgent(settings, state, { restartService: true });
    if (!result.updated) console.log(`이미 게시된 최신 클라이언트입니다: ${result.version}`);
    else {
      console.log(`클라이언트 업데이트 완료: ${result.version}`);
      if (result.restarted) console.log('백그라운드 서비스를 새 버전으로 재시작했습니다.');
      else console.log(`새 클라이언트 실행 파일: ${path.join(installRoot(), 'current/quant-agent')}\n직접 실행 중인 agent는 종료한 뒤 이 파일로 run 명령을 다시 실행하세요.`);
    }
    return;
  }
  // 설치·설정·업데이트 명령은 계산 런타임과 네이티브 DB 모듈을 로드하지 않는다.
  const { AgentClient } = await import('./client.js');
  const client = new AgentClient(settings, state, async (version) => {
    await updateAgent(settings, state, { expectedVersion: version });
    await client.stop();
    console.log('클라이언트 업데이트 완료 — 백그라운드 서비스가 새 버전으로 재시작합니다');
    process.exit(75);
  });
  client.start();
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    void client.stop().then(() => process.exit(0));
  };
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
}
