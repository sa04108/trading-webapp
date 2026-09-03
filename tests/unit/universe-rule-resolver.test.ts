import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createKrxHistoricalUniverseSource } from '../../src/server/modules/market-data/infrastructure/krx/krx-historical-universe-source.js';
import {
  SymbolMasterService,
  type KnownRegisteredSymbolIdentity,
  type SymbolMasterServiceDeps,
} from '../../src/server/modules/market-data/application/symbol-master-service.js';
import { UniverseRuleResolver } from '../../src/server/modules/backtest/application/universe-rule-resolver.js';
import type { UniverseRule } from '../../src/shared/schemas/universe-rule.js';
import type { Fact } from '../../src/server/modules/facts/domain/fact.js';
import type { FactQuery } from '../../src/server/modules/facts/application/ports.js';
import type { SharesChange } from '../../src/server/modules/facts/domain/corporate-action-effective-date.js';
import type { Candle } from '../../src/server/modules/market-data/domain/candle.js';
import type { CandleQuery } from '../../src/server/modules/market-data/application/ports.js';
import type { DailySelectionMetric } from '../../src/server/modules/market-data/application/selection-metric-repository.js';
import type {
  KnownSymbolIdentityVersion,
  SymbolIdentitySelection,
  SymbolIdentityValidationResult,
} from '../../src/server/modules/market-data/domain/symbol-identity-lifetime.js';
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
  const marketCapRule = (
    limit: number,
    direction: 'HIGH' | 'LOW' = 'HIGH',
  ): UniverseRule => ({
    markets: ['KOSPI'],
    stages: [{ criterion: 'MARKET_CAP', direction, limit }],
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

  it('시가총액 LOW는 작은 시가총액부터 N개를 고른다', async () => {
    const ctx = await setup();
    await ingestFixtureUniverse(ctx);

    const result = await ctx.resolver.resolve(marketCapRule(2, 'LOW'), ['2023-01-02']);

    expect(result.schedule[0]?.symbols).toEqual(['000030', '000020']);
    expect(result.unionSymbols).toEqual(['000020', '000030']);
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

function totalEquityFact(
  symbol: string,
  value: number,
  disclosedAt = PIPELINE_TS - 1,
): Fact {
  return {
    scope: 'SYMBOL',
    key: symbol,
    field: 'TOTAL_EQUITY',
    periodKey: '2025Q1',
    asOfTsMs: disclosedAt,
    value,
    unit: 'KRW',
  };
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
  financiallyCoveredSymbols?: readonly string[];
  financialCoverage?: ReadonlyMap<string, readonly number[]>;
  candles?: readonly Candle[];
  actionCoverage?: ReadonlyMap<string, readonly number[]>;
  actionGaps?: ReadonlyMap<string, readonly number[]>;
  sharesChanges?: readonly SharesChange[];
  priceRangeCovered?: boolean;
  masterCovered?: boolean;
  effectiveTradingDate?: (rebalanceDate: string) => string | undefined;
  metricReads?: string[][];
  metricDateReads?: string[][];
  identityReads?: SymbolIdentitySelection[][];
  factReads?: string[][];
  factQueries?: FactQuery[];
  financialCoverageReads?: string[][];
  candleReads?: string[][];
  bulkCandleReads?: string[][];
  closePriceReads?: string[][];
  actionCoverageReads?: string[][];
  validateIdentity?: (
    selections: readonly SymbolIdentitySelection[],
  ) => SymbolIdentityValidationResult;
  identityRegistrations?: readonly KnownRegisteredSymbolIdentity[];
  unregisteredFactShortCodes?: readonly string[];
  uncoveredBarShortCodes?: readonly string[];
} = {}): UniverseRuleResolver {
  const metrics = options.metrics ?? pipelineMetrics;
  const facts = options.facts ?? [
    ...netIncomeFacts('000001', [1]),
    ...netIncomeFacts('000002', [5, 5, 5, 5]),
    ...netIncomeFacts('000003', [5, 5, 5, 5]),
  ];
  const financiallyCoveredSymbols = new Set(
    options.financiallyCoveredSymbols ?? PIPELINE_ENTRIES.map((entry) => entry.shortCode),
  );
  const sharesChanges = options.sharesChanges ?? facts.flatMap((fact): SharesChange[] => (
    fact.field === 'SPLIT_RATIO'
      ? [{ shortCode: fact.key, effectiveDate: fact.periodKey, ratio: fact.value }]
      : []
  ));
  // PER 결측 판정은 financial coverage 연도를 본다 — 기본 종목은 PIPELINE_DATE(2025)
  // 기준 필요 연도 [2024, 2025]를 모두 덮은 것으로 둔다.
  const financialCoverage = options.financialCoverage ?? new Map(
    [...financiallyCoveredSymbols].map((code) => [code, [2024, 2025] as readonly number[]]),
  );
  const candles = options.candles ?? [];
  const actionCoverage = options.actionCoverage ?? new Map(
    PIPELINE_ENTRIES.map((entry) => [entry.shortCode, [2025] as const]),
  );
  const actionGaps = options.actionGaps ?? new Map<string, readonly number[]>();

  return new UniverseRuleResolver({
    symbolMaster: {
      isCovered: () => options.masterCovered ?? true,
      isRangeCovered: () => options.priceRangeCovered ?? false,
      effectiveTradingDateWithinCoverage: (rebalanceDate: string) => options.masterCovered === false
        ? undefined
        : options.effectiveTradingDate?.(rebalanceDate) ?? PIPELINE_DATE,
      getUniverseAsOf: () => new Map(PIPELINE_ENTRIES.map((entry) => [entry.standardCode, entry])),
      getMarketCapsAt: async () => new Map(metrics.flatMap((row) =>
        row.marketCapKrw === null ? [] : [[row.standardCode, row.marketCapKrw.toString()]],
      )),
      nonTradingDaysBetween: () => [],
      sharesChangesBetween: (from: string, to: string) => sharesChanges.filter(
        (change) => change.effectiveDate >= from && change.effectiveDate <= to,
      ),
      readIdentitySnapshot: (shortCodes: readonly string[], standardCodes: readonly string[]) => {
        const selectionsByPair = new Map<string, SymbolIdentitySelection>();
        for (let index = 0; index < shortCodes.length; index += 1) {
          const shortCode = shortCodes[index]!;
          const standardCode = standardCodes[index]
            ?? PIPELINE_ENTRIES.find((entry) => entry.shortCode === shortCode)?.standardCode
            ?? `UNKNOWN-${shortCode}`;
          selectionsByPair.set(`${shortCode}\0${standardCode}`, {
            shortCode,
            standardCode,
            effectiveDate: PIPELINE_DATE,
          });
        }
        const selections = [...selectionsByPair.values()];
        options.identityReads?.push([...selections]);
        const requested = options.validateIdentity?.(selections) ?? { safe: true, conflicts: [] };
        const versionsByPair = new Map<string, KnownSymbolIdentityVersion>();
        const remember = (version: KnownSymbolIdentityVersion): void => {
          versionsByPair.set(`${version.shortCode}\0${version.standardCode}`, version);
        };
        for (const selection of selections) {
          remember({
            shortCode: selection.shortCode,
            standardCode: selection.standardCode,
            validFromDate: '2000-01-01',
            validToDate: null,
          });
        }
        for (const conflict of requested.conflicts) {
          if (conflict.kind === 'SHORT_CODE_REUSED') {
            for (const standardCode of conflict.standardCodes) {
              remember({
                shortCode: conflict.shortCode,
                standardCode,
                validFromDate: standardCode === selections[0]?.standardCode
                  ? '2000-01-01'
                  : '1990-01-01',
                validToDate: standardCode === selections[0]?.standardCode ? null : '2000-01-01',
              });
            }
          } else if (conflict.kind === 'STANDARD_CODE_REASSIGNED') {
            for (const shortCode of conflict.shortCodes) {
              remember({
                shortCode,
                standardCode: conflict.standardCode,
                validFromDate: shortCode === selections[0]?.shortCode
                  ? '2000-01-01'
                  : '1990-01-01',
                validToDate: shortCode === selections[0]?.shortCode ? null : '2000-01-01',
              });
            }
          }
        }
        return {
          versions: [...versionsByPair.values()],
          registrations: options.identityRegistrations ?? selections.map((selection) => ({
            code: selection.shortCode,
            standardCode: selection.standardCode,
          })),
          unregisteredFactShortCodes: options.unregisteredFactShortCodes ?? [],
          uncoveredBarShortCodes: options.uncoveredBarShortCodes ?? [],
        };
      },
    } as never,
    selectionMetrics: {
      getAt: (date: string, standardCodes: readonly string[]) => {
        options.metricReads?.push([...standardCodes]);
        return new Map(metrics
          .filter((row) => row.date === date && standardCodes.includes(row.standardCode))
          .map((row) => [row.standardCode, row]));
      },
      findMissingTradingValueDates: (dates: readonly string[]) => {
        options.metricDateReads?.push([...dates]);
        return [...(options.missingTradingValueDates ?? [])];
      },
    } as never,
    facts: {
      getFacts: async (query: FactQuery) => {
        if (query.keys !== undefined) options.factReads?.push([...query.keys]);
        options.factQueries?.push(query);
        return facts.filter((fact) => (
          (query.keys?.includes(fact.key) ?? true)
          && (query.fields?.includes(fact.field) ?? true)
          && (query.asOfMaxTsMs === undefined || fact.asOfTsMs <= query.asOfMaxTsMs)
        ));
      },
      saveFacts: async () => undefined,
      replaceSymbolFinancialFactsForYear: async () => undefined,
      replaceSymbolCorporateActionFactsForYear: async () => undefined,
    },
    factCoverage: {
      getCoveredYears: (codes?: readonly string[]) => {
        if (codes !== undefined) options.financialCoverageReads?.push([...codes]);
        return codes === undefined
          ? financialCoverage
          : new Map([...financialCoverage].filter(([code]) => codes.includes(code)));
      },
      getCoverageState: (codes?: readonly string[]) => new Map(
        [...financialCoverage]
          .filter(([code]) => codes === undefined || codes.includes(code))
          .map(([code, years]) => [code, {
            verifiedYears: years,
            blockingGapYears: [],
            blockingGapDetails: [],
          }]),
      ),
      getUpdatedAtMs: () => new Map<string, number>(),
      getProcessedFilingReceiptNos: () => new Set<string>(),
      addProcessedFilings: () => undefined,
      addCoveredYears: () => undefined,
      addCoverageResult: () => undefined,
    },
    candles: {
      async *getCandles(query: { symbols: readonly string[]; fromTsMs?: number; toTsMs?: number }) {
        options.candleReads?.push([...query.symbols]);
        for (const candle of candles) {
          if (
            query.symbols.includes(candle.symbol)
            && (query.fromTsMs === undefined || candle.tsMs >= query.fromTsMs)
            && (query.toTsMs === undefined || candle.tsMs <= query.toTsMs)
          ) yield candle;
        }
      },
      ...(options.bulkCandleReads === undefined ? {} : {
        getCandlesArray: async (query: CandleQuery) => {
          options.bulkCandleReads?.push([...query.symbols]);
          return candles.filter((candle) => (
            query.symbols.includes(candle.symbol)
            && (query.fromTsMs === undefined || candle.tsMs >= query.fromTsMs)
            && (query.toTsMs === undefined || candle.tsMs <= query.toTsMs)
          ));
        },
      }),
      ...(options.closePriceReads === undefined ? {} : {
        getClosePricesBySymbol: async (query: CandleQuery) => {
          options.closePriceReads?.push([...query.symbols]);
          const grouped = new Map<string, Candle[]>();
          for (const candle of candles) {
            if (
              !query.symbols.includes(candle.symbol)
              || (query.fromTsMs !== undefined && candle.tsMs < query.fromTsMs)
              || (query.toTsMs !== undefined && candle.tsMs > query.toTsMs)
            ) continue;
            const values = grouped.get(candle.symbol) ?? [];
            values.push(candle);
            grouped.set(candle.symbol, values);
          }
          return grouped;
        },
      }),
      getTimestamps: async () => [],
    },
    actionCoverage: {
      getCoveredYears: (codes: readonly string[]) => {
        options.actionCoverageReads?.push([...codes]);
        return actionCoverage;
      },
      getGapYears: () => actionGaps,
      getUpdatedAtMs: () => new Map<string, number>(),
      addCoveredYears: () => undefined,
      addGapYears: () => undefined,
      addCoverageResult: () => undefined,
    },
    logger: { warn: () => {}, info: () => {}, error: () => {}, debug: () => {} } as never,
  });
}

describe('UniverseRuleResolver.resolveOrDescribeNeeds', () => {
  const period = { from: PIPELINE_DATE, to: PIPELINE_DATE };
  it('리밸런싱 날짜별 진행률을 시작 0부터 완료까지 보고한다', async () => {
    const progress: Array<{ completedRebalanceDates: number; totalRebalanceDates: number }> = [];

    const result = await makePipelineResolver().resolveOrDescribeNeeds(
      pipelineRule([{ criterion: 'MARKET_CAP', direction: 'HIGH', limit: 1 }]),
      period,
      { onProgress: (value) => progress.push(value) },
    );

    expect(result.kind).toBe('READY');
    expect(progress).toEqual([
      { completedRebalanceDates: 0, totalRebalanceDates: 1 },
      { completedRebalanceDates: 1, totalRebalanceDates: 1 },
    ]);
  });

  it('날짜 사이 취소 요청은 다음 SQLite 조회 전에 resolver를 중단한다', async () => {
    const metricReads: string[][] = [];

    await expect(makePipelineResolver({ metricReads }).resolveOrDescribeNeeds(
      pipelineRule([{ criterion: 'MARKET_CAP', direction: 'HIGH', limit: 1 }]),
      period,
      { shouldStop: () => true },
    )).rejects.toMatchObject({
      name: 'UniverseResolutionCancelledError',
    });
    expect(metricReads).toEqual([]);
  });

  it('마지막 날짜 완료 직후 취소되면 최종 identity 조회 전에 중단한다', async () => {
    let stopped = false;
    const identityReads: SymbolIdentitySelection[][] = [];

    await expect(makePipelineResolver({ identityReads }).resolveOrDescribeNeeds(
      pipelineRule([{ criterion: 'MARKET_CAP', direction: 'HIGH', limit: 1 }]),
      period,
      {
        onProgress: ({ completedRebalanceDates, totalRebalanceDates }) => {
          if (completedRebalanceDates === totalRebalanceDates) stopped = true;
        },
        shouldStop: () => stopped,
      },
    )).rejects.toMatchObject({ name: 'UniverseResolutionCancelledError' });
    expect(identityReads).toEqual([]);
  });

  it('앞 단계가 후보 0을 확정하면 후속 short-keyed 저장소를 읽지 않는다', async () => {
    const factQueries: FactQuery[] = [];
    const candleReads: string[][] = [];
    const actionCoverageReads: string[][] = [];
    const identityReads: SymbolIdentitySelection[][] = [];
    const metrics = pipelineMetrics.map((metric) => ({ ...metric, marketCapKrw: null }));

    const result = await makePipelineResolver({
      metrics,
      factQueries,
      candleReads,
      actionCoverageReads,
      identityReads,
    }).resolveOrDescribeNeeds(pipelineRule([
      { criterion: 'MARKET_CAP', direction: 'HIGH', limit: 1 },
      { criterion: 'PER', direction: 'LOW', limit: 1 },
      { criterion: 'DECLINE', direction: 'LOW', limit: 1, lookbackTradingDays: 3 },
    ]), period);

    expect(result.kind).toBe('READY');
    if (result.kind !== 'READY') throw new Error('빈 후보는 추가 데이터 없이 확정돼야 합니다.');
    expect(result.schedule[0]?.members).toEqual([]);
    expect(factQueries).toEqual([]);
    expect(candleReads).toEqual([]);
    expect(actionCoverageReads).toEqual([]);
    expect(identityReads).toEqual([]);
  });


  it('PER 후보 identity가 모호하면 coverage와 fact를 읽기 전에 실패한다', async () => {
    const identityReads: SymbolIdentitySelection[][] = [];
    const financialCoverageReads: string[][] = [];
    const factReads: string[][] = [];
    const resolver = makePipelineResolver({
      identityReads,
      financialCoverageReads,
      factReads,
      validateIdentity: () => ({
        safe: false,
        conflicts: [{
          kind: 'SHORT_CODE_REUSED',
          shortCode: '000001',
          standardCodes: ['KR7000001001', 'KR7999999999'],
        }],
      }),
    });

    await expect(resolver.resolveOrDescribeNeeds(
      pipelineRule([{ criterion: 'PER', direction: 'LOW', limit: 1 }]),
      period,
    )).rejects.toThrow(/단축코드 000001.*여러 표준코드/);
    expect(identityReads).toHaveLength(1);
    expect(financialCoverageReads).toEqual([]);
    expect(factReads).toEqual([]);
  });

  it('DECLINE 후보 identity가 모호하면 봉·action·fact를 읽기 전에 실패한다', async () => {
    const candleReads: string[][] = [];
    const actionCoverageReads: string[][] = [];
    const factReads: string[][] = [];
    const resolver = makePipelineResolver({
      candleReads,
      actionCoverageReads,
      factReads,
      validateIdentity: () => ({
        safe: false,
        conflicts: [{
          kind: 'STANDARD_CODE_REASSIGNED',
          standardCode: 'KR7000001001',
          shortCodes: ['000001', '999999'],
        }],
      }),
    });

    await expect(resolver.resolveOrDescribeNeeds(
      pipelineRule([{
        criterion: 'DECLINE', direction: 'LOW', limit: 1, lookbackTradingDays: 3,
      }]),
      period,
    )).rejects.toThrow(/여러 단축코드.*코드 변경 전후/);
    expect(candleReads).toEqual([]);
    expect(actionCoverageReads).toEqual([]);
    expect(factReads).toEqual([]);
  });

  it('등록 shortCode가 다른 표준코드 owner이면 fact coverage보다 먼저 실패한다', async () => {
    const financialCoverageReads: string[][] = [];
    const factReads: string[][] = [];
    const resolver = makePipelineResolver({
      financialCoverageReads,
      factReads,
      identityRegistrations: [{ code: '000001', standardCode: 'KR7999999999' }],
    });

    await expect(resolver.resolveOrDescribeNeeds(
      pipelineRule([
        { criterion: 'MARKET_CAP', direction: 'HIGH', limit: 1 },
        { criterion: 'PER', direction: 'LOW', limit: 1 },
      ]),
      period,
    )).rejects.toThrow(/기존 표준코드.*선택된 종목의 표준코드.*다릅니다/);
    expect(financialCoverageReads).toEqual([]);
    expect(factReads).toEqual([]);
  });

  it('미등록 shortCode에 orphan fact가 남아 있으면 신규 등록 전에 실패한다', async () => {
    const financialCoverageReads: string[][] = [];
    const factReads: string[][] = [];
    const resolver = makePipelineResolver({
      financialCoverageReads,
      factReads,
      identityRegistrations: [],
      unregisteredFactShortCodes: ['000001'],
    });

    await expect(resolver.resolveOrDescribeNeeds(
      pipelineRule([
        { criterion: 'MARKET_CAP', direction: 'HIGH', limit: 1 },
        { criterion: 'PER', direction: 'LOW', limit: 1 },
      ]),
      period,
    )).rejects.toThrow(/미등록.*기존 단축코드 팩트.*격리·이관/);
    expect(financialCoverageReads).toEqual([]);
    expect(factReads).toEqual([]);
  });

  it('standardCode 단계에서 탈락한 ambiguous 후보는 short-keyed 검사를 과잉 차단하지 않는다', async () => {
    const identityReads: SymbolIdentitySelection[][] = [];
    const resolver = makePipelineResolver({
      identityReads,
      validateIdentity: (selections) => selections.some((selection) => selection.shortCode === '000003')
        ? {
            safe: false,
            conflicts: [{
              kind: 'SHORT_CODE_REUSED',
              shortCode: '000003',
              standardCodes: ['KR7000003003', 'KR7999999999'],
            }],
          }
        : { safe: true, conflicts: [] },
    });

    const result = await resolver.resolveOrDescribeNeeds(pipelineRule([
      { criterion: 'MARKET_CAP', direction: 'HIGH', limit: 1 },
      { criterion: 'PER', direction: 'LOW', limit: 1 },
    ]), period);

    expect(result.kind).toBe('READY');
    expect(identityReads.map((read) => read.map((selection) => selection.shortCode)))
      .toEqual([['000001'], ['000001']]);
  });

  it('short-keyed 조회 중 SCD가 바뀌면 READY 반환 직전 fresh 검증에서 차단한다', async () => {
    const identityReads: SymbolIdentitySelection[][] = [];
    let validationCount = 0;
    const resolver = makePipelineResolver({
      identityReads,
      validateIdentity: () => {
        validationCount += 1;
        return validationCount === 1
          ? { safe: true, conflicts: [] }
          : {
              safe: false,
              conflicts: [{
                kind: 'SHORT_CODE_REUSED',
                shortCode: '000001',
                standardCodes: ['KR7000001001', 'KR7999999999'],
              }],
            };
      },
    });

    await expect(resolver.resolveOrDescribeNeeds(
      pipelineRule([
        { criterion: 'MARKET_CAP', direction: 'HIGH', limit: 1 },
        { criterion: 'PER', direction: 'LOW', limit: 1 },
      ]),
      period,
    )).rejects.toThrow(/단축코드 000001.*여러 표준코드/);
    expect(identityReads).toHaveLength(2);
  });

  it('market-only 최종 일정도 strategy/engine 진입 전에 identity를 검사한다', async () => {
    const identityReads: SymbolIdentitySelection[][] = [];
    const result = await makePipelineResolver({ identityReads }).resolveOrDescribeNeeds(
      pipelineRule([{ criterion: 'MARKET_CAP', direction: 'HIGH', limit: 1 }]),
      period,
    );

    expect(result.kind).toBe('READY');
    expect(identityReads.map((read) => read.map((selection) => selection.shortCode)))
      .toEqual([['000001']]);
  });

  it('같은 lifetime pair가 여러 일정에 반복돼도 identity DB 검사는 한 번만 한다', async () => {
    const identityReads: SymbolIdentitySelection[][] = [];
    const result = await makePipelineResolver({ identityReads }).resolveOrDescribeNeeds(
      pipelineRule([{ criterion: 'MARKET_CAP', direction: 'HIGH', limit: 1 }]),
      { from: '2025-05-15', to: '2025-08-15' },
    );

    expect(result.kind).toBe('READY');
    if (result.kind !== 'READY') throw new Error('fixture는 READY여야 합니다.');
    expect(result.schedule.length).toBeGreaterThan(1);
    expect(identityReads).toHaveLength(1);
    expect(identityReads[0]?.map((selection) => selection.shortCode)).toEqual(['000001']);
  });

  it('ROE는 PIT 양수 재무 안에서 HIGH와 LOW를 반대로 고른다', async () => {
    const facts = [
      ...netIncomeFacts('000001', [10, 10, 10, 10]),
      totalEquityFact('000001', 100),
      totalEquityFact('000001', 10_000, Date.parse('2025-05-15T15:00:00.000Z')),
      ...netIncomeFacts('000002', [5, 5, 5, 5]),
      totalEquityFact('000002', 100),
      ...netIncomeFacts('000003', [5, 5, 5, 5]),
      totalEquityFact('000003', -100),
    ];

    const high = await makePipelineResolver({ facts }).resolveOrDescribeNeeds(
      pipelineRule([{ criterion: 'ROE', direction: 'HIGH', limit: 1 }]),
      period,
    );
    const low = await makePipelineResolver({ facts }).resolveOrDescribeNeeds(
      pipelineRule([{ criterion: 'ROE', direction: 'LOW', limit: 1 }]),
      period,
    );

    expect(high.kind).toBe('READY');
    expect(low.kind).toBe('READY');
    if (high.kind !== 'READY' || low.kind !== 'READY') throw new Error('재무 coverage가 완전해야 한다');
    expect(high.schedule[0]?.members.map((member) => member.symbol)).toEqual(['000001']);
    expect(low.schedule[0]?.members.map((member) => member.symbol)).toEqual(['000002']);
    expect(high.diagnostics[0]?.stages[0]).toMatchObject({
      criterion: 'ROE', direction: 'HIGH', eligibleCount: 2, excludedMissingCount: 1,
    });
  });

  it('master 날짜를 아직 수집하지 않았으면 빈 후보 Map을 실제 빈 scope로 확정하지 않는다', async () => {
    const resolver = makePipelineResolver({ masterCovered: false });

    const result = await resolver.resolveOrDescribeNeeds(
      pipelineRule([{ criterion: 'MARKET_CAP', direction: 'HIGH', limit: 1 }]),
      period,
    );

    expect(result).toMatchObject({
      kind: 'NEEDS_DATA',
      candidateScopeKnown: false,
      unionEntries: new Map(),
      needs: { selectionMetricDates: [PIPELINE_DATE] },
    });
  });

  it('stage 순서를 그대로 적용해 MARKET_CAP→PER와 PER→MARKET_CAP 결과가 달라진다', async () => {
    const resolver = makePipelineResolver();
    const capThenPer = await resolver.resolveOrDescribeNeeds(pipelineRule([
      { criterion: 'MARKET_CAP', direction: 'HIGH', limit: 2 },
      { criterion: 'PER', direction: 'LOW', limit: 1 },
    ]), period);
    const perThenCap = await resolver.resolveOrDescribeNeeds(pipelineRule([
      { criterion: 'PER', direction: 'LOW', limit: 1 },
      { criterion: 'MARKET_CAP', direction: 'HIGH', limit: 1 },
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

  it('한 날짜의 stage와 READY pin은 최초 후보 metric을 한 번만 읽어 재사용한다', async () => {
    const metricReads: string[][] = [];
    const resolver = makePipelineResolver({ metricReads });
    const result = await resolver.resolveOrDescribeNeeds(pipelineRule([
      { criterion: 'MARKET_CAP', direction: 'HIGH', limit: 2 },
      { criterion: 'PER', direction: 'LOW', limit: 1 },
    ]), period);

    expect(result.kind).toBe('READY');
    expect(metricReads).toEqual([
      ['KR7000001001', 'KR7000002002', 'KR7000003003'],
    ]);
  });

  it('여러 리밸런스 날짜의 metric ingest 상태는 전체 날짜를 한 번에 조회한다', async () => {
    const dates = ['2025-06-13', '2025-07-13', '2025-08-13'];
    const metricDateReads: string[][] = [];
    const metrics = dates.flatMap((date) => (
      pipelineMetrics.map((metric) => ({ ...metric, date }))
    ));
    const resolver = makePipelineResolver({
      metrics,
      metricDateReads,
      effectiveTradingDate: (rebalanceDate) => rebalanceDate,
    });

    const result = await resolver.resolveOrDescribeNeeds(
      pipelineRule([{ criterion: 'MARKET_CAP', direction: 'HIGH', limit: 1 }]),
      { from: dates[0]!, to: dates[2]! },
    );

    expect(result.kind).toBe('READY');
    expect(metricDateReads).toEqual([dates]);
  });

  it('여러 리밸런스 날짜의 동일 급하락 후보는 action coverage와 fact를 한 번만 읽는다', async () => {
    const day = (offset: number) => PIPELINE_TS - offset * 86_400_000;
    const candle = (symbol: string, offset: number): Candle => ({
      symbol, market: 'KR', timeframe: '1d', tsMs: day(offset),
      open: 100, high: 100, low: 100, close: 100, volume: 1,
    });
    const factReads: string[][] = [];
    const actionCoverageReads: string[][] = [];
    const resolver = makePipelineResolver({
      candles: PIPELINE_ENTRIES.flatMap((entry) => [
        candle(entry.shortCode, 2), candle(entry.shortCode, 1), candle(entry.shortCode, 0),
      ]),
      factReads,
      actionCoverageReads,
    });

    const result = await resolver.resolveOrDescribeNeeds(
      pipelineRule([{ criterion: 'DECLINE', direction: 'LOW', limit: 1, lookbackTradingDays: 3 }]),
      { from: PIPELINE_DATE, to: '2025-06-15' },
    );

    expect(result.kind).toBe('READY');
    expect(actionCoverageReads).toEqual([['000001', '000002', '000003']]);
    expect(factReads).toEqual([['000001', '000002', '000003']]);
  });

  it('PER은 effective KST date가 끝난 뒤 다음 KST 날짜에 공시된 재집계를 제외한다', async () => {
    const nextKstDateRestatement = netIncomeFacts(
      '000001',
      [1_000, 1_000, 1_000, 1_000],
      Date.parse('2025-05-15T15:00:00.000Z'),
    );
    const resolver = makePipelineResolver({
      facts: [
        ...netIncomeFacts('000001', [5, 5, 5, 5]),
        ...netIncomeFacts('000002', [-5, -5, -5, -5]),
        ...netIncomeFacts('000003', [5, 5, 5, 5]),
        ...nextKstDateRestatement,
      ],
    });

    const result = await resolver.resolveOrDescribeNeeds(
      pipelineRule([{ criterion: 'PER', direction: 'LOW', limit: 3 }]),
      period,
    );
    expect(result.kind).toBe('READY');
    if (result.kind !== 'READY') throw new Error('fixture coverage가 완전해야 합니다.');
    // 000002는 TTM 순이익이 0 이하라 제외. 다음 KST 날짜의 재집계가 보였다면
    // 000001의 PER이 15에서 0.075로 낮아져 000003보다 먼저 선정된다.
    expect(result.schedule[0]?.members.map((member) => member.symbol)).toEqual(['000003', '000001']);
    expect(result.diagnostics[0]?.stages[0]).toMatchObject({
      inputCount: 3,
      eligibleCount: 2,
      selectedCount: 2,
      excludedMissingCount: 1,
    });
  });

  it('선정 지표가 미해소면 short-keyed 후속 데이터 요구를 시장 데이터 뒤로 미룬다', async () => {
    const identityReads: SymbolIdentitySelection[][] = [];
    const factReads: string[][] = [];
    const candleReads: string[][] = [];
    const resolver = makePipelineResolver({
      missingTradingValueDates: [PIPELINE_DATE],
      financiallyCoveredSymbols: [],
      candles: [],
      actionCoverage: new Map(),
      identityReads,
      factReads,
      candleReads,
    });
    const result = await resolver.resolveOrDescribeNeeds(pipelineRule([
      { criterion: 'TRADING_VALUE', direction: 'HIGH', limit: 3 },
      { criterion: 'PER', direction: 'LOW', limit: 2 },
      { criterion: 'DECLINE', direction: 'LOW', limit: 1, lookbackTradingDays: 3 },
    ]), period);

    expect(result).toMatchObject({
      kind: 'NEEDS_DATA',
      candidateScopeKnown: true,
      needs: {
        factSymbols: [],
        actionSymbols: [],
        selectionMetricDates: [PIPELINE_DATE],
      },
    });
    if (result.kind !== 'NEEDS_DATA') throw new Error('fixture는 데이터 부족이어야 합니다.');
    expect([...result.unionEntries.keys()]).toEqual(['000001', '000002', '000003']);
    expect(result.needs.priceRange).toBeNull();
    expect(identityReads).toEqual([]);
    expect(factReads).toEqual([]);
    expect(candleReads).toEqual([]);
  });

  it('첫 unresolved stage의 후보 상한을 후속 ready stage의 non-empty 선택으로 좁히지 않는다', async () => {
    const resolver = makePipelineResolver({ missingTradingValueDates: [PIPELINE_DATE] });

    const result = await resolver.resolveOrDescribeNeeds(pipelineRule([
      { criterion: 'TRADING_VALUE', direction: 'HIGH', limit: 1 },
      { criterion: 'MARKET_CAP', direction: 'HIGH', limit: 1 },
    ]), period);

    expect(result.kind).toBe('NEEDS_DATA');
    if (result.kind !== 'NEEDS_DATA') throw new Error('fixture의 첫 stage는 unresolved여야 합니다.');
    expect([...result.unionEntries.keys()]).toEqual(['000001', '000002', '000003']);
    expect(result.needs.selectionMetricDates).toEqual([PIPELINE_DATE]);
  });

  it('ingest 안 된 날짜의 VOLUME 결측은 제외 대신 metric 수집을 요구한다', async () => {
    // 수집할 수 있는 결측은 eligible 0 실패가 아니라 NEEDS_DATA 로 돌려준다.
    const resolver = makePipelineResolver({
      metrics: pipelineMetrics.map((row) => ({ ...row, volume: null, tradingValueKrw: null })),
      missingTradingValueDates: [PIPELINE_DATE],
    });

    const result = await resolver.resolveOrDescribeNeeds(
      pipelineRule([{ criterion: 'VOLUME', direction: 'HIGH', limit: 2 }]),
      period,
    );

    expect(result).toMatchObject({ kind: 'NEEDS_DATA' });
    if (result.kind !== 'NEEDS_DATA') throw new Error('NEEDS_DATA 여야 한다');
    expect(result.needs.selectionMetricDates).toEqual([PIPELINE_DATE]);
  });

  it('ingest 된 날짜의 VOLUME null 은 구조적 결측으로 확정해 제외한다', async () => {
    const metrics = pipelineMetrics.map((row, index) => (
      index === 2 ? { ...row, volume: null } : row
    ));
    const resolver = makePipelineResolver({ metrics, missingTradingValueDates: [] });

    const result = await resolver.resolveOrDescribeNeeds(
      pipelineRule([{ criterion: 'VOLUME', direction: 'HIGH', limit: 3 }]),
      period,
    );

    expect(result).toMatchObject({ kind: 'READY' });
    if (result.kind !== 'READY') throw new Error('READY 여야 한다');
    expect(result.diagnostics[0]?.stages[0]).toMatchObject({
      inputCount: 3,
      eligibleCount: 2,
      excludedMissingCount: 1,
    });
  });

  it.each(['MARKET_CAP', 'VOLUME', 'TRADING_VALUE', 'PER'] as const)(
    'ingest 완료 날짜의 %s 후보 행 누락은 그 종목을 제외하고 남은 후보를 랭킹한다',
    async (criterion) => {
      const resolver = makePipelineResolver({
        metrics: pipelineMetrics.slice(0, 2),
        missingTradingValueDates: [],
      });

      const result = await resolver.resolveOrDescribeNeeds(
        pipelineRule([{ criterion, direction: 'HIGH', limit: 3 }]),
        period,
      );

      expect(result.kind).toBe('READY');
      if (result.kind !== 'READY') throw new Error('READY 여야 한다');
      expect(result.schedule[0]?.members.some((member) => member.symbol === '000003')).toBe(false);
      expect(result.dataExclusions).toContainEqual(expect.objectContaining({
        symbol: '000003',
        periodKey: PIPELINE_DATE,
        category: 'KRX_SELECTION_METRIC',
      }));
    },
  );

  it('PER 선정 지표 날짜가 아직 미수집이면 실패하지 않고 metric 수집을 요구한다', async () => {
    const resolver = makePipelineResolver({
      metrics: [],
      missingTradingValueDates: [PIPELINE_DATE],
    });

    const result = await resolver.resolveOrDescribeNeeds(
      pipelineRule([{ criterion: 'PER', direction: 'LOW', limit: 2 }]),
      period,
    );

    expect(result).toMatchObject({
      kind: 'NEEDS_DATA',
      needs: { selectionMetricDates: [PIPELINE_DATE] },
    });
  });

  it('자본변동 fact만 있어도 재무 coverage가 없으면 NEEDS_DATA로 요구한다', async () => {
    // 단순 fact 존재로 판정하던 회귀: 재무 coverage가 없는 000003도 재무 있음으로
    // 오인돼 PER 결측에서 빠졌다. coverage를 일부러 두 종목에만 준다.
    const resolver = makePipelineResolver({
      financialCoverage: new Map([
        ['000001', [2024, 2025]],
        ['000002', [2024, 2025]],
      ]),
    });

    const result = await resolver.resolveOrDescribeNeeds(
      pipelineRule([{ criterion: 'PER', direction: 'LOW', limit: 2 }]),
      period,
    );

    expect(result).toMatchObject({ kind: 'NEEDS_DATA' });
    if (result.kind !== 'NEEDS_DATA') throw new Error('NEEDS_DATA 여야 한다');
    expect(result.needs.factSymbols).toEqual(['000003']);
  });

  it('재무 coverage 가 필요 연도 일부만 덮으면 결측으로 본다', async () => {
    // 2025-05-15 효력일의 TTM 은 공시 지연 때문에 2024 사업연도까지 필요하다.
    const resolver = makePipelineResolver({
      financialCoverage: new Map([
        ['000001', [2024, 2025]],
        ['000002', [2024, 2025]],
        ['000003', [2025]],
      ]),
    });

    const result = await resolver.resolveOrDescribeNeeds(
      pipelineRule([{ criterion: 'PER', direction: 'LOW', limit: 2 }]),
      period,
    );

    expect(result).toMatchObject({ kind: 'NEEDS_DATA' });
    if (result.kind !== 'NEEDS_DATA') throw new Error('NEEDS_DATA 여야 한다');
    expect(result.needs.factSymbols).toEqual(['000003']);
  });

  it('후속 ready stage가 완전한 후보 상한의 eligible 0을 증명하면 이전 needs를 버린다', async () => {
    const resolver = makePipelineResolver({
      financiallyCoveredSymbols: [],
      metrics: pipelineMetrics.map((row) => ({ ...row, marketCapKrw: null })),
    });

    const result = await resolver.resolveOrDescribeNeeds(pipelineRule([
      { criterion: 'PER', direction: 'LOW', limit: 1 },
      { criterion: 'MARKET_CAP', direction: 'HIGH', limit: 1 },
    ]), period);

    expect(result.kind).toBe('READY');
    if (result.kind !== 'READY') throw new Error('완전한 empty 증명은 stale needs를 남기면 안 됩니다.');
    expect(result.schedule[0]?.members).toEqual([]);
    expect([...result.unionEntries.keys()]).toEqual([]);
  });

  it('한 날짜의 empty 증명이 다른 날짜의 non-empty 후보 needs를 지우지 않는다', async () => {
    const secondDate = '2025-06-15';
    const metrics = [PIPELINE_DATE, secondDate].flatMap((date) => PIPELINE_ENTRIES.map((entry, index) => ({
      date,
      standardCode: entry.standardCode,
      marketCapKrw: date === secondDate ? null : [300n, 200n, 100n][index]!,
      volume: null,
      tradingValueKrw: null,
    })));
    const resolver = makePipelineResolver({
      financiallyCoveredSymbols: [],
      metrics,
      effectiveTradingDate: (date) => date,
    });

    const result = await resolver.resolveOrDescribeNeeds(
      pipelineRule([
        { criterion: 'PER', direction: 'LOW', limit: 1 },
        { criterion: 'MARKET_CAP', direction: 'HIGH', limit: 1 },
      ]),
      { from: PIPELINE_DATE, to: secondDate },
    );

    expect(result.kind).toBe('NEEDS_DATA');
    if (result.kind !== 'NEEDS_DATA') throw new Error('첫 날짜의 needs는 남아야 합니다.');
    expect(result.needs.factSymbols).toEqual(['000001', '000002', '000003']);
    expect([...result.unionEntries.keys()]).toEqual(['000001', '000002', '000003']);
  });

  it('급하락은 effective date 포함 N개 봉의 분할보정 수익률을 오름차순으로 고른다', async () => {
    const day = (offset: number) => PIPELINE_TS - offset * 86_400_000;
    const candle = (symbol: string, offset: number, close: number): Candle => ({
      symbol, market: 'KR', timeframe: '1d', tsMs: day(offset),
      open: close, high: close, low: close, close, volume: 1,
    });
    const factQueries: FactQuery[] = [];
    const candleReads: string[][] = [];
    const bulkCandleReads: string[][] = [];
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
      factQueries,
      candleReads,
      bulkCandleReads,
    });

    const result = await resolver.resolveOrDescribeNeeds(
      pipelineRule([{ criterion: 'DECLINE', direction: 'LOW', limit: 1, lookbackTradingDays: 3 }]),
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
    expect(factQueries).toContainEqual({
      scope: 'SYMBOL', keys: ['000001', '000002', '000003'], fields: ['SPLIT_RATIO'],
    });
    expect(bulkCandleReads).toEqual([['000001', '000002', '000003']]);
    expect(candleReads).toEqual([]);
  });

  it('급하락은 종가 전용 bulk port를 전체 캔들 bulk보다 우선 사용한다', async () => {
    const day = (offset: number) => PIPELINE_TS - offset * 86_400_000;
    const candles = PIPELINE_ENTRIES.flatMap((entry) => [2, 1, 0].map((offset): Candle => ({
      symbol: entry.shortCode,
      market: 'KR',
      timeframe: '1d',
      tsMs: day(offset),
      open: 100,
      high: 100,
      low: 100,
      close: 100,
      volume: 1,
    })));
    const closePriceReads: string[][] = [];
    const bulkCandleReads: string[][] = [];
    const candleReads: string[][] = [];
    const resolver = makePipelineResolver({
      candles,
      closePriceReads,
      bulkCandleReads,
      candleReads,
    });

    const result = await resolver.resolveOrDescribeNeeds(
      pipelineRule([{ criterion: 'DECLINE', direction: 'LOW', limit: 1, lookbackTradingDays: 3 }]),
      period,
    );

    expect(result.kind).toBe('READY');
    expect(closePriceReads).toEqual([['000001', '000002', '000003']]);
    expect(bulkCandleReads).toEqual([]);
    expect(candleReads).toEqual([]);
  });

  it('좁은 범위에서 N봉이 부족한 종목만 보수 범위로 확장 조회한다', async () => {
    const candle = (symbol: string, date: string, close: number): Candle => ({
      symbol,
      market: 'KR',
      timeframe: '1d',
      tsMs: Date.parse(`${date}T00:00:00Z`),
      open: close,
      high: close,
      low: close,
      close,
      volume: 1,
    });
    const bulkCandleReads: string[][] = [];
    const resolver = makePipelineResolver({
      candles: [
        candle('000001', '2025-05-13', 100),
        candle('000001', '2025-05-14', 100),
        candle('000001', '2025-05-15', 100),
        // 04-26은 N+14일 빠른 범위 밖, 2N+14일 보수 범위 안이다.
        candle('000002', '2025-04-26', 100),
        candle('000002', '2025-05-14', 90),
        candle('000002', '2025-05-15', 80),
        candle('000003', '2025-05-13', 100),
        candle('000003', '2025-05-14', 100),
        candle('000003', '2025-05-15', 100),
      ],
      bulkCandleReads,
    });

    const result = await resolver.resolveOrDescribeNeeds(
      pipelineRule([{
        criterion: 'DECLINE', direction: 'LOW', limit: 1, lookbackTradingDays: 3,
      }]),
      period,
    );

    expect(result.kind).toBe('READY');
    expect(bulkCandleReads).toEqual([
      ['000001', '000002', '000003'],
      ['000002'],
    ]);
  });

  it('급하락 순위도 DART 기준일이 아니라 KRX 실제 변경일로 분할보정한다', async () => {
    const day = (offset: number) => PIPELINE_TS - offset * 86_400_000;
    const candle = (symbol: string, offset: number, close: number): Candle => ({
      symbol, market: 'KR', timeframe: '1d', tsMs: day(offset),
      open: close, high: close, low: close, close, volume: 1,
    });
    const split: Fact = {
      scope: 'SYMBOL', key: '000001', field: 'SPLIT_RATIO', periodKey: '2025-05-13',
      asOfTsMs: PIPELINE_TS + 365 * 86_400_000, value: 5, unit: 'ratio',
    };
    const resolver = makePipelineResolver({
      candles: [
        candle('000001', 2, 50_000), candle('000001', 1, 50_000), candle('000001', 0, 10_000),
        candle('000002', 2, 100), candle('000002', 1, 90), candle('000002', 0, 80),
        candle('000003', 2, 100), candle('000003', 1, 100), candle('000003', 0, 100),
      ],
      facts: [split],
      sharesChanges: [{ shortCode: '000001', effectiveDate: '2025-05-15', ratio: 5 }],
    });

    const result = await resolver.resolveOrDescribeNeeds(
      pipelineRule([{ criterion: 'DECLINE', direction: 'LOW', limit: 1, lookbackTradingDays: 3 }]),
      period,
    );

    expect(result.kind).toBe('READY');
    if (result.kind !== 'READY') throw new Error('fixture coverage가 완전해야 합니다.');
    // raw 기준일(첫 봉)에 적용하면 000001이 -80%로 잘못 뽑힌다. 실제 변경일(마지막
    // 봉)로 옮기면 분할보정 수익률은 0%라 진짜 -20%인 000002가 선정된다.
    expect(result.schedule[0]?.members.map((member) => member.symbol)).toEqual(['000002']);
  });

  it('급하락은 현재 lookback 밖 자본변동까지 포함한 worker와 같은 전체 매칭 그래프를 쓴다', async () => {
    const candle = (symbol: string, date: string, close: number): Candle => ({
      symbol, market: 'KR', timeframe: '1d', tsMs: Date.parse(`${date}T00:00:00Z`),
      open: close, high: close, low: close, close, volume: 1,
    });
    const action = (periodKey: string): Fact => ({
      scope: 'SYMBOL', key: '000001', field: 'SPLIT_RATIO', periodKey,
      asOfTsMs: PIPELINE_TS + 365 * 86_400_000, value: 2, unit: 'ratio',
    });
    const resolver = makePipelineResolver({
      candles: [
        candle('000001', '2025-05-05', 100),
        candle('000001', '2025-05-10', 100),
        candle('000001', '2025-05-15', 100),
        candle('000002', '2025-05-05', 100),
        candle('000002', '2025-05-10', 105),
        candle('000002', '2025-05-15', 110),
        candle('000003', '2025-05-05', 100),
        candle('000003', '2025-05-10', 110),
        candle('000003', '2025-05-15', 120),
      ],
      // 06-16 공시는 현재 lookback의 raw 관련 상한(05-15 + 30일 = 06-14) 밖이다.
      // 그래도 worker는 종목의 전체 공시를 읽으므로 resolver도 이를 매칭 그래프에서
      // 빼면 안 된다. 06-16은 05-17만 쓸 수 있고(정확히 -30일), 최대 매칭은
      // 05-14 공시를 05-06으로 보내야 두 사건을 모두 정렬한다.
      facts: [action('2025-05-14'), action('2025-06-16')],
      sharesChanges: [
        { shortCode: '000001', effectiveDate: '2025-05-06', ratio: 2 },
        { shortCode: '000001', effectiveDate: '2025-05-17', ratio: 2 },
      ],
    });

    const result = await resolver.resolveOrDescribeNeeds(
      pipelineRule([{ criterion: 'DECLINE', direction: 'LOW', limit: 1, lookbackTradingDays: 3 }]),
      period,
    );

    expect(result.kind).toBe('READY');
    if (result.kind !== 'READY') throw new Error('fixture coverage가 완전해야 합니다.');
    // 전체 그래프: 000001은 05-06 분할을 반영해 +100%, 따라서 +10%인 000002가 LOW다.
    // 관련 공시만 잘라 매칭하면 05-14가 더 가까운 05-17로 가서 000001이 0%로 잘못 뽑힌다.
    expect(result.schedule[0]?.members.map((member) => member.symbol)).toEqual(['000002']);
  });

  it('자본변동 실제 변경일을 확인할 수 없는 종목은 제외하고 차순위를 고른다', async () => {
    const candle = (symbol: string, offset: number, close: number): Candle => ({
      symbol, market: 'KR', timeframe: '1d', tsMs: PIPELINE_TS - offset * 86_400_000,
      open: close, high: close, low: close, close, volume: 1,
    });
    const resolver = makePipelineResolver({
      candles: PIPELINE_ENTRIES.flatMap((entry) => [
        candle(entry.shortCode, 2, 100),
        candle(entry.shortCode, 1, 90),
        candle(entry.shortCode, 0, 80),
      ]),
      facts: [{
        scope: 'SYMBOL', key: '000001', field: 'SPLIT_RATIO', periodKey: '2025-05-13',
        asOfTsMs: PIPELINE_TS + 365 * 86_400_000, value: 5, unit: 'ratio',
      }],
      sharesChanges: [],
    });

    for (const direction of ['LOW', 'HIGH'] as const) {
      const result = await resolver.resolveOrDescribeNeeds(
        pipelineRule([{ criterion: 'DECLINE', direction, limit: 1, lookbackTradingDays: 3 }]),
        period,
      );
      expect(result.kind).toBe('READY');
      if (result.kind !== 'READY') throw new Error('fixture coverage가 완전해야 합니다.');
      expect(result.schedule[0]?.members.map((member) => member.symbol)).toEqual(['000002']);
      expect(result.corporateActionExclusions).toEqual([expect.objectContaining({
        symbol: '000001',
        year: 2025,
        periodKey: '2025-05-13',
        reason: 'KRX 상장주식수 변경일과 정렬할 수 없는 자본변동',
      })]);
    }
  });

  it('급하락은 effective KST date 다음 날의 자본변동을 분할보정에서 제외한다', async () => {
    const candle = (symbol: string, tsMs: number, close: number): Candle => ({
      symbol, market: 'KR', timeframe: '1d', tsMs,
      open: close, high: close, low: close, close, volume: 1,
    });
    const tiny = Number.MIN_VALUE;
    const resolver = makePipelineResolver({
      candles: [
        candle('000001', PIPELINE_TS - 86_400_000, tiny),
        candle('000001', PIPELINE_TS, tiny * 2),
        candle('000002', PIPELINE_TS - 86_400_000, 1),
        candle('000002', PIPELINE_TS, 3),
        candle('000003', PIPELINE_TS - 86_400_000, 1),
        candle('000003', PIPELINE_TS, 4),
      ],
      facts: [{
        scope: 'SYMBOL', key: '000001', field: 'SPLIT_RATIO', periodKey: '2025-05-16',
        asOfTsMs: PIPELINE_TS, value: 2, unit: 'ratio',
      }],
    });

    const result = await resolver.resolveOrDescribeNeeds(
      pipelineRule([{ criterion: 'DECLINE', direction: 'LOW', limit: 1, lookbackTradingDays: 2 }]),
      period,
    );

    expect(result.kind).toBe('READY');
    if (result.kind !== 'READY') throw new Error('fixture coverage가 완전해야 합니다.');
    // 다음 KST 날짜의 2:1 분할을 잘못 포함하면 tiny / 2가 0으로 underflow되어
    // 000001이 결측으로 제외된다. 올바른 컷오프에서는 원수익률 +100%로 가장 낮다.
    expect(result.schedule[0]?.members.map((member) => member.symbol)).toEqual(['000001']);
    expect(result.diagnostics[0]?.stages[0]).toMatchObject({
      eligibleCount: 3,
      excludedMissingCount: 0,
    });
  });

  it('급하락 자본변동 coverage는 실제 N개 봉에 정렬될 수 있는 인접 연도까지 요구한다', async () => {
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
    const missing = await makePipelineResolver({ candles }).resolveOrDescribeNeeds(
      pipelineRule([{ criterion: 'DECLINE', direction: 'LOW', limit: 1, lookbackTradingDays: 100 }]),
      period,
    );
    expect(missing.kind).toBe('NEEDS_DATA');
    if (missing.kind !== 'NEEDS_DATA') throw new Error('인접 2024 coverage가 부족해야 합니다.');
    expect(missing.needs.actionSymbols).toEqual(['000001', '000002', '000003']);

    const actionCoverage = new Map(
      PIPELINE_ENTRIES.map((entry) => [entry.shortCode, [2024, 2025] as const]),
    );
    const ready = await makePipelineResolver({ candles, actionCoverage }).resolveOrDescribeNeeds(
      pipelineRule([{ criterion: 'DECLINE', direction: 'LOW', limit: 1, lookbackTradingDays: 100 }]),
      period,
    );
    expect(ready.kind).toBe('READY');
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
      pipelineRule([{ criterion: 'DECLINE', direction: 'LOW', limit: 1, lookbackTradingDays: 3 }]),
      period,
    );
    expect(result.kind).toBe('NEEDS_DATA');
    if (result.kind !== 'NEEDS_DATA') throw new Error('fixture는 데이터 부족이어야 합니다.');
    expect(result.needs.actionSymbols).toEqual(['000002', '000003']);
    expect(result.needs.priceRange).not.toBeNull();
    expect('schedule' in result).toBe(false);
  });

  it('급하락 가격만 부족하면 자본변동과 무관하게 stage 진입 후보를 가격 대상으로 남긴다', async () => {
    const complete = (offset: number): Candle => ({
      symbol: '000001', market: 'KR', timeframe: '1d', tsMs: PIPELINE_TS - offset * 86_400_000,
      open: 100, high: 100, low: 100, close: 100, volume: 1,
    });
    const resolver = makePipelineResolver({
      // 000001만 3개 봉을 채웠다. 부족한 000002/000003만 가격 수집 대상이어야 한다.
      candles: [complete(2), complete(1), complete(0)],
      // 기본 actionCoverage는 세 후보의 2025년을 모두 덮는다. 가격 후보가
      // actionSymbols에 기대면 이 상태에서 수집 대상을 잃는다.
    });

    const result = await resolver.resolveOrDescribeNeeds(
      pipelineRule([{ criterion: 'DECLINE', direction: 'LOW', limit: 1, lookbackTradingDays: 3 }]),
      period,
    );

    expect(result.kind).toBe('NEEDS_DATA');
    if (result.kind !== 'NEEDS_DATA') throw new Error('fixture는 가격 warm-up 부족이어야 합니다.');
    expect(result.needs.actionSymbols).toEqual([]);
    expect(result.needs.priceSymbols).toEqual(['000002', '000003']);
    expect(result.needs.priceRange).not.toBeNull();
  });

  it('급등락 후보에 covered+gap 연도가 있으면 해당 종목을 제외하고 차순위를 채운다', async () => {
    const candle = (symbol: string, offset: number, close: number): Candle => ({
      symbol, market: 'KR', timeframe: '1d', tsMs: PIPELINE_TS - offset * 86_400_000,
      open: close, high: close, low: close, close, volume: 1,
    });
    const resolver = makePipelineResolver({
      candles: PIPELINE_ENTRIES.flatMap((entry) => [
        candle(entry.shortCode, 2, 100),
        candle(entry.shortCode, 1, 90),
        candle(entry.shortCode, 0, 80),
      ]),
      // 세 후보 모두 2025 covered. 000002 만 2025 에 gap — 시도했지만 비율 미상.
      actionGaps: new Map([['000002', [2025]]]),
      sharesChanges: [
        { shortCode: '000002', effectiveDate: '2025-05-14', ratio: 2 },
      ],
    });

    for (const direction of ['LOW', 'HIGH'] as const) {
      const result = await resolver.resolveOrDescribeNeeds(
        pipelineRule([{ criterion: 'DECLINE', direction, limit: 3, lookbackTradingDays: 3 }]),
        period,
      );
      expect(result.kind).toBe('READY');
      if (result.kind !== 'READY') throw new Error('fixture coverage가 완전해야 합니다.');
      expect(result.schedule[0]?.members.map((member) => member.symbol))
        .toEqual(['000001', '000003']);
      expect(result.corporateActionExclusions).toEqual([
        expect.objectContaining({ symbol: '000002', year: 2025, severity: 'BLOCKING' }),
      ]);
    }
  });

  it('앞 stage 후보가 아직 미확정이면 자본변동 gap보다 해소 가능한 needs를 먼저 반환한다', async () => {
    const candle = (symbol: string, offset: number): Candle => ({
      symbol, market: 'KR', timeframe: '1d', tsMs: PIPELINE_TS - offset * 86_400_000,
      open: 100, high: 100, low: 100, close: 100, volume: 1,
    });
    const resolver = makePipelineResolver({
      financiallyCoveredSymbols: [],
      candles: PIPELINE_ENTRIES.flatMap((entry) => [
        candle(entry.shortCode, 2),
        candle(entry.shortCode, 1),
        candle(entry.shortCode, 0),
      ]),
      actionGaps: new Map([['000002', [2025]]]),
    });

    const result = await resolver.resolveOrDescribeNeeds(
      pipelineRule([
        { criterion: 'PER', direction: 'LOW', limit: 1 },
        { criterion: 'DECLINE', direction: 'LOW', limit: 1, lookbackTradingDays: 3 },
      ]),
      period,
    );

    expect(result.kind).toBe('NEEDS_DATA');
    if (result.kind !== 'NEEDS_DATA') throw new Error('앞 PER stage 데이터가 부족해야 합니다.');
    expect(result.needs.factSymbols).toEqual(['000001', '000002', '000003']);
  });

  it('급하락 gap 연도가 lookback 윈도우 밖이면 후보를 제외하지 않는다', async () => {
    const candle = (symbol: string, offset: number, close: number): Candle => ({
      symbol, market: 'KR', timeframe: '1d', tsMs: PIPELINE_TS - offset * 86_400_000,
      open: close, high: close, low: close, close, volume: 1,
    });
    const resolver = makePipelineResolver({
      candles: PIPELINE_ENTRIES.flatMap((entry) => [
        candle(entry.shortCode, 2, 100),
        candle(entry.shortCode, 1, 90),
        candle(entry.shortCode, 0, 80),
      ]),
      // 윈도우(2025)에 걸리지 않는 옛 gap — 누적 응답 노이즈로 남은 기록일 수 있다.
      actionGaps: new Map([['000002', [2017]]]),
    });

    const result = await resolver.resolveOrDescribeNeeds(
      pipelineRule([{ criterion: 'DECLINE', direction: 'LOW', limit: 3, lookbackTradingDays: 3 }]),
      period,
    );

    expect(result.kind).toBe('READY');
    if (result.kind !== 'READY') throw new Error('윈도우 밖 gap 은 영향이 없어야 합니다.');
    expect(result.schedule[0]?.members.map((member) => member.symbol))
      .toEqual(['000001', '000002', '000003']);
  });

  it('급하락 보수 범위를 아직 모두 조회하지 않았으면 부족한 봉을 계속 가격 대상으로 남긴다', async () => {
    const resolver = makePipelineResolver({ priceRangeCovered: false });

    const result = await resolver.resolveOrDescribeNeeds(
      pipelineRule([{ criterion: 'DECLINE', direction: 'LOW', limit: 1, lookbackTradingDays: 3 }]),
      period,
    );

    expect(result.kind).toBe('NEEDS_DATA');
    if (result.kind !== 'NEEDS_DATA') throw new Error('불완전 coverage는 가격 수집이 필요해야 합니다.');
    expect(result.needs.priceSymbols).toEqual(['000001', '000002', '000003']);
  });

  it('급하락 보수 범위를 모두 조회했는데 N봉 미만이면 결측 후보로 진단하고 재요청하지 않는다', async () => {
    const complete = (offset: number): Candle => ({
      symbol: '000001', market: 'KR', timeframe: '1d', tsMs: PIPELINE_TS - offset * 86_400_000,
      open: 100, high: 100, low: 100, close: 100, volume: 1,
    });
    const resolver = makePipelineResolver({
      candles: [complete(2), complete(1), complete(0)],
      priceRangeCovered: true,
    });

    const result = await resolver.resolveOrDescribeNeeds(
      pipelineRule([{ criterion: 'DECLINE', direction: 'LOW', limit: 3, lookbackTradingDays: 3 }]),
      period,
    );

    expect(result.kind).toBe('READY');
    if (result.kind !== 'READY') throw new Error('완전 시도된 짧은 이력은 terminal READY여야 합니다.');
    expect(result.schedule[0]?.members.map((member) => member.symbol)).toEqual(['000001']);
    expect(result.diagnostics[0]?.stages[0]).toMatchObject({
      inputCount: 3,
      eligibleCount: 1,
      selectedCount: 1,
      excludedMissingCount: 2,
    });
  });
});
