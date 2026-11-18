/**
 * 알림 생산자 연결 (설계 2026-08-03-notification-center,
 * 2026-08-08-notification-body-and-korean-names).
 *
 * backtest 모듈이 notification 모듈을 import 하지 않도록 container 가 이 listener 를
 * orchestrator.events 에 건다 — facts-wiring 과 같은 관례로, 테스트가 겨눌 수 있는
 * 자리에 둔다.
 */
import type { JobEvent } from "../modules/backtest/application/job-orchestrator.js";
import type {
  BacktestJobRow,
  JobQueue,
} from "../modules/backtest/application/job-queue.js";
import type { NotificationInput } from "../modules/notification/application/notification-service.js";
import type { IntradayTerminalEvent } from "../modules/intraday/application/intraday-service.js";
import { INTRADAY_STRATEGIES } from "../../shared/schemas/intraday-strategies.js";
import type { Logger } from "../shared/logger.js";

// status 컬럼은 리터럴 유니온이 아니라 text() 라 string 이다 — Record 키를
// BacktestJobRow['status'] 로 두면 string 전체가 키가 되어 의미가 없으므로 string 으로 둔다
const TERMINAL_NOTIFICATIONS: Partial<
  Record<string, { title: string; severity: "info" | "error" }>
> = {
  COMPLETED: { title: "백테스트가 완료되었습니다", severity: "info" },
  FAILED: { title: "백테스트가 실패했습니다", severity: "error" },
  CANCELLED: { title: "백테스트가 취소되었습니다", severity: "info" },
  INTERRUPTED: { title: "백테스트가 중단되었습니다", severity: "error" },
};

/**
 * 부호 붙은 백분율. 웹 `formatSignedPct` 와 규칙이 같다 — 공유하려면 `src/shared` 에
 * 서식 모듈을 새로 만들고 웹을 그쪽으로 돌려야 해서 여기 둔다.
 */
function signedPct(value: number): string {
  return `${value > 0 ? "+" : ""}${value.toFixed(2)}%`;
}

/** 분봉 작업의 종료 전이를 사용자에게 알린다. */
export function createIntradayNotificationListener(deps: {
  notify: (input: NotificationInput) => void;
  logger: Logger;
}): (event: IntradayTerminalEvent) => void {
  return (event) => {
    try {
      const completed = event.status === "COMPLETED";
      const period = `${event.period.from} ~ ${event.period.to}`;
      const label = event.kind === "collection"
        ? event.symbol
        : `${INTRADAY_STRATEGIES.find((strategy) => strategy.id === event.strategyId)?.name ?? event.strategyId} · ${event.symbol}`;
      const summary = event.kind === "run" && completed && event.returnPct !== null
        ? `${label} · 수익률 ${signedPct(event.returnPct)}`
        : label;
      deps.notify({
        type: event.kind === "collection" ? "data-sync" : "backtest",
        severity: completed ? "info" : "error",
        title: event.kind === "collection"
          ? `분봉 수집이 ${completed ? "완료되었습니다" : "실패했습니다"}`
          : `분봉 백테스트가 ${completed ? "완료되었습니다" : "실패했습니다"}`,
        body: [summary, period, ...(!completed && event.error ? [event.error] : [])].join("\n"),
        link: event.kind === "collection"
          ? `/jobs/${encodeURIComponent(`intraday-collection:${event.id}`)}`
          : `/backtests/intraday/${encodeURIComponent(event.id)}`,
      });
    } catch (error) {
      deps.logger.warn(
        { module: "notification", event: "notify.intraday.failed", jobId: event.id, err: error },
        "intraday notification failed",
      );
    }
  };
}

/** 저장된 경고 원문. 깨진 JSON 은 빈 배열로 — 설명 조립 실패가 알림을 없애면 안 된다 */
function parseSubmitWarnings(
  json: string | null,
  logger: Logger,
  jobId: string,
): string[] {
  if (json === null) return [];
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed)
      ? parsed.filter((w): w is string => typeof w === "string")
      : [];
  } catch (error) {
    logger.warn(
      {
        module: "notification",
        event: "notify.warnings.parse_failed",
        jobId,
        err: error,
      },
      "submit warnings parse failed",
    );
    return [];
  }
}

export function createBacktestNotificationListener(deps: {
  queue: Pick<JobQueue, "getJob">;
  /** 전략 한국어 이름. 등록이 풀린 전략은 null — 그때는 strategyId 를 적는다 */
  strategyName: (strategyId: string) => string | null;
  /** backtest_metrics.total_return_pct. 결과가 없으면 null */
  totalReturnPct: (jobId: string) => number | null;
  notify: (input: NotificationInput) => void;
  logger: Logger;
}): (event: JobEvent) => void {
  return (event) => {
    if (event.kind !== "status") return;
    // 알림 실패가 orchestrator 의 emit 경로를 끊으면 안 된다 — 삼키고 warn 만 남긴다
    try {
      const job: BacktestJobRow | null | undefined = deps.queue.getJob(
        event.jobId,
      );
      if (!job) return;
      const terminal = TERMINAL_NOTIFICATIONS[job.status];
      if (!terminal) return;

      const label = deps.strategyName(job.strategyId) ?? job.strategyId;
      // 접힌 행은 한 줄만 보인다(notifications-page.tsx) — 첫 줄이 이름과 결과를 진다
      const headline = ((): string => {
        if (job.status === "FAILED" && job.error)
          return `${label} — ${job.error}`;
        if (job.status !== "COMPLETED") return label;
        const pct = deps.totalReturnPct(job.id);
        // 결과 기록 없이 완료로 표시된 잡이다. `수익률 -` 은 "0에 가깝다" 로 읽힌다
        return pct === null ? label : `${label} · 수익률 ${signedPct(pct)}`;
      })();

      const warnings = parseSubmitWarnings(
        job.submitWarningsJson,
        deps.logger,
        job.id,
      );
      deps.notify({
        type: "backtest",
        severity: terminal.severity,
        title: terminal.title,
        body: [headline, ...warnings.map((w) => `경고: ${w}`)].join("\n"),
        link: `/backtests/${job.id}`,
      });
    } catch (error) {
      deps.logger.warn(
        {
          module: "notification",
          event: "notify.backtest.failed",
          jobId: event.jobId,
          err: error,
        },
        "backtest notification failed",
      );
    }
  };
}
