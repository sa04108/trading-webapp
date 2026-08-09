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
import type { Fact } from '../../src/server/modules/facts/domain/fact.js';
import type { Candle } from '../../src/server/modules/market-data/domain/candle.js';
import type { DailySelectionMetric } from '../../src/server/modules/market-data/application/selection-metric-repository.js';
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
  const marketCapRule = (limit: number): UniverseRule => ({
    markets: ['KOSPI'],
    stages: [{ criterion: 'MARKET_CAP', limit }],
    rebalanceInterval: { value: 1, unit: 'MONTH' },
  });

  it('시총 상위 N 을 내림차순으로 고르고, 시장·instrumentType·시총 유무로 거른다', async () => {
    const ctx = await setup();
    await ingestFixtureUniverse(ctx);

    const rule = marketCapRule(3);
    const result = await ctx.resolver.resolve(rule, ['2023-01-02']);

    // A(500) > B(300) > C(200) 순 — D 는 시장, F 는 instrumentType, E 는 시총 없음으로 제외된다.
    // excludedNonTradingCount: 0 — 이 픽스처는 거래불가일을 하나도 채우지 않는다(거래불가
    // 제외 필드가 schedule 항목에 추가되면서 이 값도 함께 검증해야 한다).
    expect(result.schedule).toEqual([
      {
        rebalanceDate: '2023-01-02',
        effectiveTradingDate: '2023-01-02',
        symbols: ['000010', '000020', '000030'],
        excludedNonTradingCount: 0,
      },
    ]);
    expect(result.unionSymbols).toEqual(['000010', '000020', '000030']);
    expect(result.uncoveredDates).toEqual([]);

    // 자동 등록(Task 4)이 이름·시장·표준코드를 여기서 가져온다 — union 에 든
    // 종목만큼만 담기고(D·F·E 는 없다), 원본 항목이 그대로 보존된다.
    expect([...result.unionEntries.keys()].sort()).toEqual(['000010', '000020', '000030']);
    expect(result.unionEntries.get('000010')).toMatchObject({
      standardCode: 'KR7000010001',
      shortCode: '000010',
      name: 'A전자',
      market: 'KOSPI',
    });

    const expectedHash = createHash('sha256').update(JSON.stringify(result.schedule)).digest('hex');
    expect(result.scheduleHash).toBe(expectedHash);

    await teardown(ctx);
  });

  it('마스터가 커버하지 않는 날짜는 uncoveredDates 로 분리하고 KRX 를 부르지 않는다', async () => {
    const ctx = await setup();
    await ingestFixtureUniverse(ctx);

    const rule = marketCapRule(3);
    const before = ctx.fake.requests.length;
    const result = await ctx.resolver.resolve(rule, ['2023-01-02', '2023-02-01']);
    const duringResolve = ctx.fake.requests.slice(before);

    expect(result.uncoveredDates).toEqual(['2023-02-01']);
    // excludedNonTradingCount: 0 — 이 픽스처는 거래불가일을 채우지 않는다.
    expect(result.schedule).toEqual([
      {
        rebalanceDate: '2023-01-02',
        effectiveTradingDate: '2023-01-02',
        symbols: ['000010', '000020', '000030'],
        excludedNonTradingCount: 0,
      },
    ]);
    // 커버된 날짜의 getMarketCapsAt 캐시 미스(KOSPI·KOSDAQ 2회)만 발생한다 —
    // 커버 밖 날짜는 isCovered 에서 걸러져 KRX 호출 예산을 쓰지 않는다.
    expect(duringResolve).toHaveLength(2);

    await teardown(ctx);
  });

  it('휴장 리밸런스 날짜는 직전 거래일 유니버스로 해소한다', async () => {
    const ctx = await setup();
    await ingestFixtureUniverse(ctx); // 2023-01-02 거래일 수집
    await ctx.svc.ingestDate('2023-01-03'); // fake 서버 기본값(빈 응답) → 휴장으로 수집된다

    const rule = marketCapRule(3);
    const result = await ctx.resolver.resolve(rule, ['2023-01-03']);

    expect(result.uncoveredDates).toEqual([]);
    // excludedNonTradingCount: 0 — 이 픽스처는 거래불가일을 채우지 않는다.
    expect(result.schedule).toEqual([
      {
        rebalanceDate: '2023-01-03',
        effectiveTradingDate: '2023-01-02',
        symbols: ['000010', '000020', '000030'],
        excludedNonTradingCount: 0,
      },
    ]);

    await teardown(ctx);
  });

  it('적용 거래일이 없으면 uncovered 로 분류한다', async () => {
    const ctx = await setup();
    // 휴장만 수집된 상태 — coverage 는 생기지만 거래일 기록은 하나도 없다
    await ctx.svc.ingestDate('2023-01-03');

    const rule = marketCapRule(3);
    const result = await ctx.resolver.resolve(rule, ['2023-01-03']);

    expect(result.uncoveredDates).toEqual(['2023-01-03']);
    expect(result.schedule).toEqual([]);

    await teardown(ctx);
  });

  it('coverage 밖 날짜는 적용 거래일이 있어도 uncovered 다', async () => {
    const ctx = await setup();
    await ingestFixtureUniverse(ctx); // 2023-01-02 만 커버

    // effectiveTradingDate 는 date 이하 최근 거래일을 찾을 뿐이라, coverage 를 한참
    // 벗어난 먼 미래 날짜에도 2023-01-02 를 돌려준다 — 이 경우까지 옛 유니버스로
    // 조용히 해소되지 않아야 한다.
    expect(ctx.svc.effectiveTradingDate('2026-01-01')).toBe('2023-01-02');
    expect(ctx.svc.isCovered('2026-01-01')).toBe(false);

    const rule = marketCapRule(3);
    const result = await ctx.resolver.resolve(rule, ['2026-01-01']);

    expect(result.uncoveredDates).toEqual(['2026-01-01']);
    expect(result.schedule).toEqual([]);

    await teardown(ctx);
  });

  it('date 자체가 고립된 coverage 섬이어도, 안 이어진 옛 거래일로 조용히 해소되지 않는다', async () => {
    const ctx = await setup();
    await ingestFixtureUniverse(ctx); // 2023-01-02 거래일 수집(coverage: [2023-01-02, 2023-01-02])

    // 2023-06-01 을 직접 휴장으로 ingest — ensureTradingDay 의 소급 없이, 그 날짜
    // 하나만 담은 고립 coverage 섬을 남긴다(2023-01-02 섬과 안 이어진다). isCovered
    // 는 이 섬만 보고도 참이 된다 — 리뷰에서 지적된 지점: isCovered(date) 는
    // "date 가 어떤 구간엔 있나"만 볼 뿐, 그 구간이 실제 직전 거래일까지 이어지는지는
    // 보지 않는다.
    await ctx.svc.ingestDate('2023-06-01');
    expect(ctx.svc.isCovered('2023-06-01')).toBe(true);
    // 버그가 있었다면(resolver 가 전역 effectiveTradingDate 를 썼다면): 2023-01-02
    // 가 "2023-06-01 이하 최근 거래일"로 잡혀 isCovered 게이트를 통과해 버렸을
    // 것이다 — 두 날짜가 안 이어져 있다는 사실은 이 값만으로는 알 수 없다.
    expect(ctx.svc.effectiveTradingDate('2023-06-01')).toBe('2023-01-02');

    const rule = marketCapRule(3);
    const result = await ctx.resolver.resolve(rule, ['2023-06-01']);

    expect(result.uncoveredDates).toEqual(['2023-06-01']);
    expect(result.schedule).toEqual([]);

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

const PIPELINE_DATE = '2025-05-15';
const PIPELINE_TS = Date.parse(`${PIPELINE_DATE}T00:00:00Z`);
const PIPELINE_ENTRIES = [
  { standardCode: 'KR7000001001', shortCode: '000001', name: '하나', market: 'KOSPI', sharesOutstanding: '1', instrumentType: 'COMMON_STOCK', listedDate: null },
  { standardCode: 'KR7000002002', shortCode: '000002', name: '둘', market: 'KOSPI', sharesOutstanding: '1', instrumentType: 'COMMON_STOCK', listedDate: null },
  { standardCode: 'KR7000003003', shortCode: '000003', name: '셋', market: 'KOSPI', sharesOutstanding: '1', instrumentType: 'COMMON_STOCK', listedDate: null },
] as const;

const pipelineMetrics: DailySelectionMetric[] = PIPELINE_ENTRIES.map((entry, index) => ({
  date: PIPELINE_DATE,
  standardCode: entry.standardCode,
  marketCapKrw: [300n, 200n, 100n][index]!,
  volume: [3_000, 2_000, 1_000][index]!,
  tradingValueKrw: [30_000n, 20_000n, 10_000n][index]!,
}));

function netIncomeFacts(symbol: string, quarterly: readonly number[], disclosedAt = PIPELINE_TS - 1): Fact[] {
  return quarterly.map((value, index) => ({
    scope: 'SYMBOL',
    key: symbol,
    field: 'NET_INCOME',
    periodKey: ['2024Q2', '2024Q3', '2024Q4', '2025Q1'][index]!,
    asOfTsMs: disclosedAt,
    value,
    unit: 'KRW',
  }));
}

function pipelineRule(stages: UniverseRule['stages']): UniverseRule {
  return {
    markets: ['KOSPI'],
    stages,
    rebalanceInterval: { unit: 'MONTH', value: 1 },
  };
}

function makePipelineResolver(options: {
  metrics?: readonly DailySelectionMetric[];
  missingTradingValueDates?: readonly string[];
  facts?: readonly Fact[];
  factsPresent?: readonly string[];
  candles?: readonly Candle[];
  actionCoverage?: ReadonlyMap<string, readonly number[]>;
  actionGaps?: ReadonlyMap<string, readonly number[]>;
  metricReads?: string[][];
} = {}): UniverseRuleResolver {
  const metrics = options.metrics ?? pipelineMetrics;
  const facts = options.facts ?? [
    ...netIncomeFacts('000001', [1]),
    ...netIncomeFacts('000002', [5, 5, 5, 5]),
    ...netIncomeFacts('000003', [5, 5, 5, 5]),
  ];
  const factsPresent = new Set(options.factsPresent ?? PIPELINE_ENTRIES.map((entry) => entry.shortCode));
  const candles = options.candles ?? [];
  const actionCoverage = options.actionCoverage ?? new Map(
    PIPELINE_ENTRIES.map((entry) => [entry.shortCode, [2025] as const]),
  );
  const actionGaps = options.actionGaps ?? new Map<string, readonly number[]>();

  return new UniverseRuleResolver({
    symbolMaster: {
      isCovered: () => true,
      effectiveTradingDateWithinCoverage: () => PIPELINE_DATE,
      getUniverseAsOf: () => new Map(PIPELINE_ENTRIES.map((entry) => [entry.standardCode, entry])),
      getMarketCapsAt: async () => new Map(metrics.flatMap((row) =>
        row.marketCapKrw === null ? [] : [[row.standardCode, row.marketCapKrw.toString()]],
      )),
      nonTradingDaysBetween: () => [],
    } as never,
    selectionMetrics: {
      getAt: (date: string, standardCodes: readonly string[]) => {
        options.metricReads?.push([...standardCodes]);
        return new Map(metrics
          .filter((row) => row.date === date && standardCodes.includes(row.standardCode))
          .map((row) => [row.standardCode, row]));
      },
      findMissingTradingValueDates: () => [...(options.missingTradingValueDates ?? [])],
    } as never,
    facts: {
      getFacts: async ({ keys }: { keys?: readonly string[] }) => facts.filter((fact) => keys?.includes(fact.key) ?? true),
      hasFacts: (_scope: 'SYMBOL' | 'MACRO', key: string) => factsPresent.has(key),
      symbolsWithFacts: () => factsPresent,
      saveFacts: async () => undefined,
    },
    candles: {
      async *getCandles(query: { symbols: readonly string[]; fromTsMs?: number; toTsMs?: number }) {
        for (const candle of candles) {
          if (
            query.symbols.includes(candle.symbol)
            && (query.fromTsMs === undefined || candle.tsMs >= query.fromTsMs)
            && (query.toTsMs === undefined || candle.tsMs <= query.toTsMs)
          ) yield candle;
        }
      },
      getTimestamps: async () => [],
    },
    actionCoverage: {
      getCoveredYears: () => actionCoverage,
      getGapYears: () => actionGaps,
      addCoveredYears: () => undefined,
      addGapYears: () => undefined,
    },
    logger: { warn: () => {}, info: () => {}, error: () => {}, debug: () => {} } as never,
  });
}

describe('UniverseRuleResolver.resolveOrDescribeNeeds', () => {
  const period = { from: PIPELINE_DATE, to: PIPELINE_DATE };

  it('stage 순서를 그대로 적용해 MARKET_CAP→PER와 PER→MARKET_CAP 결과가 달라진다', async () => {
    const resolver = makePipelineResolver();
    const capThenPer = await resolver.resolveOrDescribeNeeds(pipelineRule([
      { criterion: 'MARKET_CAP', limit: 2 },
      { criterion: 'PER', limit: 1 },
    ]), period);
    const perThenCap = await resolver.resolveOrDescribeNeeds(pipelineRule([
      { criterion: 'PER', limit: 1 },
      { criterion: 'MARKET_CAP', limit: 1 },
    ]), period);

    expect(capThenPer.kind).toBe('READY');
    expect(perThenCap.kind).toBe('READY');
    if (capThenPer.kind !== 'READY' || perThenCap.kind !== 'READY') {
      throw new Error('fixture coverage가 완전해야 합니다.');
    }
    expect(capThenPer.schedule[0]?.members.map((member) => member.symbol)).toEqual(['000002']);
    expect(perThenCap.schedule[0]?.members.map((member) => member.symbol)).toEqual(['000003']);
    expect(capThenPer.diagnostics[0]?.stages[1]).toMatchObject({
      inputCount: 2,
      eligibleCount: 1,
      selectedCount: 1,
      excludedMissingCount: 1,
    });
  });

  it('각 stage와 READY pin은 그 시점의 현재 후보만 선정 지표 저장소에서 읽는다', async () => {
    const metricReads: string[][] = [];
    const resolver = makePipelineResolver({ metricReads });
    const result = await resolver.resolveOrDescribeNeeds(pipelineRule([
      { criterion: 'MARKET_CAP', limit: 2 },
      { criterion: 'PER', limit: 1 },
    ]), period);

    expect(result.kind).toBe('READY');
    expect(metricReads).toEqual([
      ['KR7000001001', 'KR7000002002', 'KR7000003003'],
      ['KR7000001001', 'KR7000002002'],
      ['KR7000002002'],
    ]);
  });

  it('PER은 effective date까지 공시된 양수 TTM 순이익과 그날 시가총액만 쓴다', async () => {
    const futureRestatement = netIncomeFacts('000003', [1_000, 1_000, 1_000, 1_000], PIPELINE_TS + 86_400_000);
    const resolver = makePipelineResolver({
      facts: [
        ...netIncomeFacts('000001', [5, 5, 5, 5]),
        ...netIncomeFacts('000002', [-5, -5, -5, -5]),
        ...netIncomeFacts('000003', [5, 5, 5, 5]),
        ...futureRestatement,
      ],
    });

    const result = await resolver.resolveOrDescribeNeeds(
      pipelineRule([{ criterion: 'PER', limit: 3 }]),
      period,
    );
    expect(result.kind).toBe('READY');
    if (result.kind !== 'READY') throw new Error('fixture coverage가 완전해야 합니다.');
    // 000002는 TTM 순이익이 0 이하라 제외. 미래 재집계가 보였다면 000003이 1위가 된다.
    expect(result.schedule[0]?.members.map((member) => member.symbol)).toEqual(['000003', '000001']);
    expect(result.diagnostics[0]?.stages[0]).toMatchObject({
      inputCount: 3,
      eligibleCount: 2,
      selectedCount: 2,
      excludedMissingCount: 1,
    });
  });

  it('모든 날짜와 아직 좁힐 수 없는 후속 단계의 데이터 필요량을 합집합으로 반환한다', async () => {
    const resolver = makePipelineResolver({
      missingTradingValueDates: [PIPELINE_DATE],
      factsPresent: [],
      candles: [],
      actionCoverage: new Map(),
    });
    const result = await resolver.resolveOrDescribeNeeds(pipelineRule([
      { criterion: 'TRADING_VALUE', limit: 3 },
      { criterion: 'PER', limit: 2 },
      { criterion: 'DECLINE', limit: 1, lookbackTradingDays: 3 },
    ]), period);

    expect(result).toMatchObject({
      kind: 'NEEDS_DATA',
      needs: {
        factSymbols: ['000001', '000002', '000003'],
        actionSymbols: ['000001', '000002', '000003'],
        selectionMetricDates: [PIPELINE_DATE],
      },
    });
    if (result.kind !== 'NEEDS_DATA') throw new Error('fixture는 데이터 부족이어야 합니다.');
    expect(result.needs.priceRange).not.toBeNull();
  });

  it('급하락은 effective date 포함 N개 봉의 분할보정 수익률을 오름차순으로 고른다', async () => {
    const day = (offset: number) => PIPELINE_TS - offset * 86_400_000;
    const candle = (symbol: string, offset: number, close: number): Candle => ({
      symbol, market: 'KR', timeframe: '1d', tsMs: day(offset),
      open: close, high: close, low: close, close, volume: 1,
    });
    const resolver = makePipelineResolver({
      candles: [
        candle('000001', 2, 100), candle('000001', 1, 50), candle('000001', 0, 55),
        candle('000002', 2, 100), candle('000002', 1, 90), candle('000002', 0, 80),
        candle('000003', 2, 100), candle('000003', 1, 100), candle('000003', 0, 100),
      ],
      facts: [{
        scope: 'SYMBOL', key: '000001', field: 'SPLIT_RATIO', periodKey: '2025-05-14',
        asOfTsMs: PIPELINE_TS + 365 * 86_400_000, value: 2, unit: 'ratio',
      }],
    });

    const result = await resolver.resolveOrDescribeNeeds(
      pipelineRule([{ criterion: 'DECLINE', limit: 1, lookbackTradingDays: 3 }]),
      period,
    );
    expect(result.kind).toBe('READY');
    if (result.kind !== 'READY') throw new Error('fixture coverage가 완전해야 합니다.');
    // 000001은 분할보정 후 +10%, 000002는 -20%다. 분할 미보정이면 000001(-45%)이 잘못 뽑힌다.
    expect(result.schedule[0]?.members.map((member) => member.symbol)).toEqual(['000002']);
    expect(result.schedule[0]?.members[0]).toMatchObject({
      standardCode: 'KR7000002002',
      marketCapKrw: '200',
      volume: 2_000,
      tradingValueKrw: '20000',
    });
  });

  it('급하락 자본변동 coverage는 추정 달력 범위가 아니라 실제 N개 봉 범위만 요구한다', async () => {
    const candles = PIPELINE_ENTRIES.flatMap((entry) =>
      Array.from({ length: 100 }, (_, index): Candle => {
        const tsMs = PIPELINE_TS - (99 - index) * 86_400_000;
        return {
          symbol: entry.shortCode,
          market: 'KR',
          timeframe: '1d',
          tsMs,
          open: 100 + index,
          high: 100 + index,
          low: 100 + index,
          close: 100 + index,
          volume: 1,
        };
      }),
    );
    const resolver = makePipelineResolver({ candles });

    const result = await resolver.resolveOrDescribeNeeds(
      pipelineRule([{ criterion: 'DECLINE', limit: 1, lookbackTradingDays: 100 }]),
      period,
    );
    expect(result.kind).toBe('READY');
  });

  it('급하락 warm-up 또는 자본변동 coverage가 부족하면 부분 schedule 없이 NEEDS_DATA다', async () => {
    const candle = (symbol: string, offset: number): Candle => ({
      symbol, market: 'KR', timeframe: '1d', tsMs: PIPELINE_TS - offset * 86_400_000,
      open: 100, high: 100, low: 100, close: 100, volume: 1,
    });
    const resolver = makePipelineResolver({
      candles: PIPELINE_ENTRIES.flatMap((entry) => [candle(entry.shortCode, 1), candle(entry.shortCode, 0)]),
      actionCoverage: new Map([['000001', [2025]]]),
    });

    const result = await resolver.resolveOrDescribeNeeds(
      pipelineRule([{ criterion: 'DECLINE', limit: 1, lookbackTradingDays: 3 }]),
      period,
    );
    expect(result.kind).toBe('NEEDS_DATA');
    if (result.kind !== 'NEEDS_DATA') throw new Error('fixture는 데이터 부족이어야 합니다.');
    expect(result.needs.actionSymbols).toEqual(['000002', '000003']);
    expect(result.needs.priceRange).not.toBeNull();
    expect('schedule' in result).toBe(false);
  });
});
