import { expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from '../../src/runtime/shared/db/schema.js';
import { openDatabase } from '../../src/runtime/shared/db/database.js';
import { createAgentCollectionRuntime } from '../../src/server/modules/agents/application/agent-collection-runtime.js';
import { AgentCollectionPaused } from '../../src/server/modules/agents/application/agent-data-queue.js';
import { SqliteDartRawSnapshotStore } from '../../src/server/modules/facts/infrastructure/dart/sqlite-dart-raw-snapshot-store.js';
import { facts } from '../../src/runtime/shared/db/schema.js';
import { SqliteCorporateActionCoverageStore } from '../../src/runtime/modules/facts/application/corporate-action-coverage.js';
import { SqliteFactCoverageStore } from '../../src/runtime/modules/facts/application/fact-coverage-store.js';

it.each(['DAILY_QUOTA','CANCELLED','ERROR'] as const)('ACTIONS의 %s는 재무 수집 없이 중단하고 공시를 완료로 표시하지 않는다',async(stopReason)=>{
  const database=openDatabase(':memory:');
  const now=Date.parse('2026-09-20T10:00:00Z');
  const runtime=createAgentCollectionRuntime({database,clock:{now:()=>now},logger:{info(){},warn(){},error(){},debug(){}} as never,
    auditLog:{} as never,externalApiUsage:{} as never,
    config:{dartApiKey:null,dartBaseUrl:'https://dart.test',krxApiKey:null,krxBaseUrl:'https://krx.test',krxApprovalExpiry:null,krxDailyCallBudget:100}});
  const report={stopReason,failureMessage:'수집 대기'} as Awaited<ReturnType<typeof runtime.factSyncService.sync>>;
  const sync=vi.spyOn(runtime.factSyncService,'sync');
  const actions=vi.spyOn(runtime.factSyncService,'syncCorporateActions').mockResolvedValue(report);
  try{
    database.sqlite.prepare(`INSERT INTO dart_discovered_filings
      (identity,receipt_no,symbol,business_year,report_code,payload_json,discovered_at_ms,status)
      VALUES('affected','20260828001423','005930',2025,'11011','{}',1,'PENDING')`).run();
    database.sqlite.exec(`INSERT INTO dart_filing_endpoint_checkpoints(receipt_no,endpoint,fs_div,status)
      VALUES('20260828001423','SHARE_STATUS','NONE','APPLIED'),
        ('20260828001423','ISSUANCE_STATUS','NONE','APPLIED')`);
    database.sqlite.prepare(`INSERT INTO provider_input_issues(id,symbol,business_year,report_code,reason,evidence)
      VALUES('dart-filing:affected','005930',2025,'11011','PENDING_FILING','receipt'),('outside','005930',2020,'11011','PENDING_FILING','receipt')`).run();
    const request=runtime.collect({kind:'ACTIONS',symbols:['005930'],fromYear:2025,toYear:2026},()=>false,()=>{});
    if(stopReason==='DAILY_QUOTA'){
      await expect(request).rejects.toMatchObject({constructor:AgentCollectionPaused,resumeAtMs:Date.parse('2026-09-20T15:00:00Z')});
    }else if(stopReason==='ERROR') await expect(request).rejects.toThrow('수집 대기');
    else await expect(request).resolves.toBeUndefined();
    expect(actions).toHaveBeenCalledExactlyOnceWith({kind:'ACTIONS',symbols:['005930'],fromYear:2025,toYear:2026,consolidated:true,mode:'INCREMENTAL'},expect.anything());
    expect(sync).not.toHaveBeenCalled();
    expect(database.sqlite.prepare('SELECT COUNT(*) AS n FROM provider_input_issues').get()).toEqual({n:2});
    expect(database.sqlite.prepare("SELECT reason FROM provider_input_issues WHERE id='dart-filing:affected'").get()).toEqual({ reason: 'PENDING_FILING' });
  }finally{await runtime.filingDiscovery.stop();vi.restoreAllMocks();database.close();}
});

it('CFS 게시 대기 중에도 저장된 정정공시의 자본변동을 반영하고 재무 대기는 보존한다', async () => {
  const database = openDatabase(':memory:');
  const now = Date.parse('2026-09-21T08:25:24Z');
  const runtime = createAgentCollectionRuntime({
    database, clock: { now: () => now },
    logger: { info() {}, warn() {}, error() {}, debug() {} } as never,
    auditLog: {} as never, externalApiUsage: {} as never,
    config: { dartApiKey: 'fixture', dartBaseUrl: 'https://dart.test', krxApiKey: null,
      krxBaseUrl: 'https://krx.test', krxApprovalExpiry: null, krxDailyCallBudget: 100 },
  });
  const http = vi.spyOn(globalThis, 'fetch');
  const financialSync = vi.spyOn(runtime.factSyncService, 'sync');
  const snapshots = new SqliteDartRawSnapshotStore(database.db);
  const symbol = '058970';
  const receipt = '20260828001423';
  try {
    database.sqlite.prepare("INSERT INTO symbols(code,market,created_at_ms) VALUES(?,'KR',1)").run(symbol);
    database.db.insert(facts).values({ scope: 'SYMBOL', key: symbol, field: 'NET_INCOME',
      periodKey: '2026Q1', asOfTsMs: 1, value: 100, unit: 'KRW' }).run();
    runtime.factCoverageStore.addCoveredYears(symbol, [2026], 1);
    runtime.actionCoverageStore.addCoveredYears(symbol, [2026], 1);
    database.sqlite.prepare(`INSERT INTO dart_discovered_filings
      (identity,receipt_no,symbol,business_year,report_code,payload_json,discovered_at_ms,status)
      VALUES(?,?,?,2026,'11012','{}',?,'PENDING')`).run(receipt, receipt, symbol, now);
    database.sqlite.prepare(`INSERT INTO provider_input_issues
      (id,symbol,business_year,report_code,reason,evidence)
      VALUES(?,?,2026,'11012','PENDING_FILING',?)`).run(`dart-filing:${receipt}`, symbol, receipt);
    database.sqlite.prepare(`INSERT INTO dart_filing_endpoint_checkpoints
      (receipt_no,endpoint,fs_div,status,retry_after_ms)
      VALUES(?,'FINANCIAL_STATEMENT','CFS','PENDING_PUBLICATION',?)`).run(receipt, now + 86_400_000);
    for (const year of [2025, 2026]) {
      const reports = year === 2025 ? ['11013', '11012', '11014', '11011'] as const : ['11013', '11012'] as const;
      for (const reportCode of reports) {
        const current = year === 2026 && reportCode === '11012';
        snapshots.put({ symbol, endpoint: 'SHARE_STATUS', businessYear: year, reportCode, fsDiv: 'NONE' }, {
          status: '000', list: [{ rcept_no: current ? receipt : '20260515000001', se: '보통주',
            istc_totqy: current ? '2000' : '1000', stlm_dt: current ? '2026.06.30' : `${year}.03.31` }],
        }, now - 1000);
        if (year !== 2026) continue;
        snapshots.put({ symbol, endpoint: 'ISSUANCE_STATUS', businessYear: year, reportCode, fsDiv: 'NONE' },
          current ? { status: '000', list: [{ rcept_no: receipt, isu_dcrs_de: '2026-04-01',
            isu_dcrs_stle: '무상증자', isu_dcrs_stock_knd: '보통주', isu_dcrs_qy: '1000' }] }
            : { status: '013' }, now - 1000);
        snapshots.put({ symbol, endpoint: 'FINANCIAL_STATEMENT', businessYear: year, reportCode, fsDiv: 'CFS' },
          { status: '013' }, now - 1000);
      }
    }
    const request = { kind: 'ACTIONS', symbols: [symbol], fromYear: 2026, toYear: 2026 } as const;
    const progress = vi.fn();
    await runtime.collect({ ...request, symbols: [...request.symbols] }, () => false, progress);
    expect(financialSync).not.toHaveBeenCalled();
    expect(http).not.toHaveBeenCalled();
    expect(progress).toHaveBeenCalledWith(expect.objectContaining({ completed: 1, total: 1, currentItem: symbol }));
    expect(database.sqlite.prepare("SELECT value FROM facts WHERE key=? AND field='SPLIT_RATIO'").get(symbol)).toEqual({ value: 2 });
    expect(database.sqlite.prepare('SELECT reason FROM provider_input_issues').get())
      .toEqual({ reason: 'PENDING_FINANCIAL_FILING' });
    expect(database.sqlite.prepare("SELECT endpoint,status,retry_after_ms FROM dart_filing_endpoint_checkpoints ORDER BY endpoint").all())
      .toEqual([
        { endpoint: 'FINANCIAL_STATEMENT', status: 'PENDING_PUBLICATION', retry_after_ms: now + 86_400_000 },
        { endpoint: 'ISSUANCE_STATUS', status: 'APPLIED', retry_after_ms: null },
        { endpoint: 'SHARE_STATUS', status: 'APPLIED', retry_after_ms: null },
      ]);
    expect(runtime.actionCoverageStore.getCoveredYears([symbol]).get(symbol)).toEqual([2026]);
    expect(runtime.actionCoverageStore.getGapYears([symbol]).get(symbol)).toEqual([]);
    expect(runtime.factCoverageStore.getCoveredYears([symbol]).get(symbol)).toEqual([]);
    expect(database.sqlite.prepare('SELECT status FROM dart_discovered_filings').get()).toEqual({ status: 'PENDING' });
    // 계산 스냅샷만 받은 agent도 운영 공시 테이블 없이 같은 완료 경계를 읽어야 한다.
    const snapshot = new Database(database.sqlite.serialize({ attached: 'data' }));
    try {
      const db = drizzle(snapshot, { schema });
      expect(snapshot.prepare("SELECT name FROM sqlite_master WHERE name IN ('dart_discovered_filings','dart_filing_endpoint_checkpoints')").all()).toEqual([]);
      expect(new SqliteCorporateActionCoverageStore(db).getCoveredYears([symbol]).get(symbol)).toEqual([2026]);
      expect(new SqliteCorporateActionCoverageStore(db).getGapYears([symbol]).get(symbol)).toEqual([]);
      expect(new SqliteFactCoverageStore(db).getCoveredYears([symbol]).get(symbol)).toEqual([]);
    } finally { snapshot.close(); }
    const revision = database.sqlite.prepare('SELECT revision FROM dataset_state').get();
    await runtime.collect({ ...request, symbols: [...request.symbols] }, () => false, () => {});
    expect(database.sqlite.prepare('SELECT revision FROM dataset_state').get()).toEqual(revision);
    await expect(runtime.collect({ kind: 'FINANCIAL', symbols: [symbol], fromYear: 2026, toYear: 2026 }, () => false, () => {}))
      .rejects.toMatchObject({ reason: 'PENDING_PUBLICATION', retryAfterMs: now + 86_400_000 });
    expect(http).not.toHaveBeenCalled();
  } finally { await runtime.filingDiscovery.stop(); vi.restoreAllMocks(); database.close(); }
});
