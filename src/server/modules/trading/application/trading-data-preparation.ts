import type { MarketIndexRequirement } from "../../../../runtime/modules/market-data/domain/market-index.js";
import { createHash } from "node:crypto";
import type { SymbolMasterService } from "../../../../runtime/modules/market-data/application/symbol-master-service.js";
import type { SymbolService } from "../../../../runtime/modules/market-data/application/symbol-service.js";
import type { FactSyncPort } from "../../../../runtime/modules/facts/application/fact-sync-port.js";
import type { ExternalApiUsage } from "../../../../runtime/shared/external-api-usage.js";
import { DART_DAILY_CALL_LIMIT } from "../../../../runtime/modules/facts/domain/sync-plan.js";
import { addCalendarDays } from "../../../../runtime/modules/market-data/domain/kst-date.js";
import type { TradingDataNeed } from "./trading-data.js";

/** 동결된 전략 자식이 요구한 범위만 준비한다. 최신 전략 레지스트리는 참조하지 않는다. */
export class TradingDataPreparation {
  private running: Promise<void> | null = null;
  private closed = false;
  private completedKey: string | null = null;
  private message = "";
  constructor(private readonly deps: {
    ensureMarketIndex?: (requirement: MarketIndexRequirement, shouldStop: () => boolean, onProgress: (completed: number, total: number, date: string) => void) => Promise<void>;
    master: Pick<SymbolMasterService,"ingestDate"|"ensureTradingDay"|"ensureSelectionMetrics">;
    symbols: Pick<SymbolService,"getRegisteredIdentity"|"getRegisteredIdentityByStandardCode"|"addSymbol">;
    facts: FactSyncPort;
    usage: ExternalApiUsage;
    progress: (deploymentId:string,message:string,error?:boolean)=>void;
  }) {}

  request(deploymentId:string,artifactHash:string,need:TradingDataNeed):string {
    if(this.closed)throw new Error("매매 데이터 준비기가 종료되었습니다.");
    if(this.running)return this.message;
    const key=createHash("sha256").update(JSON.stringify({deploymentId,artifactHash,need})).digest("hex");
    if(this.completedKey===key)throw new Error("요청한 데이터 수집 후에도 확정 일봉·재무·자본변동 검증을 통과하지 못했습니다. 데이터 화면의 결손 내역을 확인하세요.");
    this.message="매매 데이터 준비 중 · 완료 후 활성화를 다시 시도하세요.";
    this.running=Promise.resolve().then(()=>this.prepare(deploymentId,need)).then(()=>{
      this.completedKey=key;this.message="요청한 매매 데이터 수집 완료 · 활성화를 다시 시도해 전체 입력을 검증하세요.";
      this.deps.progress(deploymentId,this.message);
    }).catch((error:unknown)=>{
      this.message=`매매 데이터 준비 실패: ${error instanceof Error?error.message:"수집 오류"}`;
      this.deps.progress(deploymentId,this.message,true);
    }).finally(()=>{this.running=null;});
    return this.message;
  }

  private async prepare(id:string,need:TradingDataNeed):Promise<void> {
    if (need.marketIndex) {
      if (!this.deps.ensureMarketIndex) throw new Error("KOSPI 지수 준비기가 없습니다");
      await this.deps.ensureMarketIndex(need.marketIndex, () => this.closed, (completed, total, date) => {
        this.message = `매매 데이터 준비 중 · KOSPI ${completed}/${total} (${date})`;
        this.deps.progress(id, this.message);
      });
    }
    const dates=new Set(need.masterDates);
    if(need.priceRange){
      let count=0;
      for(let date=need.priceRange.from;date<=need.priceRange.to;date=addCalendarDays(date,1)){
        if(++count>10_000)throw new Error("요청한 가격 이력 범위가 너무 큽니다.");
        dates.add(date);
      }
    }
    let done=0;
    for(const date of [...dates].sort()){
      if(this.closed)throw new Error("서버 종료로 준비를 중단했습니다. 다시 활성화를 시도하면 이어서 준비합니다.");
      this.message=`매매 데이터 준비 중 · KRX ${++done}/${dates.size} (${date})`;
      this.deps.progress(id,this.message);
      await this.deps.master.ingestDate(date);
    }
    // 리밸런스 기준일이 휴장일이면 직전 개장일도 확보한다.
    for(const date of need.masterDates)await this.deps.master.ensureTradingDay(date);
    await this.deps.master.ensureSelectionMetrics(need.masterDates);
    for(const entry of need.entries){
      const registered=this.deps.symbols.getRegisteredIdentity(entry.shortCode);
      const owner=this.deps.symbols.getRegisteredIdentityByStandardCode(entry.standardCode);
      if((registered&&registered.standardCode!==entry.standardCode)||(owner&&owner.code!==entry.shortCode))throw new Error(`종목 정체성을 확인할 수 없습니다: ${entry.shortCode}`);
      if(!registered)this.deps.symbols.addSymbol(entry.shortCode,"KR",entry.name,entry.standardCode);
    }
    for(const [label,range] of [["재무",need.financial],["자본변동",need.actions]] as const){
      if(!range?.symbols.length)continue;
      this.message=`매매 데이터 준비 중 · ${label} ${range.fromYear}–${range.toYear}년`;
      this.deps.progress(id,this.message);
      const request={...range,consolidated:true,mode:"INCREMENTAL" as const};
      const hooks={shouldStop:()=>this.closed,beforeDartRequest:():"CONTINUE"|"PAUSE_DAILY_QUOTA"=>this.deps.usage.quotaExceeded("DART","daily")||this.deps.usage.callsUsed("DART","daily")>=DART_DAILY_CALL_LIMIT?"PAUSE_DAILY_QUOTA":"CONTINUE",onSymbolDone:(progress:{index:number;total:number})=>{
        this.message=`매매 데이터 준비 중 · ${label} ${progress.index}/${progress.total}`;this.deps.progress(id,this.message);
      }};
      const report=label==="재무"?await this.deps.facts.sync(request,hooks):await this.deps.facts.syncCorporateActions(request,hooks);
      if(report.stopReason||report.gapCount)throw new Error(report.failureMessage??`${label} 데이터에 ${report.gapCount}건의 결손이 있습니다. 데이터 화면에서 확인하세요.`);
    }
  }
  async close():Promise<void>{this.closed=true;await this.running;}
}
