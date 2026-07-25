import { createHash } from 'node:crypto';
import { desc, eq } from 'drizzle-orm';
import type { AppDatabase } from '../../../shared/db/database.js';
import {
  dataCoverage,
  dataImportJobs,
  datasetVersions,
  datasets,
} from '../../../shared/db/schema.js';
import type { Clock } from '../../../shared/clock.js';
import { newId } from '../../../shared/ids.js';
import type { Logger } from '../../../shared/logger.js';
import type { AuditLogService } from '../../audit/audit-service.js';
import { SYMBOL_PATTERN, type Market, type Timeframe } from '../domain/candle.js';
import { aggregateToHourly } from '../domain/aggregate.js';
import { computeCoverage } from '../domain/coverage.js';
import { getSessionForMarket } from '../domain/exchange-session.js';
import { parseCandleCsv } from './csv-parser.js';
import type { CandleRepository } from './ports.js';

export interface DatasetSummary {
  id: string;
  name: string;
  market: Market;
  timeframe: Timeframe;
  symbols: string[];
  description: string | null;
  latestVersion: number;
  createdAtMs: number;
}

export interface ImportRequest {
  readonly datasetName: string;
  readonly market: Market;
  readonly timeframe: '1m' | '1h';
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
    return rows.map((row) => this.toSummary(row));
  }

  getDataset(datasetId: string): DatasetSummary | null {
    const row = this.db.select().from(datasets).where(eq(datasets.id, datasetId)).get();
    return row ? this.toSummary(row) : null;
  }

  private toSummary(row: typeof datasets.$inferSelect): DatasetSummary {
    const latest = this.db
      .select()
      .from(datasetVersions)
      .where(eq(datasetVersions.datasetId, row.id))
      .orderBy(desc(datasetVersions.version))
      .limit(1)
      .get();
    return {
      id: row.id,
      name: row.name,
      market: row.market as Market,
      timeframe: row.timeframe as Timeframe,
      symbols: JSON.parse(row.symbolsJson) as string[],
      description: row.description,
      latestVersion: latest?.version ?? 0,
      createdAtMs: row.createdAtMs,
    };
  }

  getCoverage(datasetId: string) {
    return this.db.select().from(dataCoverage).where(eq(dataCoverage.datasetId, datasetId)).all();
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

    // CSV 는 데이터셋 메타데이터를 만지기 전에 파싱한다 — 전량 불량인 업로드가
    // 빈 데이터셋을 만들거나 존재하지 않는 심볼을 symbolsJson 에 남기지 않는다
    const parsed = parseCandleCsv(request.csvContent, {
      market: request.market,
      timeframe: request.timeframe,
      symbol: request.symbol,
    });
    if (parsed.candles.length === 0) {
      throw new Error(parsed.errors[0] ?? 'CSV 에 유효한 봉이 없습니다');
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

      // 스펙 §11: 백테스트는 사전 집계 1시간봉 우선 — 1m import 시 1h 를 함께 생성
      if (request.timeframe === '1m') {
        const hourly = aggregateToHourly(parsed.candles, session);
        if (hourly.length === 0) {
          // 모든 봉이 세션 밖 → 세션 불일치·잘못된 데이터. 완료로 위장하지 않는다.
          throw new Error('모든 봉이 거래 세션 밖입니다. 타임스탬프와 시장 설정을 확인하세요.');
        }
        await this.candleRepository.saveCandles(dataset.id, hourly);
      }

      await this.refreshCoverage(dataset.id, request.market, dataset.timeframe as Timeframe);
      this.bumpVersion(dataset.id, request, now);

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
        this.db
          .update(datasets)
          .set({ symbolsJson: JSON.stringify([...symbols].sort()), updatedAtMs: nowMs })
          .where(eq(datasets.id, existing.id))
          .run();
      }
      return { ...existing, symbolsJson: JSON.stringify([...new Set([...JSON.parse(existing.symbolsJson) as string[], request.symbol])].sort()) };
    }

    // 데이터셋의 timeframe 은 백테스트가 소비하는 기준 — 1m import 도 1h 로 사전 집계되므로 1h 로 둔다
    const row: typeof datasets.$inferInsert = {
      id: newId('ds'),
      name: request.datasetName,
      market: request.market,
      timeframe: '1h',
      symbolsJson: JSON.stringify([request.symbol]),
      description: null,
      createdAtMs: nowMs,
      updatedAtMs: nowMs,
    };
    this.db.insert(datasets).values(row).run();
    return row as typeof datasets.$inferSelect;
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

  private bumpVersion(datasetId: string, request: ImportRequest, nowMs: number): void {
    const latest = this.getLatestVersion(datasetId);
    // 체인 해시: 이전 버전 해시에 이번 업로드를 연결해 전체 import 이력이 해시에 반영되게 한다.
    // 마지막 파일만 해싱하면 서로 다른 데이터셋이 같은 지문을 가질 수 있다 (재현성 §9.5).
    const csvHash = createHash('sha256').update(request.csvContent).digest('hex');
    const contentHash = createHash('sha256')
      .update(`${latest?.contentHash ?? ''}:${request.symbol}:${request.timeframe}:${csvHash}`)
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

  async refreshCoverage(datasetId: string, market: Market, timeframe: Timeframe): Promise<void> {
    const session = getSessionForMarket(market);
    const dataset = this.db.select().from(datasets).where(eq(datasets.id, datasetId)).get();
    if (!dataset) return;
    const symbols = JSON.parse(dataset.symbolsJson) as string[];

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
        firstTsMs: coverage.firstTsMs,
        lastTsMs: coverage.lastTsMs,
        barCount: coverage.barCount,
        expectedBarCount: coverage.expectedBarCount,
        missingRangesJson: JSON.stringify(coverage.missingRanges),
        computedAtMs: this.clock.now(),
      });
    }

    this.db.transaction((tx) => {
      tx.delete(dataCoverage).where(eq(dataCoverage.datasetId, datasetId)).run();
      for (const row of rows) tx.insert(dataCoverage).values(row).run();
    });
  }
}
