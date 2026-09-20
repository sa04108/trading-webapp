import { afterEach, expect, vi } from 'vitest';
import { authenticatedTest as base } from '../helpers/test-fixtures.js';
import { RestClient } from '../../src/server/shared/rest-client.js';
import { installPreviewShapeStubs } from '../helpers/backtest-preparation-stubs.js';
import { seedSymbolMasterUniverse } from '../helpers/symbol-master-seed.js';
import { waitForPreparationFixture } from '../helpers/test-app.js';

const it=base.extend({appOptions:{env:{DART_API_KEY:'fixture-key'}}});
const input={universeRule:{markets:['KOSPI'],stages:[{criterion:'MARKET_CAP',direction:'HIGH',limit:1}],rebalanceInterval:{unit:'DAY',value:1}},
  period:{from:'2026-01-05',to:'2026-01-05'},strategyId:'range-breakout',parameters:{}};
afterEach(()=>vi.restoreAllMocks());

for (const state of ['FAILED','INCOMPLETE'] as const) {
it(`목록 ${state}에도 기존 데이터로 미리보기를 완료하고 최신성 단계는 본문을 수집하지 않는다`,async({ctx,cookie})=>{
  const restore=installPreviewShapeStubs(ctx);
  const http=vi.spyOn(RestClient.prototype,'request').mockImplementation(async(_group,path,_init,hooks)=>{
    expect(path).toMatch(/^\/api\/list\.json\?/);hooks?.beforeAttempt?.();
    if(state==='FAILED')throw new Error('목록 공급자 오류');
    return {status:'000',total_page:3,list:[]};
  });
  const sync=vi.spyOn(ctx.container.factSyncService,'sync');
  const actions=vi.spyOn(ctx.container.factSyncService,'syncCorporateActions');
  const refresh=ctx.container.filingDiscovery.refresh.bind(ctx.container.filingDiscovery);
  vi.spyOn(ctx.container.filingDiscovery,'refresh').mockImplementation(async()=>{
    const before=[sync.mock.calls.length,actions.mock.calls.length];
    await refresh();
    expect([sync.mock.calls.length,actions.mock.calls.length]).toEqual(before);
  });
  try{
    seedSymbolMasterUniverse(ctx.container,['2026-01-05'],[{standardCode:'KR7005930003',shortCode:'005930',name:'삼성전자',market:'KOSPI',marketCapKrw:'500000000000000'}]);
    const post=()=>ctx.app.inject({method:'POST',url:'/api/v1/backtests/universe-preview',cookies:{session:cookie},payload:input});
    const started=await post();expect(started.statusCode).toBe(202);
    const id=started.json().job.id as string;
    expect(await waitForPreparationFixture(()=>ctx.container.backtestPreparationOrchestrator.get(id),id)).toBe(true);
    expect(http).toHaveBeenCalledTimes(state==='FAILED'?1:2);
    const freshness=await ctx.app.inject({url:'/api/v1/provider-data/freshness',cookies:{session:cookie}});
    expect(freshness.json()).toMatchObject({pending:true,warning:expect.stringContaining('미확인')});
    const result=await ctx.app.inject({method:'POST',url:'/api/v1/backtests/universe-preview',cookies:{session:cookie},payload:{...input,completedPreparationJobId:id}});
    expect(result.statusCode).toBe(200);expect(http).toHaveBeenCalledTimes(state==='FAILED'?1:2);
    const second=await post();expect(second.statusCode).toBe(202);expect(second.json().job.id).not.toBe(id);
    expect(await waitForPreparationFixture(()=>ctx.container.backtestPreparationOrchestrator.get(second.json().job.id),second.json().job.id)).toBe(true);
    expect(http).toHaveBeenCalledTimes(state==='FAILED'?2:4);
  }finally{await ctx.close();restore();}
});

}

it('별도 목록 수집은 명시적인 인증 요청으로만 시작하며 원문 동기화를 호출하지 않는다',async({ctx,cookie})=>{
  const collect=vi.spyOn(ctx.container.filingDiscovery,'collectPending').mockResolvedValue();
  const sync=vi.spyOn(ctx.container.factSyncService,'sync');
  expect((await ctx.app.inject({method:'POST',url:'/api/v1/provider-data/filings/collect',payload:{}})).statusCode).toBe(401);
  expect(collect).not.toHaveBeenCalled();
  expect((await ctx.app.inject({method:'POST',url:'/api/v1/provider-data/filings/collect',cookies:{session:cookie},payload:{}})).statusCode).toBe(202);
  expect(collect).toHaveBeenCalledOnce();expect(sync).not.toHaveBeenCalled();
});
