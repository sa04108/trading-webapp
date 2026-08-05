import { and, asc, eq, gt, gte, lte } from 'drizzle-orm';
import type { Clock } from '../../../shared/clock.js';
import type { AppDatabase } from '../../../shared/db/database.js';
import {
  symbolMasterCheckpointSymbols,
  symbolMasterCheckpoints,
  symbolMasterCoverage,
  symbolMasterEvents,
} from '../../../shared/db/schema.js';
import { newId } from '../../../shared/ids.js';
import type { Logger } from '../../../shared/logger.js';
import type { KrxMarket } from '../domain/krx-universe-types.js';
import {
  applyEventsBackward,
  applyEventsForward,
  type SymbolMasterEntry,
  type SymbolMasterEventDraft,
  type SymbolMasterInstrumentType,
  type UniverseState,
} from '../domain/symbol-master.js';
import type { KrxHistoricalUniverseSource } from './ports.js';

export type SymbolMasterEventRow = typeof symbolMasterEvents.$inferSelect;
type SymbolMasterCheckpointRow = typeof symbolMasterCheckpoints.$inferSelect;

export interface SymbolMasterServiceDeps {
  readonly db: AppDatabase;
  /** 다음 태스크(재구성 갭 채우기)가 쓴다 — 이 태스크는 저장·조회만 다뤄 미사용이다 */
  readonly source: KrxHistoricalUniverseSource;
  readonly clock: Clock;
  readonly logger: Logger;
}

/** 요청한 날짜를 커버하는 체크포인트가 하나도 없을 때 던진다 */
export class SymbolMasterNotCoveredError extends Error {
  constructor(readonly date: string) {
    super(`종목 마스터가 ${date} 를 커버하지 않는다`);
    this.name = 'SymbolMasterNotCoveredError';
  }
}

/** DB row 를 도메인 이벤트 draft 로 좁힌다 — drizzle 은 text 컬럼을 string 으로만 추론한다 */
function toEventDraft(row: SymbolMasterEventRow): SymbolMasterEventDraft {
  return {
    effectiveDate: row.effectiveDate,
    standardCode: row.standardCode,
    eventType: row.eventType as SymbolMasterEventDraft['eventType'],
    oldValue: row.oldValue,
    newValue: row.newValue,
    observedSpanStart: row.observedSpanStart,
  };
}

export class SymbolMasterService {
  constructor(private readonly deps: SymbolMasterServiceDeps) {}

  /** 유니버스 전체 스냅샷을 새 체크포인트로 저장한다. 반환값은 체크포인트 id */
  saveCheckpoint(
    date: string,
    universeState: UniverseState,
    verified: boolean,
    mismatch?: object,
  ): string {
    const id = newId('smc');
    const now = this.deps.clock.now();
    this.deps.db.transaction((tx) => {
      tx.insert(symbolMasterCheckpoints).values({
        id,
        checkpointDate: date,
        source: 'KRX',
        verifiedAtMs: verified ? now : null,
        mismatchJson: mismatch ? JSON.stringify(mismatch) : null,
        createdAtMs: now,
      }).run();

      const rows = [...universeState.values()].map((entry) => ({ checkpointId: id, ...entry }));
      // SQLite 바인딩 변수 한도(999)를 피하려 500개 단위로 나눠 넣는다
      for (let i = 0; i < rows.length; i += 500) {
        tx.insert(symbolMasterCheckpointSymbols).values(rows.slice(i, i + 500)).run();
      }
    });
    return id;
  }

  /** 체크포인트 + 이벤트 재구성으로 특정 시점의 유니버스 상태를 만든다 */
  getUniverseAsOf(date: string): UniverseState {
    const cp = this.nearestCheckpoint(date);
    if (!cp) throw new SymbolMasterNotCoveredError(date);

    const symbolRows = this.deps.db
      .select()
      .from(symbolMasterCheckpointSymbols)
      .where(eq(symbolMasterCheckpointSymbols.checkpointId, cp.id))
      .all();
    const base: UniverseState = new Map(symbolRows.map((row) => [row.standardCode, {
      standardCode: row.standardCode,
      shortCode: row.shortCode,
      name: row.name,
      market: row.market as KrxMarket,
      sharesOutstanding: row.sharesOutstanding,
      instrumentType: row.instrumentType as SymbolMasterInstrumentType,
      listedDate: row.listedDate,
    } satisfies SymbolMasterEntry]));

    if (date >= cp.checkpointDate) {
      // (cp.checkpointDate, date] 구간을 순방향으로 적용한다
      const events = this.eventsBetween(cp.checkpointDate, date);
      return applyEventsForward(base, events);
    }
    // (date, cp.checkpointDate] 구간을 역방향으로 적용한다
    const events = this.eventsBetween(date, cp.checkpointDate);
    return applyEventsBackward(base, events);
  }

  /** 수집 완료 구간 목록 — startDate 오름차순 */
  coverageRanges(): { startDate: string; endDate: string }[] {
    return this.deps.db
      .select({
        startDate: symbolMasterCoverage.startDate,
        endDate: symbolMasterCoverage.endDate,
      })
      .from(symbolMasterCoverage)
      .orderBy(asc(symbolMasterCoverage.startDate))
      .all();
  }

  /** 주어진 날짜를 포함하는 수집 완료 구간이 있는지 */
  isCovered(date: string): boolean {
    const row = this.deps.db
      .select({ id: symbolMasterCoverage.id })
      .from(symbolMasterCoverage)
      .where(and(lte(symbolMasterCoverage.startDate, date), gte(symbolMasterCoverage.endDate, date)))
      .get();
    return row !== undefined;
  }

  /** [from, to] 구간의 이벤트 원본 row (id 포함) — effectiveDate, id 오름차순 */
  listEvents(from: string, to: string): SymbolMasterEventRow[] {
    return this.deps.db
      .select()
      .from(symbolMasterEvents)
      .where(and(gte(symbolMasterEvents.effectiveDate, from), lte(symbolMasterEvents.effectiveDate, to)))
      .orderBy(asc(symbolMasterEvents.effectiveDate), asc(symbolMasterEvents.id))
      .all();
  }

  /**
   * |checkpointDate - date| 최소인 체크포인트를 고른다. 동률이면 과거 쪽을 택한다 —
   * 체크포인트 개수가 적어(분기 경계마다 하나) 전체를 읽어 비교해도 비용이 무시할 만하다.
   */
  private nearestCheckpoint(date: string): SymbolMasterCheckpointRow | undefined {
    const rows = this.deps.db.select().from(symbolMasterCheckpoints).all();
    const target = Date.parse(date);
    let best: SymbolMasterCheckpointRow | undefined;
    let bestDiff = Infinity;
    for (const row of rows) {
      const diff = Math.abs(Date.parse(row.checkpointDate) - target);
      if (
        diff < bestDiff
        || (diff === bestDiff && best !== undefined && row.checkpointDate < best.checkpointDate)
      ) {
        best = row;
        bestDiff = diff;
      }
    }
    return best;
  }

  /**
   * (from, to] 구간의 이벤트를 effectiveDate·id 오름차순으로 가져온다. from 을 배제해야
   * 체크포인트 자체 날짜의 이벤트를 중복 적용하지 않는다. 같은 날 여러 이벤트가 있을 때도
   * id 순서를 보존해야 순방향·역방향 적용이 서로 왕복 가능하다.
   */
  private eventsBetween(from: string, to: string): SymbolMasterEventDraft[] {
    return this.deps.db
      .select()
      .from(symbolMasterEvents)
      .where(and(gt(symbolMasterEvents.effectiveDate, from), lte(symbolMasterEvents.effectiveDate, to)))
      .orderBy(asc(symbolMasterEvents.effectiveDate), asc(symbolMasterEvents.id))
      .all()
      .map(toEventDraft);
  }
}
