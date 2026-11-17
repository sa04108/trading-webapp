import type { AppDatabase } from "../../../../runtime/shared/db/database.js";
import { riskFreeRateHistory } from "../../../../runtime/shared/db/data-schema.js";
import { addCalendarDays, isWeekendDate, kstDateOf, kstHourOf } from "../../../../runtime/modules/market-data/domain/kst-date.js";
import { readRiskFreeRateHistory, versionRateHistory } from "../../../../runtime/modules/market-data/infrastructure/sqlite-risk-free-rate-store.js";
import type { RateChange, RiskFreeRateHistory } from "../../../../shared/schemas/risk-free-rate.js";
import { createOfficialKrxTradingCalendar } from "../infrastructure/krx/krx-trading-calendar.js";

class IncompleteRateHistoryError extends Error {}

interface RateSource {
  fetchDailyRates(input: { statCode: string; itemCode: string; startDate: string; endDate: string; signal?: AbortSignal }): Promise<RateChange[]>;
}

export class RiskFreeRateService {
  private running: Promise<void> | null = null;
  private readonly abort = new AbortController();
  private lastAttemptAtMs: number | null = null;
  private lastSuccessDate: string | null = null;
  private lastError: string | null = null;
  private notifiedDate: string | null = null;
  private readonly calendar = createOfficialKrxTradingCalendar();

  constructor(private readonly options: {
    db: AppDatabase;
    source: RateSource | null;
    now: () => number;
    onError?: (message: string) => void;
  }) {
    readRiskFreeRateHistory(options.db);
  }

  history(): RiskFreeRateHistory { return readRiskFreeRateHistory(this.options.db); }

  status() {
    const history = this.history();
    return {
      configured: this.options.source !== null, syncing: this.running !== null,
      series: history.series, coveredFrom: history.coveredFrom, coveredTo: history.coveredTo,
      changeCount: history.changes.length, historyVersion: history.version,
      lastAttemptAtMs: this.lastAttemptAtMs, error: this.lastError,
    };
  }

  /** KST 18시 이후 전날까지 조회한다. 성공한 날에는 추가 자동 요청을 보내지 않는다. */
  async tick(): Promise<void> {
    const now = this.options.now();
    if (!this.options.source || this.abort.signal.aborted || kstHourOf(now) < 18 ||
      this.lastSuccessDate === kstDateOf(now) ||
      (this.lastAttemptAtMs !== null && now - this.lastAttemptAtMs < 3_600_000)) return;
    await this.sync().catch(() => {});
  }

  sync(): Promise<void> {
    if (!this.options.source) return Promise.reject(new Error("ECOS_API_KEY가 설정되지 않았습니다"));
    if (this.abort.signal.aborted) return Promise.reject(new Error("서버가 종료 중입니다"));
    if (this.running) return this.running;
    this.lastAttemptAtMs = this.options.now();
    this.lastError = null;
    this.running = this.update().then(() => {
      this.lastSuccessDate = kstDateOf(this.options.now());
    }).catch((error: unknown) => {
      // 공급자 응답 원문과 인증키가 오류 메시지로 외부에 전달되지 않도록 고정 안내만 보낸다.
      this.lastError = error instanceof IncompleteRateHistoryError ? error.message
        : "ECOS 금리 동기화에 실패했습니다. 기존 금리표를 유지합니다. API 키와 연결 상태를 확인하세요.";
      const today = kstDateOf(this.options.now());
      if (!this.abort.signal.aborted && this.notifiedDate !== today) {
        this.notifiedDate = today;
        this.options.onError?.(this.lastError);
      }
      throw error;
    }).finally(() => { this.running = null; });
    return this.running;
  }

  private async update(): Promise<void> {
    const before = this.history();
    const endDate = addCalendarDays(kstDateOf(this.options.now()), -1);
    if (endDate <= before.coveredTo) return;
    // 최근 일주일을 겹쳐 조회하면 주말·휴일만 남은 증분 구간도 정상 응답으로 확인할 수 있다.
    const startDate = [before.coveredFrom, addCalendarDays(before.coveredTo, -7)].sort().at(-1)!;
    const rows = await this.options.source!.fetchDailyRates({
      statCode: "817Y002", itemCode: before.series === "KRW_MSB_91D" ? "010400000" : "010502000",
      startDate, endDate, signal: this.abort.signal,
    });
    this.abort.signal.throwIfAborted();
    const lastDate = rows.at(-1)?.date;
    if (!lastDate || lastDate <= before.coveredTo) return;
    const observedDates = new Set(rows.map(({ date }) => date));
    for (let date = addCalendarDays(before.coveredTo, 1); date <= lastDate; date = addCalendarDays(date, 1)) {
      if (observedDates.has(date) || isWeekendDate(date)) continue;
      // 주식 시장이 열린 날의 금리가 빠졌으면 변경 없음으로 압축하지 않는다.
      // 달력을 확보하지 못한 날짜도 휴일이라고 추측하지 않고 기존 이력을 보존한다.
      if (this.calendar.classify(date, "KOSPI").state !== "CLOSED") {
        throw new IncompleteRateHistoryError(`ECOS 금리 관측이 ${date}에 없고 휴장일로 확인되지 않았습니다. 기존 금리표를 유지하며 다음 동기화에서 다시 조회합니다.`);
      }
    }
    // 사용자가 제공한 과거 이력은 유지하고 이후 발표분만 원래 정밀도로 추가한다.
    const changes = [...before.changes];
    for (const row of rows) {
      if (row.date > before.coveredTo && row.annualRatePct !== changes.at(-1)!.annualRatePct) changes.push(row);
    }
    const { version: _version, ...payload } = before;
    const history = versionRateHistory({ ...payload, source: "USER_CSV_AND_ECOS", coveredTo: lastDate, changes });
    this.options.db.transaction((tx) => {
      if (readRiskFreeRateHistory(tx).version !== before.version) throw new Error("동기화 중 금리표가 변경되었습니다");
      tx.update(riskFreeRateHistory).set({ historyJson: JSON.stringify(history) }).run();
    });
  }

  async close(): Promise<void> {
    this.abort.abort();
    await this.running?.catch(() => {});
  }
}
