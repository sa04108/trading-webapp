import type { Container } from '../../src/server/bootstrap/container.js';
import type { Market } from '../../src/server/modules/market-data/domain/candle.js';
import type { DatasetSummary } from '../../src/server/modules/market-data/application/dataset-service.js';

/**
 * 종목 등록 — 데이터셋이 참조할 수 있게 만든다.
 *
 * 종목이 1급 객체가 된 뒤(설계 2026-07-31-symbol-as-first-class) 데이터셋은 **이미 등록된**
 * 종목만 참조한다. 테스트가 매번 이 두 단계를 손으로 쓰면 의도(무엇을 검증하는가)가
 * 준비 코드에 묻히므로 헬퍼로 둔다.
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

/** 종목 등록 + 데이터셋 생성 — 구 `createBrokerDataset(name, market, collect, codes)` 자리 */
export function seedDataset(
  container: Container,
  name: string,
  market: Market,
  codes: readonly string[],
): DatasetSummary {
  registerSymbols(container, market, codes);
  return container.datasetService.createDataset(name, codes);
}
