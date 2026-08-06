import type { Container } from '../../src/server/bootstrap/container.js';
import type { Market } from '../../src/server/modules/market-data/domain/candle.js';

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
