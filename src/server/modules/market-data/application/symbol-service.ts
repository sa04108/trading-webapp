import { createHash } from 'node:crypto';
import { and, desc, eq, gt, inArray, isNotNull } from 'drizzle-orm';
import type { AppDatabase } from '../../../shared/db/database.js';
import {
  dataSyncJobs,
  symbolCoverage,
  symbolSlices,
  symbolVersions,
  symbols as symbolsTable,
} from '../../../shared/db/schema.js';
import type { Clock } from '../../../shared/clock.js';
import { newId } from '../../../shared/ids.js';
import type { Logger } from '../../../shared/logger.js';
import type { AuditLogService } from '../../audit/audit-service.js';
import { MAX_BACKTEST_BARS } from '../../../shared/backtest-limits.js';
import { SYMBOL_PATTERN, type Candle, type Market, type Timeframe } from '../domain/candle.js';
import { aggregateToHourly } from '../domain/aggregate.js';
import { computeCoverage } from '../domain/coverage.js';
import {
  ALL_SLICES,
  coverageTimeframeForSlice,
  sliceForTimeframe,
  sliceTimeframes,
  type DatasetSlice,
} from '../domain/dataset-slice.js';
import { getSessionForMarket, hasMarketSession } from '../domain/exchange-session.js';
import {
  estimateMinuteBackfillBars,
  MINUTE_BACKFILL_MAX_MONTHS,
  minuteBackfillFloorTsMs,
  recommendedMinuteMonths,
} from '../domain/minute-backfill.js';
import { parseCandleCsv } from './csv-parser.js';
import type { CandleRepository } from './ports.js';

/** 재무 버전 체인의 슬라이스 자리 — 재무는 봉 슬라이스 축이 없다 */
export const FACTS_SLICE = 'FACTS';

/** 재무 수집 예상 — facts 모듈이 계산해 이 모듈이 응답에 실어 보낸다 */
export type FactsSyncEstimate =
  | { basis: 'UNSUPPORTED'; reason: string }
  | { basis: 'AFTER_CANDLES' }
  | {
      basis: 'PLANNED';
      fromYear: number;
      toYear: number;
      calls: number;
      estimatedMs: number;
      overDailyLimit: boolean;
    };

/** 실행이 소비한 (종목, 슬라이스, 버전, 해시) 한 칸 — §9.5 재현성 스냅샷의 구성 요소 */
export interface ConsumedVersionEntry {
  readonly code: string;
  readonly slice: string;
  readonly version: number;
  readonly contentHash: string;
}

/** 백테스트가 제출 시점에 고정하는 종목 버전 pin (§9.5) — 구 `UniverseSnapshot` 자리 */
export interface ConsumedVersionSnapshot {
  readonly entries: readonly ConsumedVersionEntry[];
  /** 정렬된 항목을 이어 붙인 집계 해시 */
  readonly hash: string;
}

/** 종목 화면의 한 행 */
export interface SymbolSummary {
  readonly code: string;
  readonly market: Market;
  readonly name: string | null;
  readonly slices: ReadonlyArray<{
    readonly slice: DatasetSlice;
    readonly hasData: boolean;
    readonly barCount: number;
    readonly firstTsMs: number | null;
    readonly lastTsMs: number | null;
    /** 이 슬라이스가 마지막으로 수집된 시각 — 슬라이스마다 다르다 */
    readonly lastSyncedAtMs: number | null;
  }>;
}

export interface CsvImportRequest {
  readonly market: Market;
  readonly timeframe: '1m' | '1d';
  readonly symbol: string;
  readonly fileName: string;
  readonly csvContent: string;
}

export interface MinutePlan {
  readonly capMonths: number;
  readonly recommendedMonths: number;
  readonly fromTsMs: number;
  readonly expectedBars: number;
  readonly exceedsBacktestLimit: boolean;
}

export type CandleSyncEstimate = { basis: 'LAST_RUN'; ms: number } | { basis: 'UNKNOWN' };

/**
 * 종목이 1급 객체가 된 뒤의 데이터 소관 (설계 2026-07-31-symbol-as-first-class).
 *
 * 봉·커버리지·수집 워터마크·버전이 모두 종목에 매달린다. 데이터셋은 참조만 가지므로
 * 같은 종목을 열 개 데이터셋이 참조해도 물리 사본과 DART 호출은 한 벌이다.
 */
export class SymbolService {
  constructor(
    private readonly db: AppDatabase,
    private readonly candleRepository: CandleRepository,
    private readonly clock: Clock,
    private readonly logger: Logger,
    private readonly audit: AuditLogService,
  ) {}

  listSymbols(): SymbolSummary[] {
    const rows = this.db.select().from(symbolsTable).all();
    if (rows.length === 0) return [];

    // N+1 방지 — 종목 200개에서 행마다 조회하면 목록 한 번에 600 쿼리가 난다
    const coverageRows = this.db.select().from(symbolCoverage).all();
    const sliceRows = this.db.select().from(symbolSlices).all();

    const coverageBy = new Map<string, (typeof coverageRows)[number]>();
    for (const row of coverageRows) coverageBy.set(`${row.code}:${row.slice}`, row);
    const sliceBy = new Map<string, (typeof sliceRows)[number]>();
    for (const row of sliceRows) sliceBy.set(`${row.code}:${row.slice}`, row);

    return rows.map((row) => this.toSummary(row, coverageBy, sliceBy));
  }

  /**
   * 종목 하나만 조회한다 — 목록 전체를 만들어 찾지 않는다.
   *
   * 이전에는 `listSymbols().find(...)` 였다. 등록이 반환값으로 이것을 부르므로 1,000종목
   * 일괄 등록이 목록을 1,000번 재구성하는 O(n²) 가 됐다 (테이블 4개 × 매번 전체 스캔).
   */
  getSymbol(code: string): SymbolSummary | null {
    const row = this.db.select().from(symbolsTable).where(eq(symbolsTable.code, code)).get();
    if (!row) return null;

    const coverageBy = new Map<string, (typeof symbolCoverage.$inferSelect)>();
    for (const entry of this.db
      .select()
      .from(symbolCoverage)
      .where(eq(symbolCoverage.code, code))
      .all()) {
      coverageBy.set(`${entry.code}:${entry.slice}`, entry);
    }
    const sliceBy = new Map<string, (typeof symbolSlices.$inferSelect)>();
    for (const entry of this.db
      .select()
      .from(symbolSlices)
      .where(eq(symbolSlices.code, code))
      .all()) {
      sliceBy.set(`${entry.code}:${entry.slice}`, entry);
    }

    return this.toSummary(row, coverageBy, sliceBy);
  }

  /** 행 + 조회 맵 → 화면이 읽는 요약. 목록과 단건이 같은 모양을 내도록 한 곳에 둔다 */
  private toSummary(
    row: typeof symbolsTable.$inferSelect,
    coverageBy: ReadonlyMap<string, typeof symbolCoverage.$inferSelect>,
    sliceBy: ReadonlyMap<string, typeof symbolSlices.$inferSelect>,
  ): SymbolSummary {
    return {
      code: row.code,
      market: row.market as Market,
      name: row.name,
      slices: ALL_SLICES.map((slice) => {
        const coverage = coverageBy.get(`${row.code}:${slice}`);
        const state = sliceBy.get(`${row.code}:${slice}`);
        return {
          slice,
          hasData: (coverage?.barCount ?? 0) > 0,
          barCount: coverage?.barCount ?? 0,
          firstTsMs: coverage?.firstTsMs ?? null,
          lastTsMs: coverage?.lastTsMs ?? null,
          lastSyncedAtMs: state?.lastSyncedAtMs ?? null,
        };
      }),
    };
  }

  exists(code: string): boolean {
    return this.db.select().from(symbolsTable).where(eq(symbolsTable.code, code)).get() !== undefined;
  }

  /**
   * 종목 등록. 이름은 호출부(라우트)가 `SymbolInfoService` 로 먼저 해석해 넘긴다 —
   * 애플리케이션 서비스가 외부 조회를 직접 하면 소스 미설정 환경에서 등록이 막힌다.
   *
   * standardCode(KRX 표준코드/ISIN)는 종목 마스터에서 등록할 때만 채워진다(Task 4,
   * 스펙 2026-08-06) — 단축코드 재사용을 구분하는 유일한 열쇠라고 스키마 주석에
   * 적혀 있다. 이후에는 이 값을 덮어쓸 방법을 일부러 두지 않았다: 이미 정착된
   * standardCode 를 새 조회로 갈아치우면 그 판별 근거 자체가 사라진다.
   */
  addSymbol(
    code: string,
    market: Market,
    name: string | null = null,
    standardCode: string | null = null,
  ): SymbolSummary {
    if (!SYMBOL_PATTERN.test(code)) throw new Error(`invalid symbol: ${code}`);
    // 세션 미지원 시장은 집계·coverage 가 불가능하므로 등록 시점에 거부한다 (D-006·D-027)
    getSessionForMarket(market);
    if (this.exists(code)) throw new Error(`이미 등록된 종목입니다: ${code}`);

    this.db
      .insert(symbolsTable)
      .values({ code, market, name, standardCode, createdAtMs: this.clock.now() })
      .run();
    this.audit.record('system', 'symbol.added', { code, market });
    return this.getSymbol(code)!;
  }

  /** 외부 조회로 받은 이름을 채운다 — 실패하면 null 로 남기고 화면은 코드만 쓴다 */
  setName(code: string, name: string | null): void {
    this.db.update(symbolsTable).set({ name }).where(eq(symbolsTable.code, code)).run();
  }

  /**
   * 종목 제거 — 봉·커버리지·워터마크·버전을 함께 삭제한다.
   */
  async removeSymbols(codes: readonly string[]): Promise<void> {
    if (codes.length === 0) return;
    const running = this.db
      .select({ id: dataSyncJobs.id })
      .from(dataSyncJobs)
      .where(inArray(dataSyncJobs.status, ['QUEUED', 'RUNNING']))
      .get();
    if (running) throw new Error('데이터 작업이 실행 중입니다 — 완료 후 제거하세요');

    for (const code of codes) {
      const row = this.db.select().from(symbolsTable).where(eq(symbolsTable.code, code)).get();
      if (!row) continue;
      // 물리 삭제를 먼저 — 실패하면 중단되어 메타데이터가 온전히 남는다. DB 를 먼저
      // 지우면 실패 시 디스크에 고아 파티션이 조용히 남는다.
      await this.candleRepository.deleteSymbol(row.market as Market, code);
      this.db.delete(symbolsTable).where(eq(symbolsTable.code, code)).run();
      this.audit.record('system', 'symbol.removed', { code });
    }
  }

  getCoverage(codes?: readonly string[]) {
    const rows = this.db.select().from(symbolCoverage).all();
    return codes === undefined ? rows : rows.filter((row) => codes.includes(row.code));
  }

  getSyncJob(jobId: string) {
    return this.db.select().from(dataSyncJobs).where(eq(dataSyncJobs.id, jobId)).get() ?? null;
  }

  /** 실행 중인 수집 잡 — 동시 실행은 하나다 (§10) */
  runningSyncJobId(): string | null {
    const row = this.db
      .select({ id: dataSyncJobs.id })
      .from(dataSyncJobs)
      .where(inArray(dataSyncJobs.status, ['QUEUED', 'RUNNING']))
      .get();
    return row?.id ?? null;
  }

  /**
   * 봉 수집 예상 소요시간. 계산으로는 안 나온다 — 페이지당 봉 수와 API 보관 깊이를
   * 미리 알 수 없다. 직전 실행의 실측치를 참고치로 쓴다.
   *
   * 두 문턱: (1) 선택된 전 종목이 백필 완료 상태여야 한다 — 첫 백필과 증분은 소요시간이
   * 자릿수로 다르다. (2) 그 잡이 백필 완료 **이후** 에 시작됐어야 한다.
   */
  getCandleSyncEstimate(codes: readonly string[], slice: DatasetSlice): CandleSyncEstimate {
    if (codes.length === 0) return { basis: 'UNKNOWN' };

    const states = this.db
      .select()
      .from(symbolSlices)
      .where(eq(symbolSlices.slice, slice))
      .all();
    const doneAt = new Map(states.map((state) => [state.code, state.backfillDoneAtMs]));

    let latestBackfillMs = 0;
    for (const code of codes) {
      const at = doneAt.get(code);
      if (at == null) return { basis: 'UNKNOWN' };
      if (at > latestBackfillMs) latestBackfillMs = at;
    }

    const job = this.db
      .select({ candlesMs: dataSyncJobs.candlesMs })
      .from(dataSyncJobs)
      .where(
        and(
          eq(dataSyncJobs.sourceType, 'BROKER'),
          // status 는 보지 않는다 — 재무 단계에서 멈춘 잡은 FAILED/CANCELLED 지만 그때도
          // 봉 단계는 끝나 candlesMs 가 측정돼 있다. 상태로 거르면 DART 오류 하나가 멀쩡한
          // 봉 실측치를 버린다.
          isNotNull(dataSyncJobs.candlesMs),
          gt(dataSyncJobs.createdAtMs, latestBackfillMs),
        ),
      )
      .orderBy(desc(dataSyncJobs.createdAtMs))
      .limit(1)
      .get();

    // `!job?.candlesMs` 로 쓰면 0ms 측정값이 "측정 없음" 으로 접힌다 — null 만 걸러낸다
    if (job?.candlesMs == null) return { basis: 'UNKNOWN' };
    return { basis: 'LAST_RUN', ms: job.candlesMs };
  }

  getMinutePlan(market: Market, symbolCount: number): MinutePlan | null {
    if (!hasMarketSession(market)) return null;
    const session = getSessionForMarket(market);
    const sessionMinutesPerDay = session.closeMinutes - session.openMinutes;
    const expectedBars = estimateMinuteBackfillBars(
      symbolCount,
      sessionMinutesPerDay,
      MINUTE_BACKFILL_MAX_MONTHS,
    );
    return {
      capMonths: MINUTE_BACKFILL_MAX_MONTHS,
      recommendedMonths: recommendedMinuteMonths(symbolCount),
      fromTsMs: minuteBackfillFloorTsMs(this.clock.now()),
      expectedBars,
      exceedsBacktestLimit: expectedBars > MAX_BACKTEST_BARS,
    };
  }

  /**
   * CSV import (스펙 §13): 동기 파싱 → Parquet 저장 → 1m 이면 1h 사전 집계 → coverage 갱신.
   * 데이터셋이 아니라 **종목**으로 들어간다 — 없으면 등록한다.
   */
  async importCsv(request: CsvImportRequest): Promise<typeof dataSyncJobs.$inferSelect> {
    if (!SYMBOL_PATTERN.test(request.symbol)) {
      throw new Error(`invalid symbol: ${request.symbol}`);
    }
    // 세션이 정의되지 않은 시장(US 등)은 조용한 빈 집계 대신 여기서 명시적으로 거부한다
    const session = getSessionForMarket(request.market);

    // 내용 검증은 종목 메타데이터를 만지기 전에 **전부** 끝낸다 — 구문은 멀쩡하지만 전 봉이
    // 세션 밖인 1m CSV 가 종목을 등록해 놓고 1h 데이터는 없는 상태를 만들면, 화면은 그
    // 종목을 광고하고 제출 검증도 통과시킨다.
    const parsed = parseCandleCsv(request.csvContent, {
      market: request.market,
      timeframe: request.timeframe,
      symbol: request.symbol,
    });
    if (parsed.candles.length === 0) {
      this.rejectImport(request, parsed.errors[0] ?? 'CSV 에 유효한 봉이 없습니다');
    }

    // 스펙 §11: 백테스트는 사전 집계 1시간봉 우선 — 1m import 시 1h 를 함께 생성한다.
    let hourly: Candle[] | null = null;
    if (request.timeframe === '1m') {
      hourly = aggregateToHourly(parsed.candles, session);
      if (hourly.length === 0) {
        this.rejectImport(
          request,
          '모든 봉이 거래 세션 밖입니다. 타임스탬프와 시장 설정을 확인하세요.',
        );
      }
    }

    const now = this.clock.now();
    if (!this.exists(request.symbol)) {
      this.db
        .insert(symbolsTable)
        .values({ code: request.symbol, market: request.market, name: null, createdAtMs: now })
        .run();
    }

    const slice = sliceForTimeframe(request.timeframe);
    const jobId = newId('imp');
    this.db
      .insert(dataSyncJobs)
      .values({
        id: jobId,
        status: 'RUNNING',
        sourceType: 'CSV',
        symbolsJson: JSON.stringify([request.symbol]),
        slice,
        fileName: request.fileName,
        createdAtMs: now,
      })
      .run();

    try {
      await this.candleRepository.saveCandles(parsed.candles);
      if (hourly !== null) await this.candleRepository.saveCandles(hourly);

      await this.refreshCoverage(request.symbol, request.market, slice);
      const csvHash = createHash('sha256').update(request.csvContent).digest('hex');
      this.bumpVersion(request.symbol, slice, `${request.timeframe}:${csvHash}`, now);
      this.markSynced(request.symbol, slice, now);

      const completedAt = this.clock.now();
      this.db
        .update(dataSyncJobs)
        .set({
          status: 'COMPLETED',
          rowsImported: parsed.candles.length,
          error: parsed.errors.length > 0 ? `${parsed.errors.length}행 무시됨` : null,
          completedAtMs: completedAt,
        })
        .where(eq(dataSyncJobs.id, jobId))
        .run();
      this.audit.record('system', 'data.import.completed', {
        symbol: request.symbol,
        rows: parsed.candles.length,
      });
    } catch (error) {
      this.db
        .update(dataSyncJobs)
        .set({
          status: 'FAILED',
          error: error instanceof Error ? error.message : String(error),
          completedAtMs: this.clock.now(),
        })
        .where(eq(dataSyncJobs.id, jobId))
        .run();
      this.logger.error({ module: 'market-data', event: 'data.import.failed', err: error });
    }

    return this.getSyncJob(jobId) as typeof dataSyncJobs.$inferSelect;
  }

  /**
   * 내용 검증 실패. 종목도 job 레코드도 만들지 않으므로 흔적은 감사 로그에 남긴다 —
   * 거부된 업로드도 "무슨 일이 있었는지" 는 조회 가능해야 한다.
   */
  private rejectImport(request: CsvImportRequest, reason: string): never {
    this.audit.record('system', 'data.import.rejected', {
      symbol: request.symbol,
      fileName: request.fileName,
      reason,
    });
    this.logger.warn(
      { module: 'market-data', event: 'data.import.rejected', symbol: request.symbol },
      reason,
    );
    throw new Error(reason);
  }

  /**
   * 검증 차트용 캔들 조회 (설계 2026-07-28-candle-inspection-design.md).
   * 상한 초과는 다운샘플링하지 않고 명시적으로 거부한다 — 검증 화면은 봉을 정직하게
   * 보여줘야 한다.
   */
  async getCandlesForInspection(
    code: string,
    timeframe: Timeframe,
    fromTsMs: number,
    toTsMs: number,
    maxRows = 2000,
  ): Promise<{ candles: Candle[]; missingRanges: Array<{ fromTsMs: number; toTsMs: number }> }> {
    const row = this.db.select().from(symbolsTable).where(eq(symbolsTable.code, code)).get();
    if (!row) throw new Error(`종목을 찾을 수 없습니다: ${code}`);
    const market = row.market as Market;

    const candidateTimeframes = [...new Set(ALL_SLICES.flatMap((slice) => sliceTimeframes(slice)))];
    const available: Timeframe[] = [];
    for (const candidate of candidateTimeframes) {
      const timestamps = await this.candleRepository.getTimestamps(market, candidate, code);
      if (timestamps.length > 0) available.push(candidate);
    }
    if (!available.includes(timeframe)) {
      throw new Error(
        available.length > 0
          ? `이 종목은 ${available.join('/')} 만 제공합니다`
          : '이 종목에는 아직 수집된 캔들이 없습니다 — 동기화 또는 CSV 가져오기 후 조회하세요.',
      );
    }

    const candles: Candle[] = [];
    for await (const candle of this.candleRepository.getCandles({
      market,
      timeframe,
      symbols: [code],
      fromTsMs,
      toTsMs,
    })) {
      candles.push(candle);
      if (candles.length > maxRows) {
        throw new Error(`구간에 봉이 ${maxRows}개를 넘습니다 — 조회 기간을 줄이세요`);
      }
    }

    // 커버리지 음영은 그 슬라이스의 coverage 계산 기준 timeframe 일 때만 그린다
    let missingRanges: Array<{ fromTsMs: number; toTsMs: number }> = [];
    const slice = sliceForTimeframe(timeframe);
    if (coverageTimeframeForSlice(slice) === timeframe) {
      const coverage = this.getCoverage([code]).find((entry) => entry.slice === slice);
      if (coverage?.missingRangesJson) {
        missingRanges = (
          JSON.parse(coverage.missingRangesJson) as Array<{ fromTsMs: number; toTsMs: number }>
        ).filter((range) => range.toTsMs >= fromTsMs && range.fromTsMs <= toTsMs);
      }
    }

    return { candles, missingRanges };
  }

  getLatestVersion(code: string, slice: string): { version: number; contentHash: string } | null {
    const latest = this.db
      .select()
      .from(symbolVersions)
      .where(and(eq(symbolVersions.code, code), eq(symbolVersions.slice, slice)))
      .orderBy(desc(symbolVersions.version))
      .limit(1)
      .get();
    return latest ? { version: latest.version, contentHash: latest.contentHash } : null;
  }

  /**
   * 제출 시점 종목 버전 스냅샷 (§9.5) — 백테스트가 제출 시점에 고정해, 대기 중 동기화가
   * 끼어들어도 실행이 소비한 버전이 어긋나지 않게 한다.
   *
   * 봉 슬라이스와 재무를 함께 담는다 — 둘 다 백테스트 입력이고, 재무만 백필해도 결과가
   * 달라진다. 버전이 없는 조합은 version 0 으로 남긴다: "아직 수집 안 됨" 도 입력 상태의
   * 일부이고, 빠뜨리면 나중에 수집된 실행과 스냅샷이 같아 보인다.
   */
  versionSnapshotFor(codes: readonly string[], slice: DatasetSlice): ConsumedVersionSnapshot {
    const uniqueCodes = [...new Set(codes)].sort();
    const entries: ConsumedVersionEntry[] = [];
    for (const code of uniqueCodes) {
      for (const axis of [slice, FACTS_SLICE]) {
        const latest = this.getLatestVersion(code, axis);
        entries.push({
          code,
          slice: axis,
          version: latest?.version ?? 0,
          contentHash: latest?.contentHash ?? '',
        });
      }
    }
    const hash = createHash('sha256')
      .update(entries.map((e) => `${e.code}:${e.slice}:${e.version}:${e.contentHash}`).join('|'))
      .digest('hex');
    return { entries, hash };
  }

  /**
   * 체인 해시: 이전 버전 해시에 이번 변경의 지문(seed)을 연결해 전체 변경 이력이 해시에
   * 반영되게 한다. 마지막 변경만 해싱하면 서로 다른 종목이 같은 지문을 가질 수 있다 (§9.5).
   * CSV import·증권사 동기화·재무 수집이 공유한다.
   */
  bumpVersion(code: string, slice: string, fingerprintSeed: string, nowMs: number): void {
    const latest = this.getLatestVersion(code, slice);
    const contentHash = createHash('sha256')
      .update(`${latest?.contentHash ?? ''}:${fingerprintSeed}`)
      .digest('hex');
    this.db
      .insert(symbolVersions)
      .values({
        id: newId('sv'),
        code,
        slice,
        version: (latest?.version ?? 0) + 1,
        contentHash,
        createdAtMs: nowMs,
      })
      .run();
  }

  /** 수집 완료 시각 기록 — 종목 화면의 「일봉 3일 전」이 읽는 값 */
  markSynced(code: string, slice: DatasetSlice, nowMs: number): void {
    const existing = this.db
      .select()
      .from(symbolSlices)
      .where(and(eq(symbolSlices.code, code), eq(symbolSlices.slice, slice)))
      .get();
    if (existing) {
      this.db
        .update(symbolSlices)
        .set({ lastSyncedAtMs: nowMs })
        .where(eq(symbolSlices.id, existing.id))
        .run();
      return;
    }
    this.db.insert(symbolSlices).values({ code, slice, lastSyncedAtMs: nowMs }).run();
  }

  /** slice 별 coverage 갱신 — coverageTimeframeForSlice(slice) 기준 timestamps 로 계산 */
  async refreshCoverage(code: string, market: Market, slice: DatasetSlice): Promise<void> {
    const session = getSessionForMarket(market);
    const timeframe = coverageTimeframeForSlice(slice);
    const timestamps = await this.candleRepository.getTimestamps(market, timeframe, code);
    const coverage = computeCoverage(timeframe, timestamps, session);
    const row = {
      code,
      slice,
      firstTsMs: coverage.firstTsMs,
      lastTsMs: coverage.lastTsMs,
      barCount: coverage.barCount,
      expectedBarCount: coverage.expectedBarCount,
      missingRangesJson: JSON.stringify(coverage.missingRanges),
      computedAtMs: this.clock.now(),
    };

    this.db.transaction((tx) => {
      tx.delete(symbolCoverage)
        .where(and(eq(symbolCoverage.code, code), eq(symbolCoverage.slice, slice)))
        .run();
      tx.insert(symbolCoverage).values(row).run();
    });
  }
}
