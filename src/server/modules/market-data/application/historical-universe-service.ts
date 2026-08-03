import { createHash } from 'node:crypto';
import type { Logger } from '../../../shared/logger.js';
import type { Clock } from '../../../shared/clock.js';
import { newId } from '../../../shared/ids.js';
import {
  combineMarketSnapshots,
  type UniverseCandidateSet,
} from '../domain/historical-universe.js';
import { KRX_FILTER_POLICY_VERSION } from '../domain/krx-filter-policy.js';
import {
  addCalendarDays,
  KRX_DATA_EPOCH,
  kstDateOf,
  kstHourOf,
} from '../domain/kst-date.js';
import {
  KRX_CONTRACT_VERSION,
  type KrxDailyTradeRow,
  type KrxIssueBaseInfoRow,
} from '../domain/krx-universe-types.js';
import {
  KrxApprovalExpiredError,
  KrxContractError,
  type KrxHistoricalUniverseSource,
  KrxNotConfiguredError,
} from './ports.js';

const DEFAULT_PREVIEW_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_TRADING_DAY_SEARCH = 31;
const USABLE_FROM_RULE = 'NEXT_SESSION_CONSERVATIVE_V1' as const;

export interface HistoricalUniversePreview {
  readonly previewId: string;
  readonly requestedDate: string;
  readonly effectiveTradingDate: string;
  readonly usableFromDate: string;
  readonly usableFromRule: typeof USABLE_FROM_RULE;
  readonly canonicalHash: string;
  readonly set: UniverseCandidateSet;
  readonly fetchedAtMs: number;
}

export type HistoricalUniverseDateErrorCode =
  | 'BEFORE_EPOCH'
  | 'FUTURE_OR_UNPUBLISHED'
  | 'NO_TRADING_DAY_IN_RANGE';

export class HistoricalUniverseDateError extends Error {
  constructor(
    readonly code: HistoricalUniverseDateErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'HistoricalUniverseDateError';
  }
}

export class PreviewExpiredError extends Error {
  constructor(message = '미리보기가 만료되었습니다. KRX 데이터를 다시 조회하세요.') {
    super(message);
    this.name = 'PreviewExpiredError';
  }
}

export interface HistoricalUniverseAvailability {
  readonly available: boolean;
  readonly reason: string | null;
}

interface TimedValue<T> {
  readonly value: T;
  readonly expiresAtMs: number;
}

interface StandardCodeMapCache {
  readonly value: ReadonlyMap<string, string>;
  readonly expiresAtMs: number;
}

interface EffectiveUniverseSnapshot {
  readonly set: UniverseCandidateSet;
  readonly canonicalHash: string;
  readonly fetchedAtMs: number;
}

export class HistoricalUniverseService {
  private readonly ttlMs: number;
  private readonly dailyCache = new Map<string, TimedValue<readonly KrxDailyTradeRow[]>>();
  private readonly previewById = new Map<string, TimedValue<HistoricalUniversePreview>>();
  private readonly previewByRequest = new Map<string, TimedValue<HistoricalUniversePreview>>();
  private readonly previewByEffective = new Map<string, TimedValue<EffectiveUniverseSnapshot>>();
  private readonly pendingPreviews = new Map<string, Promise<HistoricalUniversePreview>>();
  private readonly pendingEffectiveSnapshots = new Map<
    string,
    Promise<TimedValue<EffectiveUniverseSnapshot>>
  >();
  private standardCodeMapCache: StandardCodeMapCache | null = null;
  private pendingStandardCodeMap: Promise<ReadonlyMap<string, string>> | null = null;

  constructor(private readonly deps: {
    readonly source: KrxHistoricalUniverseSource;
    readonly configured: boolean;
    readonly approvalExpiry: string | null;
    readonly clock: Clock;
    readonly logger: Logger;
    readonly previewTtlMs?: number;
  }) {
    this.ttlMs = deps.previewTtlMs ?? DEFAULT_PREVIEW_TTL_MS;
  }

  availability(): HistoricalUniverseAvailability {
    if (!this.deps.configured) {
      return { available: false, reason: new KrxNotConfiguredError().message };
    }
    if (this.isApprovalExpired()) {
      return {
        available: false,
        reason: `KRX Open API 사용 승인 만료일(${this.deps.approvalExpiry})이 지났습니다. API별 승인 상태를 확인하세요.`,
      };
    }
    return { available: true, reason: null };
  }

  async preview(requestedDate: string): Promise<HistoricalUniversePreview> {
    this.purgeExpiredCaches();
    this.assertAvailable();
    this.assertPublishedDate(requestedDate);

    const pending = this.pendingPreviews.get(requestedDate);
    if (pending) return pending;

    const created = this.buildPreview(requestedDate).finally(() => {
      if (this.pendingPreviews.get(requestedDate) === created) {
        this.pendingPreviews.delete(requestedDate);
      }
    });
    this.pendingPreviews.set(requestedDate, created);
    return created;
  }

  getPreview(previewId: string): HistoricalUniversePreview | null {
    this.purgeExpiredCaches();
    const cached = this.previewById.get(previewId);
    if (!cached) return null;
    if (this.isExpired(cached)) {
      this.deletePreview(cached.value);
      return null;
    }
    return cached.value;
  }

  async currentStandardCodeMap(): Promise<ReadonlyMap<string, string>> {
    this.purgeExpiredCaches();
    this.assertAvailable();
    const cached = this.standardCodeMapCache;
    if (cached && !this.isExpired(cached)) return cached.value;
    if (cached) this.standardCodeMapCache = null;
    if (this.pendingStandardCodeMap) return this.pendingStandardCodeMap;

    const pending = this.buildCurrentStandardCodeMap().finally(() => {
      if (this.pendingStandardCodeMap === pending) this.pendingStandardCodeMap = null;
    });
    this.pendingStandardCodeMap = pending;
    return pending;
  }

  /**
   * 미설정·승인 만료를 확인한다 — public 인 이유는 `UniverseSnapshotService.createFromPreview`
   * 가 캐시된 `getPreview` 결과를 쓰기 전에도 같은 검사를 태워야 하기 때문이다.
   * `getPreview` 자체는 만료를 보지 않는 순수 캐시 조회라, 승인이 만료된 뒤에도
   * 만료 전에 만든 previewId 로는 여전히 값을 돌려준다.
   */
  assertAvailable(): void {
    if (!this.deps.configured) throw new KrxNotConfiguredError();
    if (this.isApprovalExpired()) {
      throw new KrxApprovalExpiredError(
        `KRX Open API 사용 승인 만료일(${this.deps.approvalExpiry})이 지났습니다. API별 승인 상태를 확인하세요.`,
      );
    }
  }

  private isApprovalExpired(): boolean {
    return this.deps.approvalExpiry !== null
      && kstDateOf(this.deps.clock.now()) > this.deps.approvalExpiry;
  }

  private publishedThrough(): string {
    const nowMs = this.deps.clock.now();
    const yesterday = addCalendarDays(kstDateOf(nowMs), -1);
    return kstHourOf(nowMs) < 8 ? addCalendarDays(yesterday, -1) : yesterday;
  }

  private assertPublishedDate(requestedDate: string): void {
    if (requestedDate < KRX_DATA_EPOCH) {
      throw new HistoricalUniverseDateError(
        'BEFORE_EPOCH',
        '2010-01-04 이전은 KRX 공식 제공 범위 밖입니다.',
      );
    }
    if (requestedDate > this.publishedThrough()) {
      throw new HistoricalUniverseDateError(
        'FUTURE_OR_UNPUBLISHED',
        '미래 날짜이거나 아직 KRX 일별 데이터가 공개되지 않은 날짜입니다.',
      );
    }
  }

  private async buildPreview(requestedDate: string): Promise<HistoricalUniversePreview> {
    const effective = await this.findEffectiveTradingDate(requestedDate);
    const effectiveKey = this.effectiveCacheKey(effective.date);
    const requestKey = this.requestCacheKey(requestedDate, effective.date);
    const requestedCached = this.previewByRequest.get(requestKey);
    if (requestedCached && !this.isExpired(requestedCached)) return requestedCached.value;
    if (requestedCached) this.deletePreview(requestedCached.value);

    const effectiveCached = await this.effectiveSnapshot(
      effectiveKey,
      effective.date,
      effective.kospiDaily,
    );

    const { set, canonicalHash, fetchedAtMs } = effectiveCached.value;
    const preview: HistoricalUniversePreview = {
      previewId: newId('uvp'),
      requestedDate,
      effectiveTradingDate: effective.date,
      usableFromDate: addCalendarDays(effective.date, 1),
      usableFromRule: USABLE_FROM_RULE,
      canonicalHash,
      set,
      fetchedAtMs,
    };
    const entry = { value: preview, expiresAtMs: effectiveCached.expiresAtMs };
    this.previewById.set(preview.previewId, entry);
    this.previewByRequest.set(requestKey, entry);
    this.deps.logger.info({
      event: 'krx.universe.preview.created',
      requestedDate,
      effectiveTradingDate: effective.date,
      eligibleCount: set.eligibleCount,
    }, 'KRX historical universe preview created');
    return preview;
  }

  private effectiveSnapshot(
    cacheKey: string,
    effectiveTradingDate: string,
    kospiDaily: readonly KrxDailyTradeRow[],
  ): Promise<TimedValue<EffectiveUniverseSnapshot>> {
    const cached = this.previewByEffective.get(cacheKey);
    if (cached && !this.isExpired(cached)) return Promise.resolve(cached);
    if (cached) this.previewByEffective.delete(cacheKey);

    const pending = this.pendingEffectiveSnapshots.get(cacheKey);
    if (pending) return pending;
    const created = this.buildEffectiveSnapshot(effectiveTradingDate, kospiDaily)
      .then((snapshot) => {
        const entry = { value: snapshot, expiresAtMs: snapshot.fetchedAtMs + this.ttlMs };
        this.previewByEffective.set(cacheKey, entry);
        return entry;
      })
      .finally(() => {
        if (this.pendingEffectiveSnapshots.get(cacheKey) === created) {
          this.pendingEffectiveSnapshots.delete(cacheKey);
        }
      });
    this.pendingEffectiveSnapshots.set(cacheKey, created);
    return created;
  }

  private async buildEffectiveSnapshot(
    effectiveTradingDate: string,
    kospiDaily: readonly KrxDailyTradeRow[],
  ): Promise<EffectiveUniverseSnapshot> {
    const kosdaqDaily = await this.deps.source.fetchDailyTrades('KOSDAQ', effectiveTradingDate);
    if (kosdaqDaily.length === 0) {
      // 한 시장 실패는 계약 위반과 같은 부류다 — 일반 Error 는 라우트 매핑에 없어 500 이
      // 되고, 계획한 「한 시장 실패 → 502」와 어긋난다.
      throw new KrxContractError(
        `KRX ${effectiveTradingDate} KOSDAQ 일별 응답이 비어 있어 전체 후보군을 만들 수 없습니다.`,
      );
    }

    const [kospiBase, kosdaqBase] = await Promise.all([
      this.deps.source.fetchIssueBaseInfo('KOSPI', effectiveTradingDate),
      this.deps.source.fetchIssueBaseInfo('KOSDAQ', effectiveTradingDate),
    ]);
    const set = combineMarketSnapshots({
      effectiveTradingDate,
      inputs: [
        { market: 'KOSPI', baseRows: kospiBase, dailyRows: kospiDaily },
        { market: 'KOSDAQ', baseRows: kosdaqBase, dailyRows: kosdaqDaily },
      ],
    });
    return {
      set,
      canonicalHash: createHash('sha256').update(set.canonicalPayload).digest('hex'),
      fetchedAtMs: this.deps.clock.now(),
    };
  }

  private async findEffectiveTradingDate(requestedDate: string): Promise<{
    readonly date: string;
    readonly kospiDaily: readonly KrxDailyTradeRow[];
  }> {
    for (let offset = 0; offset < MAX_TRADING_DAY_SEARCH; offset += 1) {
      const date = addCalendarDays(requestedDate, -offset);
      if (date < KRX_DATA_EPOCH) break;
      const kospiDaily = await this.fetchKospiDaily(date);
      if (kospiDaily.length > 0) return { date, kospiDaily };
    }
    throw new HistoricalUniverseDateError(
      'NO_TRADING_DAY_IN_RANGE',
      `${requestedDate}부터 이전 31일 안에 KRX 거래일을 찾지 못했습니다.`,
    );
  }

  private async fetchKospiDaily(date: string): Promise<readonly KrxDailyTradeRow[]> {
    const key = `KOSPI:${date}`;
    const cached = this.dailyCache.get(key);
    if (cached && !this.isExpired(cached)) return cached.value;
    if (cached) this.dailyCache.delete(key);

    const value = await this.deps.source.fetchDailyTrades('KOSPI', date);
    this.dailyCache.set(key, { value, expiresAtMs: this.deps.clock.now() + this.ttlMs });
    return value;
  }

  private async buildCurrentStandardCodeMap(): Promise<ReadonlyMap<string, string>> {
    const startDate = this.publishedThrough();
    for (let offset = 0; offset < MAX_TRADING_DAY_SEARCH; offset += 1) {
      const date = addCalendarDays(startDate, -offset);
      const [kospi, kosdaq] = await Promise.all([
        this.deps.source.fetchIssueBaseInfo('KOSPI', date),
        this.deps.source.fetchIssueBaseInfo('KOSDAQ', date),
      ]);
      if (kospi.length === 0 || kosdaq.length === 0) continue;

      const value = this.standardCodeMapOf([...kospi, ...kosdaq]);
      this.standardCodeMapCache = {
        value,
        expiresAtMs: this.deps.clock.now() + this.ttlMs,
      };
      return value;
    }
    throw new HistoricalUniverseDateError(
      'NO_TRADING_DAY_IN_RANGE',
      `${startDate}부터 이전 31일 안에 양 시장의 KRX 기본정보를 찾지 못했습니다.`,
    );
  }

  private standardCodeMapOf(rows: readonly KrxIssueBaseInfoRow[]): ReadonlyMap<string, string> {
    const result = new Map<string, string>();
    const shortCodeByStandardCode = new Map<string, string>();
    for (const row of rows) {
      const existing = result.get(row.shortCode);
      if (existing !== undefined && existing !== row.standardCode) {
        // 표준코드 충돌은 KRX 응답이 계약(단축코드↔표준코드 1:1)을 어겼다는 뜻이다 —
        // 일반 Error 는 500 으로 새 나가므로 KrxContractError 로 502 매핑에 태운다.
        throw new KrxContractError(`KRX 단축코드 ${row.shortCode}의 표준코드가 서로 다릅니다.`);
      }
      const existingShortCode = shortCodeByStandardCode.get(row.standardCode);
      if (existingShortCode !== undefined && existingShortCode !== row.shortCode) {
        throw new KrxContractError(
          `KRX 표준코드 ${row.standardCode}가 여러 단축코드(${existingShortCode}, ${row.shortCode})에 배정되었습니다.`,
        );
      }
      result.set(row.shortCode, row.standardCode);
      shortCodeByStandardCode.set(row.standardCode, row.shortCode);
    }
    return result;
  }

  private effectiveCacheKey(effectiveTradingDate: string): string {
    return `${effectiveTradingDate}|${KRX_FILTER_POLICY_VERSION}|${KRX_CONTRACT_VERSION}`;
  }

  private requestCacheKey(requestedDate: string, effectiveTradingDate: string): string {
    return `${requestedDate}|${this.effectiveCacheKey(effectiveTradingDate)}`;
  }

  private isExpired(entry: { readonly expiresAtMs: number }): boolean {
    return this.deps.clock.now() >= entry.expiresAtMs;
  }

  private purgeExpiredCaches(): void {
    const nowMs = this.deps.clock.now();
    for (const [key, entry] of this.dailyCache) {
      if (nowMs >= entry.expiresAtMs) this.dailyCache.delete(key);
    }
    for (const [key, entry] of this.previewByEffective) {
      if (nowMs >= entry.expiresAtMs) this.previewByEffective.delete(key);
    }
    for (const [key, entry] of this.previewByRequest) {
      if (nowMs >= entry.expiresAtMs) this.previewByRequest.delete(key);
    }
    for (const [key, entry] of this.previewById) {
      if (nowMs >= entry.expiresAtMs) this.previewById.delete(key);
    }
    if (this.standardCodeMapCache && nowMs >= this.standardCodeMapCache.expiresAtMs) {
      this.standardCodeMapCache = null;
    }
  }

  private deletePreview(preview: HistoricalUniversePreview): void {
    this.previewById.delete(preview.previewId);
    const key = this.requestCacheKey(preview.requestedDate, preview.effectiveTradingDate);
    if (this.previewByRequest.get(key)?.value.previewId === preview.previewId) {
      this.previewByRequest.delete(key);
    }
  }
}
