import { and, asc, desc, eq, gt, gte, lt, lte } from 'drizzle-orm';
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
import { classifyKrxIssue } from '../domain/krx-filter-policy.js';
import { addCalendarDays } from '../domain/kst-date.js';
import type { KrxIssueBaseInfoRow, KrxMarket } from '../domain/krx-universe-types.js';
import {
  applyEventsBackward,
  applyEventsForward,
  diffUniverse,
  type SymbolMasterEntry,
  type SymbolMasterEventDraft,
  type SymbolMasterInstrumentType,
  type UniverseState,
} from '../domain/symbol-master.js';
import type { KrxHistoricalUniverseSource } from './ports.js';

export type SymbolMasterEventRow = typeof symbolMasterEvents.$inferSelect;
type SymbolMasterCheckpointRow = typeof symbolMasterCheckpoints.$inferSelect;
type SymbolMasterCoverageRow = typeof symbolMasterCoverage.$inferSelect;

export interface SymbolMasterServiceDeps {
  readonly db: AppDatabase;
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

export type IngestResult =
  | { readonly kind: 'TRADING_DAY'; readonly eventCount: number; readonly checkpointSaved: boolean }
  | { readonly kind: 'HOLIDAY' }
  | { readonly kind: 'ALREADY_COVERED' };

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

  /**
   * 하루치 KRX 유니버스를 수집해 이벤트·coverage 를 갱신한다. 이미 커버된 날짜는
   * KRX 를 부르지 않고 바로 돌아간다 — 재수집이 호출 한도를 갉아먹지 않게 하기 위해서다.
   */
  async ingestDate(date: string): Promise<IngestResult> {
    if (this.isCovered(date)) {
      return { kind: 'ALREADY_COVERED' };
    }

    // 두 시장 모두 거래가 없으면 휴장이다. 기본정보는 휴장에도 조회되는 정적 데이터라
    // 거래 유무로만 거래일 여부를 가른다.
    const kospiTrades = await this.deps.source.fetchDailyTrades('KOSPI', date);
    const kosdaqTrades = await this.deps.source.fetchDailyTrades('KOSDAQ', date);
    if (kospiTrades.length === 0 && kosdaqTrades.length === 0) {
      this.deps.db.transaction((tx) => this.mergeCoverage(tx, date));
      return { kind: 'HOLIDAY' };
    }

    const fetched = new Map<string, SymbolMasterEntry>();
    for (const row of await this.deps.source.fetchIssueBaseInfo('KOSPI', date)) {
      this.putEntry(fetched, row, 'KOSPI');
    }
    for (const row of await this.deps.source.fetchIssueBaseInfo('KOSDAQ', date)) {
      this.putEntry(fetched, row, 'KOSDAQ');
    }

    const prevDate = this.previousCoveredDate(date);
    if (prevDate === undefined) {
      // 직전 커버일이 없다 — 비교할 과거 이력이 없으니 오늘 스냅샷을 그대로 체크포인트로 굳힌다.
      this.saveCheckpoint(date, fetched, true);
      this.deps.db.transaction((tx) => this.mergeCoverage(tx, date));
      return { kind: 'TRADING_DAY', eventCount: 0, checkpointSaved: true };
    }

    const todaysEvents = diffUniverse(this.getUniverseAsOf(prevDate), fetched, {
      effectiveDate: date,
      observedSpanStart: prevDate,
    });

    // 갭 메우기: date 뒤에 이미 커버된 거래일(D2)이 있으면 그 날의 이벤트는 더 먼 과거를
    // 기준으로 계산돼 있다. 지금 채운 date 를 기준으로 다시 diff 해야 중복 이벤트가 남지
    // 않는다. D2 의 실제 상태는 이벤트를 지우기 전에 먼저 읽어 둬야 한다 — 지운 뒤에
    // 재구성하면 그 이벤트가 만들던 변화가 사라진 상태로 읽히기 때문이다.
    const gapDate = this.firstEventEffectiveDateAfter(date);
    const gapState = gapDate === undefined ? undefined : this.getUniverseAsOf(gapDate);
    const gapEvents =
      gapDate === undefined || gapState === undefined
        ? []
        : diffUniverse(fetched, gapState, { effectiveDate: gapDate, observedSpanStart: date });

    this.deps.db.transaction((tx) => {
      this.insertEventDrafts(tx, todaysEvents);
      if (gapDate !== undefined) {
        tx.delete(symbolMasterEvents).where(eq(symbolMasterEvents.effectiveDate, gapDate)).run();
        this.insertEventDrafts(tx, gapEvents);
      }
      this.mergeCoverage(tx, date);
    });

    return { kind: 'TRADING_DAY', eventCount: todaysEvents.length, checkpointSaved: false };
  }

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

  /**
   * classifyKrxIssue 로 instrumentType 을 매겨 유니버스에 넣는다. 분류 불가 응답은
   * classifyKrxIssue 가 던진 UnknownKrxClassificationError 를 그대로 위로 전파한다 —
   * 제외 대상도 전 종목 저장 원칙에 따라 여기서 걸러내지 않는다.
   */
  private putEntry(
    universe: Map<string, SymbolMasterEntry>,
    row: KrxIssueBaseInfoRow,
    market: KrxMarket,
  ): void {
    const decision = classifyKrxIssue(row);
    const instrumentType: SymbolMasterInstrumentType =
      decision.kind === 'INCLUDE' ? decision.instrumentType : decision.reason;

    let sharesOutstanding = row.listedShares;
    if (sharesOutstanding === null) {
      // 과거 KRX 응답이 상장주식수를 비워 준 사례가 있다 — 수집을 실패시키지 않고
      // 0으로 채우되 운영이 놓치지 않도록 경고를 남긴다.
      this.deps.logger.warn(
        {
          module: 'market-data',
          event: 'symbol-master.shares-missing',
          standardCode: row.standardCode,
          market,
        },
        'KRX 기본정보에 상장주식수가 없어 0으로 채운다',
      );
      sharesOutstanding = '0';
    }

    universe.set(row.standardCode, {
      standardCode: row.standardCode,
      shortCode: row.shortCode,
      name: row.name,
      market,
      sharesOutstanding,
      instrumentType,
      listedDate: row.listedDate,
    });
  }

  /** date 이전 가장 가까운 커버 종료일 — 없으면 최초 수집이라는 뜻이다 */
  private previousCoveredDate(date: string): string | undefined {
    const row = this.deps.db
      .select({ endDate: symbolMasterCoverage.endDate })
      .from(symbolMasterCoverage)
      .where(lt(symbolMasterCoverage.endDate, date))
      .orderBy(desc(symbolMasterCoverage.endDate))
      .limit(1)
      .get();
    return row?.endDate;
  }

  /** date 뒤에서 이벤트가 존재하는 가장 이른 날짜 — 갭 메우기가 다시 계산해야 할 D2 다 */
  private firstEventEffectiveDateAfter(date: string): string | undefined {
    const row = this.deps.db
      .select({ effectiveDate: symbolMasterEvents.effectiveDate })
      .from(symbolMasterEvents)
      .where(gt(symbolMasterEvents.effectiveDate, date))
      .orderBy(asc(symbolMasterEvents.effectiveDate))
      .limit(1)
      .get();
    return row?.effectiveDate;
  }

  /** draft 이벤트를 createdAtMs 를 붙여 트랜잭션 안에 삽입한다. 빈 배열은 쓰기를 건너뛴다 */
  private insertEventDrafts(tx: AppDatabase, drafts: readonly SymbolMasterEventDraft[]): void {
    if (drafts.length === 0) return;
    const now = this.deps.clock.now();
    tx.insert(symbolMasterEvents).values(drafts.map((draft) => ({ ...draft, createdAtMs: now }))).run();
  }

  /**
   * date 하루를 coverage 에 반영하며 인접한 [a, date-1]·[date+1, b] 구간과 합친다.
   * 인접 구간이 없으면 date 하루짜리 구간을 새로 만든다.
   */
  private mergeCoverage(tx: AppDatabase, date: string): void {
    const before = addCalendarDays(date, -1);
    const after = addCalendarDays(date, 1);
    const ranges = tx.select().from(symbolMasterCoverage).all();
    const beforeRange = ranges.find((range) => range.endDate === before);
    const afterRange = ranges.find((range) => range.startDate === after);

    const toRemove: SymbolMasterCoverageRow[] = [beforeRange, afterRange].filter(
      (range): range is SymbolMasterCoverageRow => range !== undefined,
    );
    for (const range of toRemove) {
      tx.delete(symbolMasterCoverage).where(eq(symbolMasterCoverage.id, range.id)).run();
    }

    tx.insert(symbolMasterCoverage).values({
      startDate: beforeRange?.startDate ?? date,
      endDate: afterRange?.endDate ?? date,
      syncedAtMs: this.deps.clock.now(),
    }).run();
  }
}
