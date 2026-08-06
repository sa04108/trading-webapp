import { and, asc, desc, eq, gt, gte, lt, lte } from 'drizzle-orm';
import type { Clock } from '../../../shared/clock.js';
import type { AppDatabase } from '../../../shared/db/database.js';
import {
  symbolMasterCheckpointSymbols,
  symbolMasterCheckpoints,
  symbolMasterCoverage,
  symbolMasterEvents,
  symbolMasterMarketCaps,
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
  findUniverseMismatch,
  quarterOf,
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
  /**
   * 같은 date 로 겹쳐 들어온 호출을 하나로 묶는다 — POST /symbol-master/sync 이중 클릭,
   * 백필 루프, 스케줄러 갭 루프가 모두 같은 date 로 ingestDate 를 부를 수 있는데,
   * isCovered 게이트만으로는 KRX await 도중 들어온 두 번째 호출을 막지 못한다. 그 상태로
   * 진 쪽이 재개되면 previousCoveredDate 가 undefined 로 바뀌어 최초 수집 분기를 잘못 타
   * mid-quarter 가짜 체크포인트·coverage 중복·이벤트 중복 삽입으로 이어진다.
   */
  private readonly inflightIngests = new Map<string, Promise<IngestResult>>();

  /**
   * 같은 date 로 겹쳐 들어온 `getMarketCapsAt` 호출을 하나로 묶는다 — inflightIngests 와
   * 같은 이유다. 캐시 미스 상태에서 동시에 두 호출이 들어오면 둘 다 KRX 를 부르고 둘 다
   * `writeMarketCaps` 로 같은 (date, standardCode) 행을 넣으려 해 idx_smmc_date_code
   * UNIQUE 위반으로 하나가 죽는다. 다른 date 는 서로 막지 않고 각자 진행된다.
   */
  private readonly inflightMarketCaps = new Map<string, Promise<ReadonlyMap<string, string>>>();

  constructor(private readonly deps: SymbolMasterServiceDeps) {}

  /**
   * 하루치 KRX 유니버스를 수집해 이벤트·coverage 를 갱신한다. 이미 커버된 날짜는
   * KRX 를 부르지 않고 바로 돌아간다 — 재수집이 호출 한도를 갉아먹지 않게 하기 위해서다.
   *
   * 같은 date 의 두 번째 동시 호출자는 새로 실행하지 않고 진행 중인 Promise 를 그대로
   * 반환받는다 — 다른 date 는 서로 막지 않고 각자 진행된다.
   */
  ingestDate(date: string): Promise<IngestResult> {
    const inflight = this.inflightIngests.get(date);
    if (inflight !== undefined) return inflight;

    const promise = this.ingestDateUnguarded(date).finally(() => {
      this.inflightIngests.delete(date);
    });
    this.inflightIngests.set(date, promise);
    return promise;
  }

  private async ingestDateUnguarded(date: string): Promise<IngestResult> {
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
      // 체크포인트 저장과 coverage 갱신을 같은 트랜잭션에 묶는다 — checkpointDate 에 unique
      // 제약이 있어, 두 트랜잭션으로 나뉘어 있으면 그 사이에서 죽었을 때 체크포인트만 남고
      // coverage 가 비어 같은 날짜 재수집이 영구히 UNIQUE 위반으로 실패한다.
      this.deps.db.transaction((tx) => {
        this.writeCheckpoint(tx, date, fetched, true);
        this.mergeCoverage(tx, date);
      });
      return { kind: 'TRADING_DAY', eventCount: 0, checkpointSaved: true };
    }

    const todaysEvents = diffUniverse(this.getUniverseAsOf(prevDate), fetched, {
      effectiveDate: date,
      observedSpanStart: prevDate,
    });

    // 갭 메우기: date 뒤에 이미 커버된 구간이 있으면 그 구간 첫날(D2)의 이벤트는 더 먼
    // 과거를 기준으로 계산돼 있다. 지금 채운 date 를 기준으로 다시 diff 해야 중복 이벤트가
    // 남지 않는다. D2 는 "이벤트가 있는 날"이 아니라 coverage 구간의 시작일로 찾는다 —
    // 그래야 D2 가 우연히 무변화(이벤트 0개) 거래일이어도 건너뛰지 않는다. D2 의 실제 상태는
    // 이벤트를 지우기 전에 먼저 읽어 둬야 한다 — 지운 뒤에 재구성하면 그 이벤트가 만들던
    // 변화가 사라진 상태로 읽히기 때문이다.
    const gapDate = this.nextCoverageStart(date);
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

    // 분기 체크포인트 검증은 방금 확정한 이벤트를 getUniverseAsOf 로 다시 읽어야 하므로
    // 위 트랜잭션과 묶지 않는다 — 검증 저장이 실패해도 이벤트·coverage 는 이미 커밋된 채로 남는다.
    const checkpointSaved = this.verifyQuarterlyCheckpoint(date, prevDate, fetched);

    return { kind: 'TRADING_DAY', eventCount: todaysEvents.length, checkpointSaved };
  }

  /**
   * 분기가 바뀌었거나(quarterOf(date) !== quarterOf(prevDate)) 이 분기에 체크포인트가
   * 아직 없으면, 방금 확정한 이벤트로 재구성한 유니버스를 이번 ingest 의 KRX 실측과
   * 비교해 체크포인트를 남긴다. 최초 수집(prevDate 없음)은 ingestDate 상단에서 이미
   * writeCheckpoint 로 처리하므로 이 경로를 타지 않는다.
   */
  private verifyQuarterlyCheckpoint(
    date: string,
    prevDate: string,
    fetched: UniverseState,
  ): boolean {
    const currentQuarter = quarterOf(date);
    if (currentQuarter === quarterOf(prevDate) && this.hasCheckpointInQuarter(currentQuarter)) {
      return false;
    }

    const reconstructed = this.getUniverseAsOf(date);
    const mismatch = findUniverseMismatch(reconstructed, fetched);
    if (mismatch === undefined) {
      this.saveCheckpoint(date, fetched, true);
      return true;
    }

    // mismatch 를 실측으로 덮어써 이후 재구성이 이 체크포인트에서 다시 시작하게 한다 —
    // 이벤트 저장 오염이 있었더라도 여기서부터는 정상 상태로 복구된다.
    this.deps.logger.warn(
      { module: 'market-data', event: 'symbol-master.checkpoint-mismatch', date, mismatch },
      '분기 체크포인트 재구성이 KRX 실측과 어긋나 실측으로 교정한다',
    );
    this.saveCheckpoint(date, fetched, false, mismatch);
    return true;
  }

  /** checkpoints 테이블 전체를 훑어 해당 분기에 속하는 체크포인트가 있는지 본다 — 분기당 하나뿐이라 비용이 작다 */
  private hasCheckpointInQuarter(quarter: string): boolean {
    const rows = this.deps.db
      .select({ checkpointDate: symbolMasterCheckpoints.checkpointDate })
      .from(symbolMasterCheckpoints)
      .all();
    return rows.some((row) => quarterOf(row.checkpointDate) === quarter);
  }

  /** 유니버스 전체 스냅샷을 새 체크포인트로 저장한다. 반환값은 체크포인트 id */
  saveCheckpoint(
    date: string,
    universeState: UniverseState,
    verified: boolean,
    mismatch?: object,
  ): string {
    return this.deps.db.transaction((tx) =>
      this.writeCheckpoint(tx, date, universeState, verified, mismatch),
    );
  }

  /**
   * 체크포인트 insert 를 외부 트랜잭션 안에서도 실행할 수 있게 뽑아낸 헬퍼 —
   * ingestDate 의 최초 수집 경로가 coverage 갱신과 원자적으로 묶어 쓴다.
   * 같은 checkpointDate 가 이미 있으면 새로 만들지 않고 기존 id 를 재사용한다 —
   * UNIQUE 제약 위반 방어이자, 이 원자성 수정 이전에 체크포인트만 남고 coverage 가
   * 비었던 과거 데이터를 다시 수집할 때 복구 경로가 된다. 다만 id 만 재사용할 뿐
   * verified/mismatch/symbols 는 이번 호출 값으로 덮어쓴다 — 그러지 않으면 분기
   * 체크포인트 검증이 실제로 기록한 검증 결과가 과거 값에 가려 사라진다.
   */
  private writeCheckpoint(
    tx: AppDatabase,
    date: string,
    universeState: UniverseState,
    verified: boolean,
    mismatch?: object,
  ): string {
    const existing = tx
      .select({ id: symbolMasterCheckpoints.id })
      .from(symbolMasterCheckpoints)
      .where(eq(symbolMasterCheckpoints.checkpointDate, date))
      .get();

    const now = this.deps.clock.now();
    const verifiedAtMs = verified ? now : null;
    const mismatchJson = mismatch ? JSON.stringify(mismatch) : null;

    let id: string;
    if (existing) {
      id = existing.id;
      tx.update(symbolMasterCheckpoints)
        .set({ verifiedAtMs, mismatchJson })
        .where(eq(symbolMasterCheckpoints.id, id))
        .run();
      tx.delete(symbolMasterCheckpointSymbols)
        .where(eq(symbolMasterCheckpointSymbols.checkpointId, id))
        .run();
    } else {
      id = newId('smc');
      tx.insert(symbolMasterCheckpoints).values({
        id,
        checkpointDate: date,
        source: 'KRX',
        verifiedAtMs,
        mismatchJson,
        createdAtMs: now,
      }).run();
    }

    const rows = [...universeState.values()].map((entry) => ({ checkpointId: id, ...entry }));
    // SQLite 바인딩 변수 한도(999)를 피하려 500개 단위로 나눠 넣는다
    for (let i = 0; i < rows.length; i += 500) {
      tx.insert(symbolMasterCheckpointSymbols).values(rows.slice(i, i + 500)).run();
    }
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

  /**
   * date 의 시총 맵 (standardCode → marketCapKrw 문자열). 캐시 테이블에 해당 date
   * 행이 있으면 KRX 를 부르지 않고 그대로 반환한다. 미스면 getUniverseAsOf 로
   * shortCode→standardCode 매핑부터 얻는다.
   *
   * 커버 판정은 isCovered 로 캐시 조회보다 먼저 확인한다 — getUniverseAsOf 는
   * "체크포인트가 하나라도 있는지"만 보고 nearestCheckpoint 로 아무 날짜나 재구성해
   * 버리기 때문에, 체크포인트는 있지만 coverage 갭인 날짜도 통과시킨다. 그런 날짜를
   * isCovered 없이 캐시 히트 검사보다 뒤에 걸렀다면, 과거에 어쩌다 이미 캐시가 쌓인
   * 갭 날짜는 그 검증 안 된 캐시를 그대로 반환해 버렸을 것이다 — 그래서 이 게이트를
   * 캐시 조회보다도 앞에 둔다.
   *
   * 같은 date 의 동시 호출은 inflightMarketCaps 가드가 하나로 묶는다 — 실제 로직은
   * getMarketCapsAtUnguarded 에 있고, 이 메서드는 가드 역할만 한다.
   */
  getMarketCapsAt(date: string): Promise<ReadonlyMap<string, string>> {
    const inflight = this.inflightMarketCaps.get(date);
    if (inflight !== undefined) return inflight;

    const promise = this.getMarketCapsAtUnguarded(date).finally(() => {
      this.inflightMarketCaps.delete(date);
    });
    this.inflightMarketCaps.set(date, promise);
    return promise;
  }

  private async getMarketCapsAtUnguarded(date: string): Promise<ReadonlyMap<string, string>> {
    if (!this.isCovered(date)) throw new SymbolMasterNotCoveredError(date);

    const cached = this.readCachedMarketCaps(date);
    if (cached !== undefined) return cached;

    const universe = this.getUniverseAsOf(date);
    const standardCodeByShortCode = new Map<string, string>();
    for (const entry of universe.values()) {
      standardCodeByShortCode.set(entry.shortCode, entry.standardCode);
    }

    const kospiTrades = await this.deps.source.fetchDailyTrades('KOSPI', date);
    const kosdaqTrades = await this.deps.source.fetchDailyTrades('KOSDAQ', date);

    const marketCaps = new Map<string, string>();
    for (const row of [...kospiTrades, ...kosdaqTrades]) {
      // 시총을 모르는 행은 순위에 쓸 수 없으니 캐시에도 담지 않는다.
      if (row.marketCapRaw === null) continue;

      const standardCode = standardCodeByShortCode.get(row.shortCode);
      if (standardCode === undefined) {
        // 마스터가 모르는 단축코드다 — 분류 정책 밖 종목 등으로 생길 수 있어 건너뛰고 경고만 남긴다.
        this.deps.logger.warn(
          {
            module: 'market-data',
            event: 'symbol-master.market-cap-unknown-short-code',
            date,
            shortCode: row.shortCode,
          },
          '시총 조회 중 마스터에 없는 단축코드를 건너뛴다',
        );
        continue;
      }
      marketCaps.set(standardCode, row.marketCapRaw);
    }

    this.deps.db.transaction((tx) => this.writeMarketCaps(tx, date, marketCaps));
    return marketCaps;
  }

  /**
   * date 캐시 행이 하나라도 있으면 히트로 본다. 휴장일 등으로 결과가 0건인 날은
   * 매번 KRX 를 재조회하게 되지만, 그런 날짜는 애초에 커버 밖으로 걸러지는 경우가
   * 대부분이라 수용한다.
   */
  private readCachedMarketCaps(date: string): ReadonlyMap<string, string> | undefined {
    const rows = this.deps.db
      .select({
        standardCode: symbolMasterMarketCaps.standardCode,
        marketCapKrw: symbolMasterMarketCaps.marketCapKrw,
      })
      .from(symbolMasterMarketCaps)
      .where(eq(symbolMasterMarketCaps.date, date))
      .all();
    if (rows.length === 0) return undefined;
    return new Map(rows.map((row) => [row.standardCode, row.marketCapKrw]));
  }

  /** SQLite 바인딩 변수 한도(999)를 피하려 500개 단위로 나눠 넣는다 — writeCheckpoint 와 같은 이유다 */
  private writeMarketCaps(
    tx: AppDatabase,
    date: string,
    marketCaps: ReadonlyMap<string, string>,
  ): void {
    const rows = [...marketCaps.entries()].map(([standardCode, marketCapKrw]) => ({
      date,
      standardCode,
      marketCapKrw,
    }));
    for (let i = 0; i < rows.length; i += 500) {
      tx.insert(symbolMasterMarketCaps).values(rows.slice(i, i + 500)).run();
    }
  }

  /**
   * 수집 완료 구간 목록 — startDate 오름차순. syncedAtMs 는 coverage API 가
   * lastSyncedAtMs(구간들의 최댓값)를 계산하는 데 쓴다.
   */
  coverageRanges(): { startDate: string; endDate: string; syncedAtMs: number }[] {
    return this.deps.db
      .select({
        startDate: symbolMasterCoverage.startDate,
        endDate: symbolMasterCoverage.endDate,
        syncedAtMs: symbolMasterCoverage.syncedAtMs,
      })
      .from(symbolMasterCoverage)
      .orderBy(asc(symbolMasterCoverage.startDate))
      .all();
  }

  /** 체크포인트 전체 목록 — coverage API 응답용. checkpointDate 오름차순 */
  listCheckpoints(): { checkpointDate: string; verified: boolean; mismatch: boolean }[] {
    return this.deps.db
      .select({
        checkpointDate: symbolMasterCheckpoints.checkpointDate,
        verifiedAtMs: symbolMasterCheckpoints.verifiedAtMs,
        mismatchJson: symbolMasterCheckpoints.mismatchJson,
      })
      .from(symbolMasterCheckpoints)
      .orderBy(asc(symbolMasterCheckpoints.checkpointDate))
      .all()
      .map((row) => ({
        checkpointDate: row.checkpointDate,
        verified: row.verifiedAtMs !== null,
        mismatch: row.mismatchJson !== null,
      }));
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

  /**
   * date 뒤에서 가장 가까운 coverage 구간의 시작일 — 갭 메우기가 다시 계산해야 할 D2 다.
   * "이벤트가 있는 날"로 찾으면 D2 가 우연히 무변화(이벤트 0개) 거래일일 때 건너뛰게 되고
   * 그 뒤 날짜의 observedSpanStart 가 오히려 갱신되지 않는다 — coverage 구간 자체를
   * 기준으로 삼아야 그런 날도 정확히 짚는다.
   */
  private nextCoverageStart(date: string): string | undefined {
    const row = this.deps.db
      .select({ startDate: symbolMasterCoverage.startDate })
      .from(symbolMasterCoverage)
      .where(gt(symbolMasterCoverage.startDate, date))
      .orderBy(asc(symbolMasterCoverage.startDate))
      .limit(1)
      .get();
    return row?.startDate;
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
