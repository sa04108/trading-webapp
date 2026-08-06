import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createKrxHistoricalUniverseSource } from '../../src/server/modules/market-data/infrastructure/krx/krx-historical-universe-source.js';
import {
  SymbolMasterService,
  type SymbolMasterServiceDeps,
} from '../../src/server/modules/market-data/application/symbol-master-service.js';
import {
  computeRebalanceDates,
  UniverseRuleResolver,
} from '../../src/server/modules/backtest/application/universe-rule-resolver.js';
import type { UniverseRule } from '../../src/shared/schemas/universe-rule.js';
import { createTestApp, type TestApp } from '../helpers/test-app.js';
import {
  baseInfoFixture,
  dailyFixture,
  krxEnvelope,
  startKrxFakeServer,
  type KrxFakeServer,
} from '../helpers/krx-fixtures.js';

const API_KEY = 'UNIVERSE_RULE_RESOLVER_TEST_KEY';
const NOOP_SLEEP = async () => undefined;

interface Ctx {
  readonly t: TestApp;
  readonly fake: KrxFakeServer;
  readonly svc: SymbolMasterService;
  readonly resolver: UniverseRuleResolver;
}

async function setup(): Promise<Ctx> {
  const t = await createTestApp();
  const fake = await startKrxFakeServer();
  const source = createKrxHistoricalUniverseSource(
    { baseUrl: fake.baseUrl, apiKey: API_KEY, approvalExpiry: null },
    t.container.clock,
    t.container.logger,
    { sleep: NOOP_SLEEP },
  );
  const deps: SymbolMasterServiceDeps = {
    db: t.container.database.db,
    source,
    clock: t.container.clock,
    logger: t.container.logger,
  };
  const svc = new SymbolMasterService(deps);
  const resolver = new UniverseRuleResolver({ symbolMaster: svc, logger: t.container.logger });
  return { t, fake, svc, resolver };
}

async function teardown(ctx: Ctx): Promise<void> {
  await ctx.fake.close();
  await ctx.t.close();
}

/**
 * KOSPI 5종목(A~C 보통주, E 시총 미보고, F 우선주) + KOSDAQ 1종목(D)을 2023-01-02 로
 * 수집한다. topN·시장·instrumentType·시총 유무 필터를 한 번에 검증하기 위한 구성이다:
 * - D 는 시총이 가장 크지만 KOSDAQ 이라 markets=['KOSPI'] 에서 걸러진다.
 * - F 는 A·B 보다 시총이 크지만 우선주라 instrumentType 필터에서 걸러진다.
 * - E 는 KOSPI 보통주지만 일별 시세에 없어(시총 미보고) join 에서 제외된다.
 */
async function ingestFixtureUniverse(ctx: Ctx): Promise<void> {
  const basDd = '20230102';
  const date = '2023-01-02';

  ctx.fake.setResponse('stk_isu_base_info', basDd, {
    body: krxEnvelope([
      baseInfoFixture({ ISU_CD: 'KR7000010001', ISU_SRT_CD: '000010', ISU_NM: 'A전자' }),
      baseInfoFixture({ ISU_CD: 'KR7000020002', ISU_SRT_CD: '000020', ISU_NM: 'B전자' }),
      baseInfoFixture({ ISU_CD: 'KR7000030003', ISU_SRT_CD: '000030', ISU_NM: 'C전자' }),
      baseInfoFixture({ ISU_CD: 'KR7000050005', ISU_SRT_CD: '000050', ISU_NM: 'E전자' }),
      baseInfoFixture({
        ISU_CD: 'KR7000060006', ISU_SRT_CD: '000060', ISU_NM: 'F우선주',
        KIND_STKCERT_TP_NM: '우선주',
      }),
    ]),
  });
  ctx.fake.setResponse('stk_bydd_trd', basDd, {
    body: krxEnvelope([
      dailyFixture({ ISU_CD: '000010', ISU_NM: 'A전자', MKTCAP: '500,000,000,000' }),
      dailyFixture({ ISU_CD: '000020', ISU_NM: 'B전자', MKTCAP: '300,000,000,000' }),
      dailyFixture({ ISU_CD: '000030', ISU_NM: 'C전자', MKTCAP: '200,000,000,000' }),
      dailyFixture({ ISU_CD: '000060', ISU_NM: 'F우선주', MKTCAP: '888,888,888,888' }),
      // E 는 의도적으로 일별 시세에 없다 — 시총 미보고 종목을 재현한다.
    ]),
  });
  ctx.fake.setResponse('ksq_isu_base_info', basDd, {
    body: krxEnvelope([
      baseInfoFixture({
        ISU_CD: 'KR7000040004', ISU_SRT_CD: '000040', ISU_NM: 'D코스닥', MKT_TP_NM: 'KOSDAQ',
      }),
    ]),
  });
  ctx.fake.setResponse('ksq_bydd_trd', basDd, {
    body: krxEnvelope([
      dailyFixture({ ISU_CD: '000040', ISU_NM: 'D코스닥', MKTCAP: '999,999,999,999' }),
    ]),
  });

  await ctx.svc.ingestDate(date);
}

describe('UniverseRuleResolver.resolve', () => {
  it('시총 상위 N 을 내림차순으로 고르고, 시장·instrumentType·시총 유무로 거른다', async () => {
    const ctx = await setup();
    await ingestFixtureUniverse(ctx);

    const rule: UniverseRule = { markets: ['KOSPI'], topN: 3, sortKey: 'MKTCAP' };
    const result = await ctx.resolver.resolve(rule, ['2023-01-02']);

    // A(500) > B(300) > C(200) 순 — D 는 시장, F 는 instrumentType, E 는 시총 없음으로 제외된다.
    expect(result.schedule).toEqual([
      { rebalanceDate: '2023-01-02', symbols: ['000010', '000020', '000030'] },
    ]);
    expect(result.unionSymbols).toEqual(['000010', '000020', '000030']);
    expect(result.uncoveredDates).toEqual([]);

    const expectedHash = createHash('sha256').update(JSON.stringify(result.schedule)).digest('hex');
    expect(result.scheduleHash).toBe(expectedHash);

    await teardown(ctx);
  });

  it('마스터가 커버하지 않는 날짜는 uncoveredDates 로 분리하고 KRX 를 부르지 않는다', async () => {
    const ctx = await setup();
    await ingestFixtureUniverse(ctx);

    const rule: UniverseRule = { markets: ['KOSPI'], topN: 3, sortKey: 'MKTCAP' };
    const before = ctx.fake.requests.length;
    const result = await ctx.resolver.resolve(rule, ['2023-01-02', '2023-02-01']);
    const duringResolve = ctx.fake.requests.slice(before);

    expect(result.uncoveredDates).toEqual(['2023-02-01']);
    expect(result.schedule).toEqual([
      { rebalanceDate: '2023-01-02', symbols: ['000010', '000020', '000030'] },
    ]);
    // 커버된 날짜의 getMarketCapsAt 캐시 미스(KOSPI·KOSDAQ 2회)만 발생한다 —
    // 커버 밖 날짜는 isCovered 에서 걸러져 KRX 호출 예산을 쓰지 않는다.
    expect(duringResolve).toHaveLength(2);

    await teardown(ctx);
  });
});

describe('computeRebalanceDates', () => {
  it('월말 시작일은 각 리밸런스마다 그 달의 말일로 자연 클램프된다', () => {
    const dates = computeRebalanceDates({ from: '2023-01-31', to: '2023-12-31' }, 1);
    expect(dates).toEqual([
      '2023-01-31', '2023-02-28', '2023-03-31', '2023-04-30', '2023-05-31', '2023-06-30',
      '2023-07-31', '2023-08-31', '2023-09-30', '2023-10-31', '2023-11-30', '2023-12-31',
    ]);
  });

  it('rebalanceMonths 간격으로 같은 일자를 유지하고, to 초과 날짜는 제외한다', () => {
    const dates = computeRebalanceDates({ from: '2023-01-15', to: '2023-04-15' }, 3);
    expect(dates).toEqual(['2023-01-15', '2023-04-15']);

    // 다음 리밸런스(2023-07-15)가 to 를 넘으므로 목록은 여기서 끝난다.
    const bounded = computeRebalanceDates({ from: '2023-01-01', to: '2023-01-31' }, 1);
    expect(bounded).toEqual(['2023-01-01']);
  });
});
