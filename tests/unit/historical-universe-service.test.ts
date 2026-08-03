import { describe, expect, it } from 'vitest';
import {
  HistoricalUniverseService,
} from '../../src/server/modules/market-data/application/historical-universe-service.js';
import {
  KrxApprovalExpiredError,
  KrxNotConfiguredError,
  type KrxHistoricalUniverseSource,
} from '../../src/server/modules/market-data/application/ports.js';
import type {
  KrxDailyTradeRow,
  KrxIssueBaseInfoRow,
  KrxMarket,
} from '../../src/server/modules/market-data/domain/krx-universe-types.js';
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

function service(options: {
  source?: FakeSource;
  clock?: Clock;
  configured?: boolean;
  approvalExpiry?: string | null;
  previewTtlMs?: number;
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
    await expect(subject.preview('2025-01-02')).rejects.toBeInstanceOf(KrxNotConfiguredError);
  });

  it('승인 만료면 available=false이고 이유에 만료일을 표시한다', async () => {
    const { service: subject } = service({ approvalExpiry: '2026-08-02' });

    expect(subject.availability()).toEqual({ available: false, reason: expect.stringContaining('2026-08-02') });
    await expect(subject.preview('2025-01-02')).rejects.toBeInstanceOf(KrxApprovalExpiredError);
  });

  it('2010-01-04 이전 요청은 BEFORE_EPOCH로 차단한다', async () => {
    const { service: subject } = service();

    await expect(subject.preview('2010-01-03')).rejects.toMatchObject({
      code: 'BEFORE_EPOCH',
    });
  });

  it('KST 어제보다 뒤는 FUTURE_OR_UNPUBLISHED로 차단한다', async () => {
    const { service: subject } = service();

    await expect(subject.preview('2026-08-03')).rejects.toMatchObject({
      code: 'FUTURE_OR_UNPUBLISHED',
    });
  });

  it('KST 08시 전에는 어제 데이터도 공개 대기로 차단한다', async () => {
    const { service: subject } = service({ clock: mutableClock('2026-08-02T22:00:00.000Z') });

    await expect(subject.preview('2026-08-02')).rejects.toMatchObject({
      code: 'FUTURE_OR_UNPUBLISHED',
    });
  });

  it('휴장일 요청은 이전 거래일로 해소하고 요청일과 적용일을 모두 반환한다', async () => {
    const source = new FakeSource();
    source.seed('2024-12-30');
    const { service: subject } = service({ source });

    const result = await subject.preview('2025-01-01');

    expect(result.requestedDate).toBe('2025-01-01');
    expect(result.effectiveTradingDate).toBe('2024-12-30');
    expect(source.calls.filter(({ kind, market }) => kind === 'daily' && market === 'KOSPI').map(({ date }) => date))
      .toEqual(['2025-01-01', '2024-12-31', '2024-12-30']);
  });

  it('31일 안에 거래일이 없으면 NO_TRADING_DAY_IN_RANGE다', async () => {
    const { service: subject, source } = service();

    await expect(subject.preview('2025-01-31')).rejects.toMatchObject({
      code: 'NO_TRADING_DAY_IN_RANGE',
    });
    expect(source.calls.filter(({ kind, market }) => kind === 'daily' && market === 'KOSPI')).toHaveLength(31);
  });

  it('epoch 당일 탐색은 공식 범위 밖인 2009년 날짜를 호출하지 않는다', async () => {
    const { service: subject, source } = service();

    await expect(subject.preview('2010-01-04')).rejects.toMatchObject({
      code: 'NO_TRADING_DAY_IN_RANGE',
    });
    expect(source.calls.filter(({ kind, market }) => kind === 'daily' && market === 'KOSPI'))
      .toEqual([{ kind: 'daily', market: 'KOSPI', date: '2010-01-04' }]);
  });

  it('KOSPI 성공·KOSDAQ 빈 응답이면 부분 후보군을 만들지 않는다', async () => {
    const source = new FakeSource();
    source.seed('2025-01-02');
    source.daily.set('KOSDAQ:2025-01-02', []);
    const { service: subject } = service({ source });

    await expect(subject.preview('2025-01-02')).rejects.toThrow(/KOSDAQ/);
    expect(source.calls.some(({ kind }) => kind === 'base')).toBe(false);
  });

  it('한 시장 호출 실패는 전체 실패고 오류는 캐시되지 않는다', async () => {
    const source = new FakeSource();
    source.seed('2025-01-02');
    source.failDailyKey = 'KOSDAQ:2025-01-02';
    const { service: subject } = service({ source });

    await expect(subject.preview('2025-01-02')).rejects.toThrow('temporary source failure');
    source.failDailyKey = null;
    await expect(subject.preview('2025-01-02')).resolves.toMatchObject({ effectiveTradingDate: '2025-01-02' });
    expect(source.calls.filter(({ kind, market }) => kind === 'daily' && market === 'KOSDAQ')).toHaveLength(2);
  });

  it('같은 요청일 동시 호출은 single-flight로 합쳐진다', async () => {
    const source = new FakeSource();
    source.seed('2025-01-02');
    let release!: () => void;
    source.dailyGate = new Promise<void>((resolve) => { release = resolve; });
    const { service: subject } = service({ source });

    const first = subject.preview('2025-01-02');
    const second = subject.preview('2025-01-02');
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

    const first = await subject.preview('2025-01-02');
    const cached = await subject.preview('2025-01-02');
    expect(cached.previewId).toBe(first.previewId);
    expect(source.calls.filter(({ kind, market }) => kind === 'daily' && market === 'KOSPI')).toHaveLength(1);

    clock.advance(101);
    const refreshed = await subject.preview('2025-01-02');
    expect(refreshed.previewId).not.toBe(first.previewId);
    expect(source.calls.filter(({ kind, market }) => kind === 'daily' && market === 'KOSPI')).toHaveLength(2);
  });

  it('서로 다른 요청일이 같은 적용일로 해소돼도 요청일별 미리보기를 정확히 보존한다', async () => {
    const source = new FakeSource();
    source.seed('2024-12-30');
    const { service: subject } = service({ source });

    const newYear = await subject.preview('2025-01-01');
    const yearEnd = await subject.preview('2024-12-31');

    expect(newYear).toMatchObject({ requestedDate: '2025-01-01', effectiveTradingDate: '2024-12-30' });
    expect(yearEnd).toMatchObject({ requestedDate: '2024-12-31', effectiveTradingDate: '2024-12-30' });
    expect(yearEnd.previewId).not.toBe(newYear.previewId);
    expect(yearEnd.set).toBe(newYear.set);
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

    const newYearPromise = subject.preview('2025-01-01');
    const yearEndPromise = subject.preview('2024-12-31');
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
    const preview = await subject.preview('2025-01-02');

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
    await subject.preview('2025-01-02');
    await subject.preview('2025-01-03');
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

    const result = await subject.preview('2025-01-02');

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

  it('currentStandardCodeMap은 하나의 표준코드가 여러 단축코드에 배정되면 거부한다', async () => {
    const source = new FakeSource();
    const duplicateStandardCode = 'KR-DUPLICATE';
    source.base.set('KOSPI:2026-08-02', [
      { ...baseRow('005930', 'KOSPI'), standardCode: duplicateStandardCode },
      { ...baseRow('005931', 'KOSPI'), standardCode: duplicateStandardCode },
    ]);
    source.base.set('KOSDAQ:2026-08-02', [baseRow('035720', 'KOSDAQ')]);
    const { service: subject } = service({ source });

    await expect(subject.currentStandardCodeMap()).rejects.toThrow(/표준코드.*단축코드/);
  });
});
