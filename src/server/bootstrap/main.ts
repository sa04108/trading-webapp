import { configureZodLocale } from '../shared/zod-locale.js';
import { loadConfig } from './config.js';
import { createContainer } from './container.js';
import { buildServer } from './server.js';
import { readGitCommitSha } from '../shared/build-info.js';

async function main(): Promise<void> {
  configureZodLocale();
  const config = loadConfig();
  if (
    config.nodeEnv === 'production'
    && config.backtestExecutionMode === 'remote'
    && readGitCommitSha(config.nodeEnv) === 'unknown'
  ) {
    throw new Error('remote 실행에는 dist/build-info.json의 Git SHA가 필요합니다');
  }
  const container = createContainer(config);
  await container.remoteInputBundleManager.cleanupOrphanedBundles();
  await container.remoteResultUploadManager.cleanupOrphanedUploads();
  const app = await buildServer(container);

  // Install signal handling before recovery can launch background child work. Graceful container
  // close owns the bounded child termination and must finish before the process exits.
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    container.logger.info({ module: 'bootstrap', event: 'server.stopping', signal }, 'shutting down');
    const appClosing = app.close();
    // Fastify drains in-flight handlers. Stop their isolated RPC lane concurrently or a blocked
    // GET_READY/NEEDS_DART child could prevent app.close from ever reaching container.close.
    await container.backtestPreparationOrchestrator.stop();
    await appClosing;
    await container.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  // 부팅 복구는 포트를 열기 **전에** 끝낸다.
  // 열고 나서 하면 그 사이에 들어온 요청이 아직 안 거둔 `RUNNING` 행을 본다.
  // 지금은 두 줄이 붙어 있어 안전하지만, 사이에 `await` 이 하나만 끼어도 되살아난다.
  //
  // CLI 서브커맨드도 같은 컨테이너를 만들지만 이 두 메서드는 부르지 않는다.
  // 서버 부팅 경로에서만 불러야 하는 근거는 `recoverOrphaned` 의 주석을 참고한다.
  if (config.backtestExecutionMode === 'local') container.jobOrchestrator.start();
  else {
    // 이전 local 모드에서 서버와 함께 종료된 child 행만 INTERRUPTED로 정리한다.
    // remote lease는 서버 재시작 뒤에도 worker가 heartbeat를 이어 갈 수 있으므로 보존한다.
    container.jobOrchestrator.recoverOrphaned(false);
    container.remoteWorkerService.start();
  }
  container.seedCloneBatchService.recover();
  container.backtestPreparationOrchestrator.recoverOrphaned();

  await app.listen({ host: config.bindAddress, port: config.port });
  const withoutTotp = container.userRepository.listUsernamesWithoutTotp();
  if (withoutTotp.length > 0) {
    container.logger.warn(
      { module: 'bootstrap', event: 'auth.totp.not-enrolled', usernames: withoutTotp },
      'TOTP 미등록 계정 — 퍼블릭 노출 전에 totp:enroll 로 등록하라 (D-017)',
    );
  }
  container.logger.info(
    { module: 'bootstrap', event: 'server.started', address: config.bindAddress, port: config.port },
    'server started',
  );

  // 뒤에서 도는 작업(자본변동 수집 등)이 남긴 프로미스 거부를 마지막에 받는다.
  // 핸들러가 없으면 Node 가 프로세스를 그대로 죽인다.
  // 종료 중에 닫힌 DB 를 만나 죽는 것이 실제로 밟히는 경로다.
  process.on('unhandledRejection', (reason: unknown) => {
    container.logger.error(
      { module: 'bootstrap', event: 'process.unhandled-rejection', err: reason },
      'unhandled promise rejection',
    );
  });
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
