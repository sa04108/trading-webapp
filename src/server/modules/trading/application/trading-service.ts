import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { DatabaseHandle } from "../../../../runtime/shared/db/database.js";
import type { AnyTradingStrategy } from "../../../../runtime/modules/strategy/domain/strategy.js";
import type { OrderIntent } from "../../../../runtime/modules/backtest/domain/types.js";
import { backtestJobs } from "../../../../runtime/shared/db/operations-schema.js";
import { backtestRuns } from "../../../shared/db/backtest-result-schema.js";
import { paperTradingAccount, tradingControl, tradingDeployments, tradingEvents, tradingOrders } from "../../../shared/db/trading-schema.js";
import { backtestRequestSchema } from "../../../../shared/schemas/backtest-request.js";
import { PAPER_TRADING_ACCOUNT_ID, PAPER_TRADING_INITIAL_CASH_KRW, paperInitialCashSchema, tradingSetupSchema, type TradingArtifact, type TradingDeployment, type TradingOrder, type TradingQuote, type TradingSetup, type TradingSnapshot, type TradingSource } from "../../../../shared/schemas/trading.js";
import { kstDateOf } from "../../../../runtime/modules/market-data/domain/kst-date.js";
import { BrokerHoldingsChangedError, BrokerRequestError, type BrokerHolding, type BrokerOrder, type TradingBroker } from "./broker-port.js";
import { TradingDataRequired, type TradingDataNeed } from "./trading-data.js";

export interface StrategyArtifactStore {
  list(): TradingArtifact[];
  load(strategyId: string, artifactHash: string): Promise<AnyTradingStrategy>;
  bundlePath(artifactHash: string): string;
}

export interface ManagedPosition { quantity: number; cost: number; enteredAtMs: number }
export type ManagedPortfolio = Record<string, ManagedPosition>;
export interface TradingDecisionEngine {
  /** 장 시작 후 한정된 실행 창만 허용한다. 휴장·미확인 달력에서는 주문하지 않는다. */
  canTrade(now: number): boolean;
  evaluate(input: {
    deployment: TradingDeployment;
    portfolio: ManagedPortfolio;
    checkpoint: string | null;
    warmupOnly: boolean;
  }): Promise<{ checkpoint: string; barTsMs: number; orders: readonly OrderIntent[] }>;
  close(): Promise<void>;
}

type DeploymentRow = typeof tradingDeployments.$inferSelect;
type OrderRow = typeof tradingOrders.$inferSelect;
interface AccountSnapshot { holdings: BrokerHolding[]; cashBuyingPower: number }
const PENDING = ["CREATED", "SENDING", "UNKNOWN", "OPEN", "PARTIAL", "CANCEL_REQUESTED"];
const LEASE_MS = 120_000;
const SYNC_MAX_AGE_MS = 30_000;

export class TradingError extends Error {
  constructor(message: string, readonly code = "TRADING_CONFLICT", readonly statusCode = 409) { super(message); }
}

export class TradingService {
  private readonly token = randomUUID();
  private timer: ReturnType<typeof setInterval> | null = null;
  private running: Promise<void> | null = null;
  private refreshing: Promise<void> | null = null;
  private preparing: Promise<void> | null = null;
  private preparation: { deploymentId: string; revision: number; state: NonNullable<TradingSnapshot["dataPreparation"]> } | null = null;
  private brokerOperation: Promise<unknown> = Promise.resolve();
  private stopping = false;
  private acquired = false;
  private terminalSyncAt = 0;
  private readonly cancelRetry = new Map<string, { after: number; attempts: number }>();
  private readonly db;
  constructor(private readonly deps: {
    database: DatabaseHandle;
    broker: TradingBroker;
    artifacts: StrategyArtifactStore;
    engine: TradingDecisionEngine;
    prepareData?: (need: TradingDataNeed, onProgress: (message: string) => void, shouldStop: () => boolean) => Promise<string | void>;
    enabled?: boolean;
    now?: () => number;
    notify?: (message: string) => void;
  }) {
    this.db = deps.database.db;
    this.db.insert(tradingControl).values({singleton:1}).onConflictDoNothing().run();
    if (this.isPaper) this.initializePaper();
    else if (this.control().mode === "PAPER") throw new TradingError("모의투자 저장소를 실매매 실행기로 열 수 없습니다.");
  }
  private get isPaper() { return this.deps.broker.mode === "PAPER"; }
  private initializePaper() {
    this.deps.database.sqlite.transaction(() => {
      if (this.control().mode === "PAPER") return;
      const previous = this.current();
      const now = this.now();
      // 실계좌의 잔고·주문·손익은 이력으로 보관하고 설정만 새 모의 전략으로 복사한다.
      if (previous) {
        this.db.update(tradingDeployments).set({slot:null,status:"INACTIVE",updatedAtMs:now,activity:"모의투자 전환 · 실매매 이력 보관"}).where(eq(tradingDeployments.id,previous.id)).run();
        const setup = tradingSetupSchema.parse(JSON.parse(previous.setupJson));
        const id = randomUUID();
        this.db.insert(tradingDeployments).values({id,slot:1,mode:"PAPER",setupJson:previous.setupJson,name:previous.name,version:previous.version,status:"INACTIVE",createdAtMs:now,updatedAtMs:now,returnBase:setup.budgetKrw,activity:"모의투자 · 자동매매 OFF"}).run();
        this.event("기존 설정을 모의투자로 복사 · 실계좌 포지션과 주문은 이력으로 분리 보관", "system", "INFO", id);
      }
      this.db.update(tradingControl).set({mode:"PAPER",revision:sql`${tradingControl.revision}+1`,accountId:PAPER_TRADING_ACCOUNT_ID,accountsJson:"[]",snapshotJson:null,syncedAtMs:null,error:null,executorToken:null,executorExpiresAtMs:null}).where(eq(tradingControl.singleton,1)).run();
    }).immediate();
  }
  private now(): number { return this.deps.now?.() ?? Date.now(); }
  private control() { return this.db.select().from(tradingControl).where(eq(tradingControl.singleton,1)).get()!; }
  private current() { return this.db.select().from(tradingDeployments).where(eq(tradingDeployments.slot,1)).get() ?? null; }
  private portfolio(row: DeploymentRow): ManagedPortfolio { return JSON.parse(row.portfolioJson) as ManagedPortfolio; }
  private event(message: string, actor="system", severity: "INFO"|"WARNING"|"ERROR"="INFO", id=this.current()?.id ?? null) {
    this.db.insert(tradingEvents).values({deploymentId:id,actor,severity,message,createdAtMs:this.now()}).run();
  }
  private change(expectedRevision: number, fn: () => void) {
    this.deps.database.sqlite.transaction(() => {
      if (this.control().revision !== expectedRevision) throw new TradingError("다른 화면에서 매매 상태가 변경되었습니다. 새로고침 후 다시 확인하세요.","STALE_REVISION");
      fn();
      this.db.update(tradingControl).set({revision:expectedRevision+1}).where(eq(tradingControl.singleton,1)).run();
    }).immediate();
  }
  private requireInactive(): DeploymentRow {
    const row=this.current();
    if (!row) throw new TradingError("등록된 매매 전략이 없습니다.");
    if (row.status!=="INACTIVE" || this.pending(row.id).length) throw new TradingError("미체결·체결 확인을 마친 비활성 상태에서만 변경할 수 있습니다.");
    return row;
  }
  private pending(id?: string): OrderRow[] {
    return this.db.select().from(tradingOrders).where(and(inArray(tradingOrders.status,PENDING),id?eq(tradingOrders.deploymentId,id):undefined,this.isPaper?eq(tradingOrders.accountId,PAPER_TRADING_ACCOUNT_ID):undefined)).all();
  }
  private deployment(row: DeploymentRow): TradingDeployment {
    const setup=tradingSetupSchema.parse(JSON.parse(row.setupJson));
    const latest=this.deps.artifacts.list().find(a=>a.strategyId===setup.strategyId&&a.latest);
    return {...setup,id:row.id,name:row.name,version:row.version,status:row.status,createdAtMs:row.createdAtMs,updatedAtMs:row.updatedAtMs,activatedAtMs:row.activatedAtMs,lastDecisionAtMs:row.lastDecisionAtMs,lastError:row.lastError,activity:row.activity,latestArtifactHash:latest?.artifactHash??null,latestVersion:latest?.version??null};
  }
  artifacts(): TradingArtifact[] { return this.deps.artifacts.list(); }
  private paperCapital(): TradingSnapshot["paperCapital"] {
    if(!this.isPaper)return null;
    const account=this.db.select().from(paperTradingAccount).where(eq(paperTradingAccount.singleton,1)).get();
    const filled=this.deps.database.sqlite.prepare("SELECT 1 FROM paper_trading_orders WHERE json_extract(payload_json, '$.order.filledQuantity') > 0 LIMIT 1").get();
    const status=this.current()?.status;
    return {initialCashKrw:account?.initialCash??PAPER_TRADING_INITIAL_CASH_KRW,canEdit:(!status||status==="INACTIVE")&&!filled&&!this.pending().length&&Object.keys(JSON.parse(account?.holdingsJson??"{}")).length===0};
  }
  private setInitialCash(value:number|undefined,actor:string) {
    if(value===undefined)return;
    const amount=paperInitialCashSchema.parse(value);
    const capital=this.paperCapital();
    if(!capital)throw new TradingError("초기 모의자금은 모의투자에서만 설정할 수 있습니다.");
    if(amount===capital.initialCashKrw)return;
    if(!capital.canEdit)throw new TradingError("초기 모의자금은 자동매매 OFF 상태에서 첫 체결 전까지만 변경할 수 있습니다.");
    // 전략 설정과 같은 트랜잭션에서 저장해 실패한 설정이 잔고만 바꾸지 않게 한다.
    this.db.insert(paperTradingAccount).values({singleton:1,initialCash:amount,cash:amount}).onConflictDoUpdate({target:paperTradingAccount.singleton,set:{initialCash:amount,cash:amount}}).run();
    this.db.update(tradingControl).set({snapshotJson:JSON.stringify({holdings:[],cashBuyingPower:amount}),syncedAtMs:this.now(),error:null}).where(eq(tradingControl.singleton,1)).run();
    this.event(`초기 모의자금 변경: ${amount.toLocaleString("ko-KR")}원`,actor);
  }
  prepareData(expectedRevision: number, actor: string, initialNeed?: TradingDataNeed): TradingSnapshot {
    const before = this.requireInactive();
    if (this.control().revision !== expectedRevision) throw new TradingError("매매 설정이 변경되었습니다.", "STALE_REVISION");
    if (!this.deps.prepareData) throw new TradingError("매매 데이터 수집기를 사용할 수 없습니다.");
    if (this.stopping) throw new TradingError("서버 종료 중에는 데이터 준비를 시작할 수 없습니다.");
    if (this.preparing) {
      if (this.preparation?.deploymentId === before.id && this.preparation.revision === expectedRevision) return this.snapshot();
      throw new TradingError("이전 설정의 데이터 준비를 정리하고 있습니다. 잠시 후 다시 시도하세요.");
    }
    if (!this.acquire()) throw new TradingError("다른 실행기에서 매매 데이터를 처리하고 있습니다. 잠시 후 다시 시도하세요.");
    this.change(expectedRevision, () => {
      this.requireInactive();
      this.db.update(tradingDeployments).set({ lastError: null, activity: "매매 데이터 확인 중", updatedAtMs: this.now() }).where(eq(tradingDeployments.id, before.id)).run();
      this.event("매매 데이터 확인·복구 시작 · 자동매매 OFF 유지", actor);
    });
    const revision = expectedRevision + 1;
    const preparation = { deploymentId: before.id, revision, state: { status: "RUNNING" as const, message: "매매 데이터 확인 중" } };
    this.preparation = preparation;
    const current = () => {
      const row = this.current(), control = this.control();
      return row?.id === before.id && row.status === "INACTIVE" && control.revision === revision && control.executorToken === this.token && (control.executorExpiresAtMs ?? 0) > this.now();
    };
    const shouldStop = () => this.stopping || !current();
    const progress = (message: string, status: NonNullable<TradingSnapshot["dataPreparation"]>["status"] = "RUNNING") => {
      // 설정 변경·다른 실행기의 임대 획득과 같은 쓰기 경계에서 확인한다.
      this.deps.database.sqlite.transaction(() => {
        if (!current()) return;
        this.preparation = { ...preparation, state: { status, message } };
        this.db.update(tradingDeployments).set({ activity: message, lastError: status === "FAILED" ? message : null }).where(eq(tradingDeployments.id, before.id)).run();
        if (status !== "RUNNING") this.event(message, "system", status === "FAILED" ? "ERROR" : "INFO", before.id);
      }).immediate();
    };
    // HTTP 응답 뒤 수집·검증을 이어간다. 워밍업 주문과 체크포인트는 저장하지 않는다.
    this.preparing = Promise.resolve().then(async () => {
      const attempted = new Map<string, string | void>();
      let need = initialNeed;
      let cause = "";
      for (let stage = 0; stage < 20; stage++) {
        if (shouldStop()) throw new Error("서버 종료 또는 매매 설정 변경으로 데이터 준비를 중단했습니다.");
        if (need) {
          const key = JSON.stringify(need);
          if (attempted.has(key)) {
            const details = [cause, attempted.get(key)].filter(Boolean).join(" · ");
            throw new Error(`수집·재검증 후에도 해결되지 않았습니다. ${details}`);
          }
          const diagnostics = await this.deps.prepareData!(need, (message) => progress(message), shouldStop);
          attempted.set(key, diagnostics);
        }
        if (shouldStop()) throw new Error("서버 종료 또는 매매 설정 변경으로 데이터 준비를 중단했습니다.");
        progress("매매 데이터 수집 후 전략 입력 검증 중");
        try {
          await this.deps.engine.evaluate({ deployment: this.deployment(before), portfolio: this.portfolio(before), checkpoint: before.checkpoint, warmupOnly: true });
          if (shouldStop()) throw new Error("서버 종료 또는 매매 설정 변경으로 데이터 준비를 중단했습니다.");
          progress("매매 데이터 준비 완료 · 자동매매를 켜면 다시 확인 후 시작합니다.", "READY");
          return;
        } catch (error) {
          if (!(error instanceof TradingDataRequired)) throw error;
          need = error.need;
          cause = error.message;
          progress(cause);
        }
      }
      throw new Error("매매 데이터 준비 단계가 한도를 초과했습니다. 남은 결손을 확인한 뒤 다시 시도하세요.");
    }).catch((error: unknown) => {
      if (!current()) return;
      const message = `매매 데이터 준비 실패: ${error instanceof Error ? error.message : "수집 오류"}`;
      progress(message, "FAILED");
    }).finally(() => {
      this.preparing = null;
      if (this.preparation?.state.status === "RUNNING") this.preparation = { ...preparation, state: { status: "FAILED", message: "실행기 또는 매매 상태가 변경되어 준비를 중단했습니다. 다시 확인·복구해 주세요." } };
    });
    return this.snapshot();
  }
  snapshot(): TradingSnapshot {
    const control=this.control(); const row=this.current();
    const account=control.snapshotJson?JSON.parse(control.snapshotJson) as AccountSnapshot:null;
    const portfolio=row?this.portfolio(row):{};
    const positions=(account?.holdings??[]).map(h=>({...h,returnPercent:h.quantity*h.averagePrice>0?h.unrealizedPnl/(h.quantity*h.averagePrice)*100:null,deploymentId:portfolio[h.symbol]?.quantity===h.quantity?row!.id:null}));
    const marketValue=positions.reduce((n,p)=>n+p.marketValue,0);
    const unrealizedPnl=positions.reduce((n,p)=>n+p.unrealizedPnl,0);
    const cost=marketValue-unrealizedPnl;
    let performance:TradingSnapshot["performance"]=null;
    if(row&&account&&row.activatedAtMs!==null) {
      let ownPnl=0; let complete=true;
      for(const [symbol,p] of Object.entries(portfolio)) {
        const h=positions.find(h=>h.symbol===symbol);
        if(!h||h.quantity!==p.quantity){complete=false;break;}
        ownPnl+=h.marketValue-p.cost;
      }
      if(complete)performance={realizedPnl:row.realizedPnl,unrealizedPnl:ownPnl,totalPnl:row.realizedPnl+ownPnl,returnPercent:row.returnBase&&row.returnBase>0?(row.realizedPnl+ownPnl)/row.returnBase*100:null};
    }
    const blockers:string[]=[];
    if(this.deps.enabled===false)blockers.push("서버 설정에서 자동매매가 비활성화되어 있습니다.");
    if(!this.isPaper) {
      if(!this.deps.broker.configured)blockers.push("서버의 토스증권 API 자격 증명이 설정되지 않았습니다.");
      if(!control.accountId)blockers.push("토스 계좌를 연결하고 운용 계좌를 선택하세요.");
      if(control.accountId&&!account)blockers.push("계좌 잔고를 먼저 동기화하세요.");
    }
    if(control.error)blockers.push(control.error);
    if(row&&!this.artifacts().some(a=>a.strategyId===JSON.parse(row.setupJson).strategyId&&a.artifactHash===JSON.parse(row.setupJson).artifactHash))blockers.push("고정된 전략 실행 파일을 찾을 수 없습니다. 자동으로 다른 버전을 사용하지 않습니다.");
    if(this.pending().some(o=>o.status==="UNKNOWN"||o.status==="SENDING"))blockers.push("접수 여부가 불명확한 주문이 있습니다. 증권사 주문 내역 확인이 필요합니다.");
    return {
      revision:control.revision,dataPreparation:this.preparation?.deploymentId===row?.id&&this.preparation?.revision===control.revision?this.preparation.state:null,paperCapital:this.paperCapital(),deployment:row?this.deployment(row):null,
      broker:{provider:this.isPaper?"PAPER":"TOSS",configured:this.deps.broker.configured,accounts:JSON.parse(control.accountsJson),selectedAccountId:control.accountId,lastSyncAtMs:control.syncedAtMs,error:control.error},
      account:account?{cashBuyingPower:account.cashBuyingPower,marketValue,unrealizedPnl,unrealizedReturnPercent:cost>0?unrealizedPnl/cost*100:null}:null,
      performance,positions,
      orders:this.db.select().from(tradingOrders).where(this.isPaper?eq(tradingOrders.accountId,PAPER_TRADING_ACCOUNT_ID):undefined).orderBy(desc(tradingOrders.createdAtMs)).limit(100).all().map(o=>({...JSON.parse(o.payloadJson),status:o.status}) as TradingOrder),
      events:this.db.select().from(tradingEvents).where(this.isPaper?inArray(tradingEvents.deploymentId,this.db.select({id:tradingDeployments.id}).from(tradingDeployments).where(eq(tradingDeployments.mode,"PAPER"))):undefined).orderBy(desc(tradingEvents.id)).limit(100).all().map(e=>({id:e.id,message:e.message,severity:e.severity as "INFO"|"WARNING"|"ERROR",createdAtMs:e.createdAtMs})),blockers,
    };
  }
  async source(jobId:string):Promise<TradingSource> {
    const run=this.db.select().from(backtestRuns).where(eq(backtestRuns.jobId,jobId)).get();
    const job=this.db.select().from(backtestJobs).where(eq(backtestJobs.id,jobId)).get();
    if(!run||!job||job.status!=="COMPLETED")throw new TradingError("완료된 백테스트 결과를 찾을 수 없습니다.","NOT_FOUND",404);
    const request=backtestRequestSchema.parse(JSON.parse(job.requestJson));
    const artifact=this.artifacts().find(a=>a.strategyId===run.strategyId&&a.version===run.strategyVersion&&a.executionVersion===job.runnerVersion);
    if(!artifact)return {setup:null,strategyName:run.strategyId,strategyVersion:run.strategyVersion,error:"이 백테스트를 실행한 버전의 실행 파일이 보관되어 있지 않습니다. 최신 버전으로 임의 대체하지 않습니다. 사용 가능한 버전으로 백테스트한 뒤 가져오세요."};
    return {strategyName:artifact.name,strategyVersion:artifact.version,error:null,setup:tradingSetupSchema.parse({strategyId:run.strategyId,artifactHash:artifact.artifactHash,parameters:JSON.parse(run.parameterJson),universeRule:request.universeRule,timeframe:"1d",budgetKrw:request.capital.initialCash,maxPositions:request.risk.maxPositions,maxPositionPercent:request.risk.maxPositionWeightPercent??100,dailyLossLimitPercent:3,maxOrderKrw:Math.min(request.capital.initialCash,99_000_000),maxSlippageBps:50,randomSeed:request.randomSeed,sourceJobId:jobId})};
  }
  private async validate(input:TradingSetup) {
    const setup=tradingSetupSchema.parse(input);
    const artifact=this.artifacts().find(a=>a.strategyId===setup.strategyId&&a.artifactHash===setup.artifactHash);
    if(!artifact)throw new TradingError("선택한 전략 버전의 실행 파일이 없습니다.");
    const strategy=await this.deps.artifacts.load(setup.strategyId,setup.artifactHash);
    const parsed=strategy.parameterSchema.safeParse(setup.parameters);
    if(!parsed.success)throw new TradingError(parsed.error.issues.map(i=>i.message).join("; "),"INVALID_PARAMETERS",422);
    setup.parameters=parsed.data as Record<string,unknown>;
    const topN=setup.parameters.topN;
    if(typeof topN==="number"&&(topN>setup.maxPositions||topN>setup.universeRule.stages.at(-1)!.limit))throw new TradingError("보유 종목 수는 동시 보유 상한과 최종 유니버스 크기 이하여야 합니다.","INVALID_PARAMETERS",422);
    if(setup.maxOrderKrw>=100_000_000)throw new TradingError("건당 1억원 미만 주문만 지원합니다.","INVALID_PARAMETERS",422);
    if(strategy.requiredRebalanceGapBars&&setup.universeRule.rebalanceInterval.unit==="DAY"&&setup.universeRule.rebalanceInterval.value<strategy.requiredRebalanceGapBars+1)throw new TradingError("이 전략은 매도·매수 단계 사이에 거래일이 필요합니다. 더 긴 리밸런스 주기를 선택하세요.","INVALID_PARAMETERS",422);
    return {setup,artifact};
  }
  async register(input:TradingSetup,expectedRevision:number,actor:string,initialCashKrw?:number) {
    const {setup,artifact}=await this.validate(input);
    this.change(expectedRevision,()=>{
      if(this.current())throw new TradingError("전략은 최대 1개까지 등록할 수 있습니다. 기존 전략을 먼저 제거하세요.");
      if(this.pending().length)throw new TradingError("확인이 끝나지 않은 주문이 있어 새 전략을 등록할 수 없습니다.");
      const id=randomUUID();const now=this.now();
      this.db.insert(tradingDeployments).values({id,slot:1,mode:this.isPaper?"PAPER":"LIVE",setupJson:JSON.stringify(setup),name:artifact.name,version:artifact.version,status:"INACTIVE",createdAtMs:now,updatedAtMs:now,activity:"비활성 · 활성화 전 주문하지 않습니다.",returnBase:setup.budgetKrw}).run();
      this.setInitialCash(initialCashKrw,actor);
      this.event(`전략 등록: ${artifact.name} v${artifact.version}`,actor,"INFO",id);
    });return this.snapshot();
  }
  async update(input:TradingSetup,expectedRevision:number,actor:string,initialCashKrw?:number) {
    const {setup}=await this.validate(input);
    this.change(expectedRevision,()=>{
      const row=this.requireInactive();const previous=this.deployment(row);
      if(previous.strategyId!==setup.strategyId||previous.artifactHash!==setup.artifactHash)throw new TradingError("전략 교체는 기존 전략 제거 후 등록하고, 버전 변경은 별도 기능을 사용하세요.");
      this.setInitialCash(initialCashKrw,actor);
      this.db.update(tradingDeployments).set({setupJson:JSON.stringify(setup),checkpoint:null,lastDecisionAtMs:null,updatedAtMs:this.now(),returnBase:row.activatedAtMs===null?setup.budgetKrw:previous.budgetKrw===setup.budgetKrw?row.returnBase:null,activity:"설정 변경 · 비활성 유지"}).where(eq(tradingDeployments.id,row.id)).run();
      this.event("사용자가 매매 파라미터·운용 설정 변경",actor);
    });return this.snapshot();
  }
  async version(hash:string,parameters:Record<string,unknown>,expectedRevision:number,actor:string) {
    const before=this.current();if(!before)throw new TradingError("등록된 전략이 없습니다.");
    const input={...tradingSetupSchema.parse(JSON.parse(before.setupJson)),artifactHash:hash,parameters};
    const {setup,artifact}=await this.validate(input);
    this.change(expectedRevision,()=>{
      const row=this.requireInactive();if(row.id!==before.id)throw new TradingError("전략이 변경되었습니다.");
      this.db.update(tradingDeployments).set({setupJson:JSON.stringify(setup),version:artifact.version,checkpoint:null,lastDecisionAtMs:null,lastError:null,updatedAtMs:this.now(),activity:"버전 변경 · 비활성 유지"}).where(eq(tradingDeployments.id,row.id)).run();
      this.event(`전략 버전 변경: v${row.version} → v${artifact.version} · 실행 코드 ${hash.slice(0,12)}`,actor);
    });return this.snapshot();
  }
  remove(expectedRevision:number,actor:string) {
    this.change(expectedRevision,()=>{
      const row=this.requireInactive();
      this.db.update(tradingDeployments).set({slot:null,updatedAtMs:this.now(),activity:"제거됨 · 보유 포지션 수동 관리"}).where(eq(tradingDeployments.id,row.id)).run();
      this.event("등록 전략 제거 · 포지션 청산 없이 이력 보관",actor,"WARNING",row.id);
    });return this.snapshot();
  }
  async selectAccount(accountId:string,expectedRevision:number,actor:string) {
    if(this.isPaper)throw new TradingError("모의투자는 계좌 연결을 사용하지 않습니다.");
    this.change(expectedRevision,()=>{
      if(this.current())throw new TradingError("운용 계좌 변경 전 등록 전략을 제거하세요.");
      if(this.pending().length)throw new TradingError("기존 주문 확인이 끝나지 않았습니다.");
      const accounts=JSON.parse(this.control().accountsJson) as {id:string}[];
      if(!accounts.some(a=>a.id===accountId))throw new TradingError("조회된 토스 계좌만 선택할 수 있습니다.");
      this.db.update(tradingControl).set({accountId,snapshotJson:null,syncedAtMs:null,error:null}).where(eq(tradingControl.singleton,1)).run();
      this.event("운용 토스 계좌 변경",actor);
    });await this.refresh();return this.snapshot();
  }
  async refresh():Promise<TradingSnapshot> {
    if(!this.deps.broker.configured)throw new TradingError("토스증권 API 자격 증명이 설정되지 않았습니다.","BROKER_NOT_CONFIGURED",503);
    if(!this.refreshing)this.refreshing=this.withPaperLedger(()=>this.sync()).finally(()=>{this.refreshing=null;});
    await this.refreshing;return this.snapshot();
  }
  private withPaperLedger<T>(operation:()=>Promise<T>):Promise<T> {
    if(!this.isPaper)return operation();
    // 체결과 잔고 대조 사이에 다른 조회가 끼어들어 정상 수량을 불일치로 판단하지 않는다.
    const running=this.brokerOperation.then(operation);
    this.brokerOperation=running.catch(()=>{});
    return running;
  }
  async quote(symbol:string):Promise<TradingQuote> {
    try {
      const quote=(await this.deps.broker.quotes([symbol])).find(q=>q.symbol===symbol);
      if(!quote||!Number.isFinite(quote.price)||quote.price<=0||!Number.isFinite(quote.timestampMs)||quote.timestampMs>this.now()+5_000)throw new Error("유효한 시세를 받지 못했습니다.");
      return quote;
    } catch {
      throw new TradingError("현재 시세를 조회할 수 없습니다. 시세 제공 상태를 확인하세요.","QUOTE_UNAVAILABLE",503);
    }
  }
  private async sync() {
    const selected=this.control().accountId;
    try {
      const accounts=await this.deps.broker.accounts();
      this.db.update(tradingControl).set({accountsJson:JSON.stringify(accounts)}).where(eq(tradingControl.singleton,1)).run();
      if(!selected){this.db.update(tradingControl).set({error:null}).where(eq(tradingControl.singleton,1)).run();return;}
      if(!accounts.some(a=>a.id===selected))throw new TradingError("선택한 토스 계좌에 접근할 수 없습니다.");
      if(this.isPaper){await this.syncPaper(selected);return;}
      // 누적 체결을 먼저 반영한 뒤 잔고를 읽어 부분 체결을 수동 매매로 오인하지 않는다.
      await this.reconcileOrders(selected);
      const observedAt=this.now();
      const holdings=await this.deps.broker.holdings(selected);
      const cashBuyingPower=await this.deps.broker.buyingPower(selected);
      if(this.control().accountId!==selected)return;
      this.db.update(tradingControl).set({snapshotJson:JSON.stringify({holdings,cashBuyingPower}),syncedAtMs:observedAt,error:null}).where(eq(tradingControl.singleton,1)).run();
      const row=this.current();
      if(row){for(const [symbol,p] of Object.entries(this.portfolio(row))){if((holdings.find(h=>h.symbol===symbol)?.quantity??0)!==p.quantity)throw new TradingError(`보유 수량 불일치: ${symbol}. 외부 주문·자본변동과 미확인 체결을 확인하세요.`);}}
    }catch(error){
      if(this.stopping)throw error;
      const message=error instanceof Error?error.message:"토스 계좌 동기화 실패";
      this.db.update(tradingControl).set({error:message}).where(eq(tradingControl.singleton,1)).run();
      const row=this.current();if(row?.status==="ACTIVE")this.fail(message);
      throw new TradingError(message,"BROKER_SYNC_FAILED",503);
    }
  }
  private async syncPaper(accountId:string) {
    for(let attempt=0;attempt<3;attempt++) {
      let observed:BrokerHolding[];
      try { observed=await this.deps.broker.holdings(accountId); }
      catch(error) {
        if(error instanceof BrokerHoldingsChangedError) continue;
        throw error;
      }
      const observedAt=this.now();
      const complete=this.deps.database.sqlite.transaction(()=>{
        if(this.control().accountId!==accountId)return true;
        const ledger=this.deps.database.sqlite.prepare("SELECT cash, holdings_json FROM paper_trading_account WHERE singleton = 1").get() as {cash:number;holdings_json:string}|undefined;
        const positions=JSON.parse(ledger?.holdings_json??"{}") as Record<string,{quantity:number;cost:number}>;
        const prices=new Map(observed.map(h=>[h.symbol,h]));
        if(Object.entries(positions).some(([symbol,p])=>p.quantity>0&&!prices.has(symbol)))return false;
        this.reconcilePaperOrders(accountId);
        const holdings=Object.entries(positions).filter(([,p])=>p.quantity>0).map(([symbol,p])=>{
          const quote=prices.get(symbol)!;const marketValue=p.quantity*quote.price;
          return {...quote,quantity:p.quantity,availableQuantity:p.quantity,averagePrice:p.cost/p.quantity,marketValue,unrealizedPnl:marketValue-p.cost};
        });
        const row=this.current();
        if(row){for(const [symbol,p] of Object.entries(this.portfolio(row))){if((holdings.find(h=>h.symbol===symbol)?.quantity??0)!==p.quantity)throw new TradingError(`보유 수량 불일치: ${symbol}. 외부 주문·자본변동과 미확인 체결을 확인하세요.`);}}
        this.db.update(tradingControl).set({snapshotJson:JSON.stringify({holdings,cashBuyingPower:ledger?.cash??PAPER_TRADING_INITIAL_CASH_KRW}),syncedAtMs:observedAt,error:null}).where(eq(tradingControl.singleton,1)).run();
        return true;
      }).immediate();
      if(complete)return;
    }
  }
  private reconcilePaperOrders(accountId:string) {
    const pending=this.db.select().from(tradingOrders).where(and(eq(tradingOrders.accountId,accountId),inArray(tradingOrders.status,PENDING.filter(s=>s!=="CREATED")))).all();
    for(const row of pending) {
      const id=row.brokerOrderId??row.id;
      const saved=this.deps.database.sqlite.prepare("SELECT payload_json FROM paper_trading_orders WHERE id = ?").get(id) as {payload_json:string}|undefined;
      if(!saved) {
        if(!row.brokerOrderId&&(row.status==="SENDING"||row.status==="UNKNOWN"))continue;
        throw new TradingError(`모의 주문 원장을 찾을 수 없습니다: ${id}`);
      }
      if(!row.brokerOrderId)this.saveOrder(row,{brokerOrderId:id});
      this.applyOrder({...row,brokerOrderId:id},(JSON.parse(saved.payload_json) as {order:BrokerOrder}).order);
    }
  }
  async activate(expectedRevision:number,actor:string) {
    if(this.preparing)throw new TradingError("매매 데이터 준비 중입니다. 검증 완료 후 자동매매를 켜 주세요.");
    const before=this.requireInactive();
    if(this.control().revision!==expectedRevision)throw new TradingError("매매 설정이 변경되었습니다.","STALE_REVISION");
    await this.refresh();
    const blockers=this.snapshot().blockers;if(blockers.length)throw new TradingError(blockers.join(" "));
    if(this.pending().length)throw new TradingError("기존 주문을 모두 확인한 후 활성화하세요.");
    const deployment=this.deployment(before);
    let prepared:Awaited<ReturnType<TradingDecisionEngine["evaluate"]>>;
    try { prepared=await this.deps.engine.evaluate({deployment,portfolio:this.portfolio(before),checkpoint:before.checkpoint,warmupOnly:true}); }
    catch(error){
      if(error instanceof TradingDataRequired&&this.deps.prepareData&&this.control().revision===expectedRevision&&this.current()?.id===before.id&&this.current()?.status==="INACTIVE")return this.prepareData(expectedRevision,actor,error.need);
      const message=error instanceof Error?error.message:"전략 준비에 실패했습니다.";
      const row = this.current();
      if(this.control().revision===expectedRevision&&row?.id===before.id&&row.status==="INACTIVE"){
        this.db.update(tradingDeployments).set({lastError:message,activity:"비활성 · 전략 준비 확인 필요"}).where(eq(tradingDeployments.id,before.id)).run();
        this.preparation = { deploymentId: before.id, revision: expectedRevision, state: { status: "FAILED", message } };
      }
      throw new TradingError(message,"STRATEGY_NOT_READY");
    }
    this.change(expectedRevision,()=>{
      const row=this.requireInactive();if(row.id!==before.id)throw new TradingError("등록 전략이 변경되었습니다.");
      this.db.update(tradingDeployments).set({status:"ACTIVE",checkpoint:prepared.checkpoint,lastDecisionAtMs:prepared.barTsMs,activatedAtMs:row.activatedAtMs??this.now(),updatedAtMs:this.now(),lastError:null,activity:"활성 · 다음 거래일의 유효한 신호를 기다립니다."}).where(eq(tradingDeployments.id,row.id)).run();
      this.event("사용자가 매매 활성화 · 기존 포지션 유지, 새 판단부터 주문 허용",actor);
    });return this.snapshot();
  }
  deactivate(expectedRevision:number,actor:string) {
    this.change(expectedRevision,()=>{
      const row=this.current();if(!row)throw new TradingError("등록된 전략이 없습니다.");
      if(row.status==="INACTIVE")return;
      this.db.update(tradingDeployments).set({status:"STOPPING",updatedAtMs:this.now(),activity:"중지 중 · 미체결 취소 및 최종 체결 확인",lastError:null}).where(eq(tradingDeployments.id,row.id)).run();
      for(const order of this.pending(row.id).filter(o=>o.status==="CREATED"))this.saveOrder(order,{status:"CANCELLED",error:null});
      if(this.isPaper&&!this.pending(row.id).length)this.db.update(tradingDeployments).set({status:"INACTIVE",activity:"모의투자 · 자동매매 OFF · 포지션 유지"}).where(eq(tradingDeployments.id,row.id)).run();
      this.event("사용자가 신규 주문 차단 · 미체결 취소 요청",actor,"WARNING");
    });this.kick();return this.snapshot();
  }
  async resolveOrder(orderId:string,brokerOrderId:string|null,expectedRevision:number,actor:string) {
    const row=this.db.select().from(tradingOrders).where(eq(tradingOrders.id,orderId)).get();
    if(!row||row.status!=="UNKNOWN")throw new TradingError("수동 확인 대상 주문이 아닙니다.");
    if(this.isPaper&&row.accountId!==PAPER_TRADING_ACCOUNT_ID)throw new TradingError("모의투자에서 실계좌 주문을 변경할 수 없습니다.");
    if(this.current()?.status==="ACTIVE")throw new TradingError("주문이 중지된 상태에서만 접수 여부를 확인할 수 있습니다.");
    const order=JSON.parse(row.payloadJson) as TradingOrder;
    const history=await this.deps.broker.orders(row.accountId,kstDateOf(row.createdAtMs),kstDateOf(this.now()));
    const matching=history.filter(o=>o.symbol===order.symbol&&o.side===order.side&&o.quantity===order.quantity);
    const found=brokerOrderId?history.find(o=>o.id===brokerOrderId):null;
    if(brokerOrderId&&(!found||found.symbol!==order.symbol||found.side!==order.side||found.quantity!==order.quantity||found.price!==order.price||found.orderedAtMs===undefined||Math.abs(found.orderedAtMs-row.createdAtMs)>10*60_000||(found.clientOrderId!==null&&found.clientOrderId!==row.id)))throw new TradingError("해당 주문 번호의 종목·방향·수량·가격·접수 시각이 원래 주문과 일치하지 않습니다.");
    if(!brokerOrderId&&(this.now()-row.createdAtMs<10*60_000||matching.length))throw new TradingError("10분이 지나고 일치할 수 있는 증권사 주문이 없는 경우에만 미접수로 확인할 수 있습니다. 주문이 있으면 해당 번호를 연결하세요.");
    this.change(expectedRevision,()=>{
      const current=this.db.select().from(tradingOrders).where(eq(tradingOrders.id,row.id)).get();
      if(current?.status!=="UNKNOWN"||this.current()?.status==="ACTIVE")throw new TradingError("주문 상태가 변경되었습니다.");
      if(found){this.saveOrder(current,{brokerOrderId:found.id});this.applyOrder({...current,brokerOrderId:found.id},found);}
      else this.saveOrder(current,{status:"REJECTED",error:"사용자가 증권사 내역에서 미접수 확인"});
      this.event(`사용자가 불명확한 주문을 ${found?"증권사 주문 번호와 연결":"미접수로 확인"} · 자동 재주문 없음`,actor,"WARNING",row.deploymentId);
    });return this.snapshot();
  }
  private fail(message:string) {
    let notify=false;
    this.deps.database.sqlite.transaction(()=>{
      const row=this.current();if(!row||row.status==="INACTIVE")return;
      const stopping=row.status==="STOPPING";
      const duplicate=(row.status==="ERROR"||stopping)&&row.lastError===message;
      if(duplicate)return;
      const paperStopped=this.isPaper&&!this.pending(row.id).length;
      this.db.update(tradingDeployments).set({status:paperStopped?"INACTIVE":stopping?"STOPPING":"ERROR",lastError:message,activity:paperStopped?"모의투자 · 자동매매 OFF · 오류 확인 필요":stopping?"중지 중 · 미체결 취소·체결 확인 재시도":"주문 중지 · 오류 확인 필요",updatedAtMs:this.now()}).where(eq(tradingDeployments.id,row.id)).run();
      this.db.update(tradingControl).set({revision:sql`${tradingControl.revision}+1`}).where(eq(tradingControl.singleton,1)).run();
      this.event(message,"system","ERROR");notify=true;
    }).immediate();
    if(notify)this.deps.notify?.(message);
  }
  private saveOrder(row:OrderRow,patch:Partial<TradingOrder>) {
    const fresh=this.db.select().from(tradingOrders).where(eq(tradingOrders.id,row.id)).get()!;
    const order={...JSON.parse(fresh.payloadJson),...patch,updatedAtMs:this.now()} as TradingOrder;
    this.db.update(tradingOrders).set({payloadJson:JSON.stringify(order),status:order.status,brokerOrderId:order.brokerOrderId,updatedAtMs:this.now()}).where(eq(tradingOrders.id,row.id)).run();
  }
  private applyOrder(row:OrderRow,received:BrokerOrder) {
    this.deps.database.sqlite.transaction(()=>{
      const fresh=this.db.select().from(tradingOrders).where(eq(tradingOrders.id,row.id)).get()!;
      const order=JSON.parse(fresh.payloadJson) as TradingOrder;
      if(received.id!==fresh.brokerOrderId||received.symbol!==order.symbol||received.side!==order.side||received.quantity!==order.quantity)throw new TradingError("증권사 주문 식별 정보가 저장된 주문과 다릅니다.");
      if(received.filledQuantity<fresh.appliedQuantity||received.filledQuantity>order.quantity)throw new TradingError("체결 누계가 이전 확인값과 일치하지 않습니다.");
      const amount=received.filledQuantity*(received.averageFillPrice??0);
      const delta=received.filledQuantity-fresh.appliedQuantity;
      const deltaAmount=amount-fresh.appliedAmount;
      const costs=received.commission+received.tax;
      if(!Number.isFinite(amount)||amount<fresh.appliedAmount||costs<0||!Number.isFinite(costs))throw new TradingError("체결 금액·비용이 올바르지 않습니다.");
      if(delta===0&&deltaAmount!==0)throw new TradingError("이미 반영한 체결 가격이 변경되었습니다. 거래내역 대조가 필요합니다.");
      const deployment=this.db.select().from(tradingDeployments).where(eq(tradingDeployments.id,row.deploymentId)).get()!;
      const portfolio=this.portfolio(deployment);let realized=deployment.realizedPnl-(costs-fresh.appliedCosts);
      if(delta>0){
        const current=portfolio[order.symbol]??{quantity:0,cost:0,enteredAtMs:this.now()};
        if(order.side==="BUY")portfolio[order.symbol]={quantity:current.quantity+delta,cost:current.cost+deltaAmount,enteredAtMs:current.enteredAtMs};
        else {if(delta>current.quantity)throw new TradingError("전략 관리 수량을 초과한 매도 체결입니다.");const cost=current.cost*delta/current.quantity;realized+=deltaAmount-cost;if(current.quantity===delta)delete portfolio[order.symbol];else portfolio[order.symbol]={...current,quantity:current.quantity-delta,cost:current.cost-cost};}
      }
      this.db.update(tradingDeployments).set({portfolioJson:JSON.stringify(portfolio),realizedPnl:realized}).where(eq(tradingDeployments.id,deployment.id)).run();
      this.saveOrder(fresh,{status:received.status,filledQuantity:received.filledQuantity,averageFillPrice:received.averageFillPrice,error:null});
      this.db.update(tradingOrders).set({appliedQuantity:received.filledQuantity,appliedAmount:amount,appliedCosts:costs}).where(eq(tradingOrders.id,row.id)).run();
      if(delta>0)this.event(`${order.symbol} ${order.side==="BUY"?"매수":"매도"} ${delta}주 체결`,"system","INFO",row.deploymentId);
    }).immediate();
  }
  private async reconcileOrders(accountId:string) {
    if(this.isPaper){this.deps.database.sqlite.transaction(()=>this.reconcilePaperOrders(accountId)).immediate();return;}
    const pending=this.db.select().from(tradingOrders).where(and(eq(tradingOrders.accountId,accountId),inArray(tradingOrders.status,PENDING.filter(s=>s!=="CREATED")))).all();
    const failures:string[]=[];
    for(const row of pending){
      if(!row.brokerOrderId){failures.push(`주문 ${row.id}의 접수 여부를 확인할 수 없습니다. 자동 재주문하지 않습니다. 증권사 주문 번호 확인이 필요합니다.`);continue;}
      try {
        try {this.applyOrder(row,await this.deps.broker.order(accountId,row.brokerOrderId));}
        catch(error){
          // 부분 체결의 종료 여부가 상세 응답만으로 불명확하면 OPEN/CLOSED 목록으로 확인한다.
          const date=kstDateOf(row.createdAtMs);const list=await this.deps.broker.orders(accountId,date,kstDateOf(this.now()));
          const found=list.find(o=>o.id===row.brokerOrderId);if(!found)throw error;this.applyOrder(row,found);
        }
      }
      catch(error){
        failures.push(error instanceof Error?error.message:"체결 내역 확인 실패");
      }
    }
    // 체결 이후 정산되는 비용도 최근 7일의 종료 주문과 주기적으로 대조한다.
    if(this.now()-this.terminalSyncAt>=300_000){
      const recent=this.db.select().from(tradingOrders).where(and(eq(tradingOrders.accountId,accountId),inArray(tradingOrders.status,["FILLED","CANCELLED"]),sql`${tradingOrders.createdAtMs} >= ${this.now()-7*86400_000}`,sql`${tradingOrders.appliedQuantity} > 0`)).all();
      try{
        if(recent.length){
          const history=await this.deps.broker.orders(accountId,kstDateOf(Math.min(...recent.map(o=>o.createdAtMs))),kstDateOf(this.now()));
          for(const row of recent){const found=history.find(o=>o.id===row.brokerOrderId);if(!found)throw new TradingError("종료 주문의 정산 내역을 찾을 수 없습니다.");this.applyOrder(row,found);}
        }
        this.terminalSyncAt=this.now();
      }catch(error){failures.push(error instanceof Error?error.message:"종료 주문 정산 확인 실패");}
    }
    if(failures.length)throw new TradingError([...new Set(failures)].join(" "));
  }
  private acquire() {
    return this.deps.database.sqlite.transaction(()=>{
      const now=this.now();const before=this.control();
      if(before.executorToken!==this.token)this.acquired=false;
      if(before.executorToken!==this.token&&before.executorExpiresAtMs!==null&&before.executorExpiresAtMs>=now)return false;
      this.db.update(tradingControl).set({executorToken:this.token,executorExpiresAtMs:now+LEASE_MS}).where(eq(tradingControl.singleton,1)).run();
      if(!this.acquired){
        this.acquired=true;
        for(const order of this.pending().filter(o=>o.status==="SENDING")) {
          // 모의 체결과 주문은 로컬 원장에 원자적으로 기록되어 재시작 후에도 확정할 수 있다.
          if(this.isPaper) {
            const saved=this.deps.database.sqlite.prepare("SELECT 1 FROM paper_trading_orders WHERE id = ?").get(order.id);
            this.saveOrder(order,saved?{brokerOrderId:order.id,status:"OPEN",error:null}:{status:"REJECTED",error:"모의 주문 전송 전 실행기 중단"});
          } else this.saveOrder(order,{status:"UNKNOWN",error:"이전 실행기 중단으로 접수 여부 확인 필요"});
        }
        const row=this.current();if(row?.status==="ACTIVE")this.fail("실행기가 재시작되었습니다. 잔고·주문을 확인한 후 직접 다시 활성화하세요.");
      }return true;
    }).immediate();
  }
  private assertSend(id:string,revision:number) {
    const control=this.control();const row=this.current();
    if(this.stopping||this.deps.enabled===false||control.executorToken!==this.token||!control.executorExpiresAtMs||control.executorExpiresAtMs<=this.now()||control.revision!==revision||row?.id!==id||row.status!=="ACTIVE"||!this.deps.engine.canTrade(this.now()))throw new TradingError("주문 허용 상태가 변경되어 전송을 차단했습니다.","ORDER_GATE_CLOSED");
    this.db.update(tradingControl).set({executorExpiresAtMs:this.now()+LEASE_MS}).where(and(eq(tradingControl.singleton,1),eq(tradingControl.executorToken,this.token))).run();
  }
  private async finishStop(row:DeploymentRow) {
    const account=this.control().accountId;if(!account)throw new TradingError("운용 계좌가 없습니다.");
    const failures:string[]=[];
    // 한 주문이 미확인이어도 나머지 접수된 주문의 취소는 계속한다.
    try{await this.reconcileOrders(account);}catch(error){failures.push(error instanceof Error?error.message:"체결 내역 확인 실패");}
    for(const order of this.pending(row.id)){
      if(this.stopping)return;
      if(order.status==="CREATED"){this.saveOrder(order,{status:"CANCELLED"});continue;}
      if(!order.brokerOrderId){failures.push("접수 여부가 불명확한 주문이 있어 중지 완료를 확인할 수 없습니다.");continue;}
      if(order.status==="OPEN"||order.status==="PARTIAL"||order.status==="CANCEL_REQUESTED"){
        const retry=this.cancelRetry.get(order.id);
        if(retry&&retry.after>this.now())continue;
        this.saveOrder(order,{status:"CANCEL_REQUESTED"});
        const attempts=(retry?.attempts??0)+1;
        this.cancelRetry.set(order.id,{attempts,after:this.now()+Math.min(60_000,15_000*2**Math.min(attempts-1,2))});
        try{await this.deps.broker.cancel(account,order.brokerOrderId);}catch(error){if(!(error instanceof BrokerRequestError&&error.statusCode===409))failures.push(error instanceof Error?error.message:"미체결 취소 실패");}
      }
    }
    if(this.stopping)return;
    // 모의 주문의 종료는 원장으로 확정한다. 시세 장애가 OFF 전환을 막지 않는다.
    if(!this.isPaper)try{await this.refresh();}catch(error){failures.push(error instanceof Error?error.message:"최종 잔고 확인 실패");}
    if(this.stopping)return;
    const pending=this.pending(row.id);
    for(const id of this.cancelRetry.keys())if(!pending.some(order=>order.id===id))this.cancelRetry.delete(id);
    if(pending.length||failures.length){
      if(failures.length)this.fail([...new Set(failures)].join(" "));
      else this.db.update(tradingDeployments).set({lastError:null,activity:"중지 중 · 증권사의 취소·최종 체결 확인 대기 (자동 재확인)"}).where(and(eq(tradingDeployments.id,row.id),eq(tradingDeployments.status,"STOPPING"))).run();
      return;
    }
    this.deps.database.sqlite.transaction(()=>{
      const current=this.current();if(current?.id!==row.id||(current.status!=="STOPPING"&&!(this.isPaper&&current.status==="ERROR")))return;
      this.db.update(tradingDeployments).set({status:"INACTIVE",lastError:current.status==="ERROR"?current.lastError:null,updatedAtMs:this.now(),activity:"비활성 · 매수·매도·자동 손절 중지"}).where(eq(tradingDeployments.id,row.id)).run();
      this.db.update(tradingControl).set({revision:sql`${tradingControl.revision}+1`}).where(eq(tradingControl.singleton,1)).run();this.event("비활성 완료 · 미체결·체결 대조 완료, 포지션 유지");
    }).immediate();
  }
  private async trade(row:DeploymentRow) {
    if(this.now()-(this.control().syncedAtMs??0)>20_000)await this.refresh();
    const control=this.control();const current=this.current();
    if(current?.id!==row.id||current.status!=="ACTIVE")return;
    if(!control.accountId||!control.syncedAtMs||this.now()-control.syncedAtMs>SYNC_MAX_AGE_MS)throw new TradingError("계좌 잔고가 최신 상태가 아닙니다.");
    const deployment=this.deployment(current);const portfolio=this.portfolio(current);
    const perf=this.snapshot().performance;
    if(!perf)throw new TradingError("전략 보유 잔고를 확인할 수 없습니다.");
    const date=kstDateOf(this.now());const day=current.dailyBaseJson?JSON.parse(current.dailyBaseJson) as {date:string;pnl:number}:null;
    if(day?.date===date&&(perf.totalPnl-day.pnl)/deployment.budgetKrw*100<=-deployment.dailyLossLimitPercent){
      this.deactivate(control.revision,"risk-limit");
      this.event("일일 손실 한도 도달 · 미체결 주문 취소, 보유 포지션 유지","system","WARNING");
      this.deps.notify?.("일일 손실 한도에 도달해 주문을 중지하고 미체결을 취소합니다.");return;
    }
    if(day?.date!==date)this.db.update(tradingDeployments).set({dailyBaseJson:JSON.stringify({date,pnl:perf.totalPnl})}).where(eq(tradingDeployments.id,row.id)).run();
    if(!this.deps.engine.canTrade(this.now()))return;
    if(this.pending().length)return;
    let result: Awaited<ReturnType<TradingDecisionEngine["evaluate"]>>;
    try { result=await this.deps.engine.evaluate({deployment,portfolio,checkpoint:current.checkpoint,warmupOnly:false}); }
    catch(error) {
      if(error instanceof TradingDataRequired) {
        const handled = this.deps.database.sqlite.transaction(() => {
          const latestControl = this.control(), latestRow = this.current();
          if(this.stopping||latestControl.revision!==control.revision||latestRow?.id!==row.id||latestRow.status!=="ACTIVE"||latestControl.executorToken!==this.token)return true;
          if(!this.deps.prepareData||!this.isPaper)return false;
          this.fail(error.message);
          this.prepareData(this.control().revision,"system",error.need);
          return true;
        }).immediate();
        if(handled)return;
      }
      throw error;
    }
    if(current.lastDecisionAtMs!==null&&result.barTsMs<=current.lastDecisionAtMs)return;
    await this.refresh();
    this.assertSend(row.id,control.revision);
    const snapshot=this.snapshot();const manual=new Set(snapshot.positions.filter(p=>p.deploymentId!==row.id).map(p=>p.symbol));
    const intents=result.orders.filter(o=>!manual.has(o.symbol));
    if(intents.length>400)throw new TradingError("한 번의 판단에서 주문 상한을 초과했습니다.");
    const quotes=intents.length?await this.deps.broker.quotes([...new Set(intents.map(o=>o.symbol))]):[];
    let cash=Math.min(snapshot.account!.cashBuyingPower,deployment.budgetKrw-snapshot.positions.filter(p=>p.deploymentId===row.id).reduce((n,p)=>n+p.marketValue,0));
    const planned:TradingOrder[]=[];const symbols=new Set(Object.keys(portfolio));const seen=new Set<string>();
    for(const intent of [...intents].sort((a,b)=>a.side===b.side?a.symbol.localeCompare(b.symbol):a.side==="SELL"?-1:1)){
      if(seen.has(intent.symbol))throw new TradingError("같은 판단에서 한 종목의 중복 주문이 생성되었습니다.");seen.add(intent.symbol);
      if(!Number.isSafeInteger(intent.quantity)||intent.quantity<=0||!/^\d{6}$/.test(intent.symbol))throw new TradingError("전략이 유효하지 않은 주문을 생성했습니다.");
      const quote=quotes.find(q=>q.symbol===intent.symbol);
      if(!quote||quote.timestampMs>this.now()+5_000||this.now()-quote.timestampMs>30_000||quote.price<=0)throw new TradingError(`시세가 오래되었거나 없습니다: ${intent.symbol}`);
      // 국내 보통주의 보수적 공통 호가 배수. 매수 상한·매도 하한을 벗어나지 않도록 반올림한다.
      const rawPrice=quote.price*(1+(intent.side==="BUY"?1:-1)*deployment.maxSlippageBps/10_000);
      const tick=rawPrice<2_000?1:rawPrice<5_000?5:rawPrice<20_000?10:rawPrice<50_000?50:rawPrice<200_000?100:rawPrice<500_000?500:1_000;
      const price=(intent.side==="BUY"?Math.floor(rawPrice/tick):Math.ceil(rawPrice/tick))*tick;
      let quantity=Math.min(intent.quantity,Math.floor(deployment.maxOrderKrw/price));
      if(intent.side==="SELL")quantity=Math.min(quantity,portfolio[intent.symbol]?.quantity??0,snapshot.positions.find(p=>p.symbol===intent.symbol)?.quantity??0);
      else {
        if(!symbols.has(intent.symbol)&&symbols.size>=deployment.maxPositions)continue;
        const existing=snapshot.positions.find(p=>p.symbol===intent.symbol)?.marketValue??0;
        quantity=Math.min(quantity,Math.floor(Math.max(0,deployment.budgetKrw*deployment.maxPositionPercent/100-existing)/price),Math.floor(Math.max(0,cash)/(price*1.01)));
        cash-=quantity*price*1.01;if(quantity>0)symbols.add(intent.symbol);
      }
      if(quantity<=0)continue;
      planned.push({id:randomUUID(),deploymentId:row.id,brokerOrderId:null,symbol:intent.symbol,side:intent.side,quantity,price,filledQuantity:0,averageFillPrice:null,status:"CREATED",reason:intent.reason??"전략 신호",error:null,createdAtMs:this.now(),updatedAtMs:this.now()});
    }
    this.deps.database.sqlite.transaction(()=>{
      this.assertSend(row.id,control.revision);
      for(const [index,order] of planned.entries())this.db.insert(tradingOrders).values({id:order.id,deploymentId:row.id,accountId:control.accountId!,decisionKey:`${result.barTsMs}:${index}`,payloadJson:JSON.stringify(order),status:order.status,createdAtMs:order.createdAtMs,updatedAtMs:order.updatedAtMs}).run();
      this.db.update(tradingDeployments).set({checkpoint:result.checkpoint,lastDecisionAtMs:result.barTsMs,activity:planned.length?`${planned.length}건 주문 계획 저장`:`신호 확인 완료 · 주문 없음`,updatedAtMs:this.now()}).where(eq(tradingDeployments.id,row.id)).run();
    }).immediate();
    for(const order of planned){
      const stored=this.db.select().from(tradingOrders).where(eq(tradingOrders.id,order.id)).get()!;
      let requestStarted=false;
      try{
        await this.refresh();
        const quotes=await this.deps.broker.quotes([order.symbol]);const quote=quotes.find(q=>q.symbol===order.symbol);
        const sellable=order.side==="SELL"?await this.deps.broker.sellableQuantity?.(control.accountId!,order.symbol):undefined;
        const guard=()=>{
          this.assertSend(row.id,control.revision);
          const currentSnapshot=this.snapshot();const observed=this.control().syncedAtMs;
          if(!observed||this.now()-observed>SYNC_MAX_AGE_MS||!currentSnapshot.account||!quote||quote.timestampMs>this.now()+5000||this.now()-quote.timestampMs>30_000)throw new TradingError("주문 직전 잔고·시세가 최신 상태가 아닙니다.");
          const holding=currentSnapshot.positions.find(p=>p.symbol===order.symbol);
          if(holding&&holding.deploymentId!==row.id)throw new TradingError("수동 관리 종목은 자동 주문하지 않습니다.");
          const pendingBuys=this.pending(row.id).filter(p=>p.id!==order.id&&p.status!=="CREATED").map(p=>JSON.parse(p.payloadJson) as TradingOrder).filter(p=>p.side==="BUY");
          const pendingValue=pendingBuys.reduce((n,p)=>n+(p.quantity-p.filledQuantity)*p.price,0);
          const heldValue=currentSnapshot.positions.filter(p=>p.deploymentId===row.id).reduce((n,p)=>n+p.marketValue,0);
          const value=order.quantity*order.price;
          if(order.side==="BUY"){
            const pendingSymbolValue=pendingBuys.filter(p=>p.symbol===order.symbol).reduce((n,p)=>n+(p.quantity-p.filledQuantity)*p.price,0);
            if(value*1.01>currentSnapshot.account.cashBuyingPower||heldValue+pendingValue+value>deployment.budgetKrw||(holding?.marketValue??0)+pendingSymbolValue+value>deployment.budgetKrw*deployment.maxPositionPercent/100||order.price>quote.price*(1+deployment.maxSlippageBps/10_000))throw new TradingError("주문 직전 매수 가능 금액·보유 한도·가격 조건이 변경되었습니다.");
          }else if(!holding||order.quantity>holding.quantity||order.quantity>(sellable??holding.availableQuantity??0)||order.price<quote.price*(1-deployment.maxSlippageBps/10_000))throw new TradingError("주문 직전 매도 가능 수량·가격 조건이 변경되었습니다.");
          const liveDay=this.current()?.dailyBaseJson;
          if(liveDay&&currentSnapshot.performance){const baseline=JSON.parse(liveDay) as {date:string;pnl:number};if(baseline.date===kstDateOf(this.now())&&(currentSnapshot.performance.totalPnl-baseline.pnl)/deployment.budgetKrw*100<=-deployment.dailyLossLimitPercent)throw new TradingError("일일 손실 한도에 도달했습니다.","DAILY_LOSS_LIMIT");}
        };
        await this.withPaperLedger(async()=>{
          guard();this.saveOrder(stored,{status:"SENDING"});
          try {
            const result=await this.deps.broker.place(control.accountId!,{clientOrderId:order.id,symbol:order.symbol,side:order.side,quantity:order.quantity,price:order.price},()=>{requestStarted=false;guard();requestStarted=true;});
            this.deps.database.sqlite.transaction(()=>{
              const latest=this.db.select().from(tradingOrders).where(eq(tradingOrders.id,stored.id)).get()!;
              if(!["FILLED","REJECTED","CANCELLED"].includes(latest.status))this.saveOrder(latest,{brokerOrderId:result.orderId,status:"OPEN"});
            }).immediate();
          } catch(error) {
            if(this.isPaper&&error instanceof BrokerRequestError&&!error.uncertain)this.saveOrder(stored,{status:"REJECTED",error:error.message});
            throw error;
          }
        });
        this.event(`${order.symbol} ${order.side==="BUY"?"매수":"매도"} ${order.quantity}주 주문 접수`);
      }catch(error){
        const failure=error instanceof BrokerRequestError&&error.cause instanceof TradingError?error.cause:error;
        const uncertain=requestStarted&&(error instanceof BrokerRequestError?error.uncertain:!(failure instanceof TradingError&&failure.code==="ORDER_GATE_CLOSED"));
        this.saveOrder(stored,{status:uncertain?"UNKNOWN":"REJECTED",error:failure instanceof Error?failure.message:"주문 실패"});
        // 원장 트랜잭션이 롤백된 뒤 중지 상태를 확정해야 주문 차단이 함께 롤백되지 않는다.
        if(failure instanceof TradingError&&failure.code==="DAILY_LOSS_LIMIT") {
          if(this.current()?.status==="ACTIVE")this.deactivate(this.control().revision,"risk-limit");
          throw new TradingError(failure.message,"ORDER_GATE_CLOSED");
        }
        throw failure;
      }
    }
  }
  start() { if(this.timer)return;this.timer=setInterval(()=>this.kick(),5_000);this.timer.unref();this.kick(); }
  private kick() { void this.tick(); }
  /** 테스트는 실제 주문 대신 주입된 증권사 포트로 동일한 실행 경계를 검증한다. */
  tick():Promise<void> {
    if(this.running)return this.running;
    if(this.stopping)return Promise.resolve();
    this.running=this.runTick().finally(()=>{this.running=null;});
    return this.running;
  }
  private async runTick():Promise<void> {
    if(this.stopping||!this.acquire())return;
    try{
      const row=this.current();
      if(row?.status==="STOPPING"||(row?.status==="ERROR"&&this.pending(row.id).length))await this.finishStop(row);
      else if(row?.status==="ACTIVE")await this.trade(row);
      else if(this.control().accountId&&this.now()-(this.control().syncedAtMs??0)>30_000)await this.refresh();
    }catch(error){if(this.stopping||(error instanceof TradingError&&error.code==="ORDER_GATE_CLOSED"))return;const message=error instanceof Error?error.message:"매매 처리 실패";this.fail(message);}
  }
  async close() {
    this.stopping=true;if(this.timer)clearInterval(this.timer);await this.running;await this.refreshing?.catch(()=>{});await this.deps.engine.close();await this.preparing;
    this.db.update(tradingControl).set({executorToken:null,executorExpiresAtMs:null}).where(and(eq(tradingControl.singleton,1),eq(tradingControl.executorToken,this.token))).run();
  }
}
