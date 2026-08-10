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
 * 종목의 parquet fact 파티션을 만든다 — coverage 는 parquet 실체와 교차 확인해서만
 * 읽히므로(parquet-consistent-coverage.ts, 운영 장애 2026-08-10) coverage 픽스처는
 * 파티션도 함께 있어야 "받았다" 로 인정된다.
 *
 * 내용물은 중립이다: ratio 1 짜리 1970 년 SPLIT_RATIO 는 가격 보정(×1)도 수량
 * 변화(×1)도 만들지 않고 어떤 백테스트 기간보다도 앞이라 경고도 만들지 않는다.
 */
export async function seedFactPartitions(
  container: Container,
  codes: readonly string[],
): Promise<void> {
  await container.factRepository.saveFacts(codes.map((code) => ({
    scope: 'SYMBOL' as const,
    key: code,
    field: 'SPLIT_RATIO',
    periodKey: '1970-01-02',
    asOfTsMs: 1,
    value: 1,
    unit: 'RATIO',
  })));
}

/**
 * 재무 수집 커버리지를 심는다 — 제출의 재무 요구 검사(422)와 준비 계획이 이 표시로
 * "받았다" 를 판단한다. 운영에서는 FactSyncService 가 저장과 동시에 이 기록을
 * 남기므로, 재무 fact 를 saveFacts 로 직접 심는 픽스처는 이것도 함께 심어야
 * 실제 상태와 같아진다.
 */
export function seedFinancialCoverage(
  container: Container,
  codes: readonly string[],
  years: readonly number[],
): void {
  const nowMs = container.clock.now();
  for (const code of codes) {
    container.factCoverageStore.addCoveredYears(code, years, nowMs);
  }
}

/**
 * 자본변동 수집 커버리지를 심는다 — 제출 게이트(Task 6)가 이 표시를 보고
 * 종목별 자본변동 이력을 실제로 수집했는지 판단한다.
 * 실제 DART 동기화 없이 그 결과 상태만 재현한다. coverage 정합성 게이트를
 * 통과하도록 parquet 파티션도 함께 만든다.
 */
export async function seedCorporateActionCoverage(
  container: Container,
  codes: readonly string[],
  years: readonly number[],
): Promise<void> {
  await seedFactPartitions(container, codes);
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
