import { configureZodLocale } from "../shared/zod-locale.js";
import { loadConfig } from "./config.js";
import { createContainer } from "./container.js";
import { buildServer } from "./server.js";
import { readRuntimeVersions } from "../../runtime/shared/runtime-versions.js";

async function main(): Promise<void> {
  configureZodLocale();
  const config = loadConfig();
  readRuntimeVersions();
  const container = createContainer(config);
  await container.remoteResultUploadManager.cleanupOrphanedUploads();
  const app = await buildServer(container);

  // 복구 작업을 시작하기 전에 종료 신호를 처리한다.
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    container.logger.info(
      { module: "bootstrap", event: "server.stopping", signal },
      "shutting down",
    );
    const appClosing = app.close();
    await container.backtestPreparationOrchestrator.stop();
    await appClosing;
    await container.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  // 부팅 복구는 포트를 열기 **전에** 끝낸다.
  // 열고 나서 하면 그 사이에 들어온 요청이 아직 안 거둔 `RUNNING` 행을 본다.
  // 위저드 버전 복구와 기존 큐 복구 사이에는 외부 요청이나 결과를 받지 않는다.
  // CLI 서브커맨드도 같은 컨테이너를 만들지만 부팅 복구는 실행하지 않는다.
  // 서버 부팅 경로에서만 불러야 하는 근거는 `recoverOrphaned` 의 주석을 참고한다.
  // 버전이 바뀐 위저드는 이전 임대를 먼저 막는다. 같은 버전의 임대는 재접속을 허용한다.
  container.backtestWizardRecoveryService.recover();
  container.jobOrchestrator.start();
  container.agentCoordinator.start();
  container.backtestPreparationOrchestrator.recoverOrphaned(container.refreshProviderFilings);
  container.intradayService.recover();

  await app.listen({ host: config.bindAddress, port: config.port });
  const withoutTotp = container.userRepository.listUsernamesWithoutTotp();
  if (withoutTotp.length > 0) {
    container.logger.warn(
      {
        module: "bootstrap",
        event: "auth.totp.not-enrolled",
        usernames: withoutTotp,
      },
      "TOTP 미등록 계정 — 퍼블릭 노출 전에 totp:enroll 로 등록하라 (D-017)",
    );
  }
  container.logger.info(
    {
      module: "bootstrap",
      event: "server.started",
      address: config.bindAddress,
      port: config.port,
    },
    "server started",
  );

  // 뒤에서 도는 작업(자본변동 수집 등)이 남긴 프로미스 거부를 마지막에 받는다.
  // 핸들러가 없으면 Node 가 프로세스를 그대로 죽인다.
  // 종료 중에 닫힌 DB 를 만나 죽는 것이 실제로 밟히는 경로다.
  process.on("unhandledRejection", (reason: unknown) => {
    container.logger.error(
      {
        module: "bootstrap",
        event: "process.unhandled-rejection",
        err: reason,
      },
      "unhandled promise rejection",
    );
  });
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
