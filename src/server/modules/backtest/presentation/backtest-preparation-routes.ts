import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { universeRuleSchema } from "../../../../shared/schemas/universe-rule.js";
import { isoDateSchema } from "../../../../shared/schemas/backtest-request.js";
import { rebalanceIntervalFitsPeriod } from "../../../../shared/schemas/rebalance-interval.js";
import { SECURITY_HEADERS } from "../../../shared/security.js";
import {
  PreparationInputError,
  UnsafeBacktestSymbolIdentityError,
  type BacktestPreparationOrchestrator,
} from "../../../../runtime/modules/backtest/application/backtest-preparation-orchestrator.js";
import { PreparationReferenceError } from "../application/preparation-reference-service.js";
import type { FinancialFactAvailabilityService } from "../../../../runtime/modules/facts/application/financial-fact-availability.js";
import type { CandleCoverageService } from "../../../../runtime/modules/market-data/application/candle-coverage-service.js";
import type { SymbolMasterService } from "../../../../runtime/modules/market-data/application/symbol-master-service.js";
import { sendIfKrxError, sendIfNotCovered } from "./krx-error-mapping.js";
import type { AgentCoordinator } from "../../agents/application/agent-coordinator.js";

type PreHandler = (
  request: FastifyRequest,
  reply: FastifyReply,
) => Promise<void>;

export interface BacktestPreparationRouteDeps {
  readonly orchestrator: BacktestPreparationOrchestrator;
  readonly financialFacts: Pick<
    FinancialFactAvailabilityService,
    "symbolsWithFinancialFacts"
  >;
  readonly candles: Pick<CandleCoverageService, "getLastTsInWindows">;
  readonly symbolMaster: Pick<SymbolMasterService, "delistedEventsBetween">;
  readonly dartApiKeyAvailable: boolean;
  readonly refreshProviderFilings?: () => Promise<void>;
  readonly progress: Pick<AgentCoordinator, "preparationView">;
}

const previewRequestSchema = z.object({
  universeRule: universeRuleSchema,
  period: z.object({
    from: isoDateSchema,
    to: isoDateSchema,
  }),
  strategyId: z.string().min(1),
  parameters: z.record(z.string(), z.unknown()),
  sourceJobId: z.string().min(1).optional(),
  completedPreparationJobId: z.string().min(1).optional(),
});

export function registerBacktestPreparationRoutes(
  app: FastifyInstance,
  deps: BacktestPreparationRouteDeps,
  requireAuth: PreHandler,
): void {
  const { orchestrator } = deps;
  const activeStreams = new Set<() => void>();

  // Fastify는 open SSE가 있으면 일반 connection drain 전에 기다릴 수 있다. preClose는
  // 그 기다림보다 먼저 실행되므로 heartbeat·구독·reply를 라우트가 명시적으로 닫는다.
  app.addHook("preClose", async () => {
    for (const cleanup of [...activeStreams]) cleanup();
  });

  app.post(
    "/backtests/universe-preview",
    { preHandler: requireAuth },
    async (request, reply) => {
      const parsed = previewRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({
          error: parsed.error.issues
            .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
            .join("; "),
        });
      }
      const { sourceJobId, completedPreparationJobId, ...input } = parsed.data;
      const owner = {
        userId: request.authUser!.id,
        context: sourceJobId ?? "",
      };
      if (input.period.from > input.period.to) {
        return reply
          .code(400)
          .send({ error: "기간이 올바르지 않습니다 (from > to)" });
      }
      // 제출 스키마(backtest-request.ts superRefine)와 같은 검사다 — 여기서 걸러내지
      // 않으면 준비가 끝난 뒤 제출 시점에야 400 이 나 준비가 헛수고가 된다.
      if (
        !rebalanceIntervalFitsPeriod(
          input.period,
          input.universeRule.rebalanceInterval,
        )
      ) {
        return reply
          .code(400)
          .send({ error: "리밸런싱 주기가 백테스트 전체 기간을 초과합니다." });
      }

      try {
        // 완료 알림 뒤의 결과 읽기는 새 미리보기 시작과 구분한다. 현재 소유한 작업만 읽는다.
        if (completedPreparationJobId !== undefined) {
          const owned = orchestrator.getReadyPreviewForWizard(input, owner.userId);
          const ready = owned?.preparationJobId === completedPreparationJobId
            ? orchestrator.getFreshPreviewDetails(input, completedPreparationJobId) : null;
          if (!ready) return reply.code(409).send({
            error: "PREPARATION_REQUIRED", message: "미리보기 결과가 변경되었습니다. 다시 시작하세요.",
          });
          return reply.send({ ...ready.preview, fundamentalSymbols: ready.fundamentalSymbols });
        }
        // 같은 입력의 active job은 진행 상태만 담고 있다. 완료 미리보기를 다시 검증하는
        // 비싼 작업을 예약하기 전에 먼저 반환해 반복 POST가 resolver 뒤에 쌓이지 않게 한다.
        const active = orchestrator.getActive(input);
        if (active !== null) {
          orchestrator.bindWizard(owner.userId, owner.context, active.id);
          return reply.code(202).send({ job: deps.progress.preparationView(active) });
        }

        if (deps.refreshProviderFilings) return reply.code(202).send({
          job: deps.progress.preparationView(orchestrator.start(input, owner, deps.refreshProviderFilings)),
        });

        const ready = orchestrator.getFreshPreviewDetails(input);
        if (ready) {
          orchestrator.bindWizard(
            owner.userId,
            owner.context,
            ready.preview.preparationJobId!,
          );
          return reply.code(200).send({
            ...ready.preview,
            fundamentalSymbols: ready.fundamentalSymbols,
          });
        }
        if (
          !deps.dartApiKeyAvailable &&
          (await orchestrator.needsDart(input))
        ) {
          return reply.code(503).send({
            error:
              "DART API 키가 설정되지 않아 필요한 재무·자본변동 데이터를 동기화할 수 없습니다.",
          });
        }
        return reply.code(202).send({
          job: deps.progress.preparationView(orchestrator.start(input, owner)),
        });
      } catch (error) {
        // resolver 경유 오류는 제출 라우트와 같은 코드로 매핑한다. 그 밖의 오류를
        // 일괄 400 으로 접으면 내부 wiring 결함까지 사용자 요청 문제로 둔갑한다 —
        // 알려진 사용자 오류(미지 전략 등)만 400, 나머지는 500 처리기로 던진다.
        if (sendIfKrxError(reply, error)) return reply;
        if (sendIfNotCovered(reply, error)) return reply;
        if (error instanceof UnsafeBacktestSymbolIdentityError) {
          return reply.code(422).send({ error: error.message });
        }
        if (error instanceof PreparationReferenceError) {
          return reply
            .code(409)
            .send({ error: "PREPARATION_REQUIRED", message: error.message });
        }
        if (error instanceof PreparationInputError) {
          return reply.code(400).send({ error: error.message });
        }
        throw error;
      }
    },
  );

  app.get(
    "/backtests/preparation-jobs/:id",
    { preHandler: requireAuth },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const job = orchestrator.get(id);
      if (!job)
        return reply.code(404).send({ error: "준비 작업을 찾을 수 없습니다." });
      return { job: deps.progress.preparationView(job) };
    },
  );

  app.post(
    "/backtests/preparation-jobs/:id/cancel",
    { preHandler: requireAuth },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      if (!orchestrator.cancel(id)) {
        return reply.code(404).send({ error: "준비 작업을 찾을 수 없습니다." });
      }
      const job = orchestrator.get(id);
      return { job: job ? deps.progress.preparationView(job) : null };
    },
  );

  app.get(
    "/backtests/preparation-jobs/:id/events",
    { preHandler: requireAuth },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const initial = orchestrator.get(id);
      if (!initial)
        return reply.code(404).send({ error: "준비 작업을 찾을 수 없습니다." });

      reply.hijack();
      reply.raw.writeHead(200, {
        ...SECURITY_HEADERS,
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      });
      const write = (job: typeof initial): void => {
        reply.raw.write(
          `data: ${JSON.stringify(deps.progress.preparationView(job))}\n\n`,
        );
      };
      let closed = false;
      let unsubscribe = (): void => {};
      let subscribing = true;
      let terminalDuringSubscribe = false;
      const heartbeat = setInterval(
        () => reply.raw.write(":heartbeat\n\n"),
        15_000,
      );
      heartbeat.unref();
      const cleanup = (): void => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        unsubscribe();
        activeStreams.delete(cleanup);
        reply.raw.end();
      };
      activeStreams.add(cleanup);
      unsubscribe = orchestrator.subscribe(id, (job) => {
        // subscribe가 현재 snapshot을 동기적으로 주므로 첫 응답도 이 경계 하나에서
        // 쓴다. initial GET 뒤 terminal이 된 race도 최신 snapshot을 놓치지 않는다.
        write(job);
        if (orchestrator.isTerminal(job.status)) {
          if (subscribing) terminalDuringSubscribe = true;
          else cleanup();
        }
      });
      subscribing = false;
      if (terminalDuringSubscribe) cleanup();
      request.raw.on("close", cleanup);
    },
  );
}
