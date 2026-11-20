import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { LoaderCircle, LockKeyhole } from "lucide-react";
import { HoldingPriceDialog } from "./holding-price-dialog";
import { Link, useLocation, useSearchParams } from "react-router";
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
  if (!artifact) return "선택한 전략 버전을 찾을 수 없습니다.";
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

function SettingsList({ title, rows }: { title: string; rows: [string, string][] }) {
  return <section className="min-w-0 space-y-3">
    <h3 className="font-semibold">{title}</h3>
    <dl className="divide-y">
      {rows.map(([label, value]) => <div key={label} className="flex justify-between gap-4 py-2">
        <dt className="min-w-0 break-words text-muted-foreground">{label}</dt>{" "}
        <dd className="text-right font-medium tabular-nums">{value}</dd>
      </div>)}
    </dl>
  </section>;
}

function MinuteSettings({ request, version }: { request: IntradayRequest; version: string }) {
  const strategy = getIntradayStrategy(request.strategyId);
  const fields = [...strategy.fields, ...INTRADAY_TRADE_CONTROL_FIELDS];
  const riskLabels: Record<string, string> = { allocationPct: "매수 비중 (%)", stopLossPct: "손절 기준 (%)", takeProfitPct: "익절 기준 (%)" };
  const parameters: [string, string][] = Object.entries(request.parameters).map(([key, value]) => [
    fields.find((field) => field.key === key)?.label ?? riskLabels[key] ?? key, String(value),
  ]);
  const execution = request.execution;
  return <>
    <dl className="grid grid-cols-2 gap-x-5 gap-y-3 rounded-lg bg-muted/50 p-4 lg:grid-cols-4">
      {[
        ["전략 및 버전", strategy.name + " · " + version],
        ["종목 · 분봉 주기", request.symbol + " · " + request.timeframe],
        ["원본 기간", request.period.from + " ~ " + request.period.to],
        ["초기 모의자금", money(request.initialCash)],
      ].map(([label, value]) => <div key={label} className="min-w-0 space-y-1">
        <dt className="text-xs text-muted-foreground">{label}</dt>
        <dd className="break-words font-medium tabular-nums">{value}</dd>
      </div>)}
    </dl>
    <div className="grid gap-6 lg:grid-cols-2 lg:gap-8">
      <SettingsList title="고정 전략 파라미터" rows={parameters} />
      <SettingsList title="고정 체결 조건" rows={[
        ["보유 정책", "당일 청산 시도"], ["수수료", execution.commissionBps + "bps"], ["세금", execution.taxBps + "bps"],
        ["슬리피지", execution.slippageBps + "bps"], ["지연", execution.latencyMs + "ms"],
        ["주문 만료", execution.orderExpiryMinutes + "분"], ["최대 참여율", execution.maxParticipationPct + "%"],
      ]} />
    </div>
  </>;
}

export function TradingPage() {
  const [search, setSearch] = useSearchParams();
  const sourceId = search.get("sourceJobId");
  const presetId = search.get("presetId");
  const sourceRunId = search.get("sourceRunId");
  // 결과 버튼에서 만든 브라우저 이력 상태는 새로고침 후에도 같은 요청을 가리킨다.
  const state = useLocation().state as { tradingRequestId?: string } | null;
  const requestId = state?.tradingRequestId ?? null;
  const autoOpen = search.get("settings") === "open";
  return <TradingSession key={JSON.stringify([sourceId, sourceRunId, presetId, requestId])} sourceId={sourceId} sourceRunId={sourceRunId} presetId={presetId} requestId={requestId} autoOpen={autoOpen} selectPreset={(id, options) => setSearch(id === null ? {} : { presetId: id, ...(options?.open ? { settings: "open" } : {}) }, { replace: options?.replace })} clearAutoOpen={() => setSearch(presetId ? { presetId } : {}, { replace: true })} />;
}

function TradingSession({ sourceId, sourceRunId, presetId, requestId, autoOpen, selectPreset, clearAutoOpen }: { sourceId: string | null; sourceRunId: string | null; presetId: string | null; requestId: string | null; autoOpen: boolean; selectPreset: (id: string | null, options?: { open?: boolean; replace?: boolean }) => void; clearAutoOpen: () => void }) {
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const snapshot = useTrading(presetId);
  const presets = useTradingPresets();
  const selectedId = presetId ?? presets.data?.defaultAccountPresetId;
  const hasSelection = presets.data?.presets.some(preset => preset.id === selectedId) ?? false;
  useEffect(() => {
    if (!presets.data || presets.isFetching || sourceId || sourceRunId || requestId) return;
    const available = presets.data.presets;
    if (presetId && !available.some(preset => preset.id === presetId)) selectPreset(available[0]?.id ?? null, { replace: true });
    else if (!presetId && !presets.data.defaultAccountPresetId && available[0]) selectPreset(available[0].id, { replace: true });
  }, [presetId, sourceId, sourceRunId, requestId, presets.data, presets.isFetching, selectPreset]);
  const artifacts = useTradingArtifacts();
  const source = useTradingSource(sourceId);
  const minuteSource = useQuery({ queryKey: ["intraday-run", sourceRunId], queryFn: () => api<IntradayRun>(`/intraday/runs/${encodeURIComponent(sourceRunId!)}`), enabled: sourceRunId !== null });
  const minuteResult = minuteSource.data?.status === "COMPLETED" ? minuteSource.data.result : null;
  const minuteRequest = minuteResult?.request ?? null;
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
  const handoffStarted = useRef(false);
  const [handoffError, setHandoffError] = useState<string | null>(null);
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
  const toggleJob = data?.toggleJob;
  const toggling = toggleJob?.status === "RUNNING";
  const enabling = toggling && toggleJob.action === "activate";
  const nextToggleMode = inactive && !enabling ? "on" : "off";
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
  const handoff = async () => {
    if (!requestId || handoffStarted.current || (!sourceRunId && !source.data?.setup)) return;
    handoffStarted.current = true;
    setHandoffError(null);
    try {
      const body = sourceRunId ? { sourceRunId, requestId } : { ...source.data!.setup, initialCashKrw: source.data!.setup!.budgetKrw, expectedRevision: 0, requestId };
      const result = await api<{ id: string; snapshot: TradingSnapshot }>(sourceRunId ? "/trading/intraday-presets" : "/trading/presets", { method: "POST", body: JSON.stringify(body) });
      client.setQueryData(tradingKey(result.id), result.snapshot);
      void client.invalidateQueries({ queryKey: tradingPresetsKey });
      if (mounted.current) selectPreset(result.id, { open: true, replace: true });
    } catch (e) {
      handoffStarted.current = false;
      if (mounted.current) setHandoffError(e instanceof Error ? e.message : "모의투자를 만들지 못했습니다.");
    }
  };
  useEffect(() => {
    if (requestId && ((sourceRunId && minuteRequest) || (sourceId && source.data?.setup))) void handoff();
  }, [requestId, sourceRunId, minuteRequest, sourceId, source.data?.setup]);
  useEffect(() => {
    if (autoOpen && hasSelection && data && (artifacts.data || minuteDeployment)) {
      openSettings();
      clearAutoOpen();
    }
  }, [autoOpen, hasSelection, data, artifacts.data, minuteDeployment]);
  const write = useMutation({ mutationFn: async ({ path, method, body, create }: { path: string; method: string; body: unknown; create?: boolean }) => create ? api<{ id: string; snapshot: TradingSnapshot }>(path, { method, body: JSON.stringify(body) }) : api<TradingSnapshot>(tradingPath(path, presetId), {
    method, body: JSON.stringify(body),
    headers: path === "/trading/activate" || path === "/trading/deactivate" ? { Prefer: "respond-async" } : undefined,
  }), onSuccess: async (result, variables) => {
    if (variables.create) {
      const created = result as { id: string; snapshot: TradingSnapshot };
      client.setQueryData(tradingKey(created.id), created.snapshot);
      void client.invalidateQueries({ queryKey: tradingPresetsKey });
      void client.invalidateQueries({ queryKey: tradingKey(null), exact: true });
      if (sourceRunId) sessionStorage.removeItem(`intraday-paper-request:${sourceRunId}`);
      if (mounted.current) selectPreset(created.id);
      return;
    }
    if (variables.path === "/trading/activate" || variables.path === "/trading/deactivate") {
      void client.invalidateQueries({ queryKey: ["jobs"] });
    }
    if (variables.path === "/trading/strategy" && variables.method === "DELETE") {
      const removedId = presetId ?? presets.data?.defaultAccountPresetId;
      const remaining = presets.data?.presets.find(preset => preset.id !== removedId);
      await client.invalidateQueries({ queryKey: tradingPresetsKey });
      setDialog(null);
      if (mounted.current) selectPreset(remaining?.id ?? null, { replace: true });
      void client.invalidateQueries({ queryKey: tradingKey(null), exact: true });
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
    if (!draft || !data || contextChanged || (!creating && (!inactive || toggling))) return;
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
  const accountSelector = <div className="flex flex-wrap items-center gap-2">
    <Label htmlFor="trading-preset">모의투자 선택</Label>
    <select id="trading-preset" className="max-w-full rounded-md border bg-background px-3 py-2 text-sm"
      value={selectedId ?? ""} disabled={write.isPending || !presets.data?.presets.length}
      onChange={event => selectPreset(event.target.value)}>
      {!presets.data?.presets.length ? <option value="">선택할 모의투자 없음</option> : null}
      {presets.data?.presets.map(preset => <option key={preset.id} value={preset.id}>{preset.title}</option>)}
    </select>
    <Button variant="outline" disabled={!data || write.isPending || (!sourceRunId && !artifacts.data) || (!!sourceId && !source.data?.setup) || (!!sourceRunId && !minuteRequest)} onClick={openNew}>새 모의투자</Button>
  </div>;
  if (requestId) {
    const sourceFailed = sourceId ? source.isError || (source.isSuccess && !source.data?.setup) : sourceRunId ? minuteSource.isError || (minuteSource.isSuccess && !minuteRequest) : true;
    return <div className="space-y-3"><h2 className="text-lg font-semibold">매매</h2>{handoffError ? <Alert variant="destructive" role="alert"><AlertDescription>{handoffError} <Button variant="outline" size="sm" onClick={() => void handoff()}>다시 시도</Button></AlertDescription></Alert> : sourceFailed ? <Alert variant="destructive" role="alert"><AlertDescription>{source.data?.error ?? "완료된 백테스트 설정을 불러오지 못했습니다."} <Button variant="outline" size="sm" onClick={() => void (sourceId ? source.refetch() : minuteSource.refetch())}>다시 시도</Button></AlertDescription></Alert> : <p role="status">백테스트 설정으로 모의투자를 준비하는 중…</p>}</div>;
  }
  if (!data) return <div className="space-y-3"><h2 className="text-lg font-semibold">매매</h2>{accountSelector}<p role={snapshot.error ? "alert" : "status"}>{snapshot.error ? "매매 정보를 불러오지 못했습니다." : "불러오는 중…"}</p></div>;
  const minuteMode = creating ? !!sourceRunId : !!minuteDeployment;
  const minute = creating
    ? minuteResult && { request: minuteResult.request, version: minuteResult.strategyVersion }
    : minuteDeployment;
  const hasSettings = minuteMode ? !!minute : !!draft;
  const fieldsDisabled = write.isPending || (!creating && (!inactive || toggling));
  const renameDeployment = !creating && (minuteMode || !inactive) ? deployment : null;
  const savedTitle = (minuteDeployment ? minuteDeployment.title : draft?.title) ?? "";
  return <div className="space-y-4"><h2 className="text-lg font-semibold">매매</h2>
    {accountSelector}
    {presets.error ? <Alert variant="destructive"><AlertDescription>모의투자 목록을 불러오지 못했습니다.</AlertDescription></Alert> : null}
    {snapshot.error ? <Alert variant="destructive"><AlertDescription>최신 상태를 불러오지 못했습니다.</AlertDescription></Alert> : null}
    {presets.data && presets.data.presets.length === 0 ? <p>등록된 모의투자가 없습니다. 새 모의투자를 만들어 주세요.</p> : null}
    {hasSelection ? <>
    <Card><CardHeader><CardTitle>모의 투자 현황</CardTitle>{data.broker.selectedAccountId && <CardDescription>모의계좌 · {data.broker.selectedAccountId}{minuteDeployment?.lastDecisionAtMs ? ` · 평가 기준 ${date(minuteDeployment.lastDecisionAtMs)} 확정 봉 종가` : ""}</CardDescription>}</CardHeader><CardContent className="space-y-2 text-sm"><p>초기 모의 자금 {money(data.paperCapital?.initialCashKrw)} · {minuteDeployment ? "확정된 1분 OHLCV로 모의 체결하며 수수료와 세금이 적용됩니다." : "최신 시세로 모의 체결하며 수수료와 세금이 적용됩니다."}</p><p>주문 가능 {money(data.account?.cashBuyingPower)} · 보유 평가액 {money(data.account?.marketValue)} · 평가손익 {money(data.account?.unrealizedPnl)} · 총 손익 {money(data.performance?.totalPnl)} · 추정 수익률 {data.performance?.returnPercent == null ? "—" : `${data.performance.returnPercent.toFixed(2)}%`}</p></CardContent></Card>
    <Card><CardHeader><CardTitle>전략 상태</CardTitle><CardDescription>{deployment ? `${deployment.name} · ${deployment.version} · ${tradingStatusLabel[deployment.status]}${preparation ? "" : ` · ${deployment.activity}`}` : "등록된 전략이 없습니다."}</CardDescription></CardHeader><CardContent className="space-y-3">{preparation ? <Alert variant={preparation.status === "FAILED" ? "destructive" : "default"} role={preparation.status === "FAILED" ? "alert" : "status"}><AlertDescription className="flex min-w-0 items-start gap-2">{preparing ? <LoaderCircle aria-hidden="true" className="mt-0.5 size-4 shrink-0 animate-spin" /> : null}<span className="min-w-0 break-words"><strong>{preparing ? "데이터 준비 중" : preparation.status === "READY" ? "데이터 준비 완료" : "데이터 준비 실패"}</strong> · {preparation.message}{preparation.status === "READY" ? " 자동 매매를 켜려면 직접 ON을 선택하세요." : null}</span></AlertDescription></Alert> : null}{toggleJob && (toggling || toggleJob.status === "FAILED" || toggleJob.status === "INTERRUPTED") ? <p role={toggling ? "status" : "alert"} className="text-sm">{toggleJob.message} <Button variant="link" asChild><Link to="/jobs">작업 목록</Link></Button></p> : null}{deployment?.lastError && deployment.lastError !== preparation?.message && deployment.lastError !== toggleJob?.message ? <p role="alert" className="break-words text-destructive">{deployment.lastError}</p> : null}{error && !settingsOpen && !dialog && !toggleMode ? <Alert variant="destructive" role="alert"><AlertDescription className="break-words">{error}</AlertDescription></Alert> : null}{data.blockers.map((b) => <p key={b} className="text-sm text-destructive">{b}</p>)}<div className="flex flex-wrap gap-2"><Button variant="outline" disabled={(!artifacts.data && !minuteDeployment && !(sourceRunId && !deployment && minuteRequest)) || (!!sourceId && !deployment && !source.data?.setup) || (!!sourceRunId && !deployment && !minuteRequest)} onClick={openSettings}>{deployment && <LockKeyhole aria-hidden="true" />}매매 설정</Button>{deployment ? <><Button aria-pressed={deployment.status === "ACTIVE"} className={deployment.status === "ACTIVE" ? "bg-emerald-100 text-emerald-900 hover:bg-emerald-200 dark:bg-emerald-950 dark:text-emerald-100 dark:hover:bg-emerald-900" : "bg-amber-100 text-amber-900 hover:bg-amber-200 dark:bg-amber-950 dark:text-amber-100 dark:hover:bg-amber-900"} disabled={write.isPending || (toggling && !enabling) || deployment.status === "STOPPING" || (nextToggleMode === "on" && preparing)} onClick={() => { setError(null); setDialogRevision(data.revision); setToggleMode(nextToggleMode); }}>{enabling ? "자동 매매 켜기 취소" : deployment.status === "ACTIVE" ? "자동 매매 ON" : "자동 매매 OFF"}</Button>{inactive && dailyDeployment ? <Button variant="outline" disabled={write.isPending || preparing || toggling} onClick={() => { setError(null); submit("/trading/prepare", "POST", { expectedRevision: data.revision }); }}>{preparing ? "데이터 준비 중" : preparation?.status === "FAILED" ? "데이터 복구 재시도" : "데이터 확인·복구"}</Button> : null}{dailyDeployment ? <Button variant="outline" disabled={!inactive || toggling || write.isPending || !latest || latest.artifactHash === dailyDeployment.artifactHash} onClick={() => { if (latest) setVersionParams({ ...defaults(latest), ...Object.fromEntries(Object.entries(dailyDeployment.parameters).filter(([key]) => key in properties(latest))) }); setError(null); setDialogRevision(data.revision); setDialog("version"); }}>전략 버전 업데이트</Button> : null}<Button variant="outline" disabled={(!creating && (!inactive || toggling)) || write.isPending} onClick={() => { setError(null); setDialogRevision(data.revision); setDialog("remove"); }}>전략 제거</Button></> : null}</div><p className="text-sm text-muted-foreground">{!inactive ? "설정 수정, 수동 버전 업데이트 및 제거는 자동 매매를 끈 후 가능합니다." : "자동 매매가 꺼져 있으면 매수, 매도 및 손절이 실행되지 않습니다."}</p>{deployment ? <p className="text-sm text-muted-foreground">호환되는 전략 버전은 활성화할 때와 다음 실행 전에 자동 적용됩니다.</p> : null}</CardContent></Card>
    </> : null}
    {sourceId && source.isLoading ? <p>백테스트 설정을 불러오는 중…</p> : null}{sourceId && !source.isLoading && (source.error || !source.data?.setup) ? <Alert variant="destructive"><AlertDescription>{source.data?.error ?? "백테스트 설정을 불러오지 못했습니다."}</AlertDescription></Alert> : null}
    {sourceRunId && minuteSource.isLoading ? <p>백테스트 설정을 불러오는 중…</p> : null}{sourceRunId && !minuteSource.isLoading && !minuteRequest ? <Alert variant="destructive"><AlertDescription>완료된 분봉 백테스트 설정을 불러오지 못했습니다.</AlertDescription></Alert> : null}
    {artifacts.error ? <Alert variant="destructive"><AlertDescription>전략 버전 목록을 불러오지 못했습니다.</AlertDescription></Alert> : null}
    <Dialog open={settingsOpen} onOpenChange={(open) => { setSettingsOpen(open); if (!open) setCreating(false); }}>
      <DialogContent className="flex max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] min-w-0 flex-col gap-0 overflow-hidden p-0 sm:max-w-6xl">
        <DialogHeader className="shrink-0 border-b px-5 py-4 pr-12 lg:px-7">
          <DialogTitle className="text-lg font-semibold">매매 설정</DialogTitle>
        </DialogHeader>
        <div className="min-h-0 min-w-0 space-y-5 overflow-y-auto overscroll-contain px-5 py-5 lg:px-7">
          <div className="grid gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] lg:items-center lg:gap-8">
            <DialogDescription className="leading-relaxed break-keep">{minuteMode
              ? "백테스트의 설정을 사용합니다. 현재 분봉 체결 엔진은 확정된 1분 OHLCV로 모의 체결합니다. 저장과 활성화는 별도 단계입니다."
              : "일봉 전략은 거래일 09:00~09:10(KST)에 전일 확정 봉으로 판단합니다. 실행창을 놓친 신호를 장중에 소급 주문하지 않습니다. 저장과 활성화는 별도 단계입니다. 손실 한도는 주문 중지 기준이며 보유 종목을 자동 청산하지 않습니다."}
            </DialogDescription>
            {hasSettings && <div className="min-w-0 space-y-2">
              <Label htmlFor="preset-title">모의투자 이름 (선택)</Label>
              <Input id="preset-title" maxLength={100} value={title}
                placeholder={minuteMode ? undefined : artifact?.name ?? "전략 이름"}
                disabled={write.isPending || (creating && minuteMode && submittedMinuteTitle !== null)}
                onChange={(e) => setTitle(e.target.value)} />
              {creating && minuteMode && submittedMinuteTitle !== null && <p className="text-xs text-muted-foreground">재시도에는 처음 제출한 이름을 사용합니다.</p>}
            </div>}
          </div>
          {minuteMode ? minute ? <>
            <MinuteSettings request={minute.request} version={minute.version} />
            {!creating && minuteDeployment && <p className="break-all text-xs text-muted-foreground">원본 백테스트 {minuteDeployment.sourceRunId}</p>}
          </> : <p role="alert">분봉 백테스트 설정을 불러올 수 없습니다.</p> : draft ? (
            <fieldset disabled={fieldsDisabled} className="grid min-w-0 gap-6 border-t pt-5 lg:grid-cols-2 lg:gap-8">
              <section className="min-w-0 space-y-4">
                <h3 className="font-semibold">전략 및 유니버스</h3>
                <div className="space-y-2">
                  <Label htmlFor="trading-strategy">전략 및 버전</Label>
                  {(!creating && deployment) || sourceId ? (
                    <p className="break-all">{artifact ? `${artifact.name} · ${artifact.version}` : `${draft.strategyId} · ${draft.artifactHash}`}</p>
                  ) : (
                    <Select disabled={fieldsDisabled} value={`${draft.strategyId}:${draft.artifactHash}`} onValueChange={(key) => {
                      const selected = list.find((a) => `${a.strategyId}:${a.artifactHash}` === key);
                      if (selected) setDraft(baseSetup(selected));
                    }}>
                      <SelectTrigger id="trading-strategy" className="max-w-full"><SelectValue placeholder="전략 선택" /></SelectTrigger>
                      <SelectContent>{list.filter((a) => a.latest).map((a) =>
                        <SelectItem key={`${a.strategyId}:${a.artifactHash}`} value={`${a.strategyId}:${a.artifactHash}`}>{a.name} · {a.version}</SelectItem>
                      )}</SelectContent>
                    </Select>
                  )}
                  {!artifact && <p role="alert" className="text-destructive">원본의 정확한 전략 버전을 찾을 수 없습니다. 다른 버전으로 대체하지 않습니다.</p>}
                </div>
                <ParameterFields disabled={fieldsDisabled} artifact={artifact} value={draft.parameters} onChange={(v) => setField("parameters", v)} />
                <div className="space-y-2">
                  <Label htmlFor="trading-universe-market">유니버스 시장</Label>
                  <UniverseMarketSelect id="trading-universe-market" disabled={fieldsDisabled} value={draft.universeRule.markets}
                    onChange={(markets) => setField("universeRule", { ...draft.universeRule, markets })} />
                  {fieldsDisabled ? <p className="break-words">{formatUniverseRuleSummary(draft.universeRule)}</p> : (
                    <UniverseStageEditor stages={draft.universeRule.stages}
                      onChange={(stages) => setField("universeRule", { ...draft.universeRule, stages })} />
                  )}
                </div>
                <div className="space-y-2">
                  <Label htmlFor="trading-rebalance-value">리밸런스 주기</Label>
                  <div className="flex gap-2">
                    <Input id="trading-rebalance-value" className="w-24" type="number" min={1} value={draft.universeRule.rebalanceInterval.value}
                      disabled={["NONE", "YEAR"].includes(draft.universeRule.rebalanceInterval.unit)}
                      onChange={(e) => setField("universeRule", { ...draft.universeRule, rebalanceInterval: { ...draft.universeRule.rebalanceInterval, value: Number(e.target.value) } as RebalanceInterval })} />
                    <Select disabled={fieldsDisabled} value={draft.universeRule.rebalanceInterval.unit}
                      onValueChange={(unit) => setField("universeRule", { ...draft.universeRule, rebalanceInterval: { unit, value: 1 } as RebalanceInterval })}>
                      <SelectTrigger aria-label="리밸런스 주기 단위"><SelectValue /></SelectTrigger>
                      <SelectContent>{[["NONE", "안 함"], ["DAY", "일"], ["WEEK", "주"], ["MONTH", "개월"], ["YEAR", "년"]].map(([v, label]) =>
                        <SelectItem key={v} value={v!}>{label}</SelectItem>
                      )}</SelectContent>
                    </Select>
                  </div>
                </div>
              </section>
              <section className="min-w-0 space-y-4 border-t pt-5 lg:border-t-0 lg:border-l lg:pt-0 lg:pl-8">
                <h3 className="font-semibold">자금 및 운용 한도</h3>
                <div className="space-y-2">
                  <Label htmlFor="initialCashKrw">초기 모의자금 (원)</Label>
                  <Input id="initialCashKrw" type="number" min={10000} max={1000000000000} step={1}
                    disabled={fieldsDisabled || (!creating && !data.paperCapital?.canEdit)} value={Number.isFinite(initialCashKrw) ? initialCashKrw : ""}
                    onChange={(e) => setInitialCashKrw(e.target.value === "" ? NaN : Number(e.target.value))} />
                  <p className="text-xs break-keep text-muted-foreground">초기 모의자금은 모의 투자 전체의 시작 자금이며, 운용 예산은 전략의 별도 사용 한도입니다. {!creating && !inactive ? "자동매매 OFF 상태에서 변경할 수 있습니다." : !creating && data.paperCapital && !data.paperCapital.canEdit ? "진행 중인 주문이 있거나 첫 체결 이후에는 초기 모의자금을 변경할 수 없습니다." : null}</p>
                </div>
                <div className="grid gap-3 sm:grid-cols-2">{numericFields.map(([key, label]) =>
                  <div className="min-w-0 space-y-2" key={key}>
                    <Label htmlFor={key}>{label}</Label>
                    <Input id={key} type="number" step="any" value={Number.isFinite(draft[key]) ? draft[key] : ""}
                      onChange={(e) => setField(key, e.target.value === "" ? NaN : Number(e.target.value))} />
                  </div>
                )}</div>
              </section>
            </fieldset>
          ) : <p>설정을 불러올 수 없습니다.</p>}
        </div>
        {(error || contextChanged) && <Alert variant="destructive" role="alert" className="max-h-[25dvh] shrink-0 overflow-y-auto rounded-none">
          <AlertDescription>
            {error ?? "등록된 전략이 다른 화면에서 변경되었습니다. 작성 중인 입력은 유지했습니다. 최신 설정을 불러온 뒤 저장해 주세요."}
            {!creating && <Button variant="outline" size="sm" disabled={snapshot.isFetching || snapshot.isError} onClick={openSettings}>최신 설정 불러오기</Button>}
          </AlertDescription>
        </Alert>}
        {hasSettings && <DialogFooter className="mx-0 mb-0 shrink-0 flex-row justify-end px-5 py-3 lg:px-7">
          {renameDeployment && <Button className="flex-1 sm:flex-none" variant={minuteMode ? "default" : "outline"}
            disabled={write.isPending || contextChanged || title.trim() === savedTitle}
            onClick={() => submit("/trading/title", "PATCH", { deploymentId: renameDeployment.id, expectedRevision: draftRevision,
              expectedTitle: savedTitle, title: title.trim() })}>이름 저장</Button>}
          {(!minuteMode || creating) && <Button type="button" className="flex-1 sm:flex-none"
            disabled={contextChanged || fieldsDisabled || (!minuteMode && !artifact)}
            onClick={save}>설정 저장</Button>}
        </DialogFooter>}
      </DialogContent>
    </Dialog>
    {hasSelection ? <>
    <Card><CardHeader><CardTitle>보유 종목</CardTitle><CardDescription>전략에 속하지 않은 보유 종목은 수동 관리합니다. 전략에 자동 편입되지 않습니다.</CardDescription></CardHeader><CardContent><div className="overflow-x-auto"><Table><TableHeader><TableRow>{["종목", "관리", "수량", "현재가", "평가액", "평가손익"].map((x) => <TableHead key={x}>{x}</TableHead>)}</TableRow></TableHeader><TableBody>{data.positions.map((p) => <TableRow key={p.symbol}><TableCell><Button variant="link" className="h-auto p-0" onClick={() => setHolding({ symbol: p.symbol, name: p.name })}>{p.name} ({p.symbol})</Button></TableCell><TableCell>{p.deploymentId ? "전략" : "수동"}</TableCell><TableCell>{p.quantity}</TableCell><TableCell>{money(p.price)}</TableCell><TableCell>{money(p.marketValue)}</TableCell><TableCell>{money(p.unrealizedPnl)}</TableCell></TableRow>)}</TableBody></Table></div>{data.positions.length === 0 ? <p className="text-sm text-muted-foreground">표시할 보유 종목이 없습니다.</p> : null}</CardContent></Card>
    <Card><CardHeader><CardTitle>주문 내역</CardTitle></CardHeader><CardContent><div className="overflow-x-auto"><Table><TableHeader><TableRow>{["시간", "종목", "방향", "수량 / 체결", minuteDeployment ? "신호가 / 평균 체결가" : "주문가 / 평균 체결가", "상태", "사유"].map((x) => <TableHead key={x}>{x}</TableHead>)}</TableRow></TableHeader><TableBody>{data.orders.map((o) => <TableRow key={o.id}><TableCell>{date(o.createdAtMs)}</TableCell><TableCell>{o.symbol}</TableCell><TableCell>{o.side === "BUY" ? "매수" : "매도"}</TableCell><TableCell>{o.quantity} / {o.filledQuantity}</TableCell><TableCell>{money(o.price)} / {o.averageFillPrice == null ? "—" : money(o.averageFillPrice)}</TableCell><TableCell>{orderStatusLabel[o.status]}</TableCell><TableCell>{o.reason}{o.error ? ` · ${o.error}` : ""}</TableCell></TableRow>)}</TableBody></Table></div>{data.orders.length === 0 ? <p className="text-sm text-muted-foreground">주문 내역이 없습니다.</p> : null}</CardContent></Card>
    <Card><CardHeader><CardTitle>이벤트</CardTitle></CardHeader><CardContent className="space-y-2 text-sm">{data.events.length ? data.events.map((e) => <p key={e.id}>{date(e.createdAtMs)} · {e.severity} · {e.message}</p>) : <p className="text-muted-foreground">이벤트가 없습니다.</p>}</CardContent></Card>
    </> : null}
    <HoldingPriceDialog holding={holding} onClose={() => setHolding(null)} />
    <AlertDialog open={toggleMode !== null} onOpenChange={(open) => { if (!open) setToggleMode(null); }}><AlertDialogContent className={toggleMode === "on" ? "bg-emerald-50 dark:bg-emerald-950" : "bg-amber-50 dark:bg-amber-950"}><AlertDialogTitle className="text-lg font-semibold">{toggleMode === "on" ? "자동 매매를 켤까요?" : "자동 매매를 끌까요?"}</AlertDialogTitle><AlertDialogDescription className="text-sm text-muted-foreground">{toggleMode === "on" ? "저장된 설정으로 모의 자동 매매를 시작합니다." : deployment?.status === "ERROR" ? "오류 상태를 정리하고 자동 매매를 완전히 끕니다. 보유 종목은 자동으로 매도하지 않습니다." : "자동 매매를 중지합니다. 보유 종목은 자동으로 매도하지 않습니다."}</AlertDialogDescription>{error && <p role="alert" className="text-sm text-destructive">{error}</p>}<div className="flex justify-end gap-2"><AlertDialogCancel asChild><Button variant="outline">취소</Button></AlertDialogCancel><Button disabled={write.isPending || (toggling && !enabling) || toggleMode !== nextToggleMode || (toggleMode === "on" && (data.blockers.length > 0 || preparing))} onClick={() => submit(toggleMode === "on" ? "/trading/activate" : "/trading/deactivate", "POST", { expectedRevision: dialogRevision ?? data.revision, acknowledged: true })}>{toggleMode === "on" ? "켜기" : "끄기"}</Button></div></AlertDialogContent></AlertDialog>
    <Dialog open={dialog !== null} onOpenChange={(open) => { if (!open) setDialog(null); }}><DialogContent><DialogHeader><DialogTitle>{dialog === "remove" ? "전략 제거" : "전략 버전 업데이트"}</DialogTitle><DialogDescription>{dialog === "remove" ? "전략과 모의투자를 목록에서 제거합니다. 보유 종목을 매도하지 않으며, 잔고와 주문 및 이벤트 내역은 유지됩니다." : "자동 매매가 꺼진 상태에서만 변경됩니다."}</DialogDescription></DialogHeader>{dialog === "version" && deployment && latest ? <div className="space-y-3"><p className="text-sm">{deployment.version} → {latest.version}</p><ParameterFields disabled={!inactive} artifact={latest} value={versionParams} onChange={setVersionParams} />{parameterError(latest, versionParams) ? <p className="text-sm text-destructive">{parameterError(latest, versionParams)}</p> : null}</div> : null}{error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}<DialogFooter><Button variant="outline" onClick={() => setDialog(null)}>취소</Button>{dialog === "remove" ? <Button variant="destructive" disabled={!inactive || write.isPending} onClick={() => submit("/trading/strategy", "DELETE", { expectedRevision: dialogRevision ?? data.revision })}>제거</Button> : <Button disabled={!inactive || !latest || !!parameterError(latest, versionParams) || write.isPending} onClick={() => latest && submit("/trading/version", "POST", { expectedRevision: dialogRevision ?? data.revision, artifactHash: latest.artifactHash, parameters: versionParams })}>전략 버전 업데이트</Button>}</DialogFooter></DialogContent></Dialog>
  </div>;
}
