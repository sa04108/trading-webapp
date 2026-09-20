import { afterEach, expect, it, vi } from 'vitest';
import { openDatabase } from '../../src/runtime/shared/db/database.js';
import { DartFilingDiscovery, PREVIEW_FILING_TIMEOUT_MS, type FilingPage } from '../../src/server/modules/facts/application/dart-filing-discovery.js';

const logger = { warn: vi.fn() } as never;
const now = () => Date.parse('2026-09-20T10:00:00Z');
const filing = (receipt: string) => ({rcept_no:receipt,stock_code:'005930',report_nm:'반기보고서 (2026.06)'});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

it('신규 미리보기는 최근 목록 최대 두 페이지만 저장하고 이전 전체 이력을 읽지 않는다', async () => {
  const database = openDatabase(':memory:');
  const sqlite = database.sqlite;
  const queries: string[] = [];
  const prepare = sqlite.prepare.bind(sqlite);
  vi.spyOn(sqlite, 'prepare').mockImplementation((sql: string) => {
    queries.push(sql);
    if (/SELECT[\s\S]*FROM (?:symbol_facts_state|dart_raw_api_snapshots|dart_corp_code_snapshot|facts)\b/i.test(sql))
      throw new Error('목록 확인 중 데이터 전수 조회 금지');
    return prepare(sql);
  });
  const pages: number[] = [];
  const discovery = new DartFilingDiscovery({sqlite,logger,now,fetchPage:async(from,to,page,beforeAttempt)=>{
    beforeAttempt(); pages.push(page);
    expect([from,to]).toEqual(['2026-09-19','2026-09-20']);
    return {status:'000',total_page:3,list:[filing(`2026092000000${page}`)]};
  }});
  try {
    await discovery.refresh();
    expect(pages).toEqual([1,2]);
    expect(discovery.freshness()).toMatchObject({checkedThrough:null,pending:true,warning:expect.stringContaining('미확인')});
    expect(sqlite.prepare('SELECT page,status FROM dart_discovery_jobs').get()).toEqual({page:3,status:'DEFERRED'});
    expect(queries.some(sql=>sql.includes('MIN(checked_at_ms)'))).toBe(false);
  } finally { await discovery.stop(); database.close(); }
});

it('호출 예산은 내부 재시도까지 세고 세 번째 실제 요청을 차단한다', async () => {
  const db = openDatabase(':memory:'); let physical=0;
  const discovery = new DartFilingDiscovery({sqlite:db.sqlite,logger,now,fetchPage:async(_from,_to,_page,beforeAttempt)=>{
    for(let retry=0;retry<3;retry++){beforeAttempt();physical+=1;}
    return {status:'013'};
  }});
  try { await discovery.refresh();expect(physical).toBe(2);expect(discovery.freshness().pending).toBe(true); }
  finally {await discovery.stop();db.close();}
});

it.each(['오류','한도'] as const)('%s 뒤에는 마지막 완료 경계를 보존하고 새 시작도 목록만 다시 확인한다', async (kind) => {
  const db=openDatabase(':memory:');let calls=0;let fail=false;
  const discovery=new DartFilingDiscovery({sqlite:db.sqlite,logger,now,fetchPage:async(_f,_t,_p,before)=>{
    before();calls+=1;if(fail&&kind==='오류')throw new Error('offline');
    return fail?{status:'000',total_page:5,list:[]}:{status:'013'};
  }});
  try {
    await discovery.refresh();const completed=discovery.freshness();fail=true;await discovery.refresh();
    expect(discovery.freshness()).toMatchObject({checkedThrough:completed.checkedThrough,lastCheckedAtMs:completed.lastCheckedAtMs,pending:true});
    expect(calls).toBe(kind==='오류'?2:3);
    fail=false;await discovery.refresh();expect(discovery.freshness().pending).toBe(false);
  } finally {await discovery.stop();db.close();}
});

it('동시 시작은 공유하고 별도 수집이 남은 페이지를 처리하는 동안 미리보기는 기다리지 않는다', async () => {
  const db=openDatabase(':memory:');let release!:()=>void;let gated=false;let calls=0;
  const gate=new Promise<void>(resolve=>{release=resolve;});
  const discovery=new DartFilingDiscovery({sqlite:db.sqlite,logger,now,fetchPage:async(_f,_t,page,before)=>{
    before();calls+=1;if(gated)await gate;return {status:'000',total_page:3,list:[filing(`2026092000000${page}`)]};
  }});
  try {
    const first=discovery.refresh();expect(discovery.refresh()).toBe(first);await first;expect(calls).toBe(2);
    gated=true;const collection=discovery.collectPending();expect(discovery.freshness().collecting).toBe(true);
    await discovery.refresh();expect(calls).toBe(3);
    release();await collection;
    expect(db.sqlite.prepare('SELECT COUNT(*) AS n FROM dart_discovered_filings').get()).toEqual({n:3});
    expect(discovery.freshness()).toMatchObject({pending:false,checkedThrough:'2026-09-20'});
  } finally {release();await discovery.stop();db.close();}
});

it('응답이 멈춰도 제한 시간 뒤 종료하며 늦은 응답은 DB에 저장하지 않는다', async () => {
  vi.useFakeTimers();const db=openDatabase(':memory:');let resolve!: (page:FilingPage)=>void;let signal!:AbortSignal;
  const discovery=new DartFilingDiscovery({sqlite:db.sqlite,logger,now,fetchPage:async(_f,_t,_p,before,abort)=>{
    before();signal=abort;return new Promise<FilingPage>(complete=>{resolve=complete;});
  }});
  try {
    const pending=discovery.refresh();await vi.advanceTimersByTimeAsync(PREVIEW_FILING_TIMEOUT_MS);await pending;
    expect(signal.aborted).toBe(true);expect(discovery.freshness().pending).toBe(true);
    resolve({status:'000',total_page:1,list:[filing('20260920000001')]});await Promise.resolve();
    expect(db.sqlite.prepare('SELECT COUNT(*) AS n FROM dart_discovered_filings').get()).toEqual({n:0});
  } finally {await discovery.stop();db.close();}
});

it('기존 장기 checkpoint는 미리보기에서 이어 읽지 않고 별도 수집에 남긴다', async () => {
  const db=openDatabase(':memory:');const ranges:string[]=[];
  db.sqlite.prepare("INSERT INTO dart_discovery_jobs(day,from_date,to_date,page,status) VALUES('old','2020-01-01','2020-02-01',23,'PENDING')").run();
  const discovery=new DartFilingDiscovery({sqlite:db.sqlite,logger,now,fetchPage:async(from,_to,_page,before)=>{before();ranges.push(from);return {status:'013'};}});
  try {await discovery.refresh();expect(ranges).toEqual(['2026-09-19']);expect(discovery.freshness().pending).toBe(true);
    expect(db.sqlite.prepare("SELECT page FROM dart_discovery_jobs WHERE day='old'").get()).toEqual({page:23});}
  finally{await discovery.stop();db.close();}
});

it('열린 날짜의 페이지를 다음 날 재개하면 앞에 추가된 공시도 다시 확인한다', async () => {
  const db = openDatabase(':memory:');
  let current = now();
  const pages: number[] = [];
  const discovery = new DartFilingDiscovery({sqlite:db.sqlite,logger,now:()=>current,fetchPage:async(_f,_t,page,before)=>{
    before(); pages.push(page);
    const receipt = current === now() ? `2026092000000${page}` : page === 1 ? '20260920000009' : `2026092000000${page - 1}`;
    return {status:'000',total_page:current === now() ? 3 : 4,list:[filing(receipt)]};
  }});
  try {
    await discovery.refresh();
    current += 86_400_000;
    await discovery.collectPending();
    expect(pages).toEqual([1,2,1,2,3,4]);
    expect(db.sqlite.prepare("SELECT identity FROM dart_discovered_filings WHERE identity='20260920000009'").get()).toBeDefined();
    expect(discovery.freshness()).toMatchObject({pending:false,checkedThrough:'2026-09-20'});
  } finally {await discovery.stop();db.close();}
});

it('닫힌 날짜의 커서는 이어 읽으며 과거 수집 완료가 최신 확인 경계를 되돌리지 않는다', async () => {
  const db = openDatabase(':memory:');
  db.sqlite.prepare(`INSERT INTO dart_discovery_jobs(day,from_date,to_date,page,status,completed_at_ms)
    VALUES('recent','2026-09-20','2026-09-20',1,'COMPLETED',1),('old','2020-01-01','2020-01-01',3,'DEFERRED',NULL)`).run();
  db.sqlite.prepare(`INSERT INTO dart_discovery_pages(day,from_date,page,payload_json,fetched_at_ms)
    VALUES('old','2020-01-01',1,'{}',?)`).run(now());
  const ranges: Array<[string,number]> = [];
  const discovery = new DartFilingDiscovery({sqlite:db.sqlite,logger,now,fetchPage:async(from,_t,page,before)=>{
    before();ranges.push([from,page]);return {status:'013'};
  }});
  try {
    await discovery.collectPending();
    expect(ranges).toEqual([['2020-01-01',3]]);
    expect(discovery.freshness().checkedThrough).toBe('2026-09-20');
    await discovery.refresh();
    expect(ranges.at(-1)).toEqual(['2026-09-19',1]);
  } finally {await discovery.stop();db.close();}
});


it('첫 페이지와 다음 페이지 사이에 자정이 지나도 첫 페이지를 기준으로 재시작한다', async () => {
  const db = openDatabase(':memory:');
  db.sqlite.prepare("INSERT INTO dart_discovery_jobs(day,from_date,to_date,page,status) VALUES('midnight','2026-09-19','2026-09-19',3,'DEFERRED')").run();
  const save = db.sqlite.prepare("INSERT INTO dart_discovery_pages(day,from_date,page,payload_json,fetched_at_ms) VALUES('midnight','2026-09-19',?,'{}',?)");
  save.run(1,Date.parse('2026-09-19T14:59:59Z'));save.run(2,Date.parse('2026-09-19T15:00:01Z'));
  const pages:number[]=[];
  const discovery = new DartFilingDiscovery({sqlite:db.sqlite,logger,now,fetchPage:async(_f,_t,page,before)=>{
    before();pages.push(page);return {status:'013'};
  }});
  try {await discovery.collectPending();expect(pages).toEqual([1]);}
  finally {await discovery.stop();db.close();}
});
