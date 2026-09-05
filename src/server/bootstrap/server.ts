import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, {
  LogController,
  type FastifyError,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from 'fastify';
import fastifyCompress from '@fastify/compress';
import fastifyCookie from '@fastify/cookie';
import fastifyMultipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import type { Container } from './container.js';
import { buildPinoOptions } from '../shared/logger.js';
import { registerSecurity } from '../shared/security.js';
import '../shared/fastify-augment.js';
import { registerSystemRoutes } from '../modules/system/presentation/health-routes.js';
import {
  createRequireAuth,
  registerAuthRoutes,
} from '../modules/auth/presentation/auth-routes.js';
import { registerSymbolRoutes } from '../modules/market-data/presentation/symbol-routes.js';
import { registerStrategyRoutes } from '../modules/strategy/presentation/strategy-routes.js';
import { registerBacktestRoutes } from '../modules/backtest/presentation/backtest-routes.js';
import { registerBacktestWizardDraftRoutes } from '../modules/backtest/presentation/backtest-wizard-draft-routes.js';
import { registerBacktestPreparationRoutes } from '../modules/backtest/presentation/backtest-preparation-routes.js';
import { registerNotificationRoutes } from '../modules/notification/presentation/notification-routes.js';
import { registerSymbolMasterRoutes } from '../modules/market-data/presentation/symbol-master-routes.js';
import { registerRemoteWorkerRoutes } from '../modules/backtest/presentation/remote-worker-routes.js';
import { PreparationExecutionBusyError } from '../modules/backtest/application/backtest-preparation-execution.js';

const REMOTE_WORKER_CLAIM_PATH = '/api/internal/workers/jobs/claim';

function isRemoteWorkerClaim(request: FastifyRequest): boolean {
  return request.method === 'POST'
    && (request.url === REMOTE_WORKER_CLAIM_PATH
      || request.url.startsWith(`${REMOTE_WORKER_CLAIM_PATH}?`));
}

/** 정상 long-poll access log는 debug로 낮추고 인증·버전·서버 오류는 기존 레벨로 남긴다. */
class AppLogController extends LogController {
  override incomingRequest(
    request: FastifyRequest,
    reply: FastifyReply,
    metadata?: Record<string, unknown>,
  ): void {
    if (isRemoteWorkerClaim(request)) {
      request.log.debug({ req: request }, 'incoming request');
      return;
    }
    super.incomingRequest(request, reply, metadata);
  }

  override requestCompleted(
    error: Error | null,
    request: FastifyRequest,
    reply: FastifyReply,
    metadata?: Record<string, unknown>,
  ): void {
    const isSuccessfulClaim = error === null
      && isRemoteWorkerClaim(request)
      && (reply.statusCode === 200 || reply.statusCode === 204);
    if (isSuccessfulClaim) {
      reply.log.debug({ res: reply, responseTime: reply.elapsedTime }, 'request completed');
      return;
    }
    super.requestCompleted(error, request, reply, metadata);
  }
}

function resolvePublicDir(): string | null {
  // 빌드 후: dist/server/bootstrap → dist/public.
  // 소스 트리(tsx)에서 실행 중이면 cwd 의 dist/public 로 폴백 (E2E 서버 등).
  const candidates = [
    fileURLToPath(new URL('../../public', import.meta.url)),
    path.resolve(process.cwd(), 'dist', 'public'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, 'index.html'))) return candidate;
  }
  return null;
}

export async function buildServer(container: Container): Promise<FastifyInstance> {
  const { config } = container;

  const app = Fastify({
    logger: buildPinoOptions(config),
    logController: new AppLogController(),
    trustProxy: config.trustProxyLoopback ? '127.0.0.1' : false,
    bodyLimit: 10 * 1024 * 1024,
  });

  registerSecurity(app);

  await app.register(fastifyCookie, { secret: config.sessionSecret });
  await app.register(fastifyMultipart, {
    limits: { fileSize: 50 * 1024 * 1024, files: 1 },
  });

  // Caddy 의 encode zstd gzip 대체 (D-016). SSE 는 reply.hijack() 으로
  // onSend 훅을 우회하므로 압축의 영향을 받지 않는다.
  await app.register(fastifyCompress);

  const authDeps = {
    authService: container.authService,
    secureCookies: config.nodeEnv === 'production',
  };
  const requireAuth = createRequireAuth(authDeps);

  await app.register(
    async (api) => {
      registerSystemRoutes(api, container, requireAuth);
      registerAuthRoutes(api, authDeps);
      registerSymbolRoutes(
        api,
        container.symbolInfoService,
        requireAuth,
      );
      registerStrategyRoutes(api, container.strategyRegistry, requireAuth);
      registerBacktestWizardDraftRoutes(
        api,
        container.backtestWizardDraftService,
        requireAuth,
      );
      registerBacktestRoutes(
        api,
        {
          queue: container.jobQueue,
          orchestrator: container.jobOrchestrator,
          jobEvents: [
            container.jobOrchestrator.events,
            container.remoteWorkerService.events,
          ],
          results: container.resultsService,
          strategies: container.strategyRegistry,
          symbolService: container.symbolService,
          symbolMaster: container.symbolMasterService,
          candleCoverage: container.candleCoverageService,
          preparation: container.backtestPreparationOrchestrator,
          audit: container.auditLog,
          factCoverage: container.factCoverageStore,
          financialFacts: container.financialFactAvailabilityService,
          facts: container.factRepository,
          dataRoot: container.config.dataRoot,
          maxQueuedBacktests: container.config.maxQueuedBacktests,
          clock: container.clock,
          benchmarks: container.benchmarkService,
          seedCloneBatches: container.seedCloneBatchService,
        },
        requireAuth,
      );
      registerBacktestPreparationRoutes(
        api,
        {
          orchestrator: container.backtestPreparationOrchestrator,
          financialFacts: container.financialFactAvailabilityService,
          candles: container.candleCoverageService,
          symbolMaster: container.symbolMasterService,
          dartApiKeyAvailable: container.config.dartApiKey !== null,
        },
        requireAuth,
      );
      registerNotificationRoutes(api, container.notificationService, requireAuth);
      registerSymbolMasterRoutes(
        api,
        {
          service: container.symbolMasterService,
          backfill: container.symbolMasterBackfill,
          benchmarks: container.benchmarkService,
        },
        requireAuth,
      );
    },
    { prefix: '/api/v1' },
  );

  // local 모드에서도 token을 미리 설정하면 Worker 배포 probe가 STANDBY를 반환한다.
  // 실제 job API는 registerRemoteWorkerRoutes가 remote 모드에서만 등록한다.
  if (config.backtestWorkerToken !== null) {
    await app.register(
      async (workerApi) => registerRemoteWorkerRoutes(workerApi, {
        service: container.remoteWorkerService,
        inputBundles: container.remoteInputBundleManager,
        resultUploads: container.remoteResultUploadManager,
        workerToken: config.backtestWorkerToken!,
        executionMode: config.backtestExecutionMode,
        expectedRunnerVersion: container.gitCommitSha,
      }),
      { prefix: '/api/internal/workers' },
    );
  }

  // 종목 마스터 일일 동기화 스케줄러 — JobOrchestrator 와 달리 이 타이머는 여기 server.ts
  // 에서 직접 잡는다(스케줄러 자체는 내부 타이머를 두지 않는다). unref() 로 테스트·CLI
  // 종료를 막지 않게 하고, onClose 훅으로 정리한다 — JobOrchestrator 의 pruneTimer 와
  // 같은 테스트 안전 패턴이다.
  const symbolMasterSchedulerTimer = setInterval(
    () => void container.symbolMasterScheduler.tick(),
    3_600_000,
  );
  symbolMasterSchedulerTimer.unref();
  app.addHook('onClose', (_instance, done) => {
    clearInterval(symbolMasterSchedulerTimer);
    done();
  });

  app.setErrorHandler((error: FastifyError, request, reply) => {
    request.log.error({ err: error }, 'request failed');
    if (error instanceof PreparationExecutionBusyError) {
      return reply.code(503).send({ error: error.message });
    }
    const statusCode = error.statusCode && error.statusCode >= 400 ? error.statusCode : 500;
    // 스펙 §16: stack trace 미노출
    reply.code(statusCode).send({
      error: statusCode >= 500 ? 'Internal Server Error' : error.message,
    });
  });

  const publicDir = resolvePublicDir();
  if (publicDir) {
    await app.register(fastifyStatic, { root: publicDir });
    app.setNotFoundHandler((request, reply) => {
      if (request.method === 'GET' && !request.url.startsWith('/api/')) {
        return reply.type('text/html').send(fs.createReadStream(path.join(publicDir, 'index.html')));
      }
      return reply.code(404).send({ error: '요청한 리소스를 찾을 수 없습니다' });
    });
  } else {
    app.setNotFoundHandler((_request, reply) => reply.code(404).send({ error: '요청한 리소스를 찾을 수 없습니다' }));
  }

  // 첫 요청 전에 로그인 타이밍 균등화용 더미 해시를 준비한다 (콜드스타트 타이밍 노출 차단).
  // buildServer 를 거치는 모든 진입점(main, E2E, 테스트)이 자동으로 포함된다.
  await container.authService.ready();

  return app;
}
