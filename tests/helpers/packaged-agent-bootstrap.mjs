import process from 'node:process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// 저장소 밖으로 복사한 뒤 실행하며 모든 애플리케이션 모듈은 압축을 푼 패키지에서 읽는다.
const [, , packageRoot, stateDirectory] = process.argv;
const { AgentClient } = await import(pathToFileURL(path.join(packageRoot, 'dist/agent/client.js')).href);
const { readSettings } = await import(pathToFileURL(path.join(packageRoot, 'dist/agent/config.js')).href);
const client = new AgentClient(readSettings(stateDirectory), stateDirectory, async () => {
  process.stderr.write('배포 패키지와 테스트 서버의 실행 버전이 다릅니다\n');
  await client.stop();
  process.exit(1);
});
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await client.stop();
  process.exit(0);
}
process.once('SIGTERM', () => { void stop(); });
process.once('SIGINT', () => { void stop(); });
process.once('disconnect', () => { void stop(); });
client.start();
process.send?.({ type: 'STARTED', executable: process.execPath });
