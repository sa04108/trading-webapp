import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { LoaderCircle, LockKeyhole } from "lucide-react";
import { HoldingPriceDialog } from "./holding-price-dialog";
import { useSearchParams } from "react-router";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api, ApiError } from "@/lib/api-client";
import { PAPER_TRADING_INITIAL_CASH_KRW, paperInitialCashSchema, tradingSetupSchema, type TradingArtifact, type TradingSetup, type TradingSnapshot } from "@shared/schemas/trading";
import { getIntradayStrategy, INTRADAY_TRADE_CONTROL_FIELDS } from "@shared/schemas/intraday-strategies";
import type { IntradayRequest, IntradayRun } from "@shared/schemas/intraday";
import type { RebalanceInterval } from "@shared/schemas/universe-rule";
import { DEFAULT_UNIVERSE_MARKETS } from "@shared/universe-markets";
import { UniverseMarketSelect } from "@/components/universe-market-select";
import { UniverseStageEditor } from "../backtests/universe-stage-editor";
import { formatUniverseRuleSummary } from "../backtests/universe-summary";
import { orderStatusLabel, tradingStatusLabel } from "./status-labels";
import { tradingKey, tradingPath, tradingPresetsKey, useTrading, useTradingArtifacts, useTradingPresets, useTradingSource } from "./api";

type Property = { type?: string; default?: unknown; minimum?: number; maximum?: number; exclusiveMinimum?: number; exclusiveMaximum?: number; description?: string };
function properties(artifact: TradingArtifact | undefined): Record<string, Property> {
  const value = artifact?.parameterSchema.properties;
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, Property> : {};
}
function defaults(artifact: TradingArtifact): Record<string, unknown> {
  return Object.fromEntries(Object.entries(properties(artifact)).filter(([, p]) => p.default !== undefined).map(([key, p]) => [key, p.default]));
}
function parameterError(artifact: TradingArtifact | undefined, params: Record<string, unknown>): string | null {
  if (!artifact) return "고정된 전략 버전을 찾을 수 없습니다.";
  const schema = properties(artifact);
  const required = Array.isArray(artifact.parameterSchema.required) ? artifact.parameterSchema.required : [];
  for (const [key, spec] of Object.entries(schema)) {
    const value = params[key];
    if (value === undefined && !required.includes(key)) continue;
    if (spec.type === "boolean") { if (typeof value !== "boolean") return `${key}: 참 또는 거짓을 선택하세요.`; }
    else if (spec.type === "number" || spec.type === "integer") {
      if (typeof value !== "number" || !Number.isFinite(value) || (spec.type === "integer" && !Number.isInteger(value)) || (spec.minimum !== undefined && value < spec.minimum) || (spec.maximum !== undefined && value > spec.maximum) || (spec.exclusiveMinimum !== undefined && value <= spec.exclusiveMinimum) || (spec.exclusiveMaximum !== undefined && value >= spec.exclusiveMaximum)) return `${key}: 허용 범위의 숫자를 입력하세요.`;
    } else return `${key}: 지원하지 않는 파라미터 형식입니다.`;
  }
  return null;
}
const baseSetup = (artifact: TradingArtifact): TradingSetup => {
  const parameters = defaults(artifact);
  const topN = parameters.topN;
  const maxPositions = typeof topN === "number" && Number.isInteger(topN) && topN > 0 && topN <= 200 ? topN : 10;
  return { strategyId: artifact.strategyId, artifactHash: artifact.artifactHash, parameters, universeRule: { markets: [...DEFAULT_UNIVERSE_MARKETS], stages: [{ criterion: "MARKET_CAP", direction: "HIGH", limit: Math.max(100, maxPositions) }], rebalanceInterval: { unit: "MONTH", value: 1 } }, timeframe: "1d", budgetKrw: 10000000, maxPositions, maxPositionPercent: 100 / maxPositions, dailyLossLimitPercent: 3, maxOrderKrw: 1000000, maxSlippageBps: 50, randomSeed: 42, sourceJobId: null };
};
const money = (v: number | null | undefined) => v == null ? "—" : `${v.toLocaleString()}원`;
const date = (v: number | null) => v === null ? "—" : new Date(v).toLocaleString();
const numericFields = [["budgetKrw", "운용 예산 (원)"], ["maxPositions", "최대 보유 종목"], ["maxPositionPercent", "종목당 최대 비중 (%)"], ["dailyLossLimitPercent", "일일 손실 한도 (%)"], ["maxOrderKrw", "최대 주문 금액 (원, 1억원 미만)"], ["maxSlippageBps", "최대 슬리피지 (bps)"], ["randomSeed", "난수 시드"]] as const;

function ParameterFields({ artifact, value, onChange, disabled = false }: { artifact: TradingArtifact | undefined; value: Record<string, unknown>; onChange: (v: Record<string, unknown>) => void; disabled?: boolean }) {
  return <div className="grid gap-3 sm:grid-cols-2">{Object.entries(properties(artifact)).map(([key, spec]) => <div className="space-y-1" key={key}><Label htmlFor={`param-${key}`}>{key}</Label>{spec.type === "boolean" ? <div><Checkbox disabled={disabled} id={`param-${key}`} checked={value[key] === true} onCheckedChange={(checked) => onChange({ ...value, [key]: checked === true })} /></div> : <Input disabled={disabled} id={`param-${key}`} type="number" step={spec.type === "integer" ? 1 : "any"} value={typeof value[key] === "number" && Number.isFinite(value[key]) ? String(value[key]) : ""} onChange={(e) => onChange({ ...value, [key]: e.target.value === "" ? undefined : Number(e.target.value) })} />}{spec.description ? <p className="text-xs text-muted-foreground">{spec.description}</p> : null}</div>)}</div>;
}

function MinuteSettings({ request, version }: { request: IntradayRequest; version: string }) {
  return <>
    <p>{getIntradayStrategy(request.strategyId).name} · {version} · {request.symbol} · {request.timeframe}</p>
    <p>원본 기간 {request.period.from} ~ {request.period.to} · 초기 자금 {money(request.initialCash)}</p>
    <p>모의 체결에는 확정된 1분 OHLCV가 사용됩니다.</p>
    <div><p className="font-medium">고정 전략 파라미터</p><dl className="space-y-1">{Object.entries(request.parameters).map(([key, value]) => <div key={key} className="flex gap-2"><dt>{[...INTRADAY_TRADE_CONTROL_FIELDS, ...getIntradayStrategy(request.strategyId).fields].find((field) => field.key === key)?.label ?? ({ allocationPct: "매수 비중 (%)", stopLossPct: "손절 기준 (%)", takeProfitPct: "익절 기준 (%)" } as Record<string, string>)[key] ?? key}</dt><dd>{String(value)}</dd></div>)}</dl></div>
    <div><p className="font-medium">고정 체결 조건</p><p>당일 청산 시도 · 수수료 {request.execution.commissionBps}bps · 세금 {request.execution.taxBps}bps · 슬리피지 {request.execution.slippageBps}bps · 지연 {request.execution.latencyMs}ms · 주문 만료 {request.execution.orderExpiryMinutes}분 · 최대 참여율 {request.execution.maxParticipationPct}%</p></div>
  </>;
}

export function TradingPage() {
  const [search, setSearch] = useSearchParams();
  const sourceId = search.get("sourceJobId");
  const presetId = search.get("presetId");
  const sourceRunId = search.get("sourceRunId");
  return <TradingSession key={JSON.stringify([sourceId, sourceRunId, presetId])} sourceId={sourceId} sourceRunId={sourceRunId} presetId={presetId} selectPreset={(id) => setSearch(id === null ? {} : { presetId: id })} />;
}

function TradingSession({ sourceId, sourceRunId, presetId, selectPreset }: { sourceId: string | null; sourceRunId: string | null; presetId: string | null; selectPreset: (id: string | null) => void }) {
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const snapshot = useTrading(presetId);
  const presets = useTradingPresets();
  const artifacts = useTradingArtifacts();
  const source = useTradingSource(sourceId);
  const minuteSource = useQuery({ queryKey: ["intraday-run", sourceRunId], queryFn: () => api<IntradayRun>(`/intraday/runs/${encodeURIComponent(sourceRunId!)}`), enabled: sourceRunId !== null });
  const minuteRequest = minuteSource.data?.status === "COMPLETED" && minuteSource.data.result ? minuteSource.data.result.request : null;
  const client = useQueryClient();
  const createRequestId = useRef<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState("");
  const [submittedMinuteTitle, setSubmittedMinuteTitle] = useState<string | null>(null);
  const [draft, setDraft] = useState<TradingSetup | null>(null);
  const [initialCashKrw, setInitialCashKrw] = useState(PAPER_TRADING_INITIAL_CASH_KRW);
  const [initialized, setInitialized] = useState<string | null>(null);
  const [draftRevision, setDraftRevision] = useState<number | null>(null);
  const [dialogRevision, setDialogRevision] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<"remove" | "version" | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [toggleMode, setToggleMode] = useState<"on" | "off" | null>(null);
  const [holding, setHolding] = useState<{ symbol: string; name: string } | null>(null);
  const [versionParams, setVersionParams] = useState<Record<string, unknown>>({});
  const data = snapshot.data;
  const deployment = data?.deployment;
  const dailyDeployment = deployment?.timeframe === "1d" ? deployment : null;
  const minuteDeployment = deployment && deployment.timeframe !== "1d" ? deployment : null;
  const list = artifacts.data?.strategies ?? [];
  const artifact = list.find((a) => a.strategyId === draft?.strategyId && a.artifactHash === draft.artifactHash);
  const latest = list.find((a) => a.strategyId === deployment?.strategyId && a.latest);
  const inactive = !deployment || deployment.status === "INACTIVE";
  const preparation = data?.dataPreparation;
  const preparing = preparation?.status === "RUNNING";
  const contextKey = deployment ? `deployment:${deployment.id}` : sourceId ? `source:${sourceId}` : "new";
  const contextChanged = initialized !== null && initialized !== contextKey;
  const openSettings = () => {
    if (sourceRunId && !deployment) { openNew(); return; }
    if (!data || (!artifacts.data && !minuteDeployment)) return;
    setCreating(false);
    setTitle(deployment?.title ?? "");
    if (dailyDeployment) {
      const parsed = tradingSetupSchema.safeParse(Object.fromEntries(Object.keys(tradingSetupSchema.shape).map((k) => [k, dailyDeployment[k as keyof typeof dailyDeployment]])));
      setDraft(parsed.success ? parsed.data : null);
    } else if (minuteDeployment) setDraft(null);
    else if (sourceId) setDraft(source.data?.setup ?? null);
    else { const first = list.find((a) => a.latest); setDraft(first ? baseSetup(first) : null); }
    setInitialCashKrw(data.paperCapital?.initialCashKrw ?? PAPER_TRADING_INITIAL_CASH_KRW);
    setDraftRevision(data.revision);
    setInitialized(contextKey);
    setError(null);
    setSettingsOpen(true);
  };
  const openNew = () => {
    if (!data || (!sourceRunId && !artifacts.data) || (sourceId && !source.data?.setup) || (sourceRunId && !minuteRequest)) return;
    const first = list.find((a) => a.latest);
    const stored = sourceRunId ? sessionStorage.getItem(`intraday-paper-request:${sourceRunId}`) : null;
    let restoredTitle: string | null = stored && !stored.startsWith("{") ? "" : null;
    let restoredId = stored;
    if (stored?.startsWith("{")) {
      try {
        const saved: unknown = JSON.parse(stored);
        if (saved && typeof saved === "object" && "requestId" in saved && typeof saved.requestId === "string" && "title" in saved && typeof saved.title === "string") {
          restoredId = saved.requestId;
          restoredTitle = saved.title;
        } else restoredId = null;
      } catch { restoredId = null; }
    }
    createRequestId.current = restoredId ?? crypto.randomUUID();
    setSubmittedMinuteTitle(restoredTitle);
    setCreating(true); setTitle(restoredTitle ?? ""); setDraft(sourceRunId ? null : sourceId && source.data?.setup ? source.data.setup : first ? baseSetup(first) : null);
    setInitialCashKrw(PAPER_TRADING_INITIAL_CASH_KRW); setDraftRevision(0); setInitialized(contextKey); setError(null); setSettingsOpen(true);
  };
  const write = useMutation({ mutationFn: async ({ path, method, body, create }: { path: string; method: string; body: unknown; create?: boolean }) => create ? api<{ id: string; snapshot: TradingSnapshot }>(path, { method, body: JSON.stringify(body) }) : api<TradingSnapshot>(tradingPath(path, presetId), { method, body: JSON.stringify(body) }), onSuccess: async (result, variables) => {
    if (variables.create) {
      const created = result as { id: string; snapshot: TradingSnapshot };
      client.setQueryData(tradingKey(created.id), created.snapshot);
      void client.invalidateQueries({ queryKey: tradingPresetsKey });
      void client.invalidateQueries({ queryKey: tradingKey(null), exact: true });
      if (sourceRunId) sessionStorage.removeItem(`intraday-paper-request:${sourceRunId}`);
      if (mounted.current) selectPreset(created.id);
      return;
    }
    await client.cancelQueries({ queryKey: tradingKey(presetId), exact: true });
    client.setQueryData(tradingKey(presetId), result as TradingSnapshot);
    void client.invalidateQueries({ queryKey: tradingPresetsKey });
    void client.invalidateQueries({ queryKey: tradingKey(null), exact: true });
    const nextId = (result as TradingSnapshot).deployment?.id;
    if (variables.path === "/trading/strategy" && variables.method === "POST" && presetId !== null && nextId && nextId !== presetId) {
      client.setQueryData(tradingKey(nextId), result as TradingSnapshot);
      if (mounted.current) selectPreset(nextId);
      return;
    }
    if (["/trading/strategy", "/trading/version"].includes(variables.path)) setInitialized(null);
    setError(null); setDialog(null); setToggleMode(null); if (variables.path === "/trading/strategy" || variables.path === "/trading/title") setSettingsOpen(false);
  }, onError: (e) => { setError(e instanceof Error ? e.message : "요청에 실패했습니다."); if (e instanceof ApiError && e.status === 409) { setError(`${e.message} 최신 상태를 다시 불러왔습니다. 내용을 확인한 뒤 다시 시도하세요.`); void client.invalidateQueries({ queryKey: tradingKey(presetId) }); } } });
  const submit = (path: string, method: string, body: object, create = false) => { if (!data || write.isPending) return; write.mutate({ path, method, body, create }); };
  const validation = draft ? tradingSetupSchema.safeParse(draft) : null;
  const paramError = draft ? parameterError(artifact, draft.parameters) : null;
  const save = () => {
    if (creating && sourceRunId) {
      if (!minuteRequest || !data || contextChanged || write.isPending || !createRequestId.current) return;
      const savedTitle = submittedMinuteTitle ?? title.trim();
      sessionStorage.setItem(`intraday-paper-request:${sourceRunId}`, JSON.stringify({ requestId: createRequestId.current, title: savedTitle }));
      setSubmittedMinuteTitle(savedTitle);
      submit("/trading/intraday-presets", "POST", { sourceRunId, requestId: createRequestId.current, ...(savedTitle ? { title: savedTitle } : {}) }, true);
      return;
    }
    if (!draft || !data || contextChanged || (!creating && !inactive)) return;
    const canEditCapital = creating || data.paperCapital?.canEdit;
    const capitalValidation = canEditCapital ? paperInitialCashSchema.safeParse(initialCashKrw) : null;
    if (!validation?.success || paramError || (capitalValidation && !capitalValidation.success)) {
      setError((capitalValidation && !capitalValidation.success ? "초기 모의자금은 10,000원 이상 1조원 이하의 정수로 입력하세요." : null)
        ?? paramError ?? validation?.error?.issues.map(i => `${i.path.join(".")}: ${i.message}`).join(", ") ?? "설정을 확인하세요.");
      return;
    }
    const body = {
      ...validation.data, title: title.trim() || undefined,
      ...(canEditCapital ? { initialCashKrw } : {}),
      ...(creating ? { requestId: createRequestId.current } : {}),
      expectedRevision: creating ? 0 : draftRevision ?? data.revision,
    };
    submit(creating ? "/trading/presets" : "/trading/strategy", creating || !deployment ? "POST" : "PUT", body, creating);
  };
  const setField = <K extends keyof TradingSetup>(key: K, value: TradingSetup[K]) => setDraft((old) => old ? { ...old, [key]: value } : old);
  const defaultPresetId = presets.data?.defaultAccountPresetId;
  const accountSelector = <div className="flex flex-wrap items-center gap-2"><Label htmlFor="trading-preset">모의투자 선택</Label><select id="trading-preset" className="max-w-full rounded-md border bg-background px-3 py-2 text-sm" value={presetId ?? defaultPresetId ?? ""} disabled={write.isPending} onChange={(event) => selectPreset(event.target.value || null)}>{!defaultPresetId ? <option value="">기본 계좌</option> : null}{presets.data?.presets.map((preset) => <option key={preset.id} value={preset.id}>{preset.title}</option>)}{presets.data?.archived?.map((preset) => <option key={preset.id} value={preset.id}>{preset.title} (전략 제거됨)</option>)}</select><Button variant="outline" disabled={!data || write.isPending || (!sourceRunId && !artifacts.data) || (!!sourceId && !source.data?.setup) || (!!sourceRunId && !minuteRequest)} onClick={openNew}>새 모의투자</Button></div>;
  if (!data) return <div className="space-y-3"><h2 className="text-lg font-semibold">매매</h2>{accountSelector}<p role={snapshot.error ? "alert" : "status"}>{snapshot.error ? "매매 정보를 불러오지 못했습니다." : "불러오는 중…"}</p></div>;
  return <div className="space-y-4"><h2 className="text-lg font-semibold">매매</h2>
    {accountSelector}
    {snapshot.error ? <Alert variant="destructive"><AlertDescription>최신 상태를 불러오지 못했습니다.</AlertDescription></Alert> : null}
    <Card><CardHeader><CardTitle>모의 투자 현황</CardTitle>{data.broker.selectedAccountId && <CardDescription>모의계좌 · {data.broker.selectedAccountId}{minuteDeployment?.lastDecisionAtMs ? ` · 평가 기준 ${date(minuteDeployment.lastDecisionAtMs)} 확정 봉 종가` : ""}</CardDescription>}</CardHeader><CardContent className="space-y-2 text-sm"><p>초기 모의 자금 {money(data.paperCapital?.initialCashKrw)} · {minuteDeployment ? "확정된 1분 OHLCV로 모의 체결하며 수수료와 세금이 적용됩니다." : "최신 시세로 모의 체결하며 수수료와 세금이 적용됩니다."}</p><p>주문 가능 {money(data.account?.cashBuyingPower)} · 보유 평가액 {money(data.account?.marketValue)} · 평가손익 {money(data.account?.unrealizedPnl)} · 총 손익 {money(data.performance?.totalPnl)} · 추정 수익률 {data.performance?.returnPercent == null ? "—" : `${data.performance.returnPercent.toFixed(2)}%`}</p></CardContent></Card>
    <Card><CardHeader><CardTitle>전략 상태</CardTitle><CardDescription>{deployment ? `${deployment.name} · ${deployment.version} · ${tradingStatusLabel[deployment.status]}${preparation ? "" : ` · ${deployment.activity}`}` : "등록된 전략이 없습니다."}</CardDescription></CardHeader><CardContent className="space-y-3">{preparation ? <Alert variant={preparation.status === "FAILED" ? "destructive" : "default"} role={preparation.status === "FAILED" ? "alert" : "status"}><AlertDescription className="flex min-w-0 items-start gap-2">{preparing ? <LoaderCircle aria-hidden="true" className="mt-0.5 size-4 shrink-0 animate-spin" /> : null}<span className="min-w-0 break-words"><strong>{preparing ? "데이터 준비 중" : preparation.status === "READY" ? "데이터 준비 완료" : "데이터 준비 실패"}</strong> · {preparation.message}{preparation.status === "READY" ? " 자동 매매를 켜려면 직접 ON을 선택하세요." : null}</span></AlertDescription></Alert> : null}{deployment?.lastError && deployment.lastError !== preparation?.message ? <p role="alert" className="break-words text-destructive">{deployment.lastError}</p> : null}{error && !settingsOpen && !dialog && !toggleMode ? <Alert variant="destructive" role="alert"><AlertDescription className="break-words">{error}</AlertDescription></Alert> : null}{data.blockers.map((b) => <p key={b} className="text-sm text-destructive">{b}</p>)}<div className="flex flex-wrap gap-2"><Button variant="outline" disabled={(!artifacts.data && !minuteDeployment && !(sourceRunId && !deployment && minuteRequest)) || (!!sourceId && !deployment && !source.data?.setup) || (!!sourceRunId && !deployment && !minuteRequest)} onClick={openSettings}>{deployment && <LockKeyhole aria-hidden="true" />}매매 설정</Button>{deployment ? <><Button aria-pressed={deployment.status === "ACTIVE"} className={deployment.status === "ACTIVE" ? "bg-emerald-100 text-emerald-900 hover:bg-emerald-200 dark:bg-emerald-950 dark:text-emerald-100 dark:hover:bg-emerald-900" : "bg-amber-100 text-amber-900 hover:bg-amber-200 dark:bg-amber-950 dark:text-amber-100 dark:hover:bg-amber-900"} disabled={write.isPending || deployment.status === "STOPPING" || (inactive && preparing)} onClick={() => { setError(null); setDialogRevision(data.revision); setToggleMode(inactive ? "on" : "off"); }}>{deployment.status === "ACTIVE" ? "자동 매매 ON" : "자동 매매 OFF"}</Button>{inactive && dailyDeployment ? <Button variant="outline" disabled={write.isPending || preparing} onClick={() => { setError(null); submit("/trading/prepare", "POST", { expectedRevision: data.revision }); }}>{preparing ? "데이터 준비 중" : preparation?.status === "FAILED" ? "데이터 복구 재시도" : "데이터 확인·복구"}</Button> : null}{dailyDeployment ? <Button variant="outline" disabled={!inactive || write.isPending || !latest || latest.artifactHash === dailyDeployment.artifactHash} onClick={() => { if (latest) setVersionParams({ ...defaults(latest), ...Object.fromEntries(Object.entries(dailyDeployment.parameters).filter(([key]) => key in properties(latest))) }); setError(null); setDialogRevision(data.revision); setDialog("version"); }}>최신 버전으로 변경</Button> : null}<Button variant="outline" disabled={(!creating && !inactive) || write.isPending} onClick={() => { setError(null); setDialogRevision(data.revision); setDialog("remove"); }}>전략 제거</Button></> : null}</div><p className="text-sm text-muted-foreground">{!inactive ? "설정 수정, 버전 변경 및 제거는 자동 매매를 끈 후 가능합니다." : "자동 매매가 꺼져 있으면 매수, 매도 및 손절이 실행되지 않습니다."}</p></CardContent></Card>
    {sourceId && source.isLoading ? <p>백테스트 설정을 불러오는 중…</p> : null}{sourceId && !source.isLoading && (source.error || !source.data?.setup) ? <Alert variant="destructive"><AlertDescription>{source.data?.error ?? "백테스트 설정을 불러오지 못했습니다."}</AlertDescription></Alert> : null}
    {sourceRunId && minuteSource.isLoading ? <p>백테스트 설정을 불러오는 중…</p> : null}{sourceRunId && !minuteSource.isLoading && !minuteRequest ? <Alert variant="destructive"><AlertDescription>완료된 분봉 백테스트 설정을 불러오지 못했습니다.</AlertDescription></Alert> : null}
    {artifacts.error ? <Alert variant="destructive"><AlertDescription>전략 버전 목록을 불러오지 못했습니다.</AlertDescription></Alert> : null}
    <Dialog open={settingsOpen} onOpenChange={(open) => { setSettingsOpen(open); if (!open) setCreating(false); }}>
      <DialogContent className="flex max-h-[calc(100dvh-2rem)] min-w-0 flex-col overflow-hidden sm:max-w-3xl">
        <DialogHeader className="shrink-0 pr-8">
          <DialogTitle>매매 설정</DialogTitle>
        </DialogHeader>
        <div className="min-h-0 min-w-0 space-y-4 overflow-y-auto overscroll-contain">
          <DialogDescription>{(minuteDeployment && !creating) || (creating && minuteRequest) ? "백테스트의 고정 설정을 그대로 사용합니다. 설정은 읽기 전용이며 저장과 활성화는 별도 단계입니다." : <>일봉 전략은 거래일 09:00~09:10(KST)에 전일 확정 봉으로 판단합니다. 실행창을 놓친 신호를 장중에 소급 주문하지 않습니다. 저장과 활성화는 별도 단계입니다. 손실 한도는 주문 중지 기준이며 보유 종목을 자동 청산하지 않습니다.</>}</DialogDescription>
          {error || contextChanged ? <Alert variant="destructive" role="alert"><AlertDescription>{error ?? "등록된 전략이 다른 화면에서 변경되었습니다. 작성 중인 입력은 유지했습니다. 최신 설정을 불러온 뒤 저장해 주세요."} {!creating ? <Button variant="outline" size="sm" disabled={snapshot.isFetching || snapshot.isError} onClick={openSettings}>최신 설정 불러오기</Button> : null}</AlertDescription></Alert> : null}
          {creating && sourceRunId ? minuteRequest ? <div className="space-y-3 text-sm">
            <div className="space-y-1"><Label htmlFor="minute-new-title">모의투자 이름 (선택)</Label><Input id="minute-new-title" maxLength={100} value={title} disabled={write.isPending || submittedMinuteTitle !== null} onChange={(e) => setTitle(e.target.value)} />{submittedMinuteTitle !== null ? <p>재시도에는 처음 제출한 이름을 사용합니다.</p> : null}</div>
            <MinuteSettings request={minuteRequest} version={minuteSource.data!.result!.strategyVersion} />
            <p>모의투자에는 현재 분봉 체결 엔진이 사용됩니다.</p>
            <Button disabled={write.isPending || contextChanged} onClick={save}>설정 저장</Button>
          </div> : <p role="alert">분봉 백테스트 설정을 불러올 수 없습니다.</p> : minuteDeployment && !creating ? <div className="space-y-3 text-sm">
            <div className="space-y-1"><Label htmlFor="minute-title">모의투자 이름 (선택)</Label><Input id="minute-title" maxLength={100} value={title} disabled={write.isPending} onChange={(e) => setTitle(e.target.value)} /><Button variant="outline" size="sm" disabled={write.isPending || contextChanged || title.trim() === (minuteDeployment.title ?? "")} onClick={() => submit("/trading/title", "PATCH", { deploymentId: minuteDeployment.id, expectedRevision: draftRevision, expectedTitle: minuteDeployment.title ?? "", title: title.trim() })}>이름 저장</Button></div>
            <MinuteSettings request={minuteDeployment.request} version={minuteDeployment.version} />
            <p>원본 백테스트 {minuteDeployment.sourceRunId}</p>
          </div> : draft ? <div className="space-y-4">
            <div className="space-y-1">
              <Label htmlFor="preset-title">모의투자 이름 (선택)</Label>
              <Input id="preset-title" value={title} maxLength={100} disabled={write.isPending}
                placeholder={artifact?.name ?? "전략 이름"} onChange={(e) => setTitle(e.target.value)} />
              {!creating && !inactive && deployment && <Button variant="outline" size="sm"
                disabled={write.isPending || contextChanged || title.trim() === (draft.title ?? "")}
                onClick={() => submit("/trading/title", "PATCH", { deploymentId: deployment.id, expectedRevision: draftRevision,
                  expectedTitle: draft.title ?? "", title: title.trim() })}>이름 저장</Button>}
            </div>
            <fieldset disabled={(!creating && !inactive) || write.isPending} className="min-w-0 space-y-4"><div className="space-y-1"><Label>전략 및 고정 버전</Label>{(!creating && deployment) || sourceId ? <p className="break-all text-sm">{artifact ? `${artifact.name} · ${artifact.version}` : `${draft.strategyId} · ${draft.artifactHash}`} </p> : <Select disabled={(!creating && !inactive) || write.isPending} value={`${draft.strategyId}:${draft.artifactHash}`} onValueChange={(key) => { const selected = list.find((a) => `${a.strategyId}:${a.artifactHash}` === key); if (selected) setDraft(baseSetup(selected)); }}><SelectTrigger><SelectValue placeholder="전략 선택" /></SelectTrigger><SelectContent>{list.filter((a) => a.latest).map((a) => <SelectItem key={`${a.strategyId}:${a.artifactHash}`} value={`${a.strategyId}:${a.artifactHash}`}>{a.name} · {a.version}</SelectItem>)}</SelectContent></Select>}{!artifact ? <p role="alert" className="text-sm text-destructive">원본의 정확한 전략 버전을 찾을 수 없습니다. 다른 버전으로 대체하지 않습니다.</p> : null}</div><ParameterFields disabled={(!creating && !inactive) || write.isPending} artifact={artifact} value={draft.parameters} onChange={(v) => setField("parameters", v)} /><div className="space-y-2"><Label htmlFor="trading-universe-market">유니버스 시장</Label><UniverseMarketSelect id="trading-universe-market" disabled={(!creating && !inactive) || write.isPending} value={draft.universeRule.markets} onChange={(markets) => setField("universeRule", { ...draft.universeRule, markets })} /><div className="max-w-full overflow-x-auto">{(creating || inactive) && !write.isPending ? <UniverseStageEditor stages={draft.universeRule.stages} onChange={(stages) => setField("universeRule", { ...draft.universeRule, stages })} /> : <p className="break-words text-sm">{formatUniverseRuleSummary(draft.universeRule)}</p>}</div><Label>리밸런스 주기</Label><div className="flex gap-2"><Input className="min-w-0" type="number" min={1} value={draft.universeRule.rebalanceInterval.value} disabled={["NONE", "YEAR"].includes(draft.universeRule.rebalanceInterval.unit)} onChange={(e) => setField("universeRule", { ...draft.universeRule, rebalanceInterval: { ...draft.universeRule.rebalanceInterval, value: Number(e.target.value) } as RebalanceInterval })} /><Select disabled={(!creating && !inactive) || write.isPending} value={draft.universeRule.rebalanceInterval.unit} onValueChange={(unit) => setField("universeRule", { ...draft.universeRule, rebalanceInterval: { unit, value: 1 } as RebalanceInterval })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{[["NONE", "안 함"], ["DAY", "일"], ["WEEK", "주"], ["MONTH", "개월"], ["YEAR", "년"]].map(([v, label]) => <SelectItem key={v} value={v!}>{label}</SelectItem>)}</SelectContent></Select></div></div><div className="space-y-1"><Label htmlFor="initialCashKrw">초기 모의자금 (원)</Label><Input id="initialCashKrw" type="number" min={10000} max={1000000000000} step={1} disabled={(!creating && !inactive) || write.isPending || (!creating && !data.paperCapital?.canEdit)} value={Number.isFinite(initialCashKrw) ? initialCashKrw : ""} onChange={(e) => setInitialCashKrw(e.target.value === "" ? NaN : Number(e.target.value))} /><p className="text-xs text-muted-foreground">초기 모의자금은 모의 투자 전체의 시작 자금이며, 운용 예산은 전략의 별도 사용 한도입니다. {!creating && !inactive ? "자동매매 OFF 상태에서 변경할 수 있습니다." : !creating && data.paperCapital && !data.paperCapital.canEdit ? "진행 중인 주문이 있거나 첫 체결 이후에는 초기 모의자금을 변경할 수 없습니다." : null}</p></div><div className="grid gap-3 sm:grid-cols-2">{numericFields.map(([key, label]) => <div className="space-y-1" key={key}><Label htmlFor={key}>{label}</Label><Input id={key} type="number" step="any" value={Number.isFinite(draft[key]) ? draft[key] : ""} onChange={(e) => setField(key, e.target.value === "" ? NaN : Number(e.target.value))} /></div>)}</div><Button type="button" disabled={(!creating && !inactive) || !artifact || write.isPending || contextChanged} onClick={save}>설정 저장</Button></fieldset></div> : <p>설정을 불러올 수 없습니다.</p>}
        </div>
      </DialogContent>
    </Dialog>
    <Card><CardHeader><CardTitle>보유 종목</CardTitle><CardDescription>전략에 속하지 않은 보유 종목은 수동 관리합니다. 전략에 자동 편입되지 않습니다.</CardDescription></CardHeader><CardContent><div className="overflow-x-auto"><Table><TableHeader><TableRow>{["종목", "관리", "수량", "현재가", "평가액", "평가손익"].map((x) => <TableHead key={x}>{x}</TableHead>)}</TableRow></TableHeader><TableBody>{data.positions.map((p) => <TableRow key={p.symbol}><TableCell><Button variant="link" className="h-auto p-0" onClick={() => setHolding({ symbol: p.symbol, name: p.name })}>{p.name} ({p.symbol})</Button></TableCell><TableCell>{p.deploymentId ? "전략" : "수동"}</TableCell><TableCell>{p.quantity}</TableCell><TableCell>{money(p.price)}</TableCell><TableCell>{money(p.marketValue)}</TableCell><TableCell>{money(p.unrealizedPnl)}</TableCell></TableRow>)}</TableBody></Table></div>{data.positions.length === 0 ? <p className="text-sm text-muted-foreground">표시할 보유 종목이 없습니다.</p> : null}</CardContent></Card>
    <Card><CardHeader><CardTitle>주문 내역</CardTitle></CardHeader><CardContent><div className="overflow-x-auto"><Table><TableHeader><TableRow>{["시간", "종목", "방향", "수량 / 체결", minuteDeployment ? "신호가 / 평균 체결가" : "주문가 / 평균 체결가", "상태", "사유"].map((x) => <TableHead key={x}>{x}</TableHead>)}</TableRow></TableHeader><TableBody>{data.orders.map((o) => <TableRow key={o.id}><TableCell>{date(o.createdAtMs)}</TableCell><TableCell>{o.symbol}</TableCell><TableCell>{o.side === "BUY" ? "매수" : "매도"}</TableCell><TableCell>{o.quantity} / {o.filledQuantity}</TableCell><TableCell>{money(o.price)} / {o.averageFillPrice == null ? "—" : money(o.averageFillPrice)}</TableCell><TableCell>{orderStatusLabel[o.status]}</TableCell><TableCell>{o.reason}{o.error ? ` · ${o.error}` : ""}</TableCell></TableRow>)}</TableBody></Table></div>{data.orders.length === 0 ? <p className="text-sm text-muted-foreground">주문 내역이 없습니다.</p> : null}</CardContent></Card>
    <Card><CardHeader><CardTitle>이벤트</CardTitle></CardHeader><CardContent className="space-y-2 text-sm">{data.events.length ? data.events.map((e) => <p key={e.id}>{date(e.createdAtMs)} · {e.severity} · {e.message}</p>) : <p className="text-muted-foreground">이벤트가 없습니다.</p>}</CardContent></Card>
    <HoldingPriceDialog holding={holding} onClose={() => setHolding(null)} />
    <AlertDialog open={toggleMode !== null} onOpenChange={(open) => { if (!open) setToggleMode(null); }}><AlertDialogContent className={toggleMode === "on" ? "bg-emerald-50 dark:bg-emerald-950" : "bg-amber-50 dark:bg-amber-950"}><AlertDialogTitle className="text-lg font-semibold">{toggleMode === "on" ? "자동 매매를 켤까요?" : "자동 매매를 끌까요?"}</AlertDialogTitle><AlertDialogDescription className="text-sm text-muted-foreground">{toggleMode === "on" ? "저장된 설정으로 모의 자동 매매를 시작합니다." : deployment?.status === "ERROR" ? "오류 상태를 정리하고 자동 매매를 완전히 끕니다. 보유 종목은 자동으로 매도하지 않습니다." : "자동 매매를 중지합니다. 보유 종목은 자동으로 매도하지 않습니다."}</AlertDialogDescription>{error && <p role="alert" className="text-sm text-destructive">{error}</p>}<div className="flex justify-end gap-2"><AlertDialogCancel asChild><Button variant="outline">취소</Button></AlertDialogCancel><Button disabled={write.isPending || (toggleMode === "on") !== inactive || (toggleMode === "on" && (data.blockers.length > 0 || preparing))} onClick={() => submit(toggleMode === "on" ? "/trading/activate" : "/trading/deactivate", "POST", { expectedRevision: dialogRevision ?? data.revision, acknowledged: true })}>{toggleMode === "on" ? "켜기" : "끄기"}</Button></div></AlertDialogContent></AlertDialog>
    <Dialog open={dialog !== null} onOpenChange={(open) => { if (!open) setDialog(null); }}><DialogContent><DialogHeader><DialogTitle>{dialog === "remove" ? "전략 제거" : "최신 버전으로 변경"}</DialogTitle><DialogDescription>{dialog === "remove" ? "전략을 제거해도 보유 종목을 매도하지 않으며, 보유 종목과 주문 및 이벤트 내역은 유지됩니다." : "자동 매매가 꺼진 상태에서만 변경됩니다."}</DialogDescription></DialogHeader>{dialog === "version" && deployment && latest ? <div className="space-y-3"><p className="text-sm">{deployment.version} → {latest.version}</p><ParameterFields disabled={!inactive} artifact={latest} value={versionParams} onChange={setVersionParams} />{parameterError(latest, versionParams) ? <p className="text-sm text-destructive">{parameterError(latest, versionParams)}</p> : null}</div> : null}{error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}<DialogFooter><Button variant="outline" onClick={() => setDialog(null)}>취소</Button>{dialog === "remove" ? <Button variant="destructive" disabled={!inactive || write.isPending} onClick={() => submit("/trading/strategy", "DELETE", { expectedRevision: dialogRevision ?? data.revision })}>제거</Button> : <Button disabled={!inactive || !latest || !!parameterError(latest, versionParams) || write.isPending} onClick={() => latest && submit("/trading/version", "POST", { expectedRevision: dialogRevision ?? data.revision, artifactHash: latest.artifactHash, parameters: versionParams })}>버전 변경</Button>}</DialogFooter></DialogContent></Dialog>
  </div>;
}
