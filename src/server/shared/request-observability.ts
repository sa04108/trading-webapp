import { Readable } from "node:stream";
import { ReadableStream } from "node:stream/web";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

export interface RequestObservabilityOptions {
  /** 느린 정상 응답을 기록하는 최소 시간이다. */
  readonly slowMs?: number;
  /** 테스트에서 단조 시간을 고정하기 위한 시계다. */
  readonly now?: () => bigint;
}

interface RequestState {
  readonly startedAt: bigint;
  finished: boolean;
  responseFinished: boolean;
  longLivedResponse: boolean;
  readonly cleanup: () => void;
}

type RequestLogger = Pick<FastifyRequest["log"], "info" | "warn" | "error">;

const NANOSECONDS_PER_MILLISECOND = 1_000_000n;

function elapsedMs(now: () => bigint, startedAt: bigint): number {
  return Number(now() - startedAt) / Number(NANOSECONDS_PER_MILLISECOND);
}

function routeOf(request: FastifyRequest): string | null {
  return request.routeOptions?.url ?? null;
}

function isLongLivedResponse(reply: FastifyReply): boolean {
  const contentType = reply.getHeader("content-type") ?? reply.raw.getHeader("content-type");
  return typeof contentType === "string" && contentType.includes("text/event-stream");
}

/**
 * 요청 수명 종료를 한 번만 기록한다. SSE는 연결 종료 자체가 정상 동작이므로 abort로
 * 취급하지 않는다. URL·header·body는 민감 정보와 고카디널리티를 피하기 위해 남기지 않는다.
 */
export function registerRequestObservability(
  app: FastifyInstance,
  options: RequestObservabilityOptions = {},
): void {
  const slowMs = options.slowMs ?? 1_000;
  const now = options.now ?? process.hrtime.bigint;
  const states = new WeakMap<FastifyRequest, RequestState>();

  const logAborted = (
    request: FastifyRequest,
    reply: FastifyReply,
    reason: "aborted" | "closed",
  ): void => {
    const state = states.get(request);
    if (!state || state.finished || state.responseFinished || state.longLivedResponse || isLongLivedResponse(reply))
      return;
    state.finished = true;
    state.cleanup();
    request.log.warn(
      {
        event: "http.request.aborted",
        route: routeOf(request),
        method: request.method,
        elapsedMs: elapsedMs(now, state.startedAt),
        abortReason: reason,
      },
      "HTTP 요청이 응답 완료 전에 종료되었습니다",
    );
  };

  app.addHook("onRequest", (request, reply, done) => {
    const onAborted = () => logAborted(request, reply, "aborted");
    const onResponseClosed = () => {
      if (!reply.raw.writableEnded)
        logAborted(request, reply, "closed");
      states.get(request)?.cleanup();
    };
    const onFinished = () => {
      const state = states.get(request);
      if (state) state.responseFinished = true;
    };
    const cleanup = () => {
      request.raw.off("aborted", onAborted);
      reply.raw.off("close", onResponseClosed);
      reply.raw.off("finish", onFinished);
    };
    states.set(request, {
      startedAt: now(),
      finished: false,
      responseFinished: false,
      longLivedResponse: false,
      cleanup,
    });
    request.raw.once("aborted", onAborted);
    reply.raw.once("close", onResponseClosed);
    reply.raw.once("finish", onFinished);
    done();
  });

  app.addHook("onSend", (request, reply, payload, done) => {
    const state = states.get(request);
    if (
      state &&
      (isLongLivedResponse(reply) ||
        payload instanceof Readable || payload instanceof ReadableStream)
    )
      state.longLivedResponse = true;
    done();
  });

  app.addHook("onResponse", (request, reply, done) => {
    const state = states.get(request);
    if (state && !state.finished) {
      state.finished = true;
      state.cleanup();
      const duration = elapsedMs(now, state.startedAt);
      const fields = {
        route: routeOf(request),
        method: request.method,
        statusCode: reply.statusCode,
        elapsedMs: duration,
      };
      const logger: RequestLogger = request.log;
      if (reply.statusCode >= 500) {
        logger.error(
          { event: "http.request.failed", ...fields, failureClass: "SERVER" },
          "HTTP 요청 처리 실패",
        );
      } else if (reply.statusCode >= 400) {
        logger.warn(
          { event: "http.request.failed", ...fields, failureClass: "CLIENT" },
          "HTTP 요청이 클라이언트 오류로 종료되었습니다",
        );
      } else if (!state.longLivedResponse && !isLongLivedResponse(reply) && duration >= slowMs) {
        request.log.info(
          {
            event: "http.request.slow",
            ...fields,
          },
          "느린 HTTP 요청이 완료되었습니다",
        );
      }
    }
    done();
  });
}
