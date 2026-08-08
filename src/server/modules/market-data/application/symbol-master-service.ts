import { and, asc, desc, eq, gt, gte, lt, lte } from 'drizzle-orm';
import type { Clock } from '../../../shared/clock.js';
import type { AppDatabase } from '../../../shared/db/database.js';
import {
  krxDailyBars,
  krxNonTradingDays,
  krxNonTradingCoverage,
  symbolMasterCheckpointSymbols,
  symbolMasterCheckpoints,
  symbolMasterCoverage,
  symbolMasterEvents,
  symbolMasterMarketCaps,
  symbolMasterTradingDays,
} from '../../../shared/db/schema.js';
import { newId } from '../../../shared/ids.js';
import type { Logger } from '../../../shared/logger.js';
import type { Candle } from '../domain/candle.js';
import { isValidCandle } from '../domain/candle.js';
import { classifyKrxIssue } from '../domain/krx-filter-policy.js';
import { addCalendarDays } from '../domain/kst-date.js';
import { isNonTradingRow } from '../domain/non-trading-day.js';
import type {
  KrxDailyTradeRow,
  KrxIssueBaseInfoRow,
  KrxMarket,
} from '../domain/krx-universe-types.js';
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

/** ensureTradingDay 의 소급 수집 결과 — 재구성 앵커 확보 여부와 실제 수집한 날짜들을 담는다 */
export interface EnsureTradingDayResult {
  readonly requestedDate: string;
  /** 해소된 적용 거래일. 상한까지 거슬러도 못 찾으면 null */
  readonly effectiveTradingDate: string | null;
  /** 이번 호출이 실제로 수집한 날짜들 (이미 커버된 날짜는 빠진다) */
  readonly ingestedDates: readonly string[];
}

/**
 * ensureTradingDay 가 소급하며 거슬러 올라갈 기본 상한 일수 — 요청 날짜 자체의
 * 최초 ingest 1회는 별도이므로, 한 번의 호출이 건드릴 수 있는 날짜 수는
 * 최대 이 값 + 1(요청 날짜)이다.
 */
const DEFAULT_MAX_LOOKBACK_DAYS = 10;

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

  /**
   * date 가 휴장이면 직전 거래일까지 하루씩 거슬러 ingestDate 를 반복해 재구성 앵커를
   * 보장한다. date 자체의 ingestDate 는 각 호출이 내부에서 알아서 직렬화하므로 여기서
   * 별도 가드를 두지 않는다 — 소급 루프도 각 날짜의 ingestDate 호출 단위로 이미 안전하다.
   *
   * 루프 종료 판정에는 공개 effectiveTradingDate() 대신
   * effectiveTradingDateWithinCoverage() 를 쓴다 — 그 이유는 아래 그 메서드의 주석
   * 참고. 두 메서드의 용도 차이가 여기서 갈리므로, 소급 루프를 고칠 때는 반드시
   * 커버 구간 안으로 한정하는 버전을 계속 써야 한다.
   *
   * KrxQuotaError 등은 ingestDate 가 던지는 그대로 전파한다 — 소급 도중 쿼터가 바닥나도
   * 이미 커버한 날짜는 coverage 에 남아 다음 시도가 이어갈 수 있다.
   */
  async ensureTradingDay(
    date: string,
    maxLookbackDays = DEFAULT_MAX_LOOKBACK_DAYS,
  ): Promise<EnsureTradingDayResult> {
    const ingestedDates: string[] = [];
    const ingestAndRecord = async (target: string): Promise<void> => {
      const result = await this.ingestDate(target);
      if (result.kind !== 'ALREADY_COVERED') ingestedDates.push(target);
    };

    await ingestAndRecord(date);
    let resolved = this.effectiveTradingDateWithinCoverage(date);

    let cursor = date;
    for (let i = 0; resolved === undefined && i < maxLookbackDays; i += 1) {
      cursor = addCalendarDays(cursor, -1);
      await ingestAndRecord(cursor);
      resolved = this.effectiveTradingDateWithinCoverage(date);
    }

    return { requestedDate: date, effectiveTradingDate: resolved ?? null, ingestedDates };
  }

  /**
   * date 를 포함하는 커버 구간 **안**에서만 가장 가까운 거래일을 찾는다. 공개
   * effectiveTradingDate() 는 date 이하 **전역**에서 찾으므로, date 가 (예:
   * ensureTradingDay 의 첫 ingestAndRecord(date) 가 남긴 휴장일 하루짜리 구간으로)
   * 이미 커버된 상태에서 date 와 전혀 안 이어진 먼 과거의 거래일을 우연히 찾아내
   * "직전 거래일을 안다"고 착각할 수 있다 — ensureTradingDay 의 소급 루프가 그 상태를
   * "이미 찾았다"고 오판해 실제로는 한 번도 확인하지 않은 날짜를 건너뛰고, 몇 년 전
   * 무관한 거래일을 재구성 앵커로 굳혀 버린다. UniverseRuleResolver.resolve 도 이
   * 버전을 써야 한다 — isCovered(date) 게이트만으로는 못 막는다: date 가 고립된
   * 구간이라도 "어떤 구간엔 있다"는 사실 자체는 참이 되기 때문이다. (두 경로 모두
   * 리밸런스 적용 거래일 표기 e2e(Task 4, 2026-08-06 스펙)에서 재현된 버그다.)
   *
   * 커버 구간은 mergeCoverage 가 하루씩 인접할 때만 이어 붙이는 연속 구간이므로,
   * 그 안에서 가장 최근 거래일은 실제로 date 까지 하루도 빠짐없이 확인됐다는 뜻이다.
   */
  effectiveTradingDateWithinCoverage(date: string): string | undefined {
    const covering = this.deps.db
      .select({ startDate: symbolMasterCoverage.startDate })
      .from(symbolMasterCoverage)
      .where(
        and(lte(symbolMasterCoverage.startDate, date), gte(symbolMasterCoverage.endDate, date)),
      )
      .get();
    if (covering === undefined) return undefined;

    const row = this.deps.db
      .select({ date: symbolMasterTradingDays.date })
      .from(symbolMasterTradingDays)
      .where(
        and(
          gte(symbolMasterTradingDays.date, covering.startDate),
          lte(symbolMasterTradingDays.date, date),
        ),
      )
      .orderBy(desc(symbolMasterTradingDays.date))
      .limit(1)
      .get();
    return row?.date;
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
        this.recordTradingDay(tx, date);
        this.writeDailyBars(tx, date, kospiTrades, kosdaqTrades);
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
    // gapDate 는 재계산 대상일 뿐이다 — 이미 커버된 구간의 시작일이므로 그 자체로
    // "date 에 거래가 있었다"는 근거가 되지 않는다(고립된 휴장일 하루짜리 구간일 수도
    // 있다). 그래서 recordTradingDay 는 지금 ingest 중인 date 에만 걸고 gapDate 에는 걸지 않는다.
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
      this.recordTradingDay(tx, date);
      this.writeDailyBars(tx, date, kospiTrades, kosdaqTrades);
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

  /**
   * date 이하에서 가장 가까운 거래일. 없으면 undefined — 재구성 앵커가 없다는 뜻이다.
   * 휴장일은 symbolMasterTradingDays 에 기록되지 않으므로 자연히 건너뛴다.
   *
   * 커버 여부와 무관하게 전역에서 찾는 raw 버전이다 — date 가 아예 커버 밖이어도,
   * date 와 전혀 안 이어진 먼 과거 거래일이어도 값을 낼 수 있다. 그래서 "재구성해도
   * 되는 날짜"를 판정하는 실제 프로덕션 경로(ensureTradingDay 의 소급 루프,
   * UniverseRuleResolver.resolve)는 이 메서드를 직접 쓰지 않는다 — 대신 커버 구간
   * 안으로 한정하는 effectiveTradingDateWithinCoverage() 를 쓴다(그 메서드 주석에
   * 두 버전을 가르는 버그 사례가 있다). 이 raw 버전은 그 자체의 계약을 검증하는
   * 단위 테스트(tests/unit/symbol-master-trading-days.test.ts,
   * tests/unit/universe-rule-resolver.test.ts 의 raw-값 단언)를 위해 남겨 뒀다 —
   * 새 프로덕션 호출부를 추가할 때는 정말 "전역"이 맞는지 먼저 의심하라.
   */
  effectiveTradingDate(date: string): string | undefined {
    const row = this.deps.db
      .select({ date: symbolMasterTradingDays.date })
      .from(symbolMasterTradingDays)
      .where(lte(symbolMasterTradingDays.date, date))
      .orderBy(desc(symbolMasterTradingDays.date))
      .limit(1)
      .get();
    return row?.date;
  }

  /**
   * date 를 거래일로 기록한다. 재수집으로 같은 날짜가 다시 들어와도 UNIQUE 위반이
   * 나지 않게 onConflictDoNothing 을 쓴다. 호출자가 이벤트·coverage 갱신과 같은
   * 트랜잭션 안에서 불러야 한다 — 따로 두면 중간에 죽었을 때 거래일 기록만 빠진다.
   */
  private recordTradingDay(tx: AppDatabase, date: string): void {
    tx.insert(symbolMasterTradingDays).values({ date }).onConflictDoNothing().run();
  }

  /**
   * 이미 받아 둔 kospiTrades·kosdaqTrades 로 그날의 일봉을 krxDailyBars 에 저장한다 —
   * ingestDateUnguarded 가 KRX 를 다시 부르지 않고 넘겨주는 값을 그대로 쓴다. 호출자가
   * 이벤트·coverage·거래일 기록과 같은 트랜잭션 안에서 불러야 한다 — 따로 두면 중간에
   * 죽었을 때 커버는 됐는데 봉만 빠진 상태가 남는다.
   *
   * KRX 는 거래정지·무거래 행을 `null` 이 아니라 시·고·저 "0", 종가는 직전가,
   * 거래량 0 으로 준다 (실측 2026-08-08). 그 행은 `krx_non_trading_days` 에 따로
   * 기록하고 봉으로는 넣지 않는다 — 시·고·저를 우리가 지어내지 않기 위해서다.
   *
   * 그래도 `null` 검사는 남긴다. 저장할 컬럼이 NOT NULL 이라 방어선이 필요하고,
   * KRX 가 응답 모양을 바꾸면 여기서 건수로 드러난다.
   *
   * 위 둘 중 어디에도 안 걸리는데 `isValidCandle` 이 거부하는 행(high < low 등)은
   * 진짜 파싱 버그다. `invalidCount` 로 따로 센다.
   *
   * 이미 있는 날짜는 건드리지 않는다. 자본변동은 계산 시점에 반영하므로(설계
   * 2026-08-08-corporate-action-continuity) 봉을 고쳐 받을 이유가 없다.
   * ingestDate 의 isCovered 게이트가 이미 재수집을 막지만, 저장 계층도 같은
   * 규칙을 말해야 읽는 사람이 "봉이 바뀔 수 있다" 고 오해하지 않는다.
   */
  private writeDailyBars(
    tx: AppDatabase,
    date: string,
    kospiTrades: readonly KrxDailyTradeRow[],
    kosdaqTrades: readonly KrxDailyTradeRow[],
  ): void {
    const byMarket: readonly [KrxMarket, readonly KrxDailyTradeRow[]][] = [
      ['KOSPI', kospiTrades],
      ['KOSDAQ', kosdaqTrades],
    ];

    // Candle.tsMs 규약은 그 거래일의 UTC 자정이다 (krx-daily-candle-repository.ts 참고).
    const tsMs = Date.parse(`${date}T00:00:00Z`);

    let skipped = 0;
    let invalidCount = 0;
    const rows: (typeof krxDailyBars.$inferInsert)[] = [];
    const nonTradingRows: (typeof krxNonTradingDays.$inferInsert)[] = [];
    for (const [market, trades] of byMarket) {
      for (const trade of trades) {
        if (
          trade.open === null
          || trade.high === null
          || trade.low === null
          || trade.close === null
          || trade.volume === null
        ) {
          skipped += 1;
          continue;
        }
        if (isNonTradingRow(trade)) {
          nonTradingRows.push({
            shortCode: trade.shortCode,
            date,
            market,
            lastClose: trade.close,
          });
          continue;
        }
        const candle: Candle = {
          symbol: trade.shortCode,
          market: 'KR',
          timeframe: '1d',
          tsMs,
          open: trade.open,
          high: trade.high,
          low: trade.low,
          close: trade.close,
          volume: trade.volume,
        };
        if (!isValidCandle(candle)) {
          invalidCount += 1;
          continue;
        }
        rows.push({
          shortCode: trade.shortCode,
          date,
          market,
          open: trade.open,
          high: trade.high,
          low: trade.low,
          close: trade.close,
          volume: trade.volume,
        });
      }
    }

    // `warn` 이다. 프로덕션 로그 레벨에서 `debug` 는 보이지 않는다.
    // 봉이 조용히 빠진 채로 백테스트가 도는 것을 운영자가 알아야 한다.
    if (skipped > 0) {
      this.deps.logger.warn(
        { module: 'market-data', event: 'symbol-master.daily-bars-skipped', date, skipped },
        '가격·거래량 중 null 값이 있는 일봉 행을 건너뛴다',
      );
    }
    if (invalidCount > 0) {
      this.deps.logger.warn(
        { module: 'market-data', event: 'symbol-master.daily-bars-invalid', date, invalidCount },
        'OHLC 값이 서로 어긋난 일봉 행을 건너뛴다',
      );
    }
    if (nonTradingRows.length > 0) {
      this.deps.logger.info(
        {
          module: 'market-data',
          event: 'symbol-master.non-trading-days',
          date,
          count: nonTradingRows.length,
        },
        '거래정지·무거래로 봉이 없는 종목을 기록한다',
      );
    }

    // SQLite 바인딩 변수 한도(999)를 피하려 500개 단위로 나눠 넣는다 — writeCheckpoint 와 같은 이유다
    for (let i = 0; i < rows.length; i += 500) {
      tx.insert(krxDailyBars)
        .values(rows.slice(i, i + 500))
        .onConflictDoNothing()
        .run();
    }
    for (let i = 0; i < nonTradingRows.length; i += 500) {
      tx.insert(krxNonTradingDays)
        .values(nonTradingRows.slice(i, i + 500))
        .onConflictDoNothing()
        .run();
    }
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

  /**
   * 구간 안의 거래불가일 전체. 날짜 오름차순, 같은 날짜 안에서는 코드 오름차순이다 —
   * 호출부가 이 순서를 그대로 해시에 넣을 수 있어야 재현성이 흔들리지 않는다.
   */
  nonTradingDaysBetween(
    from: string,
    to: string,
  ): readonly { date: string; shortCode: string; lastClose: number }[] {
    return this.deps.db
      .select({
        date: krxNonTradingDays.date,
        shortCode: krxNonTradingDays.shortCode,
        lastClose: krxNonTradingDays.lastClose,
      })
      .from(krxNonTradingDays)
      .where(and(gte(krxNonTradingDays.date, from), lte(krxNonTradingDays.date, to)))
      .orderBy(asc(krxNonTradingDays.date), asc(krxNonTradingDays.shortCode))
      .all();
  }

  /**
   * 구간 전체를 덮는 커버 행이 하나라도 있는지. 구간을 이어 붙여 판정하지는 않는다 —
   * 백필은 한 번에 한 구간을 처리하므로 조각난 커버가 생기지 않는다.
   *
   * 행이 없는 날짜가 "거래불가 종목이 없었다" 인지 "아직 모른다" 인지를 이 메서드로만
   * 가른다. 이 구분이 없으면 결과 경고가 백필 전에도 "반영한다" 고 거짓말한다.
   */
  isNonTradingRangeCovered(from: string, to: string): boolean {
    const row = this.deps.db
      .select({ id: krxNonTradingCoverage.id })
      .from(krxNonTradingCoverage)
      .where(
        and(
          lte(krxNonTradingCoverage.startDate, from),
          gte(krxNonTradingCoverage.endDate, to),
        ),
      )
      .get();
    return row !== undefined;
  }

  /**
   * 이미 수집한 구간의 거래불가일을 뒤늦게 채운다.
   *
   * `ingestDate` 를 다시 부르지 않는다. 그쪽은 이벤트·coverage·봉을 함께 쓰므로
   * 재실행하면 이벤트가 다시 생길 위험이 있다. 여기서는 일별매매정보만 부르고
   * `krx_non_trading_days` 만 쓴다 — 되돌릴 것이 그 테이블 하나뿐이다.
   *
   * 휴장일은 응답이 0행이라 저절로 건너뛰어진다. 날짜 달력을 따로 두지 않는다.
   */
  async backfillNonTradingDays(from: string, to: string): Promise<{ dates: number; rows: number }> {
    let dates = 0;
    let rows = 0;
    for (let date = from; date <= to; date = addCalendarDays(date, 1)) {
      const byMarket: readonly [KrxMarket, readonly KrxDailyTradeRow[]][] = [
        ['KOSPI', await this.deps.source.fetchDailyTrades('KOSPI', date)],
        ['KOSDAQ', await this.deps.source.fetchDailyTrades('KOSDAQ', date)],
      ];
      const values: (typeof krxNonTradingDays.$inferInsert)[] = [];
      for (const [market, trades] of byMarket) {
        for (const trade of trades) {
          if (trade.close === null || !isNonTradingRow(trade)) continue;
          values.push({ shortCode: trade.shortCode, date, market, lastClose: trade.close });
        }
      }
      if (byMarket.some(([, trades]) => trades.length > 0)) dates += 1;
      if (values.length === 0) continue;
      this.deps.db.transaction((tx) => {
        for (let i = 0; i < values.length; i += 500) {
          tx.insert(krxNonTradingDays).values(values.slice(i, i + 500)).onConflictDoNothing().run();
        }
      });
      rows += values.length;
    }
    this.deps.db
      .insert(krxNonTradingCoverage)
      .values({ startDate: from, endDate: to, syncedAtMs: this.deps.clock.now() })
      .run();
    return { dates, rows };
  }

  /**
   * [from, to] 구간 전체가 빈틈없이 수집 완료 구간으로 덮였는지 본다. `isCovered`
   * 는 날짜 하나만 보므로, 리밸런스 날짜만 개별 동기화되고(예: `POST
   * /symbol-master/sync` 로 날짜 하나씩) 그 사이 평일이 비어 있는 부분 커버리지를
   * 잡아내지 못한다 — 이 틈은 `UniverseRuleResolver.resolve` 의 `uncoveredDates`
   * (리밸런스 날짜만 게이트)도 못 본다. 그래서 위저드가 "기간 전체 동기화" 버튼을
   * 띄울지는 이 메서드로 따로 판정한다(운영에서 확인된 버그: 리밸런스 날짜는 다
   * 커버됐는데 그 사이 날짜의 KRX 일봉이 비어 있어, 남은 유일한 해결책처럼 보이는
   * 증권사 동기화가 상장폐지 종목에서 반드시 404 로 실패했다).
   *
   * `coverageRanges()`(startDate 오름차순)를 그대로 재사용해 커서를 하루씩
   * 전진시킨다 — `mergeCoverage` 가 하루씩 인접할 때만 이어 붙이므로, 부분
   * 백필·개별 동기화가 남긴 여러 구간은 서로 떨어져 있을 수 있다. 구간과 구간
   * 사이에 커서가 못 닿는 틈이 있으면 그 자리에서 false 로 끊는다.
   */
  isRangeCovered(from: string, to: string): boolean {
    const ranges = this.coverageRanges().filter((range) => range.endDate >= from && range.startDate <= to);
    let cursor = from;
    for (const range of ranges) {
      if (range.startDate > cursor) return false; // 이 구간 앞에 빈 날짜가 있다
      if (range.endDate >= cursor) cursor = addCalendarDays(range.endDate, 1);
      if (cursor > to) return true;
    }
    return cursor > to;
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
