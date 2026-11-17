import { DartFilingDiscovery, type FilingPage } from '../../src/server/modules/facts/application/dart-filing-discovery.js';
import { SqliteDartPendingFilingStore } from '../../src/server/modules/facts/infrastructure/dart/dart-pending-filing-store.js';
import { SqliteProviderRequestPolicy } from '../../src/server/shared/provider-request-policy.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FactSyncService } from '../../src/server/modules/facts/application/fact-sync-service.js';
import { SqliteFactCoverageStore } from '../../src/runtime/modules/facts/application/fact-coverage-store.js';
import { SqliteCorporateActionCoverageStore } from '../../src/runtime/modules/facts/application/corporate-action-coverage.js';
import { createDartFactSource } from '../../src/server/modules/facts/infrastructure/dart/dart-fact-source.js';
import { SqliteDartRawSnapshotStore } from '../../src/server/modules/facts/infrastructure/dart/sqlite-dart-raw-snapshot-store.js';
import { SqliteFactRepository } from '../../src/runtime/modules/facts/infrastructure/sqlite-fact-repository.js';
import { openDatabase, type DatabaseHandle } from '../../src/runtime/shared/db/database.js';
import { symbols } from '../../src/runtime/shared/db/schema.js';

const LOGGER = { debug() {}, info() {}, warn() {}, error() {} } as never;
const START = Date.UTC(2026, 8, 12);
const REQUEST = {
  symbols: ['005930'], fromYear: 2016, toYear: 2017, consolidated: true, mode: 'INCREMENTAL' as const,
};

function setup(database: DatabaseHandle, now: number, corrected = false, options?: {
  collectionVersion?: string;
  financialRows?: (year: string, report: string) => readonly Record<string, string>[] | undefined;
}) {
  const calls: string[] = [];
  const clock = { now: () => now };
  const pending = new SqliteDartPendingFilingStore(database.sqlite);
  const policy = new SqliteProviderRequestPolicy(database.sqlite, clock.now);
  const fetchImpl = (async (url: string | URL) => {
      const parsed = new URL(String(url));
      const year = parsed.searchParams.get('bsns_year');
      const report = parsed.searchParams.get('reprt_code');
      const isCorrection = corrected && year === '2016' && report === '11011';
      calls.push(`${parsed.pathname}:${year}:${report}`);
      if (parsed.pathname.endsWith('/list.json')) {
        return Response.json({ status: '000', total_page: 1, list: corrected && (parsed.searchParams.get('bgn_de') ?? '').replaceAll('-', '') <= '20260913' && (parsed.searchParams.get('end_de') ?? '99991231').replaceAll('-', '') >= '20260913' ? [{
          stock_code: '005930', report_nm: '사업보고서 (2016.12)',
          rcept_no: '20260913000001', rcept_dt: '20260913',
        }] : [] });
      }
      if (parsed.pathname.includes('fnlttSinglAcntAll')) {
        const fixture = options?.financialRows?.(year!, report!);
        if (fixture !== undefined) return Response.json({ status: '000', list: fixture });
        return Response.json({ status: '000', list: [{
          rcept_no: isCorrection ? '20260913000001' : `${year}0515000001`,
          reprt_code: report, bsns_year: year, sj_div: 'BS',
          account_id: 'ifrs-full_CurrentAssets', account_nm: '유동자산',
          thstrm_amount: isCorrection ? '2000' : '1000',
        }] });
      }
      if (isCorrection && parsed.pathname.includes('stockTotqySttus')) return Response.json({status:'000',list:[{
        rcept_no:'20260913000001',se:'보통주',istc_totqy:'1000',now_to_isu_stock_totqy:'1000',
      }]});
      if (isCorrection && parsed.pathname.includes('irdsSttus')) return Response.json({status:'000',list:[{
        rcept_no:'20260913000001',isu_dcrs_de:'2016-12-20',isu_dcrs_stle:'유상증자',isu_dcrs_stock_knd:'보통주',isu_dcrs_qy:'100',
      }]});
      return Response.json({ status: '013', message: '조회된 데이터가 없습니다' });
    }) as typeof fetch;
  const source = createDartFactSource({ baseUrl: 'https://dart.test', apiKey: 'test' }, LOGGER, {
    clock, rawSnapshots: new SqliteDartRawSnapshotStore(database.db), pendingFilings:pending, requestPolicy:policy,
    corpCodeResolver: { resolve: async () => '00126380' }, sleep: async () => {}, fetchImpl,
  });
  const discovery = () => new DartFilingDiscovery({sqlite:database.sqlite,logger:LOGGER,now:clock.now,
    onFilingsStored:(ids)=>{pending.observeFilings(ids);},
    fetchPage:async(from,to,page,beforeAttempt)=>{
      beforeAttempt();
      const query=new URLSearchParams({bgn_de:from,end_de:to,page_no:String(page)});
      return await (await fetchImpl(`https://dart.test/api/list.json?${query}`)).json() as FilingPage;
    },
  });
  const facts = new SqliteFactRepository(database.db);
  const coverage = new SqliteFactCoverageStore(database.db, options?.collectionVersion ? { collectionVersion: options.collectionVersion } : undefined);
  const actions = new SqliteCorporateActionCoverageStore(database.db, options?.collectionVersion ? { collectionVersion: options.collectionVersion } : undefined);
  return {
    calls, facts, coverage, actions, pending, policy, discovery,
    service: new FactSyncService(source, facts, LOGGER, { bumpVersion() {} }, clock, coverage, actions),
  };
}

function seed(database: DatabaseHandle): void {
  database.db.insert(symbols).values({ code: '005930', market: 'KR', name: '테스트', createdAtMs: START }).run();
}

describe('DART 수집 중단 후 SQLite 재개', () => {
  it('새 수집 버전은 차단된 연도의 저장 원문을 재해석하고 팩트와 gap을 교체한다', async () => {
    const database = openDatabase(':memory:');
    try {
      seed(database);
      const financialRows = (year: string, report: string) => {
        if (year !== '2019' && year !== '2020') return undefined;
        const lines: readonly (readonly [string, string, string, string])[] = year === '2019' ? [
          ['1', 'ifrs_CurrentLiabilities', '유동부채', '2850327454058'],
          ['2', 'dart_CurrentPortionOfBonds', '유동성사채', '199953500839'],
          ['3', '-표준계정코드 미사용-', '소유주분배예정부채집단', '262883413682'],
          ['4', 'ifrs_NoncurrentLiabilities', '비유동부채', '1647142175954'],
          ['5', 'dart_BondsIssued', '비유동사채', '898561179354'],
          ['6', 'ifrs_Liabilities', '부채총계', '4760353043694'],
        ] : [
          ['1', 'ifrs_CurrentLiabilities', '유동부채', '1000'],
          ['2', 'dart_CurrentPortionOfBonds', '사채', '20'],
          ['3', 'dart_BondsIssued', '사채', '30'],
          ['4', 'ifrs_NoncurrentLiabilities', '비유동부채', '2000'],
          ['5', 'ifrs_Liabilities', '부채총계', '3000'],
        ];
        return lines.map(([ord, account_id, account_nm, thstrm_amount]) => ({
          rcept_no: `${year}0515000001`, reprt_code: report, bsns_year: year, sj_div: 'BS',
          ord, account_id, account_nm, thstrm_amount, currency: 'KRW', account_detail: '-',
        }));
      };
      const request = { ...REQUEST, fromYear: 2018, toYear: 2020 };
      const old = setup(database, START, false, { collectionVersion: 'a'.repeat(64), financialRows });
      await old.service.sync(request);
      const goodYear = (await old.facts.getFacts({ scope: 'SYMBOL' })).filter(fact => fact.periodKey.startsWith('2018'));
      expect(goodYear.length).toBeGreaterThan(0);
      await old.facts.replaceSymbolFinancialFactsForYear('005930', 2019, [{
        scope: 'SYMBOL', key: '005930', field: 'BONDS', periodKey: '2019Q4',
        asOfTsMs: START, value: 1, unit: 'KRW',
      }]);
      const oldGap = (year: number) => ({ symbol: '005930', periodKey: `${year}Q4`, field: 'BONDS' as const,
        reason: '이전 사채 충돌', severity: 'BLOCKING' as const, kind: 'CONFLICT' as const });
      old.coverage.addCoverageResult('005930', [2019, 2020], [oldGap(2019), oldGap(2020)], START);

      const current = setup(database, START + 1, false, { collectionVersion: 'b'.repeat(64), financialRows });
      expect(current.coverage.getCoveredYears(['005930']).get('005930')).toEqual([2018]);
      const replay = await current.service.sync(request);
      expect(replay.stopReason).toBeNull();
      expect(current.calls).toEqual([]);
      const facts = await current.facts.getFacts({ scope: 'SYMBOL' });
      expect(facts.filter(fact => fact.periodKey.startsWith('2018'))).toEqual(goodYear);
      expect(facts.filter(fact => fact.field === 'BONDS' && fact.periodKey === '2019Q4'))
        .toEqual([expect.objectContaining({ value: 1098514680193 })]);
      const state = current.coverage.getCoverageState(['005930']).get('005930');
      expect(state?.verifiedYears).toEqual([2018, 2019, 2020]);
      expect(state?.blockingGapYears).toEqual([2020]);
      expect(state?.blockingGapDetails[0]?.gaps).toEqual(expect.arrayContaining([
        expect.objectContaining({ field: 'BONDS', kind: 'CONFLICT' }),
      ]));
      const again = await current.service.sync(request);
      expect(again.savedFacts).toBe(0);
      expect(current.calls).toEqual([]);
      expect(current.coverage.getCoverageState(['005930']).get('005930')).toEqual(state);
    } finally { database.close(); }
  });

  it('새 수집 버전은 gap 연도만 원문에서 한 번 재검증하고 나머지 gap은 보류한다', async () => {
    const database = openDatabase(':memory:');
    try {
      seed(database);
      const request = { ...REQUEST, fromYear: 2018, toYear: 2020 };
      const old = setup(database, START, false, { collectionVersion: 'old' });
      expect((await old.service.syncCorporateActions(request)).stopReason).toBeNull();
      old.actions.addCoverageResult('005930', [2019, 2020], [2019, 2020], START);
      const current = setup(database, START + 1, false, { collectionVersion: 'new' });
      expect(current.actions.getCoveredYears(['005930']).get('005930')).toEqual([2018]);
      expect((await current.service.syncCorporateActions({ ...request, toYear: 2019 })).stopReason).toBeNull();
      expect(current.calls).toEqual([]);
      expect(current.actions.getCoveredYears(['005930']).get('005930')).toEqual([2018, 2019]);
      expect(current.actions.getGapYears(['005930']).get('005930')).toEqual([2020]);
      expect((await current.service.syncCorporateActions(request)).stopReason).toBeNull();
      expect(current.calls).toEqual([]);
      expect(current.actions.getCoveredYears(['005930']).get('005930')).toEqual([2018, 2019, 2020]);
      expect(current.actions.getGapYears(['005930']).get('005930')).toEqual([]);
      const again = await current.service.syncCorporateActions(request);
      expect(again.savedFacts).toBe(0);
      expect(current.calls).toEqual([]);
    } finally { database.close(); }
  });

  it.each([7, 20])('원문 %i건 저장 후 중단해도 다음 날 DB 재개는 받은 응답을 다시 호출하지 않는다', async (limit) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dart-resume-'));
    const databasePath = path.join(dir, 'app.sqlite');
    let database = openDatabase(databasePath);
    const baseline = openDatabase(':memory:');
    try {
      seed(database);
      seed(baseline);
      const first = setup(database, START);
      const stopped = await first.service.sync(REQUEST, {
        beforeDartRequest: () => first.calls.length >= limit ? 'PAUSE_DAILY_QUOTA' : 'CONTINUE',
      });
      expect(stopped.stopReason).toBe('DAILY_QUOTA');
      expect(first.calls).toHaveLength(limit);
      expect(first.coverage.getCoveredYears(['005930']).get('005930') ?? []).toEqual(limit === 7 ? [] : [2016]);
      // 새 연결과 새 어댑터로 프로세스 메모리 캐시가 없는 재시작을 재현한다.
      database.close();
      database = openDatabase(databasePath);
      const resumed = setup(database, START + 86_400_000);
      expect(resumed.service.planFinancialSync(['005930'], 2016, 2017).calls).toBe(28 - limit);
      const completed = await resumed.service.sync(REQUEST);
      expect(completed.stopReason).toBeNull();
      const resumedRawCalls = resumed.calls.filter((call) => !call.includes('/list.json'));
      expect(resumedRawCalls).toHaveLength(28 - limit);
      expect(resumedRawCalls.filter((call) => first.calls.includes(call))).toEqual([]);
      expect(resumed.coverage.getCoveredYears(['005930']).get('005930')).toEqual([2016, 2017]);
      expect(resumed.actions.getCoveredYears(['005930']).get('005930')).toEqual([2016, 2017]);
      const uninterrupted = setup(baseline, START);
      await uninterrupted.service.sync(REQUEST);
      expect(await resumed.facts.getFacts({ scope: 'SYMBOL' })).toEqual(
        await uninterrupted.facts.getFacts({ scope: 'SYMBOL' }),
      );
      expect(await resumed.facts.getFacts({ scope: 'SYMBOL' })).not.toHaveLength(0);
    } finally {
      database.close();
      baseline.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each([7, 16])('자본변동 전용 수집도 원문 %i건에서 중단한 뒤 받은 응답을 재사용한다', async (limit) => {
    const database = openDatabase(':memory:');
    try {
      seed(database);
      const first = setup(database, START);
      const stopped = await first.service.syncCorporateActions(REQUEST, {
        beforeDartRequest: () => first.calls.length >= limit ? 'PAUSE_DAILY_QUOTA' : 'CONTINUE',
      });
      expect(stopped.stopReason).toBe('DAILY_QUOTA');
      const resumed = setup(database, START + 86_400_000);
      expect(resumed.service.planCorporateActionSync(['005930'], 2016, 2017).calls).toBe(20 - limit);
      expect((await resumed.service.syncCorporateActions(REQUEST)).stopReason).toBeNull();
      const rawCalls = resumed.calls.filter((call) => !call.includes('/list.json'));
      expect(rawCalls).toHaveLength(20 - limit);
      expect(rawCalls.filter((call) => first.calls.includes(call))).toEqual([]);
      expect([...first.calls, ...resumed.calls].some((call) => call.includes('fnlttSinglAcntAll'))).toBe(false);
      expect(resumed.actions.getCoveredYears(['005930']).get('005930')).toEqual([2016, 2017]);
    } finally {
      database.close();
    }
  });

  it('91일 지난 미완료 원문도 재사용하고 실제 누락된 요청만 이어받는다', async () => {
    const database = openDatabase(':memory:');
    try {
      seed(database);
      const first = setup(database, START);
      await first.service.sync(REQUEST, {
        beforeDartRequest: () => first.calls.length >= 7 ? 'PAUSE_DAILY_QUOTA' : 'CONTINUE',
      });
      const resumed = setup(database, START + 91 * 86_400_000);
      expect(resumed.service.planFinancialSync(['005930'], 2016, 2017).calls).toBe(21);
      expect((await resumed.service.sync(REQUEST)).stopReason).toBeNull();
      expect(resumed.calls).toHaveLength(21);
      expect(resumed.calls.filter((call) => first.calls.includes(call))).toHaveLength(0);
    } finally {
      database.close();
    }
  });

  it('확인된 정정은 별도 조작 없이 세 원문만 갱신하고 다음 실행에서 모두 재사용한다', async () => {
    const database = openDatabase(':memory:');
    try {
      seed(database);
      await setup(database, START).service.sync(REQUEST);
      const current = setup(database, START + 2 * 86_400_000, true);
      await current.discovery().refresh();
      current.pending.observeFilings(['20260913000001']);
      current.calls.length = 0;
      await current.service.sync(REQUEST);
      expect(current.calls.sort()).toEqual([
        '/api/fnlttSinglAcntAll.json:2016:11011',
        '/api/irdsSttus.json:2016:11011',
        '/api/stockTotqySttus.json:2016:11011',
      ]);
      const values = await current.facts.getFacts({ scope: 'SYMBOL' });
      expect(values.find((fact) => fact.field === 'CURRENT_ASSETS' && fact.periodKey === '2016Q4')?.value).toBe(2000);
      expect(values.filter((fact) => fact.field === 'CURRENT_ASSETS' && fact.periodKey !== '2016Q4').every((fact) => fact.value === 1000)).toBe(true);
      expect(database.sqlite.prepare("SELECT status FROM dart_filing_endpoint_checkpoints WHERE receipt_no = '20260913000001'").all())
        .toEqual([{ status: 'APPLIED' }, { status: 'APPLIED' }, { status: 'APPLIED' }]);
      const restarted = setup(database, START + 3 * 86_400_000, true);
      await restarted.service.sync(REQUEST);
      await restarted.service.syncCorporateActions(REQUEST);
      expect(restarted.calls).toEqual([]);
    } finally { database.close(); }
  });
});
