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

export class HistoricalUniverseService {
  private readonly ttlMs: number;
  private readonly dailyCache = new Map<string, TimedValue<readonly KrxDailyTradeRow[]>>();
  private readonly previewById = new Map<string, TimedValue<HistoricalUniversePreview>>();
  private readonly previewByEffective = new Map<string, TimedValue<HistoricalUniversePreview>>();
  private readonly pendingPreviews = new Map<string, Promise<HistoricalUniversePreview>>();
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
    const cached = this.previewById.get(previewId);
    if (!cached) return null;
    if (this.isExpired(cached)) {
      this.deletePreview(cached.value);
      return null;
    }
    return cached.value;
  }

  async currentStandardCodeMap(): Promise<ReadonlyMap<string, string>> {
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

  private assertAvailable(): void {
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
    const cacheKey = this.effectiveCacheKey(effective.date);
    const cached = this.previewByEffective.get(cacheKey);
    if (cached && !this.isExpired(cached)) return cached.value;
    if (cached) this.deletePreview(cached.value);

    const kosdaqDaily = await this.deps.source.fetchDailyTrades('KOSDAQ', effective.date);
    if (kosdaqDaily.length === 0) {
      throw new Error(`KRX ${effective.date} KOSDAQ 일별 응답이 비어 있어 전체 후보군을 만들 수 없습니다.`);
    }

    const [kospiBase, kosdaqBase] = await Promise.all([
      this.deps.source.fetchIssueBaseInfo('KOSPI', effective.date),
      this.deps.source.fetchIssueBaseInfo('KOSDAQ', effective.date),
    ]);
    const set = combineMarketSnapshots({
      effectiveTradingDate: effective.date,
      inputs: [
        { market: 'KOSPI', baseRows: kospiBase, dailyRows: effective.kospiDaily },
        { market: 'KOSDAQ', baseRows: kosdaqBase, dailyRows: kosdaqDaily },
      ],
    });
    const fetchedAtMs = this.deps.clock.now();
    const preview: HistoricalUniversePreview = {
      previewId: newId('uvp'),
      requestedDate,
      effectiveTradingDate: effective.date,
      usableFromDate: addCalendarDays(effective.date, 1),
      usableFromRule: USABLE_FROM_RULE,
      canonicalHash: createHash('sha256').update(set.canonicalPayload).digest('hex'),
      set,
      fetchedAtMs,
    };
    const entry = { value: preview, expiresAtMs: fetchedAtMs + this.ttlMs };
    this.previewById.set(preview.previewId, entry);
    this.previewByEffective.set(cacheKey, entry);
    this.deps.logger.info({
      event: 'krx.universe.preview.created',
      requestedDate,
      effectiveTradingDate: effective.date,
      eligibleCount: set.eligibleCount,
    }, 'KRX historical universe preview created');
    return preview;
  }

  private async findEffectiveTradingDate(requestedDate: string): Promise<{
    readonly date: string;
    readonly kospiDaily: readonly KrxDailyTradeRow[];
  }> {
    for (let offset = 0; offset < MAX_TRADING_DAY_SEARCH; offset += 1) {
      const date = addCalendarDays(requestedDate, -offset);
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
    for (const row of rows) {
      const existing = result.get(row.shortCode);
      if (existing !== undefined && existing !== row.standardCode) {
        throw new Error(`KRX 단축코드 ${row.shortCode}의 표준코드가 서로 다릅니다.`);
      }
      result.set(row.shortCode, row.standardCode);
    }
    return result;
  }

  private effectiveCacheKey(effectiveTradingDate: string): string {
    return `${effectiveTradingDate}|${KRX_FILTER_POLICY_VERSION}|${KRX_CONTRACT_VERSION}`;
  }

  private isExpired(entry: { readonly expiresAtMs: number }): boolean {
    return this.deps.clock.now() >= entry.expiresAtMs;
  }

  private deletePreview(preview: HistoricalUniversePreview): void {
    this.previewById.delete(preview.previewId);
    const key = this.effectiveCacheKey(preview.effectiveTradingDate);
    if (this.previewByEffective.get(key)?.value.previewId === preview.previewId) {
      this.previewByEffective.delete(key);
    }
  }
}
