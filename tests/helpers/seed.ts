import type { Container } from '../../src/server/bootstrap/container.js';
import type { Market } from '../../src/server/modules/market-data/domain/candle.js';
import { datasets, datasetSymbols } from '../../src/server/shared/db/schema.js';
import { newId } from '../../src/server/shared/ids.js';

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

/**
 * 종목 등록 + 데이터셋 참조 행 생성.
 *
 * `DatasetService` 는 데이터셋·스냅샷 개념과 함께 제거됐다(스펙 2026-08-05, Task 6) —
 * 데이터셋을 만드는 라우트도 서비스도 이제 없다. 그래도 `datasets`/`dataset_symbols`
 * 테이블 자체는 남아 있다(스키마 제거는 Task 7 몫) — `SymbolService.removalImpact`
 * 가 이 테이블을 직접 읽어 "이 종목을 지우면 어느 데이터셋이 비는가" 를 판정하고,
 * 그 결과를 가격 데이터 화면(SymbolsPanel)의 제거 확인 대화상자가 그대로 보여준다.
 * 이 헬퍼는 그 경로를 테스트하기 위해 스키마 테이블에 직접 행을 심는다.
 */
export function seedDataset(
  container: Container,
  name: string,
  market: Market,
  codes: readonly string[],
): { id: string; symbols: readonly string[] } {
  registerSymbols(container, market, codes);
  const db = container.database.db;
  const id = newId('ds');
  const now = container.clock.now();
  const symbols = [...new Set(codes)].sort();
  db.insert(datasets).values({ id, name, description: null, createdAtMs: now, updatedAtMs: now }).run();
  for (const code of symbols) db.insert(datasetSymbols).values({ datasetId: id, code }).run();
  return { id, symbols };
}
