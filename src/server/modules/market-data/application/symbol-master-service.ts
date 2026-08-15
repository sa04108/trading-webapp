import { createHash } from 'node:crypto';
import {
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  or,
  sql,
} from 'drizzle-orm';
import type { Clock } from '../../../shared/clock.js';
import type { AppDatabase } from '../../../shared/db/database.js';
import {
  dailySelectionMetrics,
  krxDailyBars,
  krxNonTradingDays,
  krxNonTradingCoverage,
  symbolMasterCheckpointSymbols,
  symbolMasterCheckpoints,
  symbolMasterCoverage,
  symbolMasterEvents,
  symbolMasterMarketCaps,
  symbolMasterStorageState,
  symbolMasterTradingDays,
  symbolMasterVersions,
} from '../../../shared/db/schema.js';
import type { Logger } from '../../../shared/logger.js';
import type { Candle } from '../domain/candle.js';
import { isValidCandle } from '../domain/candle.js';
import { classifyKrxIssue } from '../domain/krx-filter-policy.js';
import { addCalendarDays, isWeekendDate } from '../domain/kst-date.js';
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
  type SymbolMasterEntry,
  type SymbolMasterEventDraft,
  type SymbolMasterInstrumentType,
  type UniverseState,
} from '../domain/symbol-master.js';
import {
  overlayVersionTimeline,
  sameSymbolMasterEntry,
  type SymbolMasterVersionSegment,
} from '../domain/symbol-master-version.js';
import { SelectionMetricRepository } from './selection-metric-repository.js';
import type { KrxHistoricalUniverseSource } from './ports.js';

export interface SymbolMasterEventRow extends SymbolMasterEventDraft {
  readonly id: string;
}
type LegacySymbolMasterEventRow = typeof symbolMasterEvents.$inferSelect;
type LegacySymbolMasterCheckpointRow = typeof symbolMasterCheckpoints.$inferSelect;
type SymbolMasterCoverageRow = typeof symbolMasterCoverage.$inferSelect;
type SymbolMasterVersionRow = typeof symbolMasterVersions.$inferSelect;

export interface SymbolMasterServiceDeps {
  readonly db: AppDatabase;
  readonly source: KrxHistoricalUniverseSource;
  readonly clock: Clock;
  readonly logger: Logger;
}

/** 요청한 날짜가 수집 완료 구간에 없을 때 던진다. */
export class SymbolMasterNotCoveredError extends Error {
  constructor(readonly date: string) {
    super(`종목 마스터가 ${date} 를 커버하지 않는다`);
    this.name = 'SymbolMasterNotCoveredError';
  }
}

export type IngestResult =
  | { readonly kind: 'TRADING_DAY' }
  | { readonly kind: 'HOLIDAY' }
  | { readonly kind: 'ALREADY_COVERED' };

/** ensureTradingDay 의 소급 수집 결과 — 조회 앵커 확보 여부와 실제 수집한 날짜들을 담는다 */
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
function toEventDraft(row: LegacySymbolMasterEventRow): SymbolMasterEventDraft {
  return {
    effectiveDate: row.effectiveDate,
    standardCode: row.standardCode,
    eventType: row.eventType as SymbolMasterEventDraft['eventType'],
    oldValue: row.oldValue,
    newValue: row.newValue,
    observedSpanStart: row.observedSpanStart,
  };
}

function universeFingerprint(state: UniverseState): string {
  const canonical = [...state.values()]
    .sort((a, b) => a.standardCode.localeCompare(b.standardCode))
    .map((entry) => [
      entry.standardCode,
      entry.shortCode,
      entry.name,
      entry.market,
      entry.sharesOutstanding,
      entry.instrumentType,
      entry.listedDate,
    ]);
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

/** KRX 계약 파서가 검증한 원문을 bigint 정밀도 손실 없이 DB text 로 정규화한다. */
function metricDecimalText(raw: string | null): string | null {
  return raw === null ? null : BigInt(raw.replaceAll(',', '').trim()).toString();
}

/** effectiveDate·id 정렬된 legacy 행에서 (from, to]만 이진 탐색으로 자른다. */
function legacyEventsBetween(
  rows: readonly LegacySymbolMasterEventRow[],
  from: string,
  to: string,
): SymbolMasterEventDraft[] {
  const firstAfter = (date: string): number => {
    let low = 0;
    let high = rows.length;
    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      if (rows[mid]!.effectiveDate <= date) low = mid + 1;
      else high = mid;
    }
    return low;
  };
  return rows.slice(firstAfter(from), firstAfter(to)).map(toEventDraft);
}

export class SymbolMasterService {
  /**
   * 같은 date 로 겹쳐 들어온 호출을 하나로 묶는다 — POST /symbol-master/sync 이중 클릭,
   * 백필 루프, 스케줄러 갭 루프가 모두 같은 date 로 ingestDate 를 부를 수 있는데,
   * isCovered 게이트만으로는 KRX await 도중 들어온 두 번째 호출을 막지 못한다. 그 상태로
   * 늦게 재개된 호출이 같은 날짜의 coverage·버전을 다시 쓰는 문제로 이어질 수 있다.
   */
  private readonly inflightIngests = new Map<string, Promise<IngestResult>>();

  /**
   * 같은 date 로 겹쳐 들어온 `getMarketCapsAt` 호출을 하나로 묶는다 — inflightIngests 와
   * 같은 이유다. 캐시 미스 상태에서 동시에 두 호출이 들어오면 둘 다 KRX 를 부르고 둘 다
   * `writeMarketCaps` 로 같은 (date, standardCode) 행을 넣으려 해 idx_smmc_date_code
   * UNIQUE 위반으로 하나가 죽는다. 다른 date 는 서로 막지 않고 각자 진행된다.
   */
  private readonly inflightMarketCaps = new Map<string, Promise<ReadonlyMap<string, string>>>();

  constructor(private readonly deps: SymbolMasterServiceDeps) {
    this.ensureScdStorageReady();
  }

  /**
   * 0012 이전 DB 의 체크포인트+이벤트 조회 결과를 종목별 SCD 버전으로 한 번만
   * 변환한다. 전체가 한 SQLite 트랜잭션이므로 중간 실패 시 legacy 이력과
   * PENDING 상태가 그대로 남아 다음 부팅에서 안전하게 재시도한다.
   */
  private ensureScdStorageReady(): void {
    const current = this.deps.db
      .select()
      .from(symbolMasterStorageState)
      .where(eq(symbolMasterStorageState.singleton, 1))
      .get();
    if (current?.phase === 'ACTIVE') return;

    this.deps.db.transaction((tx) => {
      const state = tx
        .select()
        .from(symbolMasterStorageState)
        .where(eq(symbolMasterStorageState.singleton, 1))
        .get();
      if (state === undefined) {
        tx.insert(symbolMasterStorageState)
          .values({ singleton: 1, phase: 'PENDING', migratedAtMs: null })
          .run();
      } else if (state.phase === 'ACTIVE') {
        return;
      }

      const checkpoints = tx
        .select()
        .from(symbolMasterCheckpoints)
        .orderBy(asc(symbolMasterCheckpoints.checkpointDate))
        .all();
      const legacyEvents = tx
        .select()
        .from(symbolMasterEvents)
        .orderBy(asc(symbolMasterEvents.effectiveDate), asc(symbolMasterEvents.id))
        .all();
      const tradingDates = tx
        .select({ date: symbolMasterTradingDays.date })
        .from(symbolMasterTradingDays)
        .orderBy(asc(symbolMasterTradingDays.date))
        .all()
        .map((row) => row.date);
      const hasCheckpointSymbols = tx
        .select({ id: symbolMasterCheckpointSymbols.id })
        .from(symbolMasterCheckpointSymbols)
        .limit(1)
        .get() !== undefined;
      if (
        checkpoints.length === 0
        && (legacyEvents.length > 0 || tradingDates.length > 0 || hasCheckpointSymbols)
      ) {
        throw new Error('종목 마스터 SCD 이행 실패: 거래 이력은 있지만 legacy 체크포인트가 없다');
      }
      tx.delete(symbolMasterVersions).run();

      if (checkpoints.length > 0) {
        const checkpointSymbols = tx.select().from(symbolMasterCheckpointSymbols).all();
        const symbolsByCheckpoint = new Map<string, Map<string, SymbolMasterEntry>>();
        for (const row of checkpointSymbols) {
          let universe = symbolsByCheckpoint.get(row.checkpointId);
          if (universe === undefined) {
            universe = new Map();
            symbolsByCheckpoint.set(row.checkpointId, universe);
          }
          universe.set(row.standardCode, {
            standardCode: row.standardCode,
            shortCode: row.shortCode,
            name: row.name,
            market: row.market as KrxMarket,
            sharesOutstanding: row.sharesOutstanding,
            instrumentType: row.instrumentType as SymbolMasterInstrumentType,
            listedDate: row.listedDate,
          });
        }
        for (const checkpoint of checkpoints) {
          if ((symbolsByCheckpoint.get(checkpoint.id)?.size ?? 0) === 0) {
            throw new Error(
              `종목 마스터 SCD 이행 실패: ${checkpoint.checkpointDate} 체크포인트가 비어 있다`,
            );
          }
        }
        // 거래일 테이블이 도입되기 전 데이터나 부분 기록도 잃지 않도록 legacy 경계일을
        // 항상 합친다. 체크포인트에만 있던 shortCode/listedDate 교정도 이 날짜에서 버전이 된다.
        const dates = [...new Set([
          ...tradingDates,
          ...checkpoints.map((checkpoint) => checkpoint.checkpointDate),
          ...legacyEvents.map((event) => event.effectiveDate),
        ])].sort();

        const recordedAtMs = this.deps.clock.now();
        const versions: (typeof symbolMasterVersions.$inferInsert)[] = [];
        const expectedFingerprints: Array<{ date: string; fingerprint: string }> = [];
        const openIndex = new Map<string, number>();
        let previous: UniverseState = new Map();

        for (const date of dates) {
          const next = this.legacyUniverseAsOf(
            date,
            checkpoints,
            symbolsByCheckpoint,
            legacyEvents,
          );
          for (const code of new Set([...previous.keys(), ...next.keys()])) {
            const before = previous.get(code);
            const after = next.get(code);
            if (sameSymbolMasterEntry(before, after)) continue;

            const existingIndex = openIndex.get(code);
            if (existingIndex !== undefined) {
              versions[existingIndex] = { ...versions[existingIndex]!, validToDate: date };
              openIndex.delete(code);
            }
            if (after !== undefined) {
              const index = versions.length;
              versions.push({
                standardCode: after.standardCode,
                validFromDate: date,
                validToDate: null,
                shortCode: after.shortCode,
                name: after.name,
                market: after.market,
                sharesOutstanding: after.sharesOutstanding,
                instrumentType: after.instrumentType,
                listedDate: after.listedDate,
                recordedAtMs,
              });
              openIndex.set(code, index);
            }
          }
          expectedFingerprints.push({ date, fingerprint: universeFingerprint(next) });
          previous = next;
        }

        for (let i = 0; i < versions.length; i += 200) {
          tx.insert(symbolMasterVersions).values(versions.slice(i, i + 200)).run();
        }
        for (const expected of expectedFingerprints) {
          const actual = universeFingerprint(this.readUniverseAsOfInternal(expected.date, tx));
          if (actual !== expected.fingerprint) {
            throw new Error(`종목 마스터 SCD 이행 검증 실패: ${expected.date}`);
          }
        }
        this.deps.logger.info(
          {
            module: 'market-data',
            event: 'symbol-master.scd-migrated',
            tradingDates: dates.length,
            versions: versions.length,
          },
          '종목 마스터 legacy 이력을 SCD 버전으로 변환했다',
        );

        // 검증을 통과한 뒤에만 중복 저장을 비운다. 테이블 자체는 구버전 DB를 읽는
        // expand-contract 코드가 제거되는 다음 contract migration까지 남겨 둔다.
        tx.delete(symbolMasterCheckpointSymbols).run();
        tx.delete(symbolMasterEvents).run();
        tx.delete(symbolMasterCheckpoints).run();
      }

      tx.update(symbolMasterStorageState)
        .set({ phase: 'ACTIVE', migratedAtMs: this.deps.clock.now() })
        .where(eq(symbolMasterStorageState.singleton, 1))
        .run();
    });
  }

  private legacyUniverseAsOf(
    date: string,
    checkpoints: readonly LegacySymbolMasterCheckpointRow[],
    symbolsByCheckpoint: ReadonlyMap<string, UniverseState>,
    rows: readonly LegacySymbolMasterEventRow[],
  ): UniverseState {
    const target = Date.parse(date);
    let checkpoint: LegacySymbolMasterCheckpointRow | undefined;
    let bestDiff = Infinity;
    for (const candidate of checkpoints) {
      const diff = Math.abs(Date.parse(candidate.checkpointDate) - target);
      if (
        diff < bestDiff
        || (diff === bestDiff && checkpoint !== undefined
          && candidate.checkpointDate < checkpoint.checkpointDate)
      ) {
        checkpoint = candidate;
        bestDiff = diff;
      }
    }
    if (checkpoint === undefined) return new Map();

    const base = new Map(symbolsByCheckpoint.get(checkpoint.id) ?? []);
    if (date >= checkpoint.checkpointDate) {
      const events = legacyEventsBetween(rows, checkpoint.checkpointDate, date);
      return applyEventsForward(base, events);
    }
    const events = legacyEventsBetween(rows, date, checkpoint.checkpointDate);
    return applyEventsBackward(base, events);
  }

  /**
   * 하루치 KRX 유니버스를 수집해 SCD 버전·coverage 를 갱신한다. 이미 커버된 날짜는
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
   * date 가 휴장이면 직전 거래일까지 하루씩 거슬러 ingestDate 를 반복해 조회 앵커를
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
   * 무관한 거래일을 조회 앵커로 굳혀 버린다. UniverseRuleResolver.resolve 도 이
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
      return this.deps.db.transaction((tx) => {
        // 다른 서비스 인스턴스가 fetch 사이에 같은 휴장일을 커밋했을 수 있다.
        if (this.isCoveredIn(tx, date)) return { kind: 'ALREADY_COVERED' } as const;
        this.mergeCoverage(tx, date);
        // 휴장일도 거래불가 커버로 남긴다. 응답 0행을 실제로 확인했으니 "봤는데 없었다" 가
        // 맞고, 주말·공휴일을 비워 두면 앞뒤 거래일 구간이 이어지지 않아 커버 판정이 끊긴다.
        this.mergeNonTradingCoverage(tx, date, date);
        return { kind: 'HOLIDAY' } as const;
      });
    }

    const kospiBaseInfo = await this.deps.source.fetchIssueBaseInfo('KOSPI', date);
    const kosdaqBaseInfo = await this.deps.source.fetchIssueBaseInfo('KOSDAQ', date);
    const modeledBeforeWrite = this.readUniverseAsOfInternal(date);
    this.assertBaseInfoPresent(date, 'KOSPI', kospiTrades, kospiBaseInfo, modeledBeforeWrite);
    this.assertBaseInfoPresent(date, 'KOSDAQ', kosdaqTrades, kosdaqBaseInfo, modeledBeforeWrite);

    const fetched = new Map<string, SymbolMasterEntry>();
    for (const row of kospiBaseInfo) {
      this.putEntry(fetched, row, 'KOSPI');
    }
    for (const row of kosdaqBaseInfo) {
      this.putEntry(fetched, row, 'KOSDAQ');
    }

    return this.persistTradingDay(date, fetched, kospiTrades, kosdaqTrades);
  }

  /**
   * 하루 full universe 를 [date, 다음 기수집 거래일) 구간에 덮어쓴다.
   * 중간 갭이나 과거 날짜를 나중에 채워도 다음 관측일 뒤의 상태는 보존된다.
   */
  private persistTradingDay(
    date: string,
    fetched: UniverseState,
    kospiTrades: readonly KrxDailyTradeRow[],
    kosdaqTrades: readonly KrxDailyTradeRow[],
  ): IngestResult {
    return this.deps.db.transaction((tx) => {
      // fetch 중 같은 날짜의 다른 요청이 먼저 커밋했을 수 있다.
      if (this.isCoveredIn(tx, date)) return { kind: 'ALREADY_COVERED' } as const;

      const nextTradingDate = this.nextTradingDate(date, tx);
      const nextBoundaryDate = this.nextVersionBoundary(date, tx);
      const nextObservationDate = [nextTradingDate, nextBoundaryDate]
        .filter((value): value is string => value !== undefined)
        .sort()[0];
      const modeled = this.readUniverseAsOfInternal(date, tx);
      const preservedFuture = nextObservationDate === undefined
        ? undefined
        : this.readUniverseAsOfInternal(nextObservationDate, tx);
      const changedCodes = new Set<string>();
      for (const code of new Set([...modeled.keys(), ...fetched.keys()])) {
        if (!sameSymbolMasterEntry(modeled.get(code), fetched.get(code))) changedCodes.add(code);
      }
      this.overlayUniverseInterval(tx, date, nextObservationDate ?? null, fetched, changedCodes);

      this.mergeCoverage(tx, date);
      this.recordTradingDay(tx, date);
      this.writeDailyBars(tx, date, kospiTrades, kosdaqTrades);
      this.writeSelectionMetrics(tx, date, fetched, kospiTrades, kosdaqTrades);
      this.mergeNonTradingCoverage(tx, date, date);
      this.assertUniversesEqual(this.readUniverseAsOfInternal(date, tx), fetched, date);
      if (nextObservationDate !== undefined && preservedFuture !== undefined) {
        this.assertUniversesEqual(
          this.readUniverseAsOfInternal(nextObservationDate, tx),
          preservedFuture,
          nextObservationDate,
        );
      }

      return { kind: 'TRADING_DAY' } as const;
    });
  }

  private readUniverseAsOfInternal(date: string, db: AppDatabase = this.deps.db): UniverseState {
    const rows = db
      .select()
      .from(symbolMasterVersions)
      .where(
        and(
          lte(symbolMasterVersions.validFromDate, date),
          or(isNull(symbolMasterVersions.validToDate), gt(symbolMasterVersions.validToDate, date)),
        ),
      )
      .all();
    return new Map(rows.map((row) => [row.standardCode, this.entryFromVersion(row)]));
  }

  private entryFromVersion(row: SymbolMasterVersionRow): SymbolMasterEntry {
    return {
      standardCode: row.standardCode,
      shortCode: row.shortCode,
      name: row.name,
      market: row.market as KrxMarket,
      sharesOutstanding: row.sharesOutstanding,
      instrumentType: row.instrumentType as SymbolMasterInstrumentType,
      listedDate: row.listedDate,
    };
  }

  private overlayUniverseInterval(
    tx: AppDatabase,
    fromDate: string,
    toDate: string | null,
    desired: UniverseState,
    changedCodes: ReadonlySet<string>,
  ): void {
    const codes = [...changedCodes];
    if (codes.length === 0) return;

    const rowsByCode = new Map<string, SymbolMasterVersionRow[]>();
    for (let i = 0; i < codes.length; i += 500) {
      const chunk = codes.slice(i, i + 500);
      for (const row of tx
        .select()
        .from(symbolMasterVersions)
        .where(inArray(symbolMasterVersions.standardCode, chunk))
        .orderBy(asc(symbolMasterVersions.standardCode), asc(symbolMasterVersions.validFromDate))
        .all()) {
        const rows = rowsByCode.get(row.standardCode) ?? [];
        rows.push(row);
        rowsByCode.set(row.standardCode, rows);
      }
    }

    const recordedAtMs = this.deps.clock.now();
    const replacements: (typeof symbolMasterVersions.$inferInsert)[] = [];
    for (const code of codes) {
      const existing: SymbolMasterVersionSegment[] = (rowsByCode.get(code) ?? []).map((row) => ({
        validFromDate: row.validFromDate,
        validToDate: row.validToDate,
        entry: this.entryFromVersion(row),
        recordedAtMs: row.recordedAtMs,
      }));
      const timeline = overlayVersionTimeline(
        existing,
        fromDate,
        toDate,
        desired.get(code),
        recordedAtMs,
      );
      for (const segment of timeline) {
        replacements.push({
          standardCode: segment.entry.standardCode,
          validFromDate: segment.validFromDate,
          validToDate: segment.validToDate,
          shortCode: segment.entry.shortCode,
          name: segment.entry.name,
          market: segment.entry.market,
          sharesOutstanding: segment.entry.sharesOutstanding,
          instrumentType: segment.entry.instrumentType,
          listedDate: segment.entry.listedDate,
          recordedAtMs: segment.recordedAtMs,
        });
      }
    }

    // 바뀐 종목의 타임라인만 원자적으로 교체한다. 인접 동일 버전은 위에서
    // 합쳐지므로 날짜를 역순으로 추가해도 행 수가 늘지 않는다.
    for (let i = 0; i < codes.length; i += 500) {
      tx.delete(symbolMasterVersions)
        .where(inArray(symbolMasterVersions.standardCode, codes.slice(i, i + 500)))
        .run();
    }
    for (let i = 0; i < replacements.length; i += 200) {
      tx.insert(symbolMasterVersions).values(replacements.slice(i, i + 200)).run();
    }
  }

  private nextTradingDate(date: string, db: AppDatabase = this.deps.db): string | undefined {
    return db
      .select({ date: symbolMasterTradingDays.date })
      .from(symbolMasterTradingDays)
      .where(gt(symbolMasterTradingDays.date, date))
      .orderBy(asc(symbolMasterTradingDays.date))
      .limit(1)
      .get()?.date;
  }

  /** trading_days 누락에도 기존 SCD 경계를 덮지 않도록 가장 가까운 미래 경계를 찾는다. */
  private nextVersionBoundary(date: string, db: AppDatabase = this.deps.db): string | undefined {
    const nextStart = db
      .select({ date: symbolMasterVersions.validFromDate })
      .from(symbolMasterVersions)
      .where(gt(symbolMasterVersions.validFromDate, date))
      .orderBy(asc(symbolMasterVersions.validFromDate))
      .limit(1)
      .get()?.date;
    const nextEnd = db
      .select({ date: symbolMasterVersions.validToDate })
      .from(symbolMasterVersions)
      .where(
        and(
          isNotNull(symbolMasterVersions.validToDate),
          gt(symbolMasterVersions.validToDate, date),
        ),
      )
      .orderBy(asc(symbolMasterVersions.validToDate))
      .limit(1)
      .get()?.date ?? undefined;
    return [nextStart, nextEnd]
      .filter((value): value is string => value !== undefined)
      .sort()[0];
  }

  private isCoveredIn(db: AppDatabase, date: string): boolean {
    return db
      .select({ id: symbolMasterCoverage.id })
      .from(symbolMasterCoverage)
      .where(and(lte(symbolMasterCoverage.startDate, date), gte(symbolMasterCoverage.endDate, date)))
      .get() !== undefined;
  }

  private assertUniversesEqual(actual: UniverseState, expected: UniverseState, date: string): void {
    if (actual.size !== expected.size) {
      throw new Error(`SCD 저장 검증 실패(${date}): ${actual.size}종목 != ${expected.size}종목`);
    }
    for (const [code, entry] of expected) {
      if (!sameSymbolMasterEntry(actual.get(code), entry)) {
        throw new Error(`SCD 저장 검증 실패(${date}): ${code} 상태 불일치`);
      }
    }
  }

  /**
   * 선택 날짜에 유효한 SCD 버전을 직접 조회해 전체 유니버스를 만든다.
   * coverage 만 있고 같은 연속 구간 안에 앞선 거래일이 없으면 고립된 휴장일이므로
   * 다른 구간의 열린 버전을 끌어오지 않는다.
   */
  getUniverseAsOf(date: string): UniverseState {
    if (!this.canResolveUniverseAsOf(date)) throw new SymbolMasterNotCoveredError(date);
    return this.readUniverseAsOfInternal(date);
  }

  /** date 를 포함한 연속 coverage 안에 실제 거래일 anchor 가 있어 유니버스를 읽을 수 있는지 본다. */
  canResolveUniverseAsOf(date: string): boolean {
    return this.effectiveTradingDateWithinCoverage(date) !== undefined;
  }

  /**
   * date 의 시총 맵 (standardCode → marketCapKrw 문자열). 캐시 테이블에 해당 date
   * 행이 있으면 KRX 를 부르지 않고 그대로 반환한다. 미스면 getUniverseAsOf 로
   * shortCode→standardCode 매핑부터 얻는다.
   *
   * 유니버스 해소 가능 여부는 캐시 조회보다 먼저 확인한다. SCD 구간은 미수집 날짜도
   * 관통할 수 있고 고립 휴장일에는 거래일 anchor가 없으므로, 그 상태나 캐시를 검증된
   * 데이터로 취급하면 안 된다.
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

  /**
   * 이미 symbol master coverage 가 있는 날짜에서 거래대금이 빈 경우만 KRX 일별
   * 응답을 다시 받아 선정 지표를 보강한다. 기존 일봉·legacy 시총 캐시는 건드리지 않는다.
   */
  async ensureSelectionMetrics(dates: readonly string[]): Promise<void> {
    const requestedDates = [...new Set(dates)];
    if (requestedDates.length === 0) return;

    this.backfillSelectionMetricVolume(requestedDates);
    const repository = new SelectionMetricRepository(this.deps.db);
    for (const date of repository.findMissingTradingValueDates(requestedDates)) {
      const universe = this.getUniverseAsOf(date);
      const kospiTrades = await this.deps.source.fetchDailyTrades('KOSPI', date);
      const kosdaqTrades = await this.deps.source.fetchDailyTrades('KOSDAQ', date);
      this.deps.db.transaction((tx) => {
        this.writeSelectionMetrics(tx, date, universe, kospiTrades, kosdaqTrades);
      });
    }
  }

  /**
   * 0014 migration 뒤에는 기존 일봉 volume 만 남아 있다. 날짜별 SCD 유니버스로
   * short-code 를 standard-code 로 해소하고, 아직 volume 이 없는 metric 만 채운다.
   */
  private backfillSelectionMetricVolume(dates: readonly string[]): void {
    for (const date of dates) {
      const bars = this.deps.db.select({
        shortCode: krxDailyBars.shortCode,
        volume: krxDailyBars.volume,
      })
        .from(krxDailyBars)
        .where(eq(krxDailyBars.date, date))
        .all();
      if (bars.length === 0) continue;

      const standardCodeByShortCode = new Map<string, string>();
      for (const entry of this.getUniverseAsOf(date).values()) {
        standardCodeByShortCode.set(entry.shortCode, entry.standardCode);
      }
      const codes = [...new Set(bars
        .map((bar) => standardCodeByShortCode.get(bar.shortCode))
        .filter((code): code is string => code !== undefined))];
      if (codes.length === 0) continue;
      const existingVolumes = new Map(this.deps.db.select({
        standardCode: dailySelectionMetrics.standardCode,
        volume: dailySelectionMetrics.volume,
      })
        .from(dailySelectionMetrics)
        .where(and(
          eq(dailySelectionMetrics.date, date),
          inArray(dailySelectionMetrics.standardCode, codes),
        ))
        .all()
        .map((row) => [row.standardCode, row.volume]));
      const rows = bars.flatMap((bar) => {
        const standardCode = standardCodeByShortCode.get(bar.shortCode);
        const existingVolume = standardCode === undefined ? undefined : existingVolumes.get(standardCode);
        if (standardCode === undefined || (existingVolume !== null && existingVolume !== undefined)) return [];
        return [{ date, standardCode, marketCapKrw: null, volume: bar.volume, tradingValueKrw: null }];
      });
      for (let index = 0; index < rows.length; index += 190) {
        this.deps.db.insert(dailySelectionMetrics)
          .values(rows.slice(index, index + 190))
          .onConflictDoUpdate({
            target: [dailySelectionMetrics.date, dailySelectionMetrics.standardCode],
            set: { volume: sql`excluded.volume` },
          })
          .run();
      }
    }
  }

  private async getMarketCapsAtUnguarded(date: string): Promise<ReadonlyMap<string, string>> {
    if (!this.canResolveUniverseAsOf(date)) throw new SymbolMasterNotCoveredError(date);

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

  /** SQLite 바인딩 변수 한도(999)를 피하려 500개 단위로 나눠 넣는다. */
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

  /**
   * 거래일로 기록된 날짜 목록 — 화면의 날짜 표시와 "가장 가까운 수집일"의 정본이다.
   *
   * 0005 이행 때 legacy 이벤트 경계일을 최선 추정 거래일로 넣었기 때문에 과거 행에는
   * 휴장일이 섞일 수 있다. 적어도 주말은 달력만으로 확정할 수 있으므로 API로 내보내기
   * 전에 제외한다. 이행 이후 ingestDate가 기록한 행은 실제 KRX 응답으로 검증된 날이다.
   */
  tradingDates(): string[] {
    return this.deps.db
      .select({ date: symbolMasterTradingDays.date })
      .from(symbolMasterTradingDays)
      .orderBy(asc(symbolMasterTradingDays.date))
      .all()
      .map((row) => row.date)
      .filter((date) => !isWeekendDate(date));
  }

  /**
   * date 이하에서 가장 가까운 거래일. 없으면 undefined — 조회 앵커가 없다는 뜻이다.
   * 휴장일은 symbolMasterTradingDays 에 기록되지 않으므로 자연히 건너뛴다.
   *
   * 커버 여부와 무관하게 전역에서 찾는 raw 버전이다 — date 가 아예 커버 밖이어도,
   * date 와 전혀 안 이어진 먼 과거 거래일이어도 값을 낼 수 있다. 그래서 "조회해도
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
   * 나지 않게 onConflictDoNothing 을 쓴다. 호출자가 SCD 버전·coverage 갱신과 같은
   * 트랜잭션 안에서 불러야 한다 — 따로 두면 중간에 죽었을 때 거래일 기록만 빠진다.
   */
  private recordTradingDay(tx: AppDatabase, date: string): void {
    tx.insert(symbolMasterTradingDays).values({ date }).onConflictDoNothing().run();
  }

  /**
   * 이미 받아 둔 kospiTrades·kosdaqTrades 로 그날의 일봉을 krxDailyBars 에 저장한다 —
   * ingestDateUnguarded 가 KRX 를 다시 부르지 않고 넘겨주는 값을 그대로 쓴다. 호출자가
   * SCD 버전·coverage·거래일 기록과 같은 트랜잭션 안에서 불러야 한다 — 따로 두면 중간에
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

  /** SCD·coverage·일봉 write 와 같은 transaction 안에서 KRX 선정 지표를 보관한다. */
  private writeSelectionMetrics(
    tx: AppDatabase,
    date: string,
    universe: UniverseState,
    kospiTrades: readonly KrxDailyTradeRow[],
    kosdaqTrades: readonly KrxDailyTradeRow[],
  ): void {
    const standardCodeByShortCode = new Map<string, string>();
    for (const entry of universe.values()) {
      standardCodeByShortCode.set(entry.shortCode, entry.standardCode);
    }
    const rows: (typeof dailySelectionMetrics.$inferInsert)[] = [];
    for (const trade of [...kospiTrades, ...kosdaqTrades]) {
      const standardCode = standardCodeByShortCode.get(trade.shortCode);
      if (standardCode === undefined) continue;
      rows.push({
        date,
        standardCode,
        marketCapKrw: metricDecimalText(trade.marketCapRaw),
        volume: trade.volume,
        tradingValueKrw: metricDecimalText(trade.tradingValueRaw),
      });
    }
    for (let index = 0; index < rows.length; index += 190) {
      tx.insert(dailySelectionMetrics)
        .values(rows.slice(index, index + 190))
        .onConflictDoUpdate({
          target: [dailySelectionMetrics.date, dailySelectionMetrics.standardCode],
          // 재조회가 KRX 빈 값을 받더라도 migration 으로 옮긴 cap·기존 보강값은 지우지 않는다.
          set: {
            marketCapKrw: sql`coalesce(excluded.market_cap_krw, daily_selection_metrics.market_cap_krw)`,
            volume: sql`coalesce(excluded.volume, daily_selection_metrics.volume)`,
            tradingValueKrw: sql`coalesce(excluded.trading_value_krw, daily_selection_metrics.trading_value_krw)`,
          },
        })
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
   * 구간 전체를 덮는 커버 행이 하나라도 있는지.
   *
   * 행이 없는 날짜가 "거래불가 종목이 없었다" 인지 "아직 모른다" 인지를 이 메서드로만
   * 가른다. 이 구분이 없으면 결과 경고가 백필 전에도 "반영한다" 고 거짓말한다.
   *
   * 조각을 읽는 쪽에서 이어 붙이지 않는다. 쓰는 쪽(mergeNonTradingCoverage)이 맞닿거나
   * 겹치는 구간을 그때그때 합치므로, 저장된 구간들은 항상 서로 떨어진 최대 구간이다.
   * 하루씩 들어오는 수집 경로는 읽기 쪽 이어붙이기만으로는 10년치에 행 수천 개를 쌓게
   * 되는데, 쓰기 쪽에서 합치면 그 문제까지 함께 사라진다.
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
   *
   * 커버는 응답을 하나라도 받은 날짜까지만 넓힌다. 한 날짜도 응답이 없으면 커버를
   * 아예 남기지 않는다 — 잘못 설정된 소스로 10년치를 돌린 실행이 아무것도 저장하지
   * 않고 그 10년을 "다 봤다" 로 만들면, 실행 경고가 영영 사라진다. 반대로 응답을
   * 받았는데 거래불가 종목만 0건인 날은 커버로 남긴다. "봤는데 없었다" 와 "안 봤다"
   * 는 끝까지 갈라야 한다.
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
      if (byMarket.every(([, trades]) => trades.length === 0)) continue;
      dates += 1;
      // 행 저장과 커버를 같은 트랜잭션에 넣는다. 나누면 중간에 죽었을 때 행은 들어갔는데
      // 커버는 없는 날짜가 남고, 그 날짜는 다시 백필하지 않는 한 영영 "모른다" 로 읽힌다.
      // 커버를 [from, date] 로 넓히는 이유는 그 사이 응답 0행인 날(휴장·주말)도 실제로
      // 조회했기 때문이다 — 하루씩만 넣으면 주말에서 구간이 끊긴다.
      this.deps.db.transaction((tx) => {
        for (let i = 0; i < values.length; i += 500) {
          tx.insert(krxNonTradingDays).values(values.slice(i, i + 500)).onConflictDoNothing().run();
        }
        this.mergeNonTradingCoverage(tx, from, date);
      });
      rows += values.length;
    }
    // 한 날짜도 응답이 없으면 본 것이 없다 — 커버를 남기지 않는다
    if (dates === 0) return { dates, rows };
    // 마지막 응답일 뒤의 날짜(구간 끝이 주말·휴장인 경우)까지 넓힌다. 그 날짜들도 조회는 했다.
    this.deps.db.transaction((tx) => this.mergeNonTradingCoverage(tx, from, to));
    return { dates, rows };
  }

  /**
   * [startDate, endDate] 를 거래불가 커버에 반영하며 맞닿거나 겹치는 구간과 합친다.
   * `mergeCoverage` 와 같은 규칙을 구간 단위로 넓힌 것이다.
   *
   * 수집 경로는 하루씩, 백필은 한 번에 여러 날을 넣는다. 합치지 않으면 두 경로 모두
   * 조각난 행을 쌓고, 구간 전체를 덮는 행이 없어 `isNonTradingRangeCovered` 가
   * 실제로는 다 채운 기간을 "모른다" 로 판정한다.
   *
   * 수집 경로에서는 반드시 봉·거래일 기록과 같은 트랜잭션 안에서 불러야 한다 —
   * 따로 두면 중간에 죽었을 때 거래불가일 행은 들어갔는데 커버는 안 남은 상태가 되고,
   * 그 날짜는 재수집 게이트에 막혀 영영 커버로 바뀌지 않는다.
   */
  private mergeNonTradingCoverage(tx: AppDatabase, startDate: string, endDate: string): void {
    // 하루 차이로 맞닿은 구간까지 합치려고 양쪽을 하루씩 넓혀 겹침을 본다
    const touchStart = addCalendarDays(startDate, -1);
    const touchEnd = addCalendarDays(endDate, 1);

    let mergedStart = startDate;
    let mergedEnd = endDate;
    const ranges = tx.select().from(krxNonTradingCoverage).all();
    for (const range of ranges) {
      if (range.endDate < touchStart || range.startDate > touchEnd) continue;
      if (range.startDate < mergedStart) mergedStart = range.startDate;
      if (range.endDate > mergedEnd) mergedEnd = range.endDate;
      tx.delete(krxNonTradingCoverage).where(eq(krxNonTradingCoverage.id, range.id)).run();
    }

    tx.insert(krxNonTradingCoverage).values({
      startDate: mergedStart,
      endDate: mergedEnd,
      syncedAtMs: this.deps.clock.now(),
    }).run();
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

  /**
   * [from, to] 구간의 버전 경계를 비교해 변경 이벤트를 파생한다. 이벤트는
   * 재구성 원천이 아니라 사용자에게 변경 이유를 보여 주는 read model 이다.
   */
  listEvents(from: string, to: string): SymbolMasterEventRow[] {
    const rows = this.deps.db
      .select()
      .from(symbolMasterVersions)
      .where(
        or(
          and(
            gte(symbolMasterVersions.validFromDate, from),
            lte(symbolMasterVersions.validFromDate, to),
          ),
          and(
            isNotNull(symbolMasterVersions.validToDate),
            gte(symbolMasterVersions.validToDate, from),
            lte(symbolMasterVersions.validToDate, to),
          ),
        ),
      )
      .all();
    const observedDates = this.deps.db
      .select({ date: symbolMasterTradingDays.date })
      .from(symbolMasterTradingDays)
      .where(lt(symbolMasterTradingDays.date, to))
      .orderBy(asc(symbolMasterTradingDays.date))
      .all()
      .map((row) => row.date);
    const previousObservedDate = (date: string): string | undefined => {
      let low = 0;
      let high = observedDates.length;
      while (low < high) {
        const mid = Math.floor((low + high) / 2);
        if (observedDates[mid]! < date) low = mid + 1;
        else high = mid;
      }
      return observedDates[low - 1];
    };

    const boundaries = new Map<string, {
      date: string;
      standardCode: string;
      before?: SymbolMasterEntry;
      after?: SymbolMasterEntry;
    }>();
    const boundary = (date: string, standardCode: string) => {
      const key = `${date}|${standardCode}`;
      const value = boundaries.get(key) ?? { date, standardCode };
      boundaries.set(key, value);
      return value;
    };

    for (const row of rows) {
      if (row.validFromDate >= from && row.validFromDate <= to) {
        boundary(row.validFromDate, row.standardCode).after = this.entryFromVersion(row);
      }
      if (row.validToDate !== null && row.validToDate >= from && row.validToDate <= to) {
        boundary(row.validToDate, row.standardCode).before = this.entryFromVersion(row);
      }
    }

    const events: SymbolMasterEventRow[] = [];
    for (const item of boundaries.values()) {
      const observedSpanStart = previousObservedDate(item.date);
      // 저장소가 처음 관측한 baseline 전 종목을 신규상장으로 오인하지 않는다.
      if (observedSpanStart === undefined) continue;
      const previous: UniverseState = item.before === undefined
        ? new Map()
        : new Map([[item.standardCode, item.before]]);
      const next: UniverseState = item.after === undefined
        ? new Map()
        : new Map([[item.standardCode, item.after]]);
      for (const draft of diffUniverse(previous, next, {
        effectiveDate: item.date,
        observedSpanStart,
      })) {
        events.push({
          ...draft,
          id: `${draft.effectiveDate}:${draft.standardCode}:${draft.eventType}`,
        });
      }
    }

    return events.sort((a, b) =>
      a.effectiveDate.localeCompare(b.effectiveDate) || a.id.localeCompare(b.id));
  }

  /**
   * [from, to] 구간에 효력이 발생한 상장폐지 이벤트. 백테스트 워커가 폐지 종목을
   * 청산하는 데 쓴다.
   *
   * `symbol_master_events` 를 직접 읽지 않고 `listEvents` 를 거른다. 그 테이블은 SCD
   * 이행(D-045) 전 legacy 이력일 뿐이라, 이행 후 발생한 폐지는 한 줄도 들어가지 않는다.
   * 테이블을 읽으면 신규 폐지가 조용히 빠져 청산이 일어나지 않는데, 에러도 경고도 없이
   * 결과만 낙관적으로 틀린다. "무엇이 폐지인가" 의 판정도 `diffUniverse` 한 곳에 남는다.
   *
   * shortCode 는 `oldValue` JSON 에서 꺼낸다. standardCode 만으로는 봉이 쓰는
   * 단축코드와 이어지지 않는다 — `diffUniverse` 가 DELISTED 의 `oldValue` 에
   * `SymbolMasterEntry` 전체를 넣으므로 정상 데이터라면 항상 있다. 파싱에 실패하거나
   * shortCode 가 없는 행은 건너뛰고 경고를 남긴다. 조용히 버리면 워커가 왜 그 종목의
   * 폐지를 반영하지 못했는지 아무도 추적할 수 없다.
   */
  delistedEventsBetween(
    from: string,
    to: string,
  ): readonly { shortCode: string; effectiveDate: string }[] {
    const candidates: { standardCode: string; shortCode: string; effectiveDate: string }[] = [];
    for (const event of this.listEvents(from, to)) {
      if (event.eventType !== 'DELISTED') continue;
      const shortCode = this.parseDelistedShortCode(event.oldValue, event.id, event.effectiveDate);
      if (shortCode === undefined) continue;
      candidates.push({ standardCode: event.standardCode, shortCode, effectiveDate: event.effectiveDate });
    }
    if (candidates.length === 0) return [];

    // 같은 **표준코드**가 폐지일 뒤에 다시 열리면 폐지가 아니라 KRX 기초정보 응답의
    // 하루짜리 결측이다. persistTradingDay 는 fetched 에 없는 종목의 구간을 닫으므로,
    // 한 종목이 하루 빠졌다 돌아오면 D 에 DELISTED, D+1 에 LISTED 로 파생된다.
    // assertBaseInfoPresent 의 80% 문턱은 이런 한 종목짜리 결측을 잡지 못한다.
    //
    // 진짜 재상장은 이 필터에 걸리지 않는다. 단축코드를 재사용해 다른 회사가 들어와도
    // 표준코드는 언제나 새로 발급되기 때문이다 — 폐지된 표준코드가 되살아나는 일은 없다.
    // 그래서 이 조건은 결측만 걸러내고 실제 폐지는 그대로 남긴다.
    const codes = [...new Set(candidates.map((candidate) => candidate.standardCode))];
    const reopenedFromDates = new Map<string, string[]>();
    // SQLite 바인딩 변수 상한에 걸리지 않게 다른 조회와 같은 크기로 끊는다
    for (let i = 0; i < codes.length; i += 500) {
      for (const row of this.deps.db
        .select({
          standardCode: symbolMasterVersions.standardCode,
          validFromDate: symbolMasterVersions.validFromDate,
        })
        .from(symbolMasterVersions)
        .where(inArray(symbolMasterVersions.standardCode, codes.slice(i, i + 500)))
        .all()) {
        const dates = reopenedFromDates.get(row.standardCode) ?? [];
        dates.push(row.validFromDate);
        reopenedFromDates.set(row.standardCode, dates);
      }
    }

    const result: { shortCode: string; effectiveDate: string }[] = [];
    for (const candidate of candidates) {
      const reopened = (reopenedFromDates.get(candidate.standardCode) ?? []).some(
        (validFromDate) => validFromDate > candidate.effectiveDate,
      );
      if (reopened) {
        this.deps.logger.warn(
          {
            module: 'market-data',
            event: 'symbol-master.delisting-suppressed',
            standardCode: candidate.standardCode,
            effectiveDate: candidate.effectiveDate,
          },
          '폐지 뒤 같은 표준코드가 다시 열려 있어 폐지로 보지 않는다 — KRX 기초정보 결측으로 본다',
        );
        continue;
      }
      result.push({ shortCode: candidate.shortCode, effectiveDate: candidate.effectiveDate });
    }
    return result;
  }

  /**
   * [from, to] 구간에 KRX 상장주식수가 바뀐 날. 백테스트 워커가 DART 자본변동의
   * 효력발생일을 **주가가 실제로 조정된 날**로 옮기는 데 쓴다
   * (corporate-action-effective-date.ts 참고).
   *
   * 액면분할에서 이 날이 곧 변경상장일이다. DART 가 주는 날짜는 분할 기준일이라
   * 그 사이 주권교체 정지 구간만큼 어긋난다.
   *
   * `delistedEventsBetween` 과 같은 이유로 `symbol_master_events` 가 아니라
   * `listEvents` 를 거른다 — 그 테이블은 SCD 이행(D-045) 전 legacy 이력이다.
   * 저장소가 처음 관측한 날은 LISTED 라 여기 걸리지 않는다.
   */
  sharesChangesBetween(
    from: string,
    to: string,
  ): readonly { shortCode: string; effectiveDate: string; ratio: number }[] {
    const events = this.listEvents(from, to).filter((event) => event.eventType === 'SHARES_CHANGED');
    if (events.length === 0) return [];

    // 단축코드는 이벤트에 없다 — SHARES_CHANGED 의 old/newValue 는 주식수 문자열뿐이다.
    // 그 날 유효한 버전 행에서 읽는다. 봉·팩트가 쓰는 키가 단축코드라 표준코드로는 잇지 못한다.
    const codes = [...new Set(events.map((event) => event.standardCode))];
    const versions: { standardCode: string; validFromDate: string; validToDate: string | null; shortCode: string }[] = [];
    for (let i = 0; i < codes.length; i += 500) {
      versions.push(
        ...this.deps.db
          .select({
            standardCode: symbolMasterVersions.standardCode,
            validFromDate: symbolMasterVersions.validFromDate,
            validToDate: symbolMasterVersions.validToDate,
            shortCode: symbolMasterVersions.shortCode,
          })
          .from(symbolMasterVersions)
          .where(inArray(symbolMasterVersions.standardCode, codes.slice(i, i + 500)))
          .all(),
      );
    }

    const result: { shortCode: string; effectiveDate: string; ratio: number }[] = [];
    for (const event of events) {
      const before = Number(JSON.parse(event.oldValue ?? 'null') as unknown);
      const after = Number(JSON.parse(event.newValue ?? 'null') as unknown);
      if (!Number.isFinite(before) || !Number.isFinite(after) || before <= 0 || after <= 0) continue;
      const version = versions.find(
        (row) =>
          row.standardCode === event.standardCode
          && row.validFromDate <= event.effectiveDate
          && (row.validToDate === null || row.validToDate > event.effectiveDate),
      );
      if (version === undefined) continue;
      result.push({
        shortCode: version.shortCode,
        effectiveDate: event.effectiveDate,
        ratio: after / before,
      });
    }
    return result.sort(
      (a, b) =>
        a.effectiveDate.localeCompare(b.effectiveDate) || a.shortCode.localeCompare(b.shortCode),
    );
  }

  /**
   * DELISTED 이벤트 한 건의 oldValue 에서 shortCode 를 꺼낸다. 실패하면 경고를 남기고 undefined 를 돌려준다.
   *
   * 아래 세 분기(oldValue 없음·파싱 실패·shortCode 없음)는 단위 테스트가 없다. `listEvents`
   * 가 만드는 DELISTED oldValue 는 `diffUniverse` 가 항상 `SymbolMasterEntry` 전체를
   * JSON.stringify 한 값이라 그 모양이 유지되는 한 이 분기들에 실제로 도달할 경로가 없다.
   * 그래도 지우지 않는 이유는 diffUniverse 의 오래된 값이 언젠가 바뀔 수 있어서다 — 그때도
   * 이 메서드가 throw 대신 skip+warn 으로 물러나야 손상된 이벤트 한 건이 백테스트 실행
   * 전체를 끌고 내려가지 않는다.
   */
  private parseDelistedShortCode(
    oldValue: string | null,
    id: string,
    effectiveDate: string,
  ): string | undefined {
    if (oldValue === null) {
      this.deps.logger.warn(
        {
          module: 'market-data',
          event: 'symbol-master.delisted-event-missing-old-value',
          id,
          effectiveDate,
        },
        'DELISTED 이벤트에 oldValue 가 없어 건너뛴다',
      );
      return undefined;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(oldValue);
    } catch {
      this.deps.logger.warn(
        {
          module: 'market-data',
          event: 'symbol-master.delisted-event-parse-failed',
          id,
          effectiveDate,
        },
        'DELISTED 이벤트의 oldValue 파싱에 실패해 건너뛴다',
      );
      return undefined;
    }

    const shortCode = (parsed as { shortCode?: unknown } | null)?.shortCode;
    if (typeof shortCode !== 'string' || shortCode.length === 0) {
      this.deps.logger.warn(
        {
          module: 'market-data',
          event: 'symbol-master.delisted-event-missing-short-code',
          id,
          effectiveDate,
        },
        'DELISTED 이벤트의 oldValue 에 shortCode 가 없어 건너뛴다',
      );
      return undefined;
    }
    return shortCode;
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
    if (universe.has(row.standardCode)) {
      throw new Error(`KRX 기본정보 중복 표준코드(${market}, ${row.standardCode})`);
    }
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

  /** 거래가 있는데 같은 시장의 기본정보가 비면 전체 상폐로 오염시키지 않고 수집을 중단한다. */
  private assertBaseInfoPresent(
    date: string,
    market: KrxMarket,
    trades: readonly KrxDailyTradeRow[],
    baseInfo: readonly KrxIssueBaseInfoRow[],
    modeled: UniverseState,
  ): void {
    const modeledCount = [...modeled.values()].filter((entry) => entry.market === market).length;
    if (baseInfo.length === 0 && (trades.length > 0 || modeledCount > 0)) {
      throw new Error(`KRX ${market} 기본정보가 비어 있다(${date})`);
    }
    if (modeledCount >= 20 && baseInfo.length < modeledCount * 0.8) {
      throw new Error(
        `KRX ${market} 기본정보가 급감했다(${date}): ${modeledCount} → ${baseInfo.length}`,
      );
    }
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
