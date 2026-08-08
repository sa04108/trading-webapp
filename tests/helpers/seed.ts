import type { Container } from '../../src/server/bootstrap/container.js';
import type { AppDatabase } from '../../src/server/shared/db/database.js';
import type { Candle, Market } from '../../src/server/modules/market-data/domain/candle.js';
import { krxDailyBars } from '../../src/server/shared/db/schema.js';

/**
 * 종목 등록 — 테스트에서 종목을 먼저 만들고 사용하는 헬퍼.
 *
 * 종목이 1급 객체다(설계 2026-07-31-symbol-as-first-class).
 */
export function registerSymbols(
  container: Container,
  market: Market,
  codes: readonly string[],
): void {
  for (const code of codes) {
    if (!container.symbolService.exists(code)) container.symbolService.addSymbol(code, market);
  }
}

/**
 * `krx_daily_bars` 에 봉을 직접 넣는다 — `CandleRepository` 포트에 쓰기 경로가
 * 없다(Task 2, 2026-08-07-price-data-removal). 실제로는 `SymbolMasterService.ingestDate`
 * 만 이 테이블에 쓰지만, 테스트는 KRX 응답을 흉내 내는 대신 결과 상태를 직접 심는다.
 *
 * tsMs 는 그 거래일의 UTC 자정이어야 한다 — 날짜로 자르는 이 변환이 그 규약을 전제한다.
 */
export function seedDailyBars(db: AppDatabase, candles: readonly Candle[]): void {
  const rows = candles.map((candle) => ({
    shortCode: candle.symbol,
    date: new Date(candle.tsMs).toISOString().slice(0, 10),
    market: 'KOSPI',
    open: candle.open,
    high: candle.high,
    low: candle.low,
    close: candle.close,
    volume: candle.volume,
  }));
  for (let i = 0; i < rows.length; i += 500) {
    db.insert(krxDailyBars)
      .values(rows.slice(i, i + 500))
      .onConflictDoNothing()
      .run();
  }
}

/**
 * 자본변동 수집 커버리지를 심는다 — 제출 게이트(Task 6)가 이 표시를 보고
 * 종목별 자본변동 이력을 실제로 수집했는지 판단한다.
 * 실제 DART 동기화 없이 그 결과 상태만 재현한다.
 */
export function seedCorporateActionCoverage(
  container: Container,
  codes: readonly string[],
  years: readonly number[],
): void {
  const nowMs = container.clock.now();
  for (const code of codes) {
    container.actionCoverageStore.addCoveredYears(code, years, nowMs);
  }
}

/** fromYear 부터 toYear 까지(양끝 포함) 연도 배열을 만든다 — 커버리지 픽스처 전용 */
export function yearRange(fromYear: number, toYear: number): number[] {
  const years: number[] = [];
  for (let year = fromYear; year <= toYear; year += 1) years.push(year);
  return years;
}
