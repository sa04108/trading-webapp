import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { backtestExecutionTelemetrySchema } from '../application/backtest-execution-telemetry.js';
import type { RemoteWorkerService } from '../application/remote-worker-service.js';
import type { RemoteInputBundleManager } from '../infrastructure/remote-input-bundle-manager.js';
import { createReadStream } from 'node:fs';
import type { RemoteResultUploadManager } from '../infrastructure/remote-result-upload-manager.js';
import type { Readable } from 'node:stream';
import { MAX_BACKTEST_RESULT_ARTIFACT_BYTES } from '../infrastructure/sqlite-backtest-result-artifact-importer.js';

const workerIdSchema = z.string().regex(/^[a-zA-Z0-9._-]{1,64}$/);
const runnerVersionSchema = z.string().min(1).max(128);
const leaseTokenSchema = z.string().min(32).max(256);

const claimBodySchema = z.object({
  workerId: workerIdSchema,
  runnerVersion: runnerVersionSchema,
});
const claimQuerySchema = z.object({
  waitSeconds: z.coerce.number().int().min(0).max(25).default(25),
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
});
const finishBodySchema = z.object({
  attempt: z.number().int().positive(),
  leaseToken: leaseTokenSchema,
  outcome: z.enum(['FAILED', 'CANCELLED']),
  error: z.string().max(2_000).optional(),
  telemetry: backtestExecutionTelemetrySchema.optional(),
});
const inputQuerySchema = z.object({ attempt: z.coerce.number().int().positive() });
const RESULT_CONTENT_TYPE = 'application/vnd.quant-platform.backtest-result+sqlite';

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

export function registerRemoteWorkerRoutes(
  app: FastifyInstance,
  deps: {
    readonly service: RemoteWorkerService;
    readonly inputBundles: RemoteInputBundleManager;
    readonly resultUploads: RemoteResultUploadManager;
    readonly workerToken: string;
  },
): void {
  const requireWorker = createRequireWorkerToken(deps.workerToken);
  app.addContentTypeParser(RESULT_CONTENT_TYPE, (_request, payload, done) => {
    done(null, payload);
  });

  app.post('/jobs/claim', { onRequest: requireWorker }, async (request, reply) => {
    const body = claimBodySchema.safeParse(request.body);
    const query = claimQuerySchema.safeParse(request.query);
    if (!body.success || !query.success) {
      return reply.code(400).send({ error: 'workerId, runnerVersion, waitSeconds를 확인하세요' });
    }

    const deadlineMs = Date.now() + query.data.waitSeconds * 1_000;
    for (;;) {
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
      if (remainingMs <= 0 || request.raw.destroyed) return reply.code(204).send();
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
    if (reserved.cancelRequested) return reply.code(409).send({ error: 'CANCEL_REQUESTED' });

    const bundle = await deps.inputBundles.prepare(params.data.jobId, query.data.attempt);
    const revalidated = deps.service.reserveArtifactTransfer(lease);
    if (revalidated.status === 'STALE_LEASE') return reply.code(409).send({ error: 'STALE_LEASE' });
    if (revalidated.cancelRequested) return reply.code(409).send({ error: 'CANCEL_REQUESTED' });
    return reply
      .header('cache-control', 'no-store')
      .header('content-type', 'application/vnd.quant-platform.backtest-input+sqlite')
      .header('content-length', bundle.size)
      .header('x-content-sha256', bundle.sha256)
      .send(createReadStream(bundle.path));
  });

  app.post('/jobs/:jobId/finish', { onRequest: requireWorker }, async (request, reply) => {
    const params = leaseParamsSchema.safeParse(request.params);
    const body = finishBodySchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(400).send({ error: '종료 요청이 올바르지 않습니다' });
    }
    const result = deps.service.finish({ jobId: params.data.jobId, ...body.data });
    if (result === 'STALE_LEASE') return reply.code(409).send({ error: result });
    await deps.inputBundles.removeJob(params.data.jobId);
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
    if (
      !params.success
      || !query.success
      || typeof leaseToken !== 'string'
      || !leaseTokenSchema.safeParse(leaseToken).success
      || typeof expectedChecksum !== 'string'
      || !/^[a-f0-9]{64}$/.test(expectedChecksum)
      || (rawTelemetry !== undefined && typeof rawTelemetry !== 'string')
    ) {
      return reply.code(400).send({ error: '결과 업로드 헤더가 올바르지 않습니다' });
    }
    let telemetry: z.infer<typeof backtestExecutionTelemetrySchema> | undefined;
    if (rawTelemetry !== undefined) {
      if (rawTelemetry.length > 16_000) return reply.code(400).send({ error: 'telemetry 헤더가 너무 큽니다' });
      try {
        telemetry = backtestExecutionTelemetrySchema.parse(
          JSON.parse(Buffer.from(rawTelemetry, 'base64url').toString('utf8')),
        );
      } catch {
        return reply.code(400).send({ error: 'telemetry 헤더가 올바르지 않습니다' });
      }
    }

    // child 종료 뒤에는 주기 heartbeat가 멈춘다. 큰 결과를 streaming하는 동안 lease가
    // 만료돼 다른 worker가 같은 job을 다시 잡지 않도록 업로드 전에 전송 창을 예약한다.
    const reserved = deps.service.reserveResultTransfer({
      jobId: params.data.jobId,
      attempt: query.data.attempt,
      leaseToken,
      checksum: expectedChecksum,
    });
    if (reserved.status === 'STALE_LEASE') return reply.code(409).send({ error: 'STALE_LEASE' });
    if (reserved.status === 'ACCEPTED' && reserved.cancelRequested) {
      return reply.code(409).send({ error: 'CANCEL_REQUESTED' });
    }

    const upload = await deps.resultUploads.receive(
      request.body as Readable,
      params.data.jobId,
      query.data.attempt,
    );
    try {
      if (upload.sha256 !== expectedChecksum) {
        return reply.code(400).send({ error: 'RESULT_CHECKSUM_MISMATCH' });
      }
      if (reserved.status === 'IDEMPOTENT') return reply.send({ status: 'IDEMPOTENT' });
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
        await deps.inputBundles.removeJob(params.data.jobId);
        return reply.send({ status: result });
      } catch (error) {
        request.log.warn(
          { module: 'backtest', event: 'backtest.remote-result-rejected', err: error },
          'remote result artifact rejected',
        );
        return reply.code(400).send({ error: 'INVALID_RESULT_ARTIFACT' });
      }
    } finally {
      await upload.cleanup();
    }
  });
}
