import { createHash } from 'node:crypto';
import { and, asc, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import type { AuditLogService } from '../../audit/audit-service.js';
import type { Clock } from '../../../shared/clock.js';
import type { AppDatabase } from '../../../shared/db/database.js';
import {
  symbols,
  universeSnapshots,
  universeSnapshotSymbols,
} from '../../../shared/db/schema.js';
import { newId } from '../../../shared/ids.js';
import type { Logger } from '../../../shared/logger.js';
import {
  selectionPayloadOf,
  type EligibleCandidate,
} from '../domain/historical-universe.js';
import {
  PreviewExpiredError,
  type HistoricalUniverseService,
  type HistoricalUniversePreview,
} from './historical-universe-service.js';

const MAX_SNAPSHOT_SYMBOLS = 1_000;
const PREVIEW_EXPIRED_GUIDANCE = '미리보기가 만료되었거나 내용이 바뀌었습니다 — 다시 조회하세요.';
const SOURCE_KIND = 'KRX_HISTORICAL' as const;
const MANUAL_SELECTION = 'MANUAL_FROM_KRX_SNAPSHOT' as const;

type SelectionMethod = 'TOP_MARKET_CAP_N' | typeof MANUAL_SELECTION;

export class SnapshotSelectionError extends Error {
  constructor(message?: string) {
    super(message);
    this.name = 'SnapshotSelectionError';
  }
}

export class SymbolIdentityConflictError extends Error {
  constructor(message?: string) {
    super(message);
    this.name = 'SymbolIdentityConflictError';
  }
}

export interface UniverseSnapshotSummary {
  readonly id: string;
  readonly sourceKind: typeof SOURCE_KIND;
  readonly requestedDate: string;
  readonly effectiveTradingDate: string;
  readonly usableFromDate: string;
  readonly selectionMethod: SelectionMethod;
  readonly selectionN: number | null;
  readonly selectedCount: number;
  readonly unknownMarketCapCount: number;
  readonly createdAtMs: number;
  /** 백테스트 provenance pin 조립용 (Task 12) — 필터 정책 버전 */
  readonly filterPolicyVersion: string;
  /** 백테스트 provenance pin 조립용 (Task 12) — 선택 종목 집합의 재현 해시 */
  readonly selectionHash: string;
}

export interface UniverseSnapshotDetail extends UniverseSnapshotSummary {
  readonly symbols: ReadonlyArray<{
    readonly standardCode: string;
    readonly shortCode: string;
    readonly name: string;
    readonly market: 'KOSPI' | 'KOSDAQ';
    readonly marketCapKrw: string | null;
    readonly rank: number | null;
  }>;
  readonly krxApprovalExpiryDate: string | null;
}

interface SelectedIdentityState {
  readonly existingByShortCode: ReadonlyMap<string, typeof symbols.$inferSelect>;
  readonly unmapped: readonly EligibleCandidate[];
}

function isSymbolIdentityUniqueConstraint(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 10 && current instanceof Error; depth += 1) {
    if (/UNIQUE constraint failed: symbols\.(?:code|standard_code)/i.test(current.message)) {
      return true;
    }
    current = current.cause;
  }
  return false;
}

export class UniverseSnapshotService {
  constructor(private readonly deps: {
    readonly db: AppDatabase;
    readonly universe: HistoricalUniverseService;
    readonly clock: Clock;
    readonly audit: AuditLogService;
    readonly logger: Logger;
    readonly approvalExpiry: string | null;
  }) {}

  async createFromPreview(args: {
    readonly previewId: string;
    readonly selectedStandardCodes: readonly string[];
    readonly selectionMethod: SelectionMethod;
    readonly selectionN: number | null;
  }): Promise<UniverseSnapshotDetail> {
    const preview = this.deps.universe.getPreview(args.previewId);
    if (preview === null) throw new PreviewExpiredError(PREVIEW_EXPIRED_GUIDANCE);

    const selected = this.validateSelection(preview, args);
    const initialIdentity = this.inspectExistingSymbols(selected, this.deps.db);
    let currentStandardCodeMap: ReadonlyMap<string, string> | null = null;
    if (initialIdentity.unmapped.length > 0) {
      currentStandardCodeMap = await this.deps.universe.currentStandardCodeMap();
      for (const candidate of initialIdentity.unmapped) {
        if (currentStandardCodeMap.get(candidate.shortCode) !== candidate.standardCode) {
          throw new SymbolIdentityConflictError(
            `기존 종목 ${candidate.shortCode}의 표준코드를 현재 KRX 정보로 검증할 수 없습니다.`,
          );
        }
      }
    }

    const createdAtMs = this.deps.clock.now();
    const selectionHash = createHash('sha256')
      .update(selectionPayloadOf(preview.set.canonicalPayload, args.selectedStandardCodes))
      .digest('hex');
    let snapshotId = '';

    try {
      this.deps.db.transaction((tx) => {
        const identity = this.inspectExistingSymbols(selected, tx);
        for (const candidate of selected) {
          const existing = identity.existingByShortCode.get(candidate.shortCode);
          if (existing === undefined) {
            tx.insert(symbols).values({
              code: candidate.shortCode,
              standardCode: candidate.standardCode,
              market: 'KR',
              name: candidate.name,
              createdAtMs,
            }).run();
          } else if (existing.standardCode === null) {
            if (currentStandardCodeMap?.get(candidate.shortCode) !== candidate.standardCode) {
              throw new SymbolIdentityConflictError(
                `기존 종목 ${candidate.shortCode}의 표준코드를 현재 KRX 정보로 검증할 수 없습니다.`,
              );
            }
            const result = tx.update(symbols)
              .set({ standardCode: candidate.standardCode })
              .where(and(eq(symbols.code, candidate.shortCode), isNull(symbols.standardCode)))
              .run();
            if (result.changes !== 1) {
              throw new SymbolIdentityConflictError(
                `기존 종목 ${candidate.shortCode}의 표준코드가 저장 중 변경되었습니다.`,
              );
            }
          }
        }

        snapshotId = newId('usn');
        tx.insert(universeSnapshots).values({
          id: snapshotId,
          sourceKind: SOURCE_KIND,
          requestedDate: preview.requestedDate,
          effectiveTradingDate: preview.effectiveTradingDate,
          usableFromDate: preview.usableFromDate,
          usableFromRule: preview.usableFromRule,
          marketsJson: JSON.stringify(['KOSPI', 'KOSDAQ']),
          filterPolicyVersion: preview.set.filterPolicyVersion,
          contractVersion: preview.set.contractVersion,
          sortKey: 'MKTCAP',
          sortDirection: 'DESC',
          selectionMethod: args.selectionMethod,
          selectionN: args.selectionN,
          selectedCount: selected.length,
          eligibleCount: preview.set.eligibleCount,
          unknownMarketCapCount: preview.set.unknownMarketCapCount,
          excludedByTypeJson: JSON.stringify(preview.set.excludedByType),
          rawCountsJson: JSON.stringify(preview.set.rawCounts),
          selectionHash,
          candidateCanonicalHash: preview.canonicalHash,
          krxApprovalExpiryDate: this.deps.approvalExpiry,
          createdAtMs,
        }).run();

        tx.insert(universeSnapshotSymbols).values(selected.map((candidate) => ({
          snapshotId,
          standardCode: candidate.standardCode,
          shortCode: candidate.shortCode,
          nameAtSelection: candidate.name,
          marketAtSelection: candidate.market,
          marketCapKrw: candidate.marketCapKrw?.toString() ?? null,
          rank: candidate.rank,
          instrumentType: 'COMMON_STOCK',
        }))).run();
      });
    } catch (error) {
      if (error instanceof SymbolIdentityConflictError) throw error;
      if (isSymbolIdentityUniqueConstraint(error)) {
        throw new SymbolIdentityConflictError('종목 단축코드 또는 표준코드가 기존 식별자와 충돌합니다.');
      }
      throw error;
    }

    try {
      this.deps.audit.record('system', 'universe.snapshot.created', {
        snapshotId,
        effectiveTradingDate: preview.effectiveTradingDate,
        selectedCount: selected.length,
        selectionMethod: args.selectionMethod,
      });
    } catch (error) {
      try {
        this.deps.logger.error({
          event: 'universe.snapshot.audit.failed',
          snapshotId,
          err: error,
        }, 'committed universe snapshot audit failed');
      } catch {
        // 커밋된 성공을 후속 관찰 실패 때문에 재시도 가능한 실패로 바꾸지 않는다.
      }
    }

    return this.getSnapshot(snapshotId)!;
  }

  listSnapshots(): UniverseSnapshotSummary[] {
    return this.deps.db
      .select()
      .from(universeSnapshots)
      .orderBy(desc(universeSnapshots.createdAtMs), desc(universeSnapshots.id))
      .all()
      .map((row) => this.toSummary(row));
  }

  getSnapshot(id: string): UniverseSnapshotDetail | null {
    const row = this.deps.db
      .select()
      .from(universeSnapshots)
      .where(eq(universeSnapshots.id, id))
      .get();
    if (row === undefined) return null;

    const snapshotSymbols = this.deps.db
      .select()
      .from(universeSnapshotSymbols)
      .where(eq(universeSnapshotSymbols.snapshotId, id))
      .orderBy(
        sql`${universeSnapshotSymbols.rank} is null`,
        asc(universeSnapshotSymbols.rank),
        asc(universeSnapshotSymbols.shortCode),
        asc(universeSnapshotSymbols.standardCode),
      )
      .all();

    return {
      ...this.toSummary(row),
      symbols: snapshotSymbols.map((item) => ({
        standardCode: item.standardCode,
        shortCode: item.shortCode,
        name: item.nameAtSelection,
        market: item.marketAtSelection as 'KOSPI' | 'KOSDAQ',
        marketCapKrw: item.marketCapKrw,
        rank: item.rank,
      })),
      krxApprovalExpiryDate: row.krxApprovalExpiryDate,
    };
  }

  private validateSelection(
    preview: HistoricalUniversePreview,
    args: {
      readonly selectedStandardCodes: readonly string[];
      readonly selectionMethod: SelectionMethod;
      readonly selectionN: number | null;
    },
  ): EligibleCandidate[] {
    const selectedCodes = new Set(args.selectedStandardCodes);
    if (
      args.selectedStandardCodes.length < 1
      || args.selectedStandardCodes.length > MAX_SNAPSHOT_SYMBOLS
      || selectedCodes.size !== args.selectedStandardCodes.length
    ) {
      throw new SnapshotSelectionError('스냅샷 선택 종목 수는 중복 없이 1개 이상 1,000개 이하여야 합니다.');
    }

    const candidateByStandardCode = new Map(
      preview.set.candidates.map((candidate) => [candidate.standardCode, candidate]),
    );
    for (const standardCode of selectedCodes) {
      if (!candidateByStandardCode.has(standardCode)) {
        throw new SnapshotSelectionError(`미리보기 후보에 없는 표준코드입니다: ${standardCode}`);
      }
    }

    if (args.selectionMethod === MANUAL_SELECTION) {
      if (args.selectionN !== null) {
        throw new SnapshotSelectionError('수동 선택의 selectionN은 null이어야 합니다.');
      }
    } else {
      if (!Number.isInteger(args.selectionN) || args.selectionN === null || args.selectionN < 1) {
        throw new SnapshotSelectionError('상위 N 선택에는 1 이상의 정수 selectionN이 필요합니다.');
      }
      if (
        preview.set.unknownMarketCapCount !== 0
        || preview.set.candidates.some((candidate) => candidate.marketCapKrw === null)
      ) {
        throw new SnapshotSelectionError('시가총액 unknown 후보가 있어 정확한 상위 N을 선택할 수 없습니다.');
      }
      const expected = preview.set.candidates.slice(0, args.selectionN);
      if (
        expected.length !== args.selectionN
        || selectedCodes.size !== args.selectionN
        || expected.some((candidate) => !selectedCodes.has(candidate.standardCode))
      ) {
        throw new SnapshotSelectionError('선택 종목이 서버가 계산한 시가총액 상위 N과 일치하지 않습니다.');
      }
    }

    const selected = preview.set.candidates.filter((candidate) => selectedCodes.has(candidate.standardCode));
    const shortCodeOwners = new Map<string, string>();
    for (const candidate of selected) {
      const owner = shortCodeOwners.get(candidate.shortCode);
      if (owner !== undefined && owner !== candidate.standardCode) {
        throw new SymbolIdentityConflictError(
          `단축코드 ${candidate.shortCode}가 여러 표준코드와 연결되어 있습니다.`,
        );
      }
      shortCodeOwners.set(candidate.shortCode, candidate.standardCode);
    }
    return selected;
  }

  private inspectExistingSymbols(
    selected: readonly EligibleCandidate[],
    database: Pick<AppDatabase, 'select'>,
  ): SelectedIdentityState {
    const shortCodes = selected.map((candidate) => candidate.shortCode);
    const standardCodes = selected.map((candidate) => candidate.standardCode);
    const existingRows = database
      .select()
      .from(symbols)
      .where(or(inArray(symbols.code, shortCodes), inArray(symbols.standardCode, standardCodes)))
      .all();
    const existingByShortCode = new Map(existingRows.map((row) => [row.code, row]));
    const existingByStandardCode = new Map(
      existingRows
        .filter((row): row is typeof row & { standardCode: string } => row.standardCode !== null)
        .map((row) => [row.standardCode, row]),
    );
    const unmapped: EligibleCandidate[] = [];

    for (const candidate of selected) {
      const sameCode = existingByShortCode.get(candidate.shortCode);
      if (sameCode !== undefined) {
        if (sameCode.market !== 'KR') {
          throw new SymbolIdentityConflictError(
            `단축코드 ${candidate.shortCode}가 다른 시장(${sameCode.market}) 종목으로 등록되어 있습니다.`,
          );
        } else if (sameCode.standardCode === null) {
          unmapped.push(candidate);
        } else if (sameCode.standardCode !== candidate.standardCode) {
          throw new SymbolIdentityConflictError(
            `단축코드 ${candidate.shortCode}가 다른 표준코드(${sameCode.standardCode})와 연결되어 있습니다.`,
          );
        }
      }

      const sameStandardCode = existingByStandardCode.get(candidate.standardCode);
      if (sameStandardCode !== undefined && sameStandardCode.code !== candidate.shortCode) {
        throw new SymbolIdentityConflictError(
          `표준코드 ${candidate.standardCode}가 다른 단축코드(${sameStandardCode.code})와 연결되어 있습니다.`,
        );
      }
    }

    return { existingByShortCode, unmapped };
  }

  private toSummary(row: typeof universeSnapshots.$inferSelect): UniverseSnapshotSummary {
    return {
      id: row.id,
      sourceKind: row.sourceKind as typeof SOURCE_KIND,
      requestedDate: row.requestedDate,
      effectiveTradingDate: row.effectiveTradingDate,
      usableFromDate: row.usableFromDate,
      selectionMethod: row.selectionMethod as SelectionMethod,
      selectionN: row.selectionN,
      selectedCount: row.selectedCount,
      unknownMarketCapCount: row.unknownMarketCapCount,
      createdAtMs: row.createdAtMs,
      filterPolicyVersion: row.filterPolicyVersion,
      selectionHash: row.selectionHash,
    };
  }
}
