import { createHash } from 'node:crypto';
import { and, desc, eq, gt, inArray, isNotNull } from 'drizzle-orm';
import type { AppDatabase } from '../../../shared/db/database.js';
import {
  brokerSyncState,
  dataCoverage,
  dataImportJobs,
  datasetVersions,
  datasets,
} from '../../../shared/db/schema.js';
import type { Clock } from '../../../shared/clock.js';
import { newId } from '../../../shared/ids.js';
import type { Logger } from '../../../shared/logger.js';
import type { AuditLogService } from '../../audit/audit-service.js';
import {
  SYMBOL_PATTERN,
  type Candle,
  type Market,
  type Timeframe,
} from '../domain/candle.js';
import { aggregateToHourly } from '../domain/aggregate.js';
import { computeCoverage } from '../domain/coverage.js';
import {
  ALL_SLICES,
  coverageTimeframeForSlice,
  legacyConsumeDefault,
  sliceForTimeframe,
  sliceTimeframes,
  symbolsKey,
  type DatasetSlice,
} from '../domain/dataset-slice.js';
import { getSessionForMarket } from '../domain/exchange-session.js';
import { parseCandleCsv } from './csv-parser.js';
import type { CandleRepository } from './ports.js';

/** 같은 종목 구성(정렬·중복 제거 후 동일)의 데이터셋이 이미 있을 때 던진다 */
export class DuplicateSymbolGroupError extends Error {
  constructor(existingName: string) {
    super(`같은 종목 구성의 데이터셋이 이미 있습니다: ${existingName}`);
    this.name = 'DuplicateSymbolGroupError';
  }
}

export interface DatasetSummary {
  id: string;
  name: string;
  market: Market;
  /** 기본 수집 봉 ('1d'|'1m') — 생성 드로어의 선택, 카드 스위치 기본값 */
  defaultTimeframe: DatasetSlice;
  /** 슬라이스별 데이터 존재 여부 — 카드가 어느 봉 종류를 갖고 있는지 표시 */
  slices: Array<{ slice: DatasetSlice; hasData: boolean }>;
  symbols: string[];
  description: string | null;
  latestVersion: number;
  createdAtMs: number;
  /** 진행 중인 증권사 동기화 잡 — UI 가 새로고침 후에도 진행 상태에 붙을 수 있게 노출 */
  runningSyncJobId: string | null;
}

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

export interface SyncEstimate {
  readonly candles: { basis: 'LAST_RUN'; ms: number } | { basis: 'UNKNOWN' };
  readonly facts: FactsSyncEstimate;
}

export interface ImportRequest {
  readonly datasetName: string;
  readonly market: Market;
  readonly timeframe: '1m' | '1d';
  readonly symbol: string;
  readonly fileName: string;
  readonly csvContent: string;
}

export class DatasetService {
  constructor(
    private readonly db: AppDatabase,
    private readonly candleRepository: CandleRepository,
    private readonly clock: Clock,
    private readonly logger: Logger,
    private readonly audit: AuditLogService,
  ) {}

  listDatasets(): DatasetSummary[] {
    const rows = this.db.select().from(datasets).all();
    if (rows.length === 0) return [];
    // N+1 방지: coverage 를 데이터셋별로 한 번에 읽어 Map 으로 넘긴다 —
    // 데이터셋마다 개별 조회하면 목록 화면이 데이터셋 수만큼 쿼리를 낸다
    const coverageRows = this.db
      .select()
      .from(dataCoverage)
      .where(
        inArray(
          dataCoverage.datasetId,
          rows.map((row) => row.id),
        ),
      )
      .all();
    const coverageByDataset = new Map<string, (typeof coverageRows)[number][]>();
    for (const coverage of coverageRows) {
      const list = coverageByDataset.get(coverage.datasetId) ?? [];
      list.push(coverage);
      coverageByDataset.set(coverage.datasetId, list);
    }
    return rows.map((row) => this.toSummary(row, coverageByDataset.get(row.id) ?? []));
  }

  getDataset(datasetId: string): DatasetSummary | null {
    const row = this.db.select().from(datasets).where(eq(datasets.id, datasetId)).get();
    return row ? this.toSummary(row) : null;
  }

  private toSummary(
    row: typeof datasets.$inferSelect,
    coverageRows?: (typeof dataCoverage.$inferSelect)[],
  ): DatasetSummary {
    const latest = this.db
      .select()
      .from(datasetVersions)
      .where(eq(datasetVersions.datasetId, row.id))
      .orderBy(desc(datasetVersions.version))
      .limit(1)
      .get();
    const runningSync = this.db
      .select({ id: dataImportJobs.id })
      .from(dataImportJobs)
      .where(
        and(
          eq(dataImportJobs.datasetId, row.id),
          eq(dataImportJobs.sourceType, 'BROKER'),
          inArray(dataImportJobs.status, ['QUEUED', 'RUNNING']),
        ),
      )
      .get();
    const coverage =
      coverageRows ??
      this.db.select().from(dataCoverage).where(eq(dataCoverage.datasetId, row.id)).all();
    const defaultTimeframe = row.defaultTimeframe as DatasetSlice;
    const slices = ALL_SLICES.map((slice) => ({
      slice,
      hasData: coverage.some((c) => c.slice === slice && c.barCount > 0),
    }));
    return {
      id: row.id,
      name: row.name,
      market: row.market as Market,
      defaultTimeframe,
      slices,
      symbols: JSON.parse(row.symbolsJson) as string[],
      description: row.description,
      latestVersion: latest?.version ?? 0,
      createdAtMs: row.createdAtMs,
      runningSyncJobId: runningSync?.id ?? null,
    };
  }

  /** 종목 구성 유일키로 기존 데이터셋을 찾는다. excludeId 는 자기 자신 제외(편집 시) 용 */
  private findBySymbolsKey(
    key: string,
    excludeId?: string,
  ): typeof datasets.$inferSelect | undefined {
    return this.db
      .select()
      .from(datasets)
      .where(eq(datasets.symbolsKey, key))
      .all()
      .find((row) => row.id !== excludeId);
  }

  getCoverage(datasetId: string) {
    return this.db.select().from(dataCoverage).where(eq(dataCoverage.datasetId, datasetId)).all();
  }

  /**
   * 봉 수집 예상 소요시간. 계산으로는 안 나온다 — 페이지당 봉 수와 API 보관 깊이를
   * 미리 알 수 없다. 직전 실행의 실측치를 참고치로 쓴다.
   *
   * 두 개의 문턱이 있다. (1) 전 종목이 백필 완료 상태여야 한다 — 첫 백필과 증분은
   * 소요시간이 자릿수로 다르다. (2) 그 잡이 백필 완료 **이후** 에 시작됐어야 한다 —
   * 백필을 포함한 실행의 시간을 증분 예상치로 쓰면 과대 추정이 된다.
   */
  getCandleSyncEstimate(datasetId: string, symbols: readonly string[]): SyncEstimate['candles'] {
    if (symbols.length === 0) return { basis: 'UNKNOWN' };

    const states = this.db
      .select()
      .from(brokerSyncState)
      .where(eq(brokerSyncState.datasetId, datasetId))
      .all();
    const doneAt = new Map(states.map((state) => [state.symbol, state.backfillDoneAtMs]));

    let latestBackfillMs = 0;
    for (const symbol of symbols) {
      const at = doneAt.get(symbol);
      if (at == null) return { basis: 'UNKNOWN' };
      if (at > latestBackfillMs) latestBackfillMs = at;
    }

    const job = this.db
      .select({ candlesMs: dataImportJobs.candlesMs })
      .from(dataImportJobs)
      .where(
        and(
          eq(dataImportJobs.datasetId, datasetId),
          eq(dataImportJobs.sourceType, 'BROKER'),
          // status 는 보지 않는다 — 재무 단계에서 멈춘 잡은 FAILED/CANCELLED 지만 그때도
          // 봉 단계는 끝나 candlesMs 가 측정돼 있다. 상태로 거르면 DART 오류 하나가 멀쩡한
          // 봉 실측치를 버린다. candlesMs IS NOT NULL 자체가 봉 단계 완주를 함의한다(스펙 §6)
          isNotNull(dataImportJobs.candlesMs),
          gt(dataImportJobs.createdAtMs, latestBackfillMs),
        ),
      )
      // 정렬 기준은 created_at_ms 다 — 같은 데이터셋의 BROKER 잡은 겹칠 수 없으므로
      // (startSync 가 SyncAlreadyRunningError 로 막는다) 시작 순서 = 종료 순서다.
      // completed_at_ms 는 nullable 이라 정렬 기준으로 쓰면 값이 없는 행에 순서가 흔들린다.
      .orderBy(desc(dataImportJobs.createdAtMs))
      .limit(1)
      .get();

    // `!job?.candlesMs` 로 쓰면 0ms 측정값이 "측정 없음" 으로 접힌다 — null 만 걸러낸다
    if (job?.candlesMs == null) return { basis: 'UNKNOWN' };
    return { basis: 'LAST_RUN', ms: job.candlesMs };
  }

  /**
   * 증권사 수집용 데이터셋 생성 (설계 2026-07-28-broker-sync-design.md).
   * collect 는 수집 timeframe — 데이터셋 timeframe 은 CSV import 와 같은 관례로
   * 백테스트 소비 기준을 따른다: 1m 수집 → 1h 데이터셋(사전 집계), 1d 수집 → 1d.
   */
  createBrokerDataset(
    name: string,
    market: Market,
    collect: '1m' | '1d',
    symbols: readonly string[],
  ): DatasetSummary {
    if (symbols.length === 0) throw new Error('심볼이 최소 1개 필요합니다');
    for (const symbol of symbols) {
      if (!SYMBOL_PATTERN.test(symbol)) throw new Error(`invalid symbol: ${symbol}`);
    }
    // 세션 미지원 시장은 집계·coverage 가 불가능하므로 생성 시점에 거부한다
    getSessionForMarket(market);
    const existing = this.db.select().from(datasets).where(eq(datasets.name, name)).get();
    if (existing) throw new Error(`같은 이름의 데이터셋이 이미 있습니다: ${name}`);

    // 중복은 접는다 (updateSymbols·importCsv 와 같은 관례) — 남겨두면 같은 종목을 두 번
    // 긁고 재무 쪽 symbolTotal·예상 호출 수까지 부푼다
    const sortedSymbols = [...new Set(symbols)].sort();
    const key = symbolsKey(sortedSymbols);
    const duplicate = this.findBySymbolsKey(key);
    if (duplicate) throw new DuplicateSymbolGroupError(duplicate.name);

    const now = this.clock.now();
    const row: typeof datasets.$inferInsert = {
      id: newId('ds'),
      name,
      market,
      timeframe: legacyConsumeDefault(collect),
      defaultTimeframe: collect,
      symbolsKey: key,
      symbolsJson: JSON.stringify(sortedSymbols),
      description: null,
      createdAtMs: now,
      updatedAtMs: now,
    };
    this.db.insert(datasets).values(row).run();
    this.audit.record('system', 'dataset.created', { datasetId: row.id, name, market, collect });
    return this.toSummary(row as typeof datasets.$inferSelect);
  }

  getImportJob(jobId: string) {
    const row = this.db.select().from(dataImportJobs).where(eq(dataImportJobs.id, jobId)).get();
    return row ?? null;
  }

  /**
   * CSV import (스펙 §13): 동기 파싱 → Parquet 저장 → 1m 이면 1h 사전 집계 → coverage 갱신.
   * 반환된 job 레코드가 결과를 담는다.
   */
  async importCsv(request: ImportRequest): Promise<typeof dataImportJobs.$inferSelect> {
    if (!SYMBOL_PATTERN.test(request.symbol)) {
      throw new Error(`invalid symbol: ${request.symbol}`);
    }
    // 세션이 정의되지 않은 시장(US 등)은 조용한 빈 집계 대신 여기서 명시적으로 거부한다
    const session = getSessionForMarket(request.market);

    // 내용 검증은 데이터셋 메타데이터를 만지기 전에 **전부** 끝낸다.
    // 파싱만 앞세우면, 구문은 멀쩡하지만 전 봉이 세션 밖인 1m CSV 가 ensureDataset 을
    // 통과해 symbolsJson 에 유령 심볼을 남긴다 — 위저드는 그 심볼을 광고하고
    // 제출 검증도 통과시키지만 1h 데이터는 존재하지 않는다.
    const parsed = parseCandleCsv(request.csvContent, {
      market: request.market,
      timeframe: request.timeframe,
      symbol: request.symbol,
    });
    if (parsed.candles.length === 0) {
      this.rejectImport(request, parsed.errors[0] ?? 'CSV 에 유효한 봉이 없습니다');
    }

    // 스펙 §11: 백테스트는 사전 집계 1시간봉 우선 — 1m import 시 1h 를 함께 생성한다.
    // 집계는 저장·메타데이터 변경 전에 끝내 완료로 위장할 여지를 없앤다.
    let hourly: Candle[] | null = null;
    if (request.timeframe === '1m') {
      hourly = aggregateToHourly(parsed.candles, session);
      if (hourly.length === 0) {
        // 모든 봉이 세션 밖 → 세션 불일치·잘못된 데이터
        this.rejectImport(
          request,
          '모든 봉이 거래 세션 밖입니다. 타임스탬프와 시장 설정을 확인하세요.',
        );
      }
    }

    const now = this.clock.now();
    const dataset = this.ensureDataset(request, now);

    const jobId = newId('imp');
    this.db
      .insert(dataImportJobs)
      .values({
        id: jobId,
        datasetId: dataset.id,
        status: 'RUNNING',
        sourceType: 'CSV',
        fileName: request.fileName,
        symbol: request.symbol,
        createdAtMs: now,
      })
      .run();

    try {
      await this.candleRepository.saveCandles(dataset.id, parsed.candles);
      if (hourly !== null) await this.candleRepository.saveCandles(dataset.id, hourly);

      await this.refreshCoverage(
        dataset.id,
        request.market,
        sliceForTimeframe(request.timeframe),
      );
      const csvHash = createHash('sha256').update(request.csvContent).digest('hex');
      this.bumpVersion(dataset.id, `${request.symbol}:${request.timeframe}:${csvHash}`, now);

      const completedAt = this.clock.now();
      this.db
        .update(dataImportJobs)
        .set({
          status: 'COMPLETED',
          rowsImported: parsed.candles.length,
          error: parsed.errors.length > 0 ? `${parsed.errors.length}행 무시됨` : null,
          completedAtMs: completedAt,
        })
        .where(eq(dataImportJobs.id, jobId))
        .run();
      this.audit.record('system', 'data.import.completed', {
        datasetId: dataset.id,
        symbol: request.symbol,
        rows: parsed.candles.length,
      });
    } catch (error) {
      this.db
        .update(dataImportJobs)
        .set({
          status: 'FAILED',
          error: error instanceof Error ? error.message : String(error),
          completedAtMs: this.clock.now(),
        })
        .where(eq(dataImportJobs.id, jobId))
        .run();
      this.logger.error({ module: 'market-data', event: 'data.import.failed', err: error });
    }

    return this.getImportJob(jobId) as typeof dataImportJobs.$inferSelect;
  }

  /**
   * 내용 검증 실패. 데이터셋도 job 레코드도 만들지 않으므로 (§13 의 FK 대상이 없다)
   * 흔적은 감사 로그에 남긴다 — 거부된 업로드도 "무슨 일이 있었는지" 는 조회 가능해야 한다.
   */
  private rejectImport(request: ImportRequest, reason: string): never {
    this.audit.record('system', 'data.import.rejected', {
      datasetName: request.datasetName,
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

  private ensureDataset(request: ImportRequest, nowMs: number): typeof datasets.$inferSelect {
    const existing = this.db
      .select()
      .from(datasets)
      .where(eq(datasets.name, request.datasetName))
      .get();

    if (existing) {
      const symbols = new Set(JSON.parse(existing.symbolsJson) as string[]);
      if (!symbols.has(request.symbol)) {
        symbols.add(request.symbol);
        const sorted = [...symbols].sort();
        const key = symbolsKey(sorted);
        const duplicate = this.findBySymbolsKey(key, existing.id);
        if (duplicate) throw new DuplicateSymbolGroupError(duplicate.name);
        this.db
          .update(datasets)
          .set({ symbolsJson: JSON.stringify(sorted), symbolsKey: key, updatedAtMs: nowMs })
          .where(eq(datasets.id, existing.id))
          .run();
        return { ...existing, symbolsJson: JSON.stringify(sorted), symbolsKey: key };
      }
      return existing;
    }

    // 데이터셋의 defaultTimeframe 은 백테스트가 소비하는 기준 — 1m import 도 1h 로
    // 사전 집계되므로 defaultTimeframe 은 1m(레거시 컬럼엔 1h 를 기록해 호환한다)
    const defaultTimeframe: DatasetSlice = request.timeframe === '1d' ? '1d' : '1m';
    const sortedSymbols = [request.symbol];
    const row: typeof datasets.$inferInsert = {
      id: newId('ds'),
      name: request.datasetName,
      market: request.market,
      timeframe: legacyConsumeDefault(defaultTimeframe),
      defaultTimeframe,
      symbolsKey: symbolsKey(sortedSymbols),
      symbolsJson: JSON.stringify(sortedSymbols),
      description: null,
      createdAtMs: nowMs,
      updatedAtMs: nowMs,
    };
    this.db.insert(datasets).values(row).run();
    return row as typeof datasets.$inferSelect;
  }

  /**
   * 심볼 목록 편집 — 유니버스 밸브 (설계 2026-07-28-broker-sync-design.md).
   * 제거는 다음 sync 부터 수집을 멈출 뿐, 이미 쌓인 봉과 워터마크는 남긴다 —
   * 지우는 건 비가역이고 남기는 건 값싸며, 재추가 시 이어받기가 공짜다.
   */
  updateSymbols(
    datasetId: string,
    change: { add?: readonly string[]; remove?: readonly string[] },
  ): DatasetSummary {
    const row = this.db.select().from(datasets).where(eq(datasets.id, datasetId)).get();
    if (!row) throw new Error(`데이터셋을 찾을 수 없습니다: ${datasetId}`);

    for (const symbol of [...(change.add ?? []), ...(change.remove ?? [])]) {
      if (!SYMBOL_PATTERN.test(symbol)) throw new Error(`invalid symbol: ${symbol}`);
    }

    const symbols = new Set(JSON.parse(row.symbolsJson) as string[]);
    for (const symbol of change.add ?? []) symbols.add(symbol);
    for (const symbol of change.remove ?? []) symbols.delete(symbol);
    if (symbols.size === 0) {
      throw new Error('심볼이 최소 1개 남아야 합니다 — 전부 비우려면 데이터셋을 삭제하세요');
    }

    const sorted = [...symbols].sort();
    const key = symbolsKey(sorted);
    const duplicate = this.findBySymbolsKey(key, datasetId);
    if (duplicate) throw new DuplicateSymbolGroupError(duplicate.name);

    const now = this.clock.now();
    this.db
      .update(datasets)
      .set({ symbolsJson: JSON.stringify(sorted), symbolsKey: key, updatedAtMs: now })
      .where(eq(datasets.id, datasetId))
      .run();
    // 심볼 구성은 백테스트가 보는 유효 데이터가 바뀌는 변경이다 — 버전에 반영 (§9.5)
    this.bumpVersion(datasetId, `symbols:${sorted.join(',')}`, now);
    this.audit.record('system', 'dataset.symbols.updated', {
      datasetId,
      add: change.add ?? [],
      remove: change.remove ?? [],
    });
    const updated = this.db.select().from(datasets).where(eq(datasets.id, datasetId)).get();
    return this.toSummary(updated as typeof datasets.$inferSelect);
  }

  /**
   * 이름 변경 — 저장된 참조는 전부 datasetId 라 안전하다. 단 CSV import 는
   * 이름을 upsert key 로 쓰므로, 변경 후 옛 이름으로 import 하면 새 데이터셋이 생긴다.
   * 이름은 백테스트가 소비하는 유효 데이터가 아니므로 버전은 올리지 않는다 (§9.5).
   */
  renameDataset(datasetId: string, name: string): DatasetSummary {
    const row = this.db.select().from(datasets).where(eq(datasets.id, datasetId)).get();
    if (!row) throw new Error(`데이터셋을 찾을 수 없습니다: ${datasetId}`);

    if (row.name !== name) {
      const taken = this.db.select().from(datasets).where(eq(datasets.name, name)).get();
      if (taken) throw new Error(`같은 이름의 데이터셋이 이미 있습니다: ${name}`);
      this.db
        .update(datasets)
        .set({ name, updatedAtMs: this.clock.now() })
        .where(eq(datasets.id, datasetId))
        .run();
      this.audit.record('system', 'dataset.renamed', { datasetId, from: row.name, to: name });
    }
    const updated = this.db.select().from(datasets).where(eq(datasets.id, datasetId)).get();
    return this.toSummary(updated as typeof datasets.$inferSelect);
  }

  /**
   * 데이터셋 삭제 — 메타데이터(cascade)와 물리 Parquet 을 함께 지운다.
   * 물리 삭제를 먼저 한다: 파일 삭제가 실패하면 중단되어 데이터셋이 온전히 남고,
   * DB 를 먼저 지우면 실패 시 디스크에 고아 파티션이 조용히 남는다.
   */
  async deleteDataset(datasetId: string): Promise<void> {
    const row = this.db.select().from(datasets).where(eq(datasets.id, datasetId)).get();
    if (!row) throw new Error(`데이터셋을 찾을 수 없습니다: ${datasetId}`);

    const runningSync = this.db
      .select({ id: dataImportJobs.id })
      .from(dataImportJobs)
      .where(
        and(
          eq(dataImportJobs.datasetId, datasetId),
          inArray(dataImportJobs.status, ['QUEUED', 'RUNNING']),
        ),
      )
      .get();
    if (runningSync) {
      throw new Error('데이터 작업이 실행 중입니다 — 완료 후 삭제하세요');
    }

    await this.candleRepository.deleteDataset(datasetId);
    this.db.delete(datasets).where(eq(datasets.id, datasetId)).run();
    this.audit.record('system', 'dataset.deleted', { datasetId, name: row.name });
  }

  /**
   * 검증 차트용 캔들 조회 (설계 2026-07-28-candle-inspection-design.md).
   * 상한 초과는 다운샘플링하지 않고 명시적으로 거부한다 — 검증 화면은 봉을 정직하게
   * 보여줘야 한다 (백테스트 결과 차트의 LTTB 와 다른 선택).
   */
  async getCandlesForInspection(
    datasetId: string,
    symbol: string,
    timeframe: Timeframe,
    fromTsMs: number,
    toTsMs: number,
    maxRows = 2000,
  ): Promise<{ candles: Candle[]; missingRanges: Array<{ fromTsMs: number; toTsMs: number }> }> {
    const dataset = this.getDataset(datasetId);
    if (!dataset) throw new Error(`데이터셋을 찾을 수 없습니다: ${datasetId}`);
    if (!dataset.symbols.includes(symbol)) {
      throw new Error(`이 데이터셋에 없는 심볼입니다: ${symbol}`);
    }

    // 허용 timeframe = 슬라이스가 보관하는 timeframe 합집합 중 실제 캔들이 있는 것.
    // 데이터셋은 종목 그룹이라 두 슬라이스(1d·1m)의 데이터가 동시에 존재할 수 있다 —
    // 예전처럼 dataset.timeframe 하나로 두 가지만 고정할 수 없다.
    const candidateTimeframes = [...new Set(ALL_SLICES.flatMap((slice) => sliceTimeframes(slice)))];
    const available: Timeframe[] = [];
    for (const candidate of candidateTimeframes) {
      const timestamps = await this.candleRepository.getTimestamps(
        datasetId,
        dataset.market,
        candidate,
        symbol,
      );
      if (timestamps.length > 0) available.push(candidate);
    }
    if (!available.includes(timeframe)) {
      throw new Error(
        available.length > 0
          ? `이 데이터셋은 ${available.join('/')} 만 제공합니다`
          : '이 데이터셋에는 아직 수집된 캔들이 없습니다 — 동기화 또는 CSV 가져오기 후 조회하세요.',
      );
    }

    const candles: Candle[] = [];
    for await (const candle of this.candleRepository.getCandles({
      datasetId,
      market: dataset.market,
      timeframe,
      symbols: [symbol],
      fromTsMs,
      toTsMs,
    })) {
      candles.push(candle);
      if (candles.length > maxRows) {
        throw new Error(`구간에 봉이 ${maxRows}개를 넘습니다 — 조회 기간을 줄이세요`);
      }
    }

    // 커버리지 음영은 그 슬라이스의 coverage 계산 기준 timeframe 일 때만 그린다
    // (1d 슬라이스 → 1d, 1m 슬라이스 → 1h) — 다른 timeframe 뷰에 근사 음영을 그리지 않는다
    let missingRanges: Array<{ fromTsMs: number; toTsMs: number }> = [];
    const slice = sliceForTimeframe(timeframe);
    if (coverageTimeframeForSlice(slice) === timeframe) {
      const row = this.getCoverage(datasetId).find(
        (coverage) => coverage.symbol === symbol && coverage.slice === slice,
      );
      if (row?.missingRangesJson) {
        missingRanges = (
          JSON.parse(row.missingRangesJson) as Array<{ fromTsMs: number; toTsMs: number }>
        ).filter((range) => range.toTsMs >= fromTsMs && range.fromTsMs <= toTsMs);
      }
    }

    return { candles, missingRanges };
  }

  getLatestVersion(datasetId: string): { version: number; contentHash: string } | null {
    const latest = this.db
      .select()
      .from(datasetVersions)
      .where(eq(datasetVersions.datasetId, datasetId))
      .orderBy(desc(datasetVersions.version))
      .limit(1)
      .get();
    return latest ? { version: latest.version, contentHash: latest.contentHash } : null;
  }

  /**
   * 체인 해시: 이전 버전 해시에 이번 변경의 지문(seed)을 연결해 전체 변경 이력이
   * 해시에 반영되게 한다. 마지막 변경만 해싱하면 서로 다른 데이터셋이 같은 지문을
   * 가질 수 있다 (재현성 §9.5). CSV import 와 broker sync 가 공유한다.
   */
  bumpVersion(datasetId: string, fingerprintSeed: string, nowMs: number): void {
    const latest = this.getLatestVersion(datasetId);
    const contentHash = createHash('sha256')
      .update(`${latest?.contentHash ?? ''}:${fingerprintSeed}`)
      .digest('hex');
    this.db
      .insert(datasetVersions)
      .values({
        id: newId('dsv'),
        datasetId,
        version: (latest?.version ?? 0) + 1,
        contentHash,
        note: null,
        createdAtMs: nowMs,
      })
      .run();
  }

  /** slice 별 coverage 갱신 — coverageTimeframeForSlice(slice) 기준 timestamps 로 계산하고 그 슬라이스 행만 delete+insert 한다 */
  async refreshCoverage(datasetId: string, market: Market, slice: DatasetSlice): Promise<void> {
    const session = getSessionForMarket(market);
    const dataset = this.db.select().from(datasets).where(eq(datasets.id, datasetId)).get();
    if (!dataset) return;
    const symbols = JSON.parse(dataset.symbolsJson) as string[];
    const timeframe = coverageTimeframeForSlice(slice);

    // 계산(비동기)을 끝낸 뒤 삭제+삽입은 단일 트랜잭션으로 —
    // 동시 조회가 비어 있거나 반쯤 채워진 coverage 를 보지 않는다
    const rows: (typeof dataCoverage.$inferInsert)[] = [];
    for (const symbol of symbols) {
      const timestamps = await this.candleRepository.getTimestamps(
        datasetId,
        market,
        timeframe,
        symbol,
      );
      const coverage = computeCoverage(timeframe, timestamps, session);
      rows.push({
        datasetId,
        symbol,
        slice,
        firstTsMs: coverage.firstTsMs,
        lastTsMs: coverage.lastTsMs,
        barCount: coverage.barCount,
        expectedBarCount: coverage.expectedBarCount,
        missingRangesJson: JSON.stringify(coverage.missingRanges),
        computedAtMs: this.clock.now(),
      });
    }

    this.db.transaction((tx) => {
      tx.delete(dataCoverage)
        .where(and(eq(dataCoverage.datasetId, datasetId), eq(dataCoverage.slice, slice)))
        .run();
      for (const row of rows) tx.insert(dataCoverage).values(row).run();
    });
  }
}
