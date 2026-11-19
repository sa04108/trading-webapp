import { readRuntimeVersions } from '../../src/runtime/shared/runtime-versions.js';
import { and, eq, isNull } from 'drizzle-orm';
import type { Container } from '../../src/server/bootstrap/container.js';
import {
  dailySelectionMetrics,
  dailySelectionMetricCoverage,
  symbolMasterCoverage,
  symbolMasterMarketCaps,
  symbolMasterTradingDays,
  symbolMasterVersions,
  symbols,
} from '../../src/runtime/shared/db/schema.js';

/** `UniverseRuleResolver` 테스트 픽스처 — 실제 KRX 마스터가 갖는 필드의 최소 부분집합 */
export interface SymbolMasterFixtureEntry {
  readonly standardCode: string;
  readonly shortCode: string;
  readonly name: string;
  readonly market: 'KOSPI' | 'KOSDAQ';
  /** 문자열 그대로 저장한다 — 실제 컬럼도 bigint 를 문자열로 보존한다 */
  readonly marketCapKrw: string;
}

/**
 * 백테스트 제출·워커 통합 테스트가 실제 KRX 호출 없이 `UniverseRuleResolver` 를
 * 태울 수 있게 종목 마스터를 직접 채운다 (HTTP 를 거치는 fake KRX 서버 왕복 대신
 * DB 를 직접 채우는 편이 테스트당 필요한 배선을 훨씬 줄인다).
 *
 * 기본 coverage는 지정한 리밸런스 날짜만 포함한다. 연속 구간이 필요한 호출자는
 * 실제로 확인된 범위를 명시한다. 종목당 열린 SCD 버전 하나를 심는다.
 */
export function seedSymbolMasterUniverse(
  container: Container,
  rebalanceDates: readonly string[],
  entries: readonly SymbolMasterFixtureEntry[],
  coverageRanges: readonly { startDate: string; endDate: string }[] = [],
): void {
  if (entries.length > 0) {
    container.database.db.insert(symbolMasterVersions).values(
      entries.map((entry) => ({
        standardCode: entry.standardCode,
        validFromDate: '2000-01-01',
        validToDate: null,
        shortCode: entry.shortCode,
        name: entry.name,
        market: entry.market,
        sharesOutstanding: '1000000',
        instrumentType: 'COMMON_STOCK',
        listedDate: null,
        recordedAtMs: container.clock.now(),
      })),
    ).run();
    // 이 helper는 권위 있는 master fixture를 만드는 경계다. 그보다 먼저 만든 등록 행도
    // 운영의 검증 완료 상태처럼 같은 표준코드로 묶어, 일반 통합 테스트가 의도치 않게
    // "미검증 legacy 등록" 시나리오가 되지 않게 한다. null 차단은 전용 테스트가 맡는다.
    for (const entry of entries) {
      container.database.db
        .update(symbols)
        .set({ standardCode: entry.standardCode })
        .where(and(eq(symbols.code, entry.shortCode), isNull(symbols.standardCode)))
        .run();
    }
  }

  const ranges = [...coverageRanges, ...[...new Set(rebalanceDates)]
    .filter((date) => !coverageRanges.some((range) => range.startDate <= date && date <= range.endDate))
    .map((date) => ({ startDate: date, endDate: date }))];
  if (ranges.length > 0) {
    container.database.db.insert(symbolMasterCoverage).values(ranges.map((range) => ({
      ...range, collectionVersion: readRuntimeVersions().collectionVersion, syncedAtMs: container.clock.now(),
    }))).run();
  }

  // resolver 는 이제 effectiveTradingDate(date) 도 함께 확인한다 — 각 리밸런스 날짜를
  // 거래일로 기록해 둬야 이 픽스처를 쓰는 기존 테스트들이 커버 밖으로 튕기지 않는다.
  if (rebalanceDates.length > 0) {
    container.database.db
      .insert(symbolMasterTradingDays)
      .values(rebalanceDates.map((date) => ({ date })))
      .onConflictDoNothing()
      .run();
  }

  const marketCapRows = rebalanceDates.flatMap((date) =>
    entries.map((entry) => ({ date, standardCode: entry.standardCode, marketCapKrw: entry.marketCapKrw })),
  );
  if (marketCapRows.length > 0) {
    container.database.db.insert(symbolMasterMarketCaps).values(marketCapRows).run();
    container.database.db.insert(dailySelectionMetrics).values(
      marketCapRows.map((row) => ({
        date: row.date,
        standardCode: row.standardCode,
        marketCapKrw: row.marketCapKrw,
        volume: null,
        tradingValueKrw: null,
      })),
    ).onConflictDoNothing().run();
    container.database.db.insert(dailySelectionMetricCoverage).values(
      [...new Set(rebalanceDates)].map((date) => ({
        date,
        collectionVersion: readRuntimeVersions().collectionVersion, syncedAtMs: container.clock.now(),
      })),
    ).onConflictDoNothing().run();
  }
}
