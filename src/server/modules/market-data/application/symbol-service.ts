import { createHash } from 'node:crypto';
import { and, desc, eq, inArray } from 'drizzle-orm';
import type { AppDatabase } from '../../../shared/db/database.js';
import { dataSyncJobs, symbolVersions, symbols as symbolsTable } from '../../../shared/db/schema.js';
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

/**
 * 종목 등록·이름·재무 버전 체인만 남은 서비스 (설계 2026-07-31-symbol-as-first-class
 * 의 후신). 봉 수집·CSV 가져오기·슬라이스 커버리지·버전 pin(옛 versionSnapshotFor)은
 * 이 커밋(Task 5, 2026-08-07-price-data-removal)이 걷어냈다.
 *
 * bumpVersion 은 남는다 — `FactSyncService` 가 재무 버전 체인(FACTS_SLICE)을 올릴 때
 * 이 서비스를 좁은 포트(SymbolVersionBumper)로 받아 쓴다 (§9.5).
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
   * 구 `CompositeCandleRepository.deleteSymbol` 주석의 근거를 그대로 따른다.
   */
  async removeSymbols(codes: readonly string[]): Promise<void> {
    if (codes.length === 0) return;
    const running = this.db
      .select({ id: dataSyncJobs.id })
      .from(dataSyncJobs)
      .where(inArray(dataSyncJobs.status, ['QUEUED', 'RUNNING']))
      .get();
    if (running) throw new Error('데이터 작업이 실행 중입니다 — 완료 후 제거하세요');

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
