import { createHash } from 'node:crypto';
import { and, desc, eq, inArray } from 'drizzle-orm';
import type { AppDatabase } from '../../../shared/db/database.js';
import { symbolVersions, symbols as symbolsTable } from '../../../shared/db/schema.js';
import type { Clock } from '../../../shared/clock.js';
import { newId } from '../../../shared/ids.js';
import type { AuditLogService } from '../../audit/audit-service.js';
import { SYMBOL_PATTERN, type Market } from '../domain/candle.js';
import { getSessionForMarket } from '../domain/exchange-session.js';

/** 종목 화면의 한 행 */
export interface SymbolSummary {
  readonly code: string;
  readonly market: Market;
  readonly name: string | null;
}

/** 단축코드 등록 행의 정체성 확인용 최소 투영. null standardCode도 중요한 상태다. */
export interface RegisteredSymbolIdentity {
  readonly code: string;
  readonly standardCode: string | null;
}

/**
 * 재무 버전 체인의 슬라이스 자리. `facts` 모듈(`fact-sync-service.ts`)이 이 값을
 * import 해서 쓴다.
 *
 * market-data 는 facts 를 몰라도 되지만(§7), facts 는 market-data 를 이미 안다
 * (예: `exchange-session.js`) — 그래서 원천을 여기 하나로 두고, 손으로 맞추던
 * 중복 상수를 없앴다(리뷰 finding, 2026-08-08).
 */
export const FACTS_SLICE = 'FACTS';

/** 실행이 소비한 (종목, 축, 버전, 해시) 한 칸 — §9.5 재현성 스냅샷의 구성 요소 */
export interface ConsumedVersionEntry {
  readonly code: string;
  readonly slice: string;
  readonly version: number;
  readonly contentHash: string;
}

/** 백테스트가 제출 시점에 고정하는 종목 버전 pin (§9.5) */
export interface ConsumedVersionSnapshot {
  readonly entries: readonly ConsumedVersionEntry[];
  /** 정렬된 항목을 이어 붙인 집계 해시 */
  readonly hash: string;
}

/**
 * 종목 등록·이름·재무 버전 체인만 남은 서비스 (설계 2026-07-31-symbol-as-first-class
 * 의 후신). 봉 수집·CSV 가져오기·슬라이스 커버리지는 Task 5(2026-08-07-price-data-removal)
 * 가 걷어냈다.
 *
 * versionSnapshotFor 는 남지만 재무(FACTS_SLICE) 축만 본다 — 봉 버전 체인이
 * 사라지면서(Task 5) 남은 유일한 축이 재무이기 때문이다(Task 6). krx_daily_bars
 * 는 시장 전체가 공유하는 원천이라 종목별 버전을 따로 매기지 않는다.
 *
 * bumpVersion 은 남는다 — `FactSyncService` 가 재무 버전 체인을 올릴 때 이 서비스를
 * 좁은 포트(SymbolVersionBumper)로 받아 쓴다 (§9.5).
 * getLatestVersion 은 그 내부 구현이라 private 로 낮췄다.
 * DART 재무 수집 자체는 이 태스크가 건드리지 않는다.
 */
export class SymbolService {
  constructor(
    private readonly db: AppDatabase,
    private readonly clock: Clock,
    private readonly audit: AuditLogService,
  ) {}

  listSymbols(): SymbolSummary[] {
    return this.db
      .select()
      .from(symbolsTable)
      .all()
      .map((row) => this.toSummary(row));
  }

  /**
   * 종목 하나만 조회한다 — 목록 전체를 만들어 찾지 않는다.
   *
   * 이전에는 `listSymbols().find(...)` 였다. 등록이 반환값으로 이것을 부르므로 1,000종목
   * 일괄 등록이 목록을 1,000번 재구성하는 O(n²) 가 됐다.
   */
  getSymbol(code: string): SymbolSummary | null {
    const row = this.db.select().from(symbolsTable).where(eq(symbolsTable.code, code)).get();
    return row ? this.toSummary(row) : null;
  }

  /**
   * KRX 스냅샷 자동 등록이 기존 단축코드를 같은 증권으로 간주해도 되는지 확인한다.
   * 표시용 `SymbolSummary`에 standardCode를 섞지 않고 준비 경계에만 좁게 노출한다.
   */
  getRegisteredIdentity(code: string): RegisteredSymbolIdentity | null {
    const row = this.db
      .select({ code: symbolsTable.code, standardCode: symbolsTable.standardCode })
      .from(symbolsTable)
      .where(eq(symbolsTable.code, code))
      .get();
    return row ?? null;
  }

  /** 표준코드가 이미 다른 단축코드에 등록됐는지 자동 등록 전에 확인한다. */
  getRegisteredIdentityByStandardCode(standardCode: string): RegisteredSymbolIdentity | null {
    const row = this.db
      .select({ code: symbolsTable.code, standardCode: symbolsTable.standardCode })
      .from(symbolsTable)
      .where(eq(symbolsTable.standardCode, standardCode))
      .get();
    return row ?? null;
  }

  /** 행 → 화면이 읽는 요약. 목록과 단건이 같은 모양을 내도록 한 곳에 둔다 */
  private toSummary(row: typeof symbolsTable.$inferSelect): SymbolSummary {
    return { code: row.code, market: row.market as Market, name: row.name };
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
   * 로컬 종목 마스터의 이름·시장 — `SymbolInfoService` 가 증권사 응답에 없는 코드를
   * 메우는 폴백으로 쓴다 (유니버스 미리보기 자동 등록이 채워 둔 이름).
   *
   * 이름이 없는 행은 결과에서 뺀다 — 폴백은 "이름을 안다" 는 확신이 있을 때만 채워야
   * 한다.
   */
  getLocalNames(codes: readonly string[]): Map<string, { name: string; market: Market }> {
    const result = new Map<string, { name: string; market: Market }>();
    if (codes.length === 0) return result;
    const rows = this.db
      .select({ code: symbolsTable.code, name: symbolsTable.name, market: symbolsTable.market })
      .from(symbolsTable)
      .where(inArray(symbolsTable.code, [...codes]))
      .all();
    for (const row of rows) {
      if (row.name) result.set(row.code, { name: row.name, market: row.market as Market });
    }
    return result;
  }

  /**
   * 종목 제거 — 목록에서만 뺀다.
   *
   * KRX 일봉은 지우지 않는다. 시장 전체가 공유하는 자산이라 종목을 목록에서 빼는
   * 일과 함께 지우면, 그 종목을 참조하던 다른 백테스트·데이터셋의 봉까지 사라진다.
   */
  removeSymbols(codes: readonly string[]): void {
    if (codes.length === 0) return;
    // 예전에는 여기서 dataSyncJobs 에 QUEUED/RUNNING 잡이 있는지 확인해 동시 수집과
    // 제거가 겹치지 않게 막았다. 동시 수집 잡 개념 자체가 D-041 로 사라져 그 조회는
    // 항상 빈 결과였다(도달 불가) — 조회 자체를 지웠다.

    for (const code of codes) {
      const row = this.db.select().from(symbolsTable).where(eq(symbolsTable.code, code)).get();
      if (!row) continue;
      this.db.delete(symbolsTable).where(eq(symbolsTable.code, code)).run();
      this.audit.record('system', 'symbol.removed', { code });
    }
  }

  private getLatestVersion(
    code: string,
    slice: string,
  ): { version: number; contentHash: string } | null {
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
   * 제출 시점 종목 버전 스냅샷 (§9.5) — 백테스트가 제출 시점에 고정해, 대기 중 재무
   * 동기화가 끼어들어도 실행이 소비한 버전이 어긋나지 않게 한다.
   *
   * 재무(FACTS_SLICE) 축 하나만 담는다. 봉은 예전에 CSV 가져오기·증권사 동기화가
   * 버전을 올렸지만, 그 경로는 Task 5 에서 사라졌다. krx_daily_bars 는 종목별 버전을
   * 매기지 않는 공유 원천이라 고정할 대상이 없다. 버전이 없는 종목도 version 0 으로
   * 남긴다 — "아직 수집 안 됨" 도 입력 상태의 일부다.
   *
   * **이 pin 은 재무 축만 덮고 봉 축은 덮지 않는다.**
   * 예전에는 이 자리에 다른 이유로 미해결 gap 을 적어 뒀다.
   * `SymbolMasterService.writeDailyBars` 가 `onConflictDoUpdate` 로 이미
   * 적재된 날짜를 덮어썼기 때문이다.
   * 그래서 제출 이후 봉이 바뀌어도 드리프트 경고가 못 잡았다.
   * 그 전제가 D-043 으로 사라졌다.
   * Task 3(자본변동 포지션 연속성, 2026-08-08)이 `writeDailyBars` 를
   * `onConflictDoNothing` 으로 바꿨다.
   * 이미 적재된 날짜는 다시 써도 값이 바뀌지 않는다.
   * 그래서 위 시나리오(재수집이 조용히 봉을 바꾼다)는 더 이상 일어나지 않는다.
   *
   * 봉 축에 버전 계보 자체가 없다는 사실은 그대로 남는다.
   * KRX 일봉은 슬라이스 축이 있던 시절에도 종목별 버전을 가진 적이 없었다.
   * 다만 봉이 구조적으로 불변이라, 그 계보 부재가 지금은 실질적인 위험으로
   * 이어지지 않는다.
   */
  versionSnapshotFor(codes: readonly string[]): ConsumedVersionSnapshot {
    const uniqueCodes = [...new Set(codes)].sort();
    const entries: ConsumedVersionEntry[] = uniqueCodes.map((code) => {
      const latest = this.getLatestVersion(code, FACTS_SLICE);
      return {
        code,
        slice: FACTS_SLICE,
        version: latest?.version ?? 0,
        contentHash: latest?.contentHash ?? '',
      };
    });
    const hash = createHash('sha256')
      .update(entries.map((e) => `${e.code}:${e.slice}:${e.version}:${e.contentHash}`).join('|'))
      .digest('hex');
    return { entries, hash };
  }

  /**
   * 체인 해시: 이전 버전 해시에 이번 변경의 지문(seed)을 연결해 전체 변경 이력이 해시에
   * 반영되게 한다. 마지막 변경만 해싱하면 서로 다른 종목이 같은 지문을 가질 수 있다 (§9.5).
   *
   * 지금은 재무 수집(`FactSyncService`)만 이 메서드를 부른다 — 봉 버전 체인은 CSV
   * 가져오기·증권사 동기화와 함께 사라졌다(Task 5, 2026-08-07-price-data-removal).
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
}
