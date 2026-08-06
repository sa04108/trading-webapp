import { describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../helpers/test-app.js';
import { symbolMasterEvents } from '../../src/server/shared/db/schema.js';
import type { KrxHistoricalUniverseSource } from '../../src/server/modules/market-data/application/ports.js';
import {
  SymbolMasterService,
  type SymbolMasterServiceDeps,
} from '../../src/server/modules/market-data/application/symbol-master-service.js';
import type {
  SymbolMasterEntry,
  SymbolMasterEventType,
  UniverseState,
} from '../../src/server/modules/market-data/domain/symbol-master.js';

// entry()/state() 헬퍼는 diff·apply 테스트와 동일하게 정의한다
function entry(overrides: Partial<SymbolMasterEntry> = {}): SymbolMasterEntry {
  return {
    standardCode: 'KR7005930003', shortCode: '005930', name: '삼성전자',
    market: 'KOSPI', sharesOutstanding: '100', instrumentType: 'COMMON_STOCK',
    listedDate: '1975-06-11', ...overrides,
  };
}
function state(...entries: SymbolMasterEntry[]): UniverseState {
  return new Map(entries.map((e) => [e.standardCode, e]));
}

// 이 태스크는 source 를 쓰지 않는다 (다음 태스크가 실제 KRX 조회에 쓴다) — 더미로 충분하다.
const DUMMY_SOURCE = {} as unknown as KrxHistoricalUniverseSource;

function makeService(t: TestApp): SymbolMasterService {
  const deps: SymbolMasterServiceDeps = {
    db: t.container.database.db,
    source: DUMMY_SOURCE,
    clock: t.container.clock,
    logger: t.container.logger,
  };
  return new SymbolMasterService(deps);
}

function insertEvent(t: TestApp, draft: {
  readonly effectiveDate: string;
  readonly standardCode: string;
  readonly eventType: SymbolMasterEventType;
  readonly oldValue: string | null;
  readonly newValue: string | null;
  readonly observedSpanStart: string;
}): void {
  t.container.database.db.insert(symbolMasterEvents).values({
    ...draft,
    createdAtMs: t.container.clock.now(),
  }).run();
}

describe('getUniverseAsOf', () => {
  it('체크포인트 이후 날짜: 순방향 이벤트 적용', async () => {
    const t = await createTestApp();
    const svc = makeService(t);
    svc.saveCheckpoint('2023-01-02', state(entry()), true);
    insertEvent(t, {
      effectiveDate: '2023-01-03', eventType: 'SHARES_CHANGED',
      standardCode: 'KR7005930003', oldValue: '"100"', newValue: '"90"',
      observedSpanStart: '2023-01-02',
    });

    expect(svc.getUniverseAsOf('2023-01-03').get('KR7005930003')!.sharesOutstanding)
      .toBe('90');
    // 이벤트 이전 날짜는 체크포인트 그대로 — (cp, date] 구간에 이벤트가 없다
    expect(svc.getUniverseAsOf('2023-01-02').get('KR7005930003')!.sharesOutstanding)
      .toBe('100');
    await t.close();
  });

  it('체크포인트 이전 날짜: 역방향 적용', async () => {
    const t = await createTestApp();
    const svc = makeService(t);
    svc.saveCheckpoint('2023-04-03', state(entry()), true);
    insertEvent(t, {
      effectiveDate: '2023-02-01', eventType: 'SHARES_CHANGED',
      standardCode: 'KR7005930003', oldValue: '"100"', newValue: '"90"',
      observedSpanStart: '2023-02-01',
    });

    // 조회일이 이벤트보다도 앞이라 (date, cp] 구간의 이벤트를 되돌려 원래 값 100 을 복원한다.
    // 방향을 거꾸로(순방향) 적용하는 버그가 있으면 90 이 나와 이 단언이 잡아낸다.
    expect(svc.getUniverseAsOf('2023-01-15').get('KR7005930003')!.sharesOutstanding)
      .toBe('100');
    await t.close();
  });

  it('가장 가까운 체크포인트를 고른다 — 두 체크포인트 사이 날짜', async () => {
    const t = await createTestApp();
    const svc = makeService(t);
    // 두 체크포인트의 값이 서로 달라야 잘못된 체크포인트를 골랐을 때 단언이 실패한다.
    svc.saveCheckpoint('2023-01-02', state(entry()), true);
    svc.saveCheckpoint('2023-04-03', state(entry({ sharesOutstanding: '999' })), true);
    insertEvent(t, {
      effectiveDate: '2023-01-10', eventType: 'SHARES_CHANGED',
      standardCode: 'KR7005930003', oldValue: '"100"', newValue: '"150"',
      observedSpanStart: '2023-01-02',
    });

    // 2023-01-20 은 1월 체크포인트(18일 차)가 4월 체크포인트(73일 차)보다 훨씬 가깝다 —
    // 1월 cp 에서 순방향으로 이벤트를 적용해 150 이 나와야 한다. 999 가 나오면 4월 cp 를
    // 잘못 골랐다는 뜻이고, 100 이 나오면 이벤트를 적용하지 않았다는 뜻이다.
    expect(svc.getUniverseAsOf('2023-01-20').get('KR7005930003')!.sharesOutstanding)
      .toBe('150');
    await t.close();
  });
});
