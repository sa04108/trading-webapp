import fs from "node:fs";
import { Readable } from "node:stream";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { BacktestResultArtifactRejectedError } from "../../../../runtime/modules/backtest/application/backtest-result-artifact.js";
import {
  MAX_BACKTEST_RESULT_ARTIFACT_BYTES,
  InvalidBacktestResultArtifactError,
} from "../../backtest/infrastructure/sqlite-backtest-result-artifact-importer.js";
import { backtestExecutionTelemetrySchema } from "../../../../runtime/modules/backtest/application/backtest-execution-telemetry.js";
import type { AgentCoordinator } from "../application/agent-coordinator.js";
import type { RemoteResultUploadManager } from "../../backtest/infrastructure/remote-result-upload-manager.js";
import { agentContainerImage, buildWindowsAgentInstaller, validateAgentServerOrigin } from "../infrastructure/agent-windows-installer.js";

type PreHandler = (
  request: FastifyRequest,
  reply: FastifyReply,
) => Promise<void>;
function parseRequest<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success)
    throw Object.assign(new Error("에이전트 요청 형식이 올바르지 않습니다"), {
      statusCode: 400,
    });
  return result.data;
}
const ARTIFACT_TYPE = "application/vnd.quant-platform.backtest-result+sqlite";
const paramsSchema = z.object({
  jobId: z.string().regex(/^[a-zA-Z0-9_-]{3,128}$/),
});
const resultHeaders = z.object({
  "x-agent-attempt": z.coerce.number().int().positive(),
  "x-agent-lease-token": z.string().min(32).max(256),
  "x-content-sha256": z.string().regex(/^[a-f0-9]{64}$/),
  "content-length": z.coerce.number().int().positive(),
});

export function registerAgentControlRoutes(
  app: FastifyInstance,
  coordinator: AgentCoordinator,
  uploads: RemoteResultUploadManager,
): void {
  const clients = new WeakMap<FastifyRequest, string>();
  const authenticate: PreHandler = async (request, reply) => {
    const header = request.headers.authorization ?? "";
    const id = header.startsWith("Bearer ")
      ? coordinator.registry.authenticate(header.slice(7))
      : null;
    if (!id) {
      await reply.code(401).send({ error: "에이전트 인증이 필요합니다" });
      return;
    }
    clients.set(request, id);
  };
  app.get(
    "/connect",
    { websocket: true, preValidation: authenticate },
    (socket, request) => {
      coordinator.connect(clients.get(request)!, socket);
    },
  );
  app.get(
    "/datasets/:version",
    { preHandler: authenticate },
    async (request, reply) => {
      const version = parseRequest(
        z.object({ version: z.coerce.number().int().positive() }),
        request.params,
      ).version;
      const manifest = coordinator.snapshots.get(version);
      if (!manifest)
        return reply.code(404).send({ error: "게시된 데이터 버전이 없습니다" });
      const file = coordinator.snapshots.file(manifest);
      if (!fs.existsSync(file))
        return reply.code(404).send({ error: "데이터 파일이 없습니다" });
      return reply
        .type("application/vnd.sqlite3")
        .header("content-length", manifest.bytes)
        .header("etag", `"${manifest.sha256}"`)
        .header("cache-control", "private, immutable")
        .send(fs.createReadStream(file));
    },
  );
  app.addContentTypeParser(ARTIFACT_TYPE, (_request, stream, done) =>
    done(null, stream),
  );
  app.post(
    "/jobs/:jobId/result",
    { preHandler: authenticate, bodyLimit: Number.MAX_SAFE_INTEGER },
    async (request, reply) => {
      const { jobId } = parseRequest(paramsSchema, request.params);
      const headers = parseRequest(resultHeaders, request.headers);
      if (!coordinator.ownsBacktest(clients.get(request)!, jobId)) {
        (request.body as Readable).resume();
        return reply.code(409).send({ status: "STALE_LEASE" });
      }
      if (headers["content-length"] > MAX_BACKTEST_RESULT_ARTIFACT_BYTES) {
        (request.body as Readable).resume();
        return reply
          .code(413)
          .send({ error: "결과 파일이 업로드 상한을 넘습니다" });
      }
      const identity = {
        jobId,
        attempt: headers["x-agent-attempt"],
        leaseToken: headers["x-agent-lease-token"],
      };
      const checksum = headers["x-content-sha256"];
      const lease = coordinator.backtests.reserveResultTransfer({
        ...identity,
        checksum,
      });
      if (lease.status === "IDEMPOTENT") {
        (request.body as Readable).resume();
        return { status: "IDEMPOTENT" };
      }
      if (lease.status === "STALE_LEASE" || lease.cancelRequested) {
        (request.body as Readable).resume();
        return reply.code(409).send({ status: "STALE_LEASE" });
      }
      if (!(request.body instanceof Readable))
        return reply
          .code(415)
          .send({ error: "결과 파일 형식이 올바르지 않습니다" });
      return coordinator.runResultOperation(async (shutdownSignal) => {
        const renewal = setInterval(() => {
          try {
            coordinator.backtests.reserveArtifactTransfer(identity);
          } catch {
            /* 다음 갱신 때 다시 확인한다. */
          }
        }, 30_000);
        renewal.unref();
        let artifact:
          | Awaited<ReturnType<RemoteResultUploadManager["receive"]>>
          | undefined;
        try {
          coordinator.backtests.reportActivity({
            ...identity,
            activity: "UPLOADING_RESULT",
            completed: 0,
            total: headers["content-length"],
          });
          artifact = await uploads.receive(
            request.body as Readable,
            jobId,
            identity.attempt,
            (bytes) =>
              coordinator.backtests.reportActivity({
                ...identity,
                activity: "UPLOADING_RESULT",
                completed: bytes,
                total: headers["content-length"],
              }),
            shutdownSignal,
          );
          if (
            artifact.size !== headers["content-length"] ||
            artifact.sha256 !== checksum
          )
            return reply
              .code(400)
              .send({ error: "결과 파일 길이 또는 해시가 다릅니다" });
          const rawTelemetry = request.headers["x-agent-telemetry"];
          const telemetry =
            typeof rawTelemetry === "string" && rawTelemetry.length < 8192
              ? backtestExecutionTelemetrySchema.parse(JSON.parse(rawTelemetry))
              : undefined;
          coordinator.backtests.reportActivity({
            ...identity,
            activity: "VALIDATING_RESULT",
            completed: artifact.size,
            total: headers["content-length"],
          });
          const status = await coordinator.backtests.complete({
            ...identity,
            checksum,
            artifactPath: artifact.path,
            telemetry,
          });
          return reply
            .code(status === "ACCEPTED" || status === "IDEMPOTENT" ? 200 : 409)
            .send({ status });
        } catch (error) {
          if (
            error instanceof BacktestResultArtifactRejectedError ||
            error instanceof InvalidBacktestResultArtifactError ||
            error instanceof z.ZodError
          )
            return reply
              .code(422)
              .send({ error: "결과 파일 검증에 실패했습니다" });
          throw error;
        } finally {
          clearInterval(renewal);
          await artifact?.cleanup();
        }
      });
    },
  );
}

export function registerAgentManagementRoutes(
  app: FastifyInstance,
  coordinator: AgentCoordinator,
  requireAuth: PreHandler,
): void {
  app.get("/agents", { preHandler: requireAuth }, async () => ({
    clients: coordinator.registry.list(),
  }));
  app.post("/agents", { preHandler: requireAuth }, async (request, reply) => {
    const { name } = parseRequest(
      z.object({ name: z.string().trim().min(1).max(80) }),
      request.body,
    );
    reply.header("cache-control", "no-store");
    return coordinator.registry.issue(name);
  });
  app.post("/agents/install/windows", { preHandler: requireAuth }, async (request, reply) => {
    const { token, serverUrl } = parseRequest(
      z.object({ token: z.string().min(32).max(256), serverUrl: z.string().max(2048) }),
      request.body,
    );
    if (!coordinator.registry.authenticate(token))
      return reply.code(401).send({ error: "유효한 Agent 토큰이 필요합니다" });
    const origin = validateAgentServerOrigin(serverUrl);
    const installer = buildWindowsAgentInstaller({ token, serverUrl: origin, image: agentContainerImage() });
    return reply
      .type("application/octet-stream")
      .header("cache-control", "no-store")
      .header("content-disposition", 'attachment; filename="quant-agent-windows.cmd"')
      .send(installer);
  });
  app.delete(
    "/agents/:id",
    { preHandler: requireAuth },
    async (request, reply) => {
      const { id } = parseRequest(z.object({ id: z.string() }), request.params);
      return coordinator.registry.revoke(id)
        ? { status: "REVOKED" }
        : reply.code(404).send({ error: "장치가 없습니다" });
    },
  );
}
