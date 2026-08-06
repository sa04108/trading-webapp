import type { Container } from '../../src/server/bootstrap/container.js';
import { symbolMasterCoverage, symbolMasterMarketCaps } from '../../src/server/shared/db/schema.js';

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
 * coverage 는 아주 넓은 고정 구간으로 한 번만 잡는다 — 체크포인트 하나에 이벤트가
 * 전혀 없으므로(symbol_master_events 비어 있음) `getUniverseAsOf` 는 어느 날짜를 물어도
 * 항상 이 체크포인트 그대로를 재구성한다. 그래서 여러 리밸런스 날짜가 필요해도
 * 체크포인트는 하나만 있으면 된다 — 시총 캐시만 각 날짜별로 채우면 된다.
 */
export function seedSymbolMasterUniverse(
  container: Container,
  rebalanceDates: readonly string[],
  entries: readonly SymbolMasterFixtureEntry[],
): void {
  const checkpointDate = rebalanceDates[0] ?? '2020-01-01';
  const universe = new Map(
    entries.map((entry) => [
      entry.standardCode,
      {
        standardCode: entry.standardCode,
        shortCode: entry.shortCode,
        name: entry.name,
        market: entry.market,
        sharesOutstanding: '1000000',
        instrumentType: 'COMMON_STOCK' as const,
        listedDate: null,
      },
    ]),
  );
  container.symbolMasterService.saveCheckpoint(checkpointDate, universe, true);

  container.database.db
    .insert(symbolMasterCoverage)
    .values({ startDate: '2000-01-01', endDate: '2099-12-31', syncedAtMs: container.clock.now() })
    .run();

  const marketCapRows = rebalanceDates.flatMap((date) =>
    entries.map((entry) => ({ date, standardCode: entry.standardCode, marketCapKrw: entry.marketCapKrw })),
  );
  if (marketCapRows.length > 0) {
    container.database.db.insert(symbolMasterMarketCaps).values(marketCapRows).run();
  }
}
