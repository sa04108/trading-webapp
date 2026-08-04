import { createHash } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import type { AppDatabase } from '../../../shared/db/database.js';
import {
  datasetSymbols,
  datasets,
  symbols as symbolsTable,
  universeSnapshots,
} from '../../../shared/db/schema.js';
import type { Clock } from '../../../shared/clock.js';
import { newId } from '../../../shared/ids.js';
import type { AuditLogService } from '../../audit/audit-service.js';
import { SYMBOL_PATTERN, type Market } from '../domain/candle.js';
import type { DatasetSlice } from '../domain/dataset-slice.js';
import { FACTS_SLICE, type SymbolService } from './symbol-service.js';

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

/**
 * 데이터셋은 이름과 종목 참조뿐이다 (설계 2026-07-31-symbol-as-first-class).
 *
 * `market`·`defaultTimeframe` 이 없다: market 은 종목의 속성이고, 소비 봉 주기는 이미
 * 백테스트 요청 필드다. 종목 구성 중복 금지(구 `symbolsKey`/`DuplicateSymbolGroupError`)도
 * 없앴다 — 그 규칙이 막던 비용은 같은 종목을 두 번 긁는 것이었고, 데이터가 종목에
 * 종속된 뒤로는 구성이 같은 데이터셋 둘이 디스크도 호출도 더 쓰지 않는다.
 */
export interface DatasetSummary {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly symbols: readonly string[];
  readonly createdAtMs: number;
  /** KRX 스냅샷 확정이 만든 데이터셋이면 그 출처 — 기준 시점·정렬 기준 표시용.
   *  손으로 만든 데이터셋은 null. */
  readonly universeSnapshot: {
    readonly snapshotId: string;
    readonly effectiveTradingDate: string;
    readonly sortKey: string;
  } | null;
}

/** 실행이 소비한 (종목, 슬라이스, 버전, 해시) — §9.5 재현성 스냅샷의 한 칸 */
export interface UniverseEntry {
  readonly code: string;
  readonly slice: string;
  readonly version: number;
  readonly contentHash: string;
}

export interface UniverseSnapshot {
  readonly entries: readonly UniverseEntry[];
  /** 정렬된 항목을 이어 붙인 집계 해시 — 구 datasetHash 자리 */
  readonly hash: string;
}

export class DatasetService {
  constructor(
    private readonly db: AppDatabase,
    private readonly symbolService: SymbolService,
    private readonly clock: Clock,
    private readonly audit: AuditLogService,
  ) {}

  listDatasets(): DatasetSummary[] {
    const rows = this.db.select().from(datasets).all();
    if (rows.length === 0) return [];
    const refs = this.db.select().from(datasetSymbols).all();
    const byDataset = new Map<string, string[]>();
    for (const ref of refs) {
      const list = byDataset.get(ref.datasetId) ?? [];
      list.push(ref.code);
      byDataset.set(ref.datasetId, list);
    }
    // 스냅샷 연결 데이터셋만 모아 한 번에 조회한다 — 행마다 조회하면 목록이 커질수록
    // N+1 이 된다.
    const snapshotIds = rows
      .map((row) => row.universeSnapshotId)
      .filter((id): id is string => id !== null);
    const snapshotById = new Map(
      snapshotIds.length === 0
        ? []
        : this.db
            .select()
            .from(universeSnapshots)
            .where(inArray(universeSnapshots.id, snapshotIds))
            .all()
            .map((row) => [row.id, row]),
    );
    return rows.map((row) =>
      this.toSummary(
        row,
        byDataset.get(row.id) ?? [],
        row.universeSnapshotId !== null ? snapshotById.get(row.universeSnapshotId) ?? null : null,
      ),
    );
  }

  getDataset(datasetId: string): DatasetSummary | null {
    const row = this.db.select().from(datasets).where(eq(datasets.id, datasetId)).get();
    if (!row) return null;
    const snapshotRow =
      row.universeSnapshotId !== null
        ? this.db
            .select()
            .from(universeSnapshots)
            .where(eq(universeSnapshots.id, row.universeSnapshotId))
            .get() ?? null
        : null;
    return this.toSummary(row, this.symbolsOf(datasetId), snapshotRow);
  }

  private toSummary(
    row: typeof datasets.$inferSelect,
    codes: string[],
    snapshotRow: typeof universeSnapshots.$inferSelect | null,
  ): DatasetSummary {
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      // 정렬은 저장 순서가 아니라 조회 시점에 — 참조 테이블에 순서 개념이 없다
      symbols: [...codes].sort(),
      createdAtMs: row.createdAtMs,
      universeSnapshot: snapshotRow
        ? {
            snapshotId: snapshotRow.id,
            effectiveTradingDate: snapshotRow.effectiveTradingDate,
            sortKey: snapshotRow.sortKey,
          }
        : null,
    };
  }

  private symbolsOf(datasetId: string): string[] {
    return this.db
      .select({ code: datasetSymbols.code })
      .from(datasetSymbols)
      .where(eq(datasetSymbols.datasetId, datasetId))
      .all()
      .map((row) => row.code);
  }

  /** 데이터셋 생성 — 종목은 **이미 등록된 것만** 참조한다 */
  createDataset(name: string, codes: readonly string[]): DatasetSummary {
    if (codes.length === 0) throw new Error('종목이 최소 1개 필요합니다');
    for (const code of codes) {
      if (!SYMBOL_PATTERN.test(code)) throw new Error(`invalid symbol: ${code}`);
    }
    const unique = [...new Set(codes)].sort();
    this.assertRegistered(unique);

    if (this.db.select().from(datasets).where(eq(datasets.name, name)).get()) {
      throw new Error(`같은 이름의 데이터셋이 이미 있습니다: ${name}`);
    }

    const now = this.clock.now();
    const id = newId('ds');
    this.db.transaction((tx) => {
      tx.insert(datasets).values({ id, name, description: null, createdAtMs: now, updatedAtMs: now }).run();
      for (const code of unique) tx.insert(datasetSymbols).values({ datasetId: id, code }).run();
    });
    this.audit.record('system', 'dataset.created', { datasetId: id, name, symbols: unique });
    return this.getDataset(id)!;
  }

  /**
   * 등록되지 않은 종목 참조를 거부한다. 자동 등록하면 시장을 추측해야 하고, 데이터셋이
   * 종목을 만들어내면 "데이터셋은 참조만 갖는다" 는 규칙이 그 자리에서 깨진다.
   */
  private assertRegistered(codes: readonly string[]): void {
    const known = new Set(
      this.db
        .select({ code: symbolsTable.code })
        .from(symbolsTable)
        .where(inArray(symbolsTable.code, [...codes]))
        .all()
        .map((row) => row.code),
    );
    const missing = codes.filter((code) => !known.has(code));
    if (missing.length > 0) {
      throw new Error(
        `등록되지 않은 종목입니다: ${missing.join(', ')} — 종목 화면에서 먼저 추가하세요`,
      );
    }
  }

  /** 참조 편집. 봉·재무는 종목 소관이라 여기서 지워지는 것은 참조뿐이다 */
  updateSymbols(
    datasetId: string,
    change: { add?: readonly string[]; remove?: readonly string[] },
  ): DatasetSummary {
    if (!this.db.select().from(datasets).where(eq(datasets.id, datasetId)).get()) {
      throw new Error(`데이터셋을 찾을 수 없습니다: ${datasetId}`);
    }
    for (const code of [...(change.add ?? []), ...(change.remove ?? [])]) {
      if (!SYMBOL_PATTERN.test(code)) throw new Error(`invalid symbol: ${code}`);
    }
    this.assertRegistered(change.add ?? []);

    const current = new Set(this.symbolsOf(datasetId));
    for (const code of change.add ?? []) current.add(code);
    for (const code of change.remove ?? []) current.delete(code);
    if (current.size === 0) {
      throw new Error('종목이 최소 1개 남아야 합니다 — 전부 비우려면 데이터셋을 삭제하세요');
    }

    const now = this.clock.now();
    this.db.transaction((tx) => {
      tx.delete(datasetSymbols).where(eq(datasetSymbols.datasetId, datasetId)).run();
      for (const code of [...current].sort()) {
        tx.insert(datasetSymbols).values({ datasetId, code }).run();
      }
      tx.update(datasets).set({ updatedAtMs: now }).where(eq(datasets.id, datasetId)).run();
    });
    this.audit.record('system', 'dataset.symbols.updated', {
      datasetId,
      add: change.add ?? [],
      remove: change.remove ?? [],
    });
    return this.getDataset(datasetId)!;
  }

  renameDataset(datasetId: string, name: string): DatasetSummary {
    const row = this.db.select().from(datasets).where(eq(datasets.id, datasetId)).get();
    if (!row) throw new Error(`데이터셋을 찾을 수 없습니다: ${datasetId}`);
    if (row.name !== name) {
      if (this.db.select().from(datasets).where(eq(datasets.name, name)).get()) {
        throw new Error(`같은 이름의 데이터셋이 이미 있습니다: ${name}`);
      }
      this.db
        .update(datasets)
        .set({ name, updatedAtMs: this.clock.now() })
        .where(eq(datasets.id, datasetId))
        .run();
      this.audit.record('system', 'dataset.renamed', { datasetId, from: row.name, to: name });
    }
    return this.getDataset(datasetId)!;
  }

  /**
   * 데이터셋 삭제 — **참조만 끊는다**. 봉·재무는 종목 소관이고 다른 데이터셋이 같은
   * 종목을 참조할 수 있다. 종전에는 여기서 Parquet 파티션을 재귀 삭제했다.
   */
  deleteDataset(datasetId: string): void {
    const row = this.db.select().from(datasets).where(eq(datasets.id, datasetId)).get();
    if (!row) throw new Error(`데이터셋을 찾을 수 없습니다: ${datasetId}`);
    this.db.delete(datasets).where(eq(datasets.id, datasetId)).run();
    this.audit.record('system', 'dataset.deleted', { datasetId, name: row.name });
  }

  /** 데이터셋 종목들의 시장 — 참조가 여러 시장에 걸치면 백테스트가 성립하지 않는다 */
  marketOf(datasetId: string): Market | null {
    const codes = this.symbolsOf(datasetId);
    if (codes.length === 0) return null;
    const markets = new Set(
      this.db
        .select({ market: symbolsTable.market })
        .from(symbolsTable)
        .where(inArray(symbolsTable.code, codes))
        .all()
        .map((row) => row.market),
    );
    return markets.size === 1 ? ([...markets][0] as Market) : null;
  }

  /**
   * 실행이 소비할 (종목, 슬라이스) 버전 스냅샷 (§9.5).
   *
   * 봉 슬라이스와 재무를 함께 담는다 — 둘 다 백테스트 입력이고, 재무만 백필해도 결과가
   * 달라진다. 버전이 없는 조합은 version 0 으로 남긴다: "아직 수집 안 됨" 도 입력 상태의
   * 일부이고, 빠뜨리면 나중에 수집된 실행과 스냅샷이 같아 보인다.
   */
  universeSnapshot(datasetId: string, slice: DatasetSlice): UniverseSnapshot {
    return this.universeSnapshotFor(this.symbolsOf(datasetId), slice);
  }

  universeSnapshotFor(codes: readonly string[], slice: DatasetSlice): UniverseSnapshot {
    const uniqueCodes = [...new Set(codes)].sort();
    const entries: UniverseEntry[] = [];
    for (const code of uniqueCodes) {
      for (const axis of [slice, FACTS_SLICE]) {
        const latest = this.symbolService.getLatestVersion(code, axis);
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
}
