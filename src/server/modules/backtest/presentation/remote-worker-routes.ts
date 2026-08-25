import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { backtestExecutionTelemetrySchema } from '../application/backtest-execution-telemetry.js';
import { REMOTE_WORKER_PROTOCOL_VERSION } from '../application/remote-worker-protocol.js';
import type { RemoteWorkerService } from '../application/remote-worker-service.js';
import {
  RemoteResultArtifactRejectedError,
  RemoteResultImportInternalError,
  RemoteResultPersistenceUnavailableError,
} from '../application/backtest-result-artifact.js';
import type { RemoteInputBundleManager } from '../infrastructure/remote-input-bundle-manager.js';
import { createReadStream } from 'node:fs';
import {
  ResultArtifactUploadError,
  type RemoteResultUploadManager,
} from '../infrastructure/remote-result-upload-manager.js';
import { Readable } from 'node:stream';
import { finished } from 'node:stream/promises';
import { MAX_BACKTEST_RESULT_ARTIFACT_BYTES } from '../infrastructure/sqlite-backtest-result-artifact-importer.js';
import { isPersistenceUnavailableError } from '../../../shared/db/sqlite-errors.js';

const workerIdSchema = z.string().regex(/^[a-zA-Z0-9._-]{1,64}$/);
const runnerVersionSchema = z.string().min(1).max(128);
const leaseTokenSchema = z.string().min(32).max(256);
const probeBodySchema = z.object({
  workerId: workerIdSchema,
  runnerVersion: runnerVersionSchema,
  protocolVersion: z.number().int().positive(),
});

const claimBodySchema = z.object({
  workerId: workerIdSchema,
  runnerVersion: runnerVersionSchema,
});
const claimQuerySchema = z.object({
  // 0을 허용하면 빈 큐에서 worker가 지연 없이 204를 재요청해 tight polling이 된다.
  waitSeconds: z.coerce.number().int().min(1).max(25).default(25),
});
const leaseParamsSchema = z.object({
  jobId: z.string().regex(/^[a-zA-Z0-9_-]{3,128}$/),
});
const heartbeatBodySchema = z.object({
  attempt: z.number().int().positive(),
  leaseToken: leaseTokenSchema,
  processedBars: z.number().int().nonnegative().optional(),
  totalBars: z.number().int().nonnegative().optional(),
  progressLabel: z.string().max(64).nullable().optional(),
}).superRefine((value, context) => {
  if ((value.processedBars === undefined) !== (value.totalBars === undefined)) {
    context.addIssue({ code: 'custom', message: 'processedBars와 totalBars는 함께 보내야 합니다' });
  } else if (
    value.processedBars !== undefined
    && value.totalBars !== undefined
    && value.processedBars > value.totalBars
  ) {
    context.addIssue({ code: 'custom', message: 'processedBars는 totalBars보다 클 수 없습니다' });
  }
});
const finishBodySchema = z.object({
  attempt: z.number().int().positive(),
  leaseToken: leaseTokenSchema,
  outcome: z.enum(['FAILED', 'CANCELLED']),
  error: z.string().max(2_000).optional(),
  telemetry: backtestExecutionTelemetrySchema.optional(),
}).superRefine((value, context) => {
  if (value.telemetry !== undefined && value.telemetry.outcome !== value.outcome) {
    context.addIssue({ code: 'custom', message: '종료 outcome과 telemetry outcome이 일치해야 합니다' });
  }
});
const inputQuerySchema = z.object({ attempt: z.coerce.number().int().positive() });
const RESULT_CONTENT_TYPE = 'application/vnd.quant-platform.backtest-result+sqlite';
const ARTIFACT_LEASE_RENEW_INTERVAL_MS = 60_000;
const LEASE_EXPIRES_HEADER = 'x-backtest-lease-expires-at-ms';

function sameSecret(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

export function createRequireWorkerToken(expectedToken: string) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const authorization = request.headers.authorization;
    const prefix = 'Bearer ';
    const token = authorization?.startsWith(prefix) ? authorization.slice(prefix.length) : '';
    if (!sameSecret(token, expectedToken)) {
      await reply.code(401).send({ error: 'worker 인증이 필요합니다' });
    }
  };
}

function wait(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function startArtifactLeaseRenewal(
  service: RemoteWorkerService,
  lease: { readonly jobId: string; readonly attempt: number; readonly leaseToken: string },
  onError: (error: unknown) => void,
): () => void {
  let stopped = false;
  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
  };
  const timer = setInterval(() => {
    try {
      const result = service.reserveArtifactTransfer(lease);
      if (result.status === 'STALE_LEASE') stop();
      else if (result.cancelRequested) {
        // reserveArtifactTransfer가 먼저 15분 창을 썼으므로 일반 heartbeat로 즉시 되돌린다.
        // 긴 snapshot/import가 끝날 때까지 CANCELLING lease를 붙들지 않는다.
        service.heartbeat(lease);
        stop();
      }
    } catch (error) {
      // 긴 import가 SQLite write lock을 잡은 순간에는 갱신이 잠깐 실패할 수 있다.
      // 이미 확보한 15분 전송 창 안에서 다음 주기에 다시 시도한다.
      onError(error);
    }
  }, ARTIFACT_LEASE_RENEW_INTERVAL_MS);
  timer.unref();
  return stop;
}

function restoreNormalLease(
  service: RemoteWorkerService,
  lease: { readonly jobId: string; readonly attempt: number; readonly leaseToken: string },
  onError: (error: unknown) => void,
): ReturnType<RemoteWorkerService['heartbeat']> | null {
  try {
    return service.heartbeat(lease);
  } catch (error) {
    onError(error);
    return null;
  }
}

async function removeInputBundleSafely(
  manager: RemoteInputBundleManager,
  jobId: string,
  onError: (error: unknown) => void,
): Promise<void> {
  try {
    await manager.removeJob(jobId);
  } catch (error) {
    // job terminal 전이는 이미 중앙 DB에 확정됐다. 임시 파일 정리 실패로 worker에게
    // 실패 응답을 보내 계산을 다시 시키지 않고, 부팅 cleanup이 한 번 더 회수한다.
    onError(error);
  }
}

async function discardResultBody(body: unknown): Promise<void> {
  if (!(body instanceof Readable)) return;
  // Content-Length를 먼저 강제·상한 검사하므로 이 drain은 유한하다. 끝까지 기다려
  // retry가 이전 request body와 겹치거나 완료 뒤 열린 socket이 남지 않게 한다.
  body.resume();
  try {
    await finished(body);
  } catch {
    // client가 먼저 끊은 경우 원래 preflight 상태를 응답할 연결도 사라졌으므로
    // 별도 서버 오류로 승격하지 않는다.
  }
}

export function registerRemoteWorkerRoutes(
  app: FastifyInstance,
  deps: {
    readonly service: RemoteWorkerService;
    readonly inputBundles: RemoteInputBundleManager;
    readonly resultUploads: RemoteResultUploadManager;
    readonly workerToken: string;
    readonly executionMode: 'local' | 'remote';
    readonly expectedRunnerVersion: string;
  },
): void {
  const requireWorker = createRequireWorkerToken(deps.workerToken);
  app.addContentTypeParser(RESULT_CONTENT_TYPE, (_request, payload, done) => {
    done(null, payload);
  });

  // 배포 readiness는 잡 claim과 분리한다. 잘못된 token·release·protocol이어도
  // supervisor 자체는 재시도하며 살아 있으므로 단순한 프로세스 상태로는 판정할 수 없다.
  app.post('/probe', { onRequest: requireWorker }, async (request, reply) => {
    const body = probeBodySchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: 'workerId, runnerVersion, protocolVersion을 확인하세요' });
    }
    if (body.data.protocolVersion !== REMOTE_WORKER_PROTOCOL_VERSION) {
      return reply.code(409).send({
        error: 'PROTOCOL_VERSION_MISMATCH',
        expectedProtocolVersion: REMOTE_WORKER_PROTOCOL_VERSION,
      });
    }
    if (body.data.runnerVersion !== deps.expectedRunnerVersion) {
      return reply.code(409).send({
        error: 'RUNNER_VERSION_MISMATCH',
        expectedRunnerVersion: deps.expectedRunnerVersion,
      });
    }
    return reply.header('cache-control', 'no-store').send({
      status: deps.executionMode === 'remote' ? 'READY' : 'STANDBY',
      runnerVersion: deps.expectedRunnerVersion,
      protocolVersion: REMOTE_WORKER_PROTOCOL_VERSION,
    });
  });

  // local 모드에서는 배포 probe만 열고 claim/heartbeat/artifact API는 노출하지 않는다.
  if (deps.executionMode === 'local') return;

  app.post('/jobs/claim', { onRequest: requireWorker }, async (request, reply) => {
    const body = claimBodySchema.safeParse(request.body);
    const query = claimQuerySchema.safeParse(request.query);
    if (!body.success || !query.success) {
      return reply.code(400).send({ error: 'workerId, runnerVersion, waitSeconds를 확인하세요' });
    }

    const deadlineMs = Date.now() + query.data.waitSeconds * 1_000;
    for (;;) {
      // IncomingMessage는 본문을 다 읽은 뒤 연결이 살아 있어도 destroyed=true가 될 수 있다.
      // 그 값을 연결 종료로 오인하면 첫 큐 확인 직후 204를 반환하고 worker가 tight loop에
      // 빠진다. keep-alive 여부가 아니라 실제 TCP 연결 상태를 확인한다.
      if (request.raw.socket.destroyed || reply.raw.destroyed) {
        // 이미 닫힌 연결이라 실제 전송은 없지만 reply를 종결해 Fastify handler가 남지 않게 한다.
        return reply.code(204).send();
      }
      const result = deps.service.claim(body.data.workerId, body.data.runnerVersion);
      if (result.status === 'VERSION_MISMATCH') {
        return reply.code(409).send({
          error: 'RUNNER_VERSION_MISMATCH',
          expectedRunnerVersion: result.expectedRunnerVersion,
        });
      }
      if (result.status === 'CLAIMED') {
        const { lease } = result;
        return reply
          .header('cache-control', 'no-store')
          .send({
            jobId: lease.job.id,
            attempt: lease.attempt,
            leaseToken: lease.leaseToken,
            leaseExpiresAtMs: lease.leaseExpiresAtMs,
            heartbeatIntervalMs: Math.max(2_000, Math.floor((lease.leaseExpiresAtMs - Date.now()) / 3)),
            runnerVersion: lease.runnerVersion,
            inputUrl: `/api/internal/workers/jobs/${lease.job.id}/input?attempt=${lease.attempt}`,
          });
      }
      const remainingMs = deadlineMs - Date.now();
      if (remainingMs <= 0) return reply.code(204).send();
      await wait(Math.min(500, remainingMs));
    }
  });

  app.post('/jobs/:jobId/heartbeat', { onRequest: requireWorker }, async (request, reply) => {
    const params = leaseParamsSchema.safeParse(request.params);
    const body = heartbeatBodySchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(400).send({ error: 'heartbeat 요청이 올바르지 않습니다' });
    }
    const result = deps.service.heartbeat({ jobId: params.data.jobId, ...body.data });
    if (result.status === 'STALE_LEASE') {
      return reply.code(409).send({ error: 'STALE_LEASE' });
    }
    return reply.header('cache-control', 'no-store').send(result);
  });

  app.get('/jobs/:jobId/input', { onRequest: requireWorker }, async (request, reply) => {
    const params = leaseParamsSchema.safeParse(request.params);
    const query = inputQuerySchema.safeParse(request.query);
    const leaseToken = request.headers['x-lease-token'];
    if (
      !params.success
      || !query.success
      || typeof leaseToken !== 'string'
      || !leaseTokenSchema.safeParse(leaseToken).success
    ) {
      return reply.code(400).send({ error: '입력 snapshot 요청이 올바르지 않습니다' });
    }
    const lease = { jobId: params.data.jobId, attempt: query.data.attempt, leaseToken };
    const reserved = deps.service.reserveArtifactTransfer(lease);
    if (reserved.status === 'STALE_LEASE') return reply.code(409).send({ error: 'STALE_LEASE' });
    if (reserved.cancelRequested) {
      restoreNormalLease(deps.service, lease, (error) => {
        request.log.warn(
          { module: 'backtest', event: 'backtest.remote-artifact-lease-restore-failed', err: error },
          'remote artifact lease restore failed',
        );
      });
      return reply.code(409).send({ error: 'CANCEL_REQUESTED' });
    }

    const stopRenewal = startArtifactLeaseRenewal(deps.service, lease, (error) => {
      request.log.warn(
        { module: 'backtest', event: 'backtest.remote-artifact-lease-renewal-failed', err: error },
        'remote artifact lease renewal failed',
      );
    });
    reply.raw.once('finish', stopRenewal);
    reply.raw.once('close', stopRenewal);
    try {
      const bundle = await deps.inputBundles.prepare(params.data.jobId, query.data.attempt);
      const revalidated = deps.service.reserveArtifactTransfer(lease);
      if (revalidated.status === 'STALE_LEASE') {
        stopRenewal();
        return reply.code(409).send({ error: 'STALE_LEASE' });
      }
      if (revalidated.cancelRequested) {
        stopRenewal();
        restoreNormalLease(deps.service, lease, (error) => {
          request.log.warn(
            { module: 'backtest', event: 'backtest.remote-artifact-lease-restore-failed', err: error },
            'remote artifact lease restore failed',
          );
        });
        return reply.code(409).send({ error: 'CANCEL_REQUESTED' });
      }
      return reply
        .header('cache-control', 'no-store')
        .header('content-type', 'application/vnd.quant-platform.backtest-input+sqlite')
        .header('content-length', bundle.size)
        .header('x-content-sha256', bundle.sha256)
        .send(createReadStream(bundle.path));
    } catch (error) {
      stopRenewal();
      restoreNormalLease(deps.service, lease, (restoreError) => {
        request.log.warn(
          { module: 'backtest', event: 'backtest.remote-artifact-lease-restore-failed', err: restoreError },
          'remote artifact lease restore failed',
        );
      });
      throw error;
    }
  });

  app.post('/jobs/:jobId/finish', { onRequest: requireWorker }, async (request, reply) => {
    const params = leaseParamsSchema.safeParse(request.params);
    const body = finishBodySchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(400).send({ error: '종료 요청이 올바르지 않습니다' });
    }
    const result = deps.service.finish({ jobId: params.data.jobId, ...body.data });
    if (result === 'STALE_LEASE') return reply.code(409).send({ error: result });
    await removeInputBundleSafely(deps.inputBundles, params.data.jobId, (error) => {
      request.log.warn(
        { module: 'backtest', event: 'backtest.remote-input-cleanup-failed', jobId: params.data.jobId, err: error },
        'remote input bundle cleanup failed',
      );
    });
    return reply.send({ status: result });
  });

  app.put('/jobs/:jobId/result', {
    onRequest: requireWorker,
    bodyLimit: MAX_BACKTEST_RESULT_ARTIFACT_BYTES,
  }, async (request, reply) => {
    const params = leaseParamsSchema.safeParse(request.params);
    const query = inputQuerySchema.safeParse(request.query);
    const leaseToken = request.headers['x-lease-token'];
    const expectedChecksum = request.headers['x-content-sha256'];
    const rawTelemetry = request.headers['x-execution-telemetry'];
    const rawContentLength = request.headers['content-length'];
    const contentLength = typeof rawContentLength === 'string' && /^\d+$/.test(rawContentLength)
      ? Number(rawContentLength)
      : Number.NaN;
    // 이 내부 protocol의 supervisor는 항상 정확한 파일 크기를 보낸다. stream parser에는
    // Fastify bodyLimit이 적용되지 않으므로 chunked/미지정 길이는 연결을 닫아 거부한다.
    if (!Number.isSafeInteger(contentLength) || contentLength <= 0) {
      return reply.header('connection', 'close').code(411).send({ error: 'RESULT_CONTENT_LENGTH_REQUIRED' });
    }
    if (contentLength > MAX_BACKTEST_RESULT_ARTIFACT_BYTES) {
      return reply.header('connection', 'close').code(413).send({ error: 'RESULT_ARTIFACT_TOO_LARGE' });
    }
    if (
      !params.success
      || !query.success
      || typeof leaseToken !== 'string'
      || !leaseTokenSchema.safeParse(leaseToken).success
      || typeof expectedChecksum !== 'string'
      || !/^[a-f0-9]{64}$/.test(expectedChecksum)
      || (rawTelemetry !== undefined && typeof rawTelemetry !== 'string')
    ) {
      await discardResultBody(request.body);
      return reply.code(400).send({ error: '결과 업로드 헤더가 올바르지 않습니다' });
    }
    let telemetry: z.infer<typeof backtestExecutionTelemetrySchema> | undefined;
    if (rawTelemetry !== undefined) {
      if (rawTelemetry.length > 16_000) {
        await discardResultBody(request.body);
        return reply.code(400).send({ error: 'telemetry 헤더가 너무 큽니다' });
      }
      try {
        telemetry = backtestExecutionTelemetrySchema.parse(
          JSON.parse(Buffer.from(rawTelemetry, 'base64url').toString('utf8')),
        );
      } catch {
        await discardResultBody(request.body);
        return reply.code(400).send({ error: 'telemetry 헤더가 올바르지 않습니다' });
      }
    }

    // child 종료 뒤에는 주기 heartbeat가 멈춘다. 큰 결과를 streaming하는 동안 lease가
    // 만료돼 다른 worker가 같은 job을 다시 잡지 않도록 업로드 전에 전송 창을 예약한다.
    const lease = { jobId: params.data.jobId, attempt: query.data.attempt, leaseToken };
    let reserved: ReturnType<RemoteWorkerService['reserveResultTransfer']>;
    try {
      reserved = deps.service.reserveResultTransfer({
        ...lease,
        checksum: expectedChecksum,
      });
    } catch (error) {
      await discardResultBody(request.body);
      if (isPersistenceUnavailableError(error)) {
        request.log.error(
          { module: 'backtest', event: 'backtest.remote-result-preflight-unavailable', err: error },
          'remote result preflight unavailable',
        );
        return reply.code(503).send({ error: 'RESULT_PERSISTENCE_UNAVAILABLE' });
      }
      throw error;
    }
    if (reserved.status === 'STALE_LEASE') {
      await discardResultBody(request.body);
      return reply.code(409).send({ error: 'STALE_LEASE' });
    }
    if (reserved.status === 'IDEMPOTENT') {
      // 완료 응답이 유실된 재전송은 header checksum만으로 이미 확정할 수 있다.
      // 본문을 임시 파일에 다시 쓰지 않되 연결이 정상 종료되도록 흘려보낸다.
      await discardResultBody(request.body);
      await removeInputBundleSafely(deps.inputBundles, params.data.jobId, (error) => {
        request.log.warn(
          { module: 'backtest', event: 'backtest.remote-input-cleanup-failed', jobId: params.data.jobId, err: error },
          'remote input bundle cleanup failed',
        );
      });
      return reply.send({ status: 'IDEMPOTENT' });
    }
    if (reserved.status === 'ACCEPTED' && reserved.cancelRequested) {
      await discardResultBody(request.body);
      restoreNormalLease(deps.service, lease, (error) => {
        request.log.warn(
          { module: 'backtest', event: 'backtest.remote-artifact-lease-restore-failed', err: error },
          'remote artifact lease restore failed',
        );
      });
      return reply.code(409).send({ error: 'CANCEL_REQUESTED' });
    }

    const stopRenewal = startArtifactLeaseRenewal(deps.service, lease, (error) => {
      request.log.warn(
        { module: 'backtest', event: 'backtest.remote-artifact-lease-renewal-failed', err: error },
        'remote artifact lease renewal failed',
      );
    });
    let upload: Awaited<ReturnType<RemoteResultUploadManager['receive']>> | null = null;
    let leaseRestoredBeforeResponse = false;
    try {
      try {
        upload = await deps.resultUploads.receive(
          request.body as Readable,
          params.data.jobId,
          query.data.attempt,
        );
      } catch (error) {
        if (error instanceof ResultArtifactUploadError) {
          return reply.code(error.statusCode).send({ error: error.message });
        }
        if (isPersistenceUnavailableError(error)) {
          await discardResultBody(request.body);
          request.log.error(
            { module: 'backtest', event: 'backtest.remote-result-upload-storage-unavailable', err: error },
            'remote result upload storage unavailable',
          );
          const restored = restoreNormalLease(deps.service, lease, (restoreError) => {
            request.log.warn(
              { module: 'backtest', event: 'backtest.remote-artifact-lease-restore-failed', err: restoreError },
              'remote artifact lease restore failed',
            );
          });
          leaseRestoredBeforeResponse = restored !== null;
          if (restored?.status === 'ACCEPTED') {
            reply.header(LEASE_EXPIRES_HEADER, String(restored.leaseExpiresAtMs));
          }
          return reply.code(503).send({ error: 'RESULT_PERSISTENCE_UNAVAILABLE' });
        }
        throw error;
      }
      if (upload.sha256 !== expectedChecksum) {
        return reply.code(400).send({ error: 'RESULT_CHECKSUM_MISMATCH' });
      }
      try {
        const result = await deps.service.complete({
          jobId: params.data.jobId,
          attempt: query.data.attempt,
          leaseToken,
          artifactPath: upload.path,
          checksum: upload.sha256,
          ...(telemetry === undefined ? {} : { telemetry }),
        });
        if (result === 'STALE_LEASE') return reply.code(409).send({ error: result });
        await removeInputBundleSafely(deps.inputBundles, params.data.jobId, (error) => {
          request.log.warn(
            { module: 'backtest', event: 'backtest.remote-input-cleanup-failed', jobId: params.data.jobId, err: error },
            'remote input bundle cleanup failed',
          );
        });
        if (result === 'IDENTITY_REJECTED') {
          return reply.code(422).send({ error: 'UNSAFE_SYMBOL_IDENTITY' });
        }
        return reply.send({ status: result });
      } catch (error) {
        if (
          error instanceof RemoteResultPersistenceUnavailableError
          || isPersistenceUnavailableError(error)
        ) {
          request.log.error(
            { module: 'backtest', event: 'backtest.remote-result-persistence-unavailable', err: error },
            'remote result persistence unavailable',
          );
          const restored = restoreNormalLease(deps.service, lease, (restoreError) => {
            request.log.warn(
              { module: 'backtest', event: 'backtest.remote-artifact-lease-restore-failed', err: restoreError },
              'remote artifact lease restore failed',
            );
          });
          leaseRestoredBeforeResponse = restored !== null;
          if (restored?.status === 'ACCEPTED') {
            reply.header(LEASE_EXPIRES_HEADER, String(restored.leaseExpiresAtMs));
          }
          return reply.code(503).send({ error: 'RESULT_PERSISTENCE_UNAVAILABLE' });
        }
        if (error instanceof RemoteResultArtifactRejectedError) {
          request.log.warn(
            { module: 'backtest', event: 'backtest.remote-result-rejected', err: error },
            'remote result artifact rejected',
          );
          return reply.code(400).send({ error: 'INVALID_RESULT_ARTIFACT' });
        }
        request.log.error(
          { module: 'backtest', event: 'backtest.remote-result-import-failed', err: error },
          error instanceof RemoteResultImportInternalError
            ? 'remote result import failed internally'
            : 'remote result import failed unexpectedly',
        );
        return reply.code(500).send({ error: 'RESULT_IMPORT_FAILED' });
      }
    } finally {
      stopRenewal();
      if (upload !== null) {
        try {
          await upload.cleanup();
        } catch (error) {
          request.log.warn(
            { module: 'backtest', event: 'backtest.remote-upload-cleanup-failed', err: error },
            'remote result upload cleanup failed',
          );
        }
      }
      // 완료 job은 STALE_LEASE가 되어 no-op이다. checksum/구조 오류나 취소 경합으로
      // 활성 상태가 남았다면 15분 전송 창을 정상 lease 길이로 되돌려 빠르게 재시도한다.
      if (!leaseRestoredBeforeResponse) {
        restoreNormalLease(deps.service, lease, (error) => {
          request.log.warn(
            { module: 'backtest', event: 'backtest.remote-artifact-lease-restore-failed', err: error },
            'remote artifact lease restore failed',
          );
        });
      }
    }
  });
}
