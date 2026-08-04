import { describe, expect, it } from 'vitest';
import {
  HistoricalUniverseService,
  SortValueUnavailableError,
} from '../../src/server/modules/market-data/application/historical-universe-service.js';
import {
  KrxApprovalExpiredError,
  KrxContractError,
  KrxNotConfiguredError,
  type FundamentalSortValueSource,
  type KrxHistoricalUniverseSource,
} from '../../src/server/modules/market-data/application/ports.js';
import type {
  KrxDailyTradeRow,
  KrxIssueBaseInfoRow,
  KrxMarket,
} from '../../src/server/modules/market-data/domain/krx-universe-types.js';
import { kstEndOfDayMs } from '../../src/server/modules/market-data/domain/kst-date.js';
import type { Clock } from '../../src/server/shared/clock.js';
import type { Logger } from '../../src/server/shared/logger.js';

const LOGGER = { debug() {}, info() {}, warn() {}, error() {} } as unknown as Logger;

function mutableClock(isoInstant = '2026-08-03T00:00:00.000Z'): Clock & { advance(ms: number): void } {
  let now = Date.parse(isoInstant);
  return { now: () => now, advance: (ms) => { now += ms; } };
}

function baseRow(shortCode: string, market: KrxMarket): KrxIssueBaseInfoRow {
  return {
    standardCode: `KR${shortCode}`,
    shortCode,
    name: `종목-${shortCode}`,
    listedDate: '2020-01-02',
    marketRaw: market === 'KOSPI' ? '유가증권시장' : '코스닥시장',
    securityGroupRaw: '주권',
    sectionRaw: null,
    stockKindRaw: '보통주',
  };
}

function dailyRow(shortCode: string): KrxDailyTradeRow {
  return { shortCode, name: `종목-${shortCode}`, marketCapRaw: '1000' };
}

class FakeSource implements KrxHistoricalUniverseSource {
  readonly calls: Array<{ kind: 'base' | 'daily'; market: KrxMarket; date: string }> = [];
  readonly base = new Map<string, readonly KrxIssueBaseInfoRow[]>();
  readonly daily = new Map<string, readonly KrxDailyTradeRow[]>();
  failDailyKey: string | null = null;
  dailyGate: Promise<void> | null = null;

  seed(date: string): void {
    this.base.set(`KOSPI:${date}`, [baseRow('005930', 'KOSPI')]);
    this.base.set(`KOSDAQ:${date}`, [baseRow('035720', 'KOSDAQ')]);
    this.daily.set(`KOSPI:${date}`, [dailyRow('005930')]);
    this.daily.set(`KOSDAQ:${date}`, [dailyRow('035720')]);
  }

  async fetchIssueBaseInfo(market: KrxMarket, isoDate: string) {
    this.calls.push({ kind: 'base', market, date: isoDate });
    return this.base.get(`${market}:${isoDate}`) ?? [];
  }

  async fetchDailyTrades(market: KrxMarket, isoDate: string) {
    this.calls.push({ kind: 'daily', market, date: isoDate });
    if (this.dailyGate) await this.dailyGate;
    const key = `${market}:${isoDate}`;
    if (this.failDailyKey === key) throw new Error('temporary source failure');
    return this.daily.get(key) ?? [];
  }

  todayCallCount(): number { return this.calls.length; }
}

class FakeSortValueSource implements FundamentalSortValueSource {
  readonly calls: Array<{ shortCodes: readonly string[]; asOfMaxTsMs: number }> = [];
  shouldFail = false;

  constructor(private readonly values: ReadonlyMap<string, number> = new Map()) {}

  async ttmOperatingIncomeAsOf(
    shortCodes: readonly string[],
    asOfMaxTsMs: number,
  ): Promise<ReadonlyMap<string, number>> {
    this.calls.push({ shortCodes, asOfMaxTsMs });
    if (this.shouldFail) throw new Error('fact repository unavailable');
    return this.values;
  }
}

function service(options: {
  source?: FakeSource;
  clock?: Clock;
  configured?: boolean;
  approvalExpiry?: string | null;
  previewTtlMs?: number;
  sortValueSource?: FundamentalSortValueSource | null;
} = {}) {
  const source = options.source ?? new FakeSource();
  const clock = options.clock ?? mutableClock();
  return {
    source,
    clock,
    service: new HistoricalUniverseService({
      source,
      configured: options.configured ?? true,
      approvalExpiry: options.approvalExpiry ?? '2027-01-01',
      sortValueSource: options.sortValueSource ?? null,
      clock,
      logger: LOGGER,
      previewTtlMs: options.previewTtlMs,
    }),
  };
}

describe('HistoricalUniverseService', () => {
  it('키 미설정이면 available=false와 발급·승인 안내 이유를 준다', async () => {
    const { service: subject } = service({ configured: false });

    expect(subject.availability()).toEqual({
      available: false,
      reason: expect.stringMatching(/키.*승인/),
    });
    await expect(subject.preview('2025-01-02', 'MKTCAP')).rejects.toBeInstanceOf(KrxNotConfiguredError);
  });

  it('승인 만료면 available=false이고 이유에 만료일을 표시한다', async () => {
    const { service: subject } = service({ approvalExpiry: '2026-08-02' });

    expect(subject.availability()).toEqual({ available: false, reason: expect.stringContaining('2026-08-02') });
    await expect(subject.preview('2025-01-02', 'MKTCAP')).rejects.toBeInstanceOf(KrxApprovalExpiredError);
  });

  it('2010-01-04 이전 요청은 BEFORE_EPOCH로 차단한다', async () => {
    const { service: subject } = service();

    await expect(subject.preview('2010-01-03', 'MKTCAP')).rejects.toMatchObject({
      code: 'BEFORE_EPOCH',
    });
  });

  it('KST 어제보다 뒤는 FUTURE_OR_UNPUBLISHED로 차단한다', async () => {
    const { service: subject } = service();

    await expect(subject.preview('2026-08-03', 'MKTCAP')).rejects.toMatchObject({
      code: 'FUTURE_OR_UNPUBLISHED',
    });
  });

  it('KST 08시 전에는 어제 데이터도 공개 대기로 차단한다', async () => {
    const { service: subject } = service({ clock: mutableClock('2026-08-02T22:00:00.000Z') });

    await expect(subject.preview('2026-08-02', 'MKTCAP')).rejects.toMatchObject({
      code: 'FUTURE_OR_UNPUBLISHED',
    });
  });

  it('휴장일 요청은 이전 거래일로 해소하고 요청일과 적용일을 모두 반환한다', async () => {
    const source = new FakeSource();
    source.seed('2024-12-30');
    const { service: subject } = service({ source });

    const result = await subject.preview('2025-01-01', 'MKTCAP');

    expect(result.requestedDate).toBe('2025-01-01');
    expect(result.effectiveTradingDate).toBe('2024-12-30');
    expect(source.calls.filter(({ kind, market }) => kind === 'daily' && market === 'KOSPI').map(({ date }) => date))
      .toEqual(['2025-01-01', '2024-12-31', '2024-12-30']);
  });

  it('31일 안에 거래일이 없으면 NO_TRADING_DAY_IN_RANGE다', async () => {
    const { service: subject, source } = service();

    await expect(subject.preview('2025-01-31', 'MKTCAP')).rejects.toMatchObject({
      code: 'NO_TRADING_DAY_IN_RANGE',
    });
    expect(source.calls.filter(({ kind, market }) => kind === 'daily' && market === 'KOSPI')).toHaveLength(31);
  });

  it('epoch 당일 탐색은 공식 범위 밖인 2009년 날짜를 호출하지 않는다', async () => {
    const { service: subject, source } = service();

    await expect(subject.preview('2010-01-04', 'MKTCAP')).rejects.toMatchObject({
      code: 'NO_TRADING_DAY_IN_RANGE',
    });
    expect(source.calls.filter(({ kind, market }) => kind === 'daily' && market === 'KOSPI'))
      .toEqual([{ kind: 'daily', market: 'KOSPI', date: '2010-01-04' }]);
  });

  it('KOSPI 성공·KOSDAQ 빈 응답이면 부분 후보군을 만들지 않고 KrxContractError(502 매핑)를 던진다', async () => {
    const source = new FakeSource();
    source.seed('2025-01-02');
    source.daily.set('KOSDAQ:2025-01-02', []);
    const { service: subject } = service({ source });

    await expect(subject.preview('2025-01-02', 'MKTCAP')).rejects.toThrow(/KOSDAQ/);
    await expect(subject.preview('2025-01-02', 'MKTCAP')).rejects.toBeInstanceOf(KrxContractError);
    expect(source.calls.some(({ kind }) => kind === 'base')).toBe(false);
  });

  it('한 시장 호출 실패는 전체 실패고 오류는 캐시되지 않는다', async () => {
    const source = new FakeSource();
    source.seed('2025-01-02');
    source.failDailyKey = 'KOSDAQ:2025-01-02';
    const { service: subject } = service({ source });

    await expect(subject.preview('2025-01-02', 'MKTCAP')).rejects.toThrow('temporary source failure');
    source.failDailyKey = null;
    await expect(subject.preview('2025-01-02', 'MKTCAP')).resolves.toMatchObject({ effectiveTradingDate: '2025-01-02' });
    expect(source.calls.filter(({ kind, market }) => kind === 'daily' && market === 'KOSDAQ')).toHaveLength(2);
  });

  it('같은 요청일 동시 호출은 single-flight로 합쳐진다', async () => {
    const source = new FakeSource();
    source.seed('2025-01-02');
    let release!: () => void;
    source.dailyGate = new Promise<void>((resolve) => { release = resolve; });
    const { service: subject } = service({ source });

    const first = subject.preview('2025-01-02', 'MKTCAP');
    const second = subject.preview('2025-01-02', 'MKTCAP');
    release();
    const [a, b] = await Promise.all([first, second]);

    expect(a.previewId).toBe(b.previewId);
    expect(source.calls.filter(({ kind, market }) => kind === 'daily' && market === 'KOSPI')).toHaveLength(1);
  });

  it('같은 적용일 재조회는 캐시를 쓰고 TTL이 지나면 다시 부른다', async () => {
    const source = new FakeSource();
    source.seed('2025-01-02');
    const clock = mutableClock();
    const { service: subject } = service({ source, clock, previewTtlMs: 100 });

    const first = await subject.preview('2025-01-02', 'MKTCAP');
    const cached = await subject.preview('2025-01-02', 'MKTCAP');
    expect(cached.previewId).toBe(first.previewId);
    expect(source.calls.filter(({ kind, market }) => kind === 'daily' && market === 'KOSPI')).toHaveLength(1);

    clock.advance(101);
    const refreshed = await subject.preview('2025-01-02', 'MKTCAP');
    expect(refreshed.previewId).not.toBe(first.previewId);
    expect(source.calls.filter(({ kind, market }) => kind === 'daily' && market === 'KOSPI')).toHaveLength(2);
  });

  it('서로 다른 요청일이 같은 적용일로 해소돼도 요청일별 미리보기를 정확히 보존한다', async () => {
    const source = new FakeSource();
    source.seed('2024-12-30');
    const { service: subject } = service({ source });

    const newYear = await subject.preview('2025-01-01', 'MKTCAP');
    const yearEnd = await subject.preview('2024-12-31', 'MKTCAP');

    expect(newYear).toMatchObject({ requestedDate: '2025-01-01', effectiveTradingDate: '2024-12-30' });
    expect(yearEnd).toMatchObject({ requestedDate: '2024-12-31', effectiveTradingDate: '2024-12-30' });
    expect(yearEnd.previewId).not.toBe(newYear.previewId);
    // preview() 마다 applySortKey 가 새 SortedUniverseCandidateSet 래퍼를 만들어 preview.set
    // 자체는 더 이상 같은 참조가 아니다 — 대신 그 안의 candidates 배열이 같은 참조인지로
    // 「같은 적용일 스냅샷을 재계산 없이 공유했다」를 확인한다.
    expect(yearEnd.set.candidates).toBe(newYear.set.candidates);
    expect(source.calls.filter(({ kind, market }) => kind === 'daily' && market === 'KOSDAQ')).toHaveLength(1);
    expect(source.calls.filter(({ kind }) => kind === 'base')).toHaveLength(2);
    expect(subject.getPreview(newYear.previewId)).toBe(newYear);
    expect(subject.getPreview(yearEnd.previewId)).toBe(yearEnd);
  });

  it('서로 다른 요청일의 동시 호출도 같은 적용일의 KOSDAQ·기본정보 요청을 공유한다', async () => {
    const source = new FakeSource();
    source.seed('2024-12-30');
    let release!: () => void;
    source.dailyGate = new Promise<void>((resolve) => { release = resolve; });
    const { service: subject } = service({ source });

    const newYearPromise = subject.preview('2025-01-01', 'MKTCAP');
    const yearEndPromise = subject.preview('2024-12-31', 'MKTCAP');
    release();
    const [newYear, yearEnd] = await Promise.all([newYearPromise, yearEndPromise]);

    expect(newYear.requestedDate).toBe('2025-01-01');
    expect(yearEnd.requestedDate).toBe('2024-12-31');
    expect(source.calls.filter(({ kind, market }) => kind === 'daily' && market === 'KOSDAQ')).toHaveLength(1);
    expect(source.calls.filter(({ kind }) => kind === 'base')).toHaveLength(2);
  });

  it('getPreview는 TTL 만료 후 null이다', async () => {
    const source = new FakeSource();
    source.seed('2025-01-02');
    const clock = mutableClock();
    const { service: subject } = service({ source, clock, previewTtlMs: 100 });
    const preview = await subject.preview('2025-01-02', 'MKTCAP');

    expect(subject.getPreview(preview.previewId)).toBe(preview);
    clock.advance(101);
    expect(subject.getPreview(preview.previewId)).toBeNull();
  });

  it('공개 메서드 진입 시 재접근하지 않은 만료 캐시도 모두 정리한다', async () => {
    const source = new FakeSource();
    source.seed('2025-01-02');
    source.seed('2025-01-03');
    const clock = mutableClock();
    const { service: subject } = service({ source, clock, previewTtlMs: 100 });
    await subject.preview('2025-01-02', 'MKTCAP');
    await subject.preview('2025-01-03', 'MKTCAP');
    const caches = subject as unknown as {
      dailyCache: Map<unknown, unknown>;
      previewById: Map<unknown, unknown>;
      previewByRequest: Map<unknown, unknown>;
      previewByEffective: Map<unknown, unknown>;
    };
    expect(caches.previewById.size).toBe(2);

    clock.advance(101);
    expect(subject.getPreview('uvp_missing')).toBeNull();

    expect(caches.dailyCache.size).toBe(0);
    expect(caches.previewById.size).toBe(0);
    expect(caches.previewByRequest.size).toBe(0);
    expect(caches.previewByEffective.size).toBe(0);
  });

  it('usableFromDate는 적용일 + 1 달력일이고 canonicalHash는 SHA-256이다', async () => {
    const source = new FakeSource();
    source.seed('2025-01-02');
    const { service: subject } = service({ source });

    const result = await subject.preview('2025-01-02', 'MKTCAP');

    expect(result.usableFromDate).toBe('2025-01-03');
    expect(result.usableFromRule).toBe('NEXT_SESSION_CONSERVATIVE_V1');
    expect(result.canonicalHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.previewId).toMatch(/^uvp_/);
  });

  it('currentStandardCodeMap은 같은 기준일의 양 시장 기본정보를 합치고 TTL 동안 캐시한다', async () => {
    const source = new FakeSource();
    source.base.set('KOSPI:2026-08-02', [baseRow('005930', 'KOSPI')]);
    source.base.set('KOSDAQ:2026-08-02', [baseRow('035720', 'KOSDAQ')]);
    const { service: subject } = service({ source });

    const first = await subject.currentStandardCodeMap();
    const second = await subject.currentStandardCodeMap();

    expect([...first.entries()]).toEqual([['005930', 'KR005930'], ['035720', 'KR035720']]);
    expect(second).toBe(first);
    expect(source.calls.filter(({ kind }) => kind === 'base')).toHaveLength(2);
  });

  it('currentStandardCodeMap은 하나의 표준코드가 여러 단축코드에 배정되면 KrxContractError(502 매핑)로 거부한다', async () => {
    const source = new FakeSource();
    const duplicateStandardCode = 'KR-DUPLICATE';
    source.base.set('KOSPI:2026-08-02', [
      { ...baseRow('005930', 'KOSPI'), standardCode: duplicateStandardCode },
      { ...baseRow('005931', 'KOSPI'), standardCode: duplicateStandardCode },
    ]);
    source.base.set('KOSDAQ:2026-08-02', [baseRow('035720', 'KOSDAQ')]);
    const { service: subject } = service({ source });

    await expect(subject.currentStandardCodeMap()).rejects.toThrow(/표준코드.*단축코드/);
    await expect(subject.currentStandardCodeMap()).rejects.toBeInstanceOf(KrxContractError);
  });

  it('currentStandardCodeMap은 하나의 단축코드가 서로 다른 표준코드로 나오면 KrxContractError(502 매핑)로 거부한다', async () => {
    const source = new FakeSource();
    source.base.set('KOSPI:2026-08-02', [
      { ...baseRow('005930', 'KOSPI'), standardCode: 'KR-FIRST' },
      { ...baseRow('005930', 'KOSPI'), standardCode: 'KR-SECOND' },
    ]);
    source.base.set('KOSDAQ:2026-08-02', [baseRow('035720', 'KOSDAQ')]);
    const { service: subject } = service({ source });

    await expect(subject.currentStandardCodeMap()).rejects.toThrow(/단축코드.*표준코드/);
    await expect(subject.currentStandardCodeMap()).rejects.toBeInstanceOf(KrxContractError);
  });
});

describe('preview sortBy', () => {
  it('MKTCAP 은 기존과 같은 후보 순서·해시를 낸다', async () => {
    const source = new FakeSource();
    source.seed('2025-01-06');
    const { service: subject } = service({ source });

    const preview = await subject.preview('2025-01-06', 'MKTCAP');

    expect(preview.set.sortKey).toBe('MKTCAP');
    expect(preview.set.candidates[0]!.rank).toBe(1);
  });

  it('OPERATING_INCOME 은 sortValueSource 값으로 rank 를 매기고 값 없는 종목이 뒤로 간다', async () => {
    const source = new FakeSource();
    source.seed('2025-01-06');
    const sortValueSource = new FakeSortValueSource(new Map([['035720', 900]]));
    const { service: subject } = service({ source, sortValueSource });

    const preview = await subject.preview('2025-01-06', 'OPERATING_INCOME');

    expect(preview.set.sortKey).toBe('OPERATING_INCOME');
    expect(preview.set.candidates[0]!.shortCode).toBe('035720');
    expect(preview.set.candidates.at(-1)!.rank).toBeNull();
    expect(preview.set.unknownSortValueCount).toBeGreaterThan(0);
  });

  it('정렬 기준이 다르면 previewId·canonicalHash 가 다르다 — 캐시가 섞이지 않는다', async () => {
    const source = new FakeSource();
    source.seed('2025-01-06');
    const sortValueSource = new FakeSortValueSource(new Map([['035720', 900]]));
    const { service: subject } = service({ source, sortValueSource });

    const byCap = await subject.preview('2025-01-06', 'MKTCAP');
    const byOi = await subject.preview('2025-01-06', 'OPERATING_INCOME');

    expect(byOi.previewId).not.toBe(byCap.previewId);
    expect(byOi.canonicalHash).not.toBe(byCap.canonicalHash);

    // 같은 (날짜, 정렬) 재요청은 캐시를 탄다
    const again = await subject.preview('2025-01-06', 'MKTCAP');
    expect(again.previewId).toBe(byCap.previewId);
  });

  it('sortValueSource 가 없거나 실패하면 SortValueUnavailableError 다 — MKTCAP 폴백 금지', async () => {
    const sourceWithoutSort = new FakeSource();
    sourceWithoutSort.seed('2025-01-06');
    const { service: serviceWithoutSource } = service({
      source: sourceWithoutSort,
      sortValueSource: null,
    });

    await expect(serviceWithoutSource.preview('2025-01-06', 'OPERATING_INCOME'))
      .rejects.toBeInstanceOf(SortValueUnavailableError);

    const sourceWithFailing = new FakeSource();
    sourceWithFailing.seed('2025-01-06');
    const failingSortValueSource = new FakeSortValueSource();
    failingSortValueSource.shouldFail = true;
    const { service: serviceWithFailingSource } = service({
      source: sourceWithFailing,
      sortValueSource: failingSortValueSource,
    });

    await expect(serviceWithFailingSource.preview('2025-01-06', 'OPERATING_INCOME'))
      .rejects.toBeInstanceOf(SortValueUnavailableError);
  });

  it('컷오프는 적용거래일 KST 하루 끝이다', async () => {
    const source = new FakeSource();
    source.seed('2025-01-06');
    const sortValueSource = new FakeSortValueSource(new Map([['035720', 900]]));
    const { service: subject } = service({ source, sortValueSource });

    await subject.preview('2025-01-06', 'OPERATING_INCOME');

    expect(sortValueSource.calls[0]?.asOfMaxTsMs).toBe(kstEndOfDayMs('2025-01-06'));
  });
});
