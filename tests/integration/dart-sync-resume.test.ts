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
import { symbols } from '../../src/server/shared/db/schema.js';

const LOGGER = { debug() {}, info() {}, warn() {}, error() {} } as never;
const START = Date.UTC(2026, 8, 12);
const REQUEST = {
  symbols: ['005930'], fromYear: 2016, toYear: 2017, consolidated: true, mode: 'INCREMENTAL' as const,
};

function setup(database: DatabaseHandle, now: number, corrected = false) {
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
    fetchPage:async(from,to,page,beforeAttempt)=>{
      beforeAttempt();
      const query=new URLSearchParams({bgn_de:from,end_de:to,page_no:String(page)});
      return await (await fetchImpl(`https://dart.test/api/list.json?${query}`)).json() as FilingPage;
    },
  });
  const facts = new SqliteFactRepository(database.db);
  const coverage = new SqliteFactCoverageStore(database.db);
  const actions = new SqliteCorporateActionCoverageStore(database.db);
  return {
    calls, facts, coverage, actions, pending, policy, discovery,
    service: new FactSyncService(source, facts, LOGGER, { bumpVersion() {} }, clock, coverage, actions),
  };
}

function seed(database: DatabaseHandle): void {
  database.db.insert(symbols).values({ code: '005930', market: 'KR', name: '테스트', createdAtMs: START }).run();
}

describe('DART 수집 중단 후 SQLite 재개', () => {
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

  it('명시적 공시 확인과 승인 이후 정정 보고서만 갱신하고 기존 원문은 재사용한다', async () => {
    const database = openDatabase(':memory:');
    try {
      seed(database);
      const first = setup(database, START);
      await first.service.sync(REQUEST, {
        beforeDartRequest: () => first.calls.length >= 20 ? 'PAUSE_DAILY_QUOTA' : 'CONTINUE',
      });
      const resumed = setup(database, START + 2 * 86_400_000, true);
      expect((await resumed.service.sync(REQUEST)).stopReason).toBeNull();
      expect(resumed.calls).toHaveLength(8);
      expect(resumed.calls.every((call)=>call.includes(':2017:'))).toBe(true);
      resumed.calls.length=0;
      await resumed.discovery().refresh();
      expect(resumed.calls).toEqual(['/api/list.json:null:null']);
      expect(await resumed.pending.reconcileDiscoveredFilings()).toEqual([{symbol:'005930',year:2016}]);
      resumed.calls.length=0;
      const correction={...REQUEST,toYear:2016,mode:'FULL' as const};
      await expect(resumed.service.sync(correction)).rejects.toThrow(/SOURCE_CHANGE_CONFIRMED/);
      expect(resumed.calls).toEqual([]);
      const blocked=database.sqlite.prepare("SELECT fingerprint FROM provider_request_plans WHERE status='BLOCKED'").all() as {fingerprint:string}[];
      expect(blocked).toHaveLength(1);
      expect(resumed.policy.decide(blocked[0]!.fingerprint,true)).toBe(true);
      expect((await resumed.service.sync(correction)).stopReason).toBeNull();
      expect(resumed.calls.sort()).toEqual([
        '/api/fnlttSinglAcntAll.json:2016:11011',
        '/api/irdsSttus.json:2016:11011',
        '/api/stockTotqySttus.json:2016:11011',
      ]);
      resumed.pending.markNormalized('005930',2016);
      expect(database.sqlite.prepare('SELECT * FROM provider_input_issues').all()).toEqual([]);
      expect(database.sqlite.prepare("SELECT endpoint FROM dart_filing_endpoint_checkpoints WHERE receipt_no='20260913000001' AND status='APPLIED'").all()).toHaveLength(3);
      const facts=await resumed.facts.getFacts({scope:'SYMBOL'});
      expect(facts.find((fact)=>fact.field==='CURRENT_ASSETS' && fact.periodKey==='2016Q4')?.value).toBe(2000);
      expect(facts.filter((fact)=>fact.field==='CURRENT_ASSETS' && fact.periodKey.startsWith('2016') && fact.periodKey!=='2016Q4').every((fact)=>fact.value===1000)).toBe(true);
      const restarted=setup(database,START + 2 * 86_400_000,true);
      await restarted.discovery().refresh();
      await restarted.service.sync(REQUEST);
      await restarted.service.syncCorporateActions(REQUEST);
      expect(restarted.calls).toEqual(['/api/list.json:null:null']);
    } finally { database.close(); }
  });
});
