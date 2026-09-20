import { expect, it, vi } from 'vitest';
import { openDatabase } from '../../src/runtime/shared/db/database.js';
import { createAgentCollectionRuntime } from '../../src/server/modules/agents/application/agent-collection-runtime.js';
import { AgentCollectionPaused } from '../../src/server/modules/agents/application/agent-data-queue.js';

it.each(['DAILY_QUOTA','CANCELLED'] as const)('ACTIONS 선행 수집의 %s는 요청 연도에서 중단하고 완료로 표시하지 않는다',async(stopReason)=>{
  const database=openDatabase(':memory:');
  const now=Date.parse('2026-09-20T10:00:00Z');
  const runtime=createAgentCollectionRuntime({database,clock:{now:()=>now},logger:{info(){},warn(){},error(){},debug(){}} as never,
    auditLog:{} as never,externalApiUsage:{} as never,
    config:{dartApiKey:null,dartBaseUrl:'https://dart.test',krxApiKey:null,krxBaseUrl:'https://krx.test',krxApprovalExpiry:null,krxDailyCallBudget:100}});
  const report={stopReason,failureMessage:'수집 대기'} as Awaited<ReturnType<typeof runtime.factSyncService.sync>>;
  const sync=vi.spyOn(runtime.factSyncService,'sync').mockResolvedValue(report);
  const actions=vi.spyOn(runtime.factSyncService,'syncCorporateActions');
  try{
    database.sqlite.prepare(`INSERT INTO provider_input_issues(id,symbol,business_year,report_code,reason,evidence)
      VALUES('affected','005930',2025,'11011','PENDING_FILING','receipt'),('outside','005930',2020,'11011','PENDING_FILING','receipt')`).run();
    const request=runtime.collect({kind:'ACTIONS',symbols:['005930'],fromYear:2025,toYear:2026},()=>false,()=>{});
    if(stopReason==='DAILY_QUOTA'){
      await expect(request).rejects.toMatchObject({constructor:AgentCollectionPaused,resumeAtMs:Date.parse('2026-09-20T15:00:00Z')});
    }else await expect(request).resolves.toBeUndefined();
    expect(sync).toHaveBeenCalledExactlyOnceWith({symbols:['005930'],fromYear:2025,toYear:2025,consolidated:true,mode:'INCREMENTAL'},expect.anything());
    expect(actions).not.toHaveBeenCalled();
    expect(database.sqlite.prepare('SELECT COUNT(*) AS n FROM provider_input_issues').get()).toEqual({n:2});
  }finally{await runtime.filingDiscovery.stop();vi.restoreAllMocks();database.close();}
});
