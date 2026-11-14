import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { addCalendarDays, kstDateOf } from "../../../../runtime/modules/market-data/domain/kst-date.js";
import { createOfficialKrxTradingCalendar } from "../../market-data/infrastructure/krx/krx-trading-calendar.js";
import type { TradingDataNeed } from "../application/trading-data.js";
import type { StrategyArtifactStore, TradingDecisionEngine } from "../application/trading-service.js";

interface Options {
  databasePath: string;
  dataPath: string;
  artifacts: StrategyArtifactStore;
  now: () => number;
  ensureData?: (date: string, input: EvaluationInput, need: TradingDataNeed) => Promise<string | void>;
}

type EvaluationInput = Parameters<TradingDecisionEngine["evaluate"]>[0];
type EvaluationOutput = Awaited<ReturnType<TradingDecisionEngine["evaluate"]>>;
class DecisionDataRequired extends Error { constructor(message: string, readonly need: TradingDataNeed) { super(message); } }

/** 검증되지 않은 휴장일에는 가장 최근 거래일도 추측하지 않는다. */
export function latestClosedTradingDate(now: number): string {
  if (!Number.isFinite(now)) throw new Error("현재 시각이 올바르지 않습니다");
  const calendar = createOfficialKrxTradingCalendar();
  let day = addCalendarDays(kstDateOf(now), -1);
  for (let count = 0; count < 30; count++) {
    const state = calendar.classify(day, "KOSPI").state;
    if (state === "UNKNOWN") throw new Error(`공식 거래일 달력이 없습니다: ${day}`);
    if (state === "OPEN") return day;
    day = addCalendarDays(day, -1);
  }
  throw new Error("최근 거래일을 확인할 수 없습니다");
}

export class DailyTradingEngine implements TradingDecisionEngine {
  private readonly children = new Set<ChildProcess>();
  private closed = false;
  constructor(private readonly options: Options) {}
  canTrade(now: number): boolean {
    if (!Number.isFinite(now)) return false;
    const kst = new Date(now + 9 * 3_600_000);
    if (kst.getUTCHours() !== 9 || kst.getUTCMinutes() >= 10) return false;
    return createOfficialKrxTradingCalendar().classify(kstDateOf(now), "KOSPI").state === "OPEN";
  }
  async evaluate(input: EvaluationInput): Promise<EvaluationOutput> {
    if (this.closed) throw new Error("전략 실행기가 종료되었습니다");
    const date = latestClosedTradingDate(this.options.now());
    const bundlePath = this.options.artifacts.bundlePath(input.deployment.artifactHash);
    try { return await this.run(input, date, bundlePath); }
    catch (error) {
      if (!(error instanceof DecisionDataRequired)) throw error;
      if (this.closed) throw new Error("전략 실행기가 종료되었습니다", { cause: error });
      const message = await this.options.ensureData?.(date, input, error.need);
      throw new Error(typeof message === "string" && message ? message : error.message, { cause: error });
    }
  }
  private run(input: EvaluationInput, date: string, bundlePath: string): Promise<EvaluationOutput> {
    const ts = import.meta.url.endsWith(".ts");
    return new Promise((resolve, reject) => {
      const child = fork(fileURLToPath(new URL(`../../../../workers/trading-decision-child.${ts ? "ts" : "js"}`, import.meta.url)), [], {
        env: { NODE_ENV: process.env.NODE_ENV ?? "production", DATABASE_PATH: this.options.databasePath, DATA_DATABASE_PATH: this.options.dataPath },
        execArgv: ts ? ["--import", "tsx"] : [], serialization: "advanced", stdio: ["ignore", "ignore", "ignore", "ipc"],
      });
      this.children.add(child);
      let failure: Error | undefined;
      let output: EvaluationOutput | undefined;
      let killTimer: NodeJS.Timeout | undefined;
      const terminate = (error: Error) => { failure ??= error; child.kill("SIGTERM"); killTimer ??= setTimeout(() => child.kill("SIGKILL"), 1000); };
      const timeout = setTimeout(() => terminate(new Error("전략 판단 시간이 초과되었습니다")), 60_000);
      child.on("message", (message: { type: string; output?: EvaluationOutput; error?: string; need?: TradingDataNeed }) => {
        if (message.type === "completed") output = message.output;
        else if (message.type === "needs-data") {
          const need = message.need;
          if (!need || !Array.isArray(need.masterDates) || !Array.isArray(need.entries) || !(need.priceRange === null || (typeof need.priceRange?.from === "string" && typeof need.priceRange?.to === "string")) || !(need.financial === null || (Array.isArray(need.financial?.symbols) && Number.isInteger(need.financial?.fromYear) && Number.isInteger(need.financial?.toYear))) || !(need.actions === null || (Array.isArray(need.actions?.symbols) && Number.isInteger(need.actions?.fromYear) && Number.isInteger(need.actions?.toYear)))) failure = new Error("전략 데이터 준비 요청이 올바르지 않습니다");
          else failure = new DecisionDataRequired(message.error ?? "전략 데이터가 준비되지 않았습니다", need);
        }
        else if (message.type === "failed") failure = new Error(message.error ?? "전략 판단에 실패했습니다");
      });
      child.once("error", (error) => terminate(error));
      child.once("close", (code) => {
        clearTimeout(timeout); if (killTimer) clearTimeout(killTimer); this.children.delete(child);
        if (failure) reject(failure); else if (code === 0 && output) resolve(output); else reject(new Error("전략 판단 프로세스가 종료되었습니다"));
      });
      child.send({ input, date, bundlePath }, (error) => { if (error) terminate(error); });
    });
  }
  async close(): Promise<void> {
    this.closed = true;
    const children = [...this.children];
    await Promise.all(children.map((child) => new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) { resolve(); return; }
      const timer = setTimeout(() => child.kill("SIGKILL"), 1000);
      child.once("close", () => { clearTimeout(timer); resolve(); }); child.kill("SIGTERM");
    })));
  }
}
