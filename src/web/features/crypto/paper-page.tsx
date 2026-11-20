import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router";
import type { CryptoRunDetail } from "@shared/crypto-runs";
import type { CryptoPaperAccount } from "@shared/crypto-paper";
import { api, postJson } from "@/lib/api-client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { PaperNavigation } from "./paper-navigation";

const money = (value: number) => `${value.toLocaleString("ko-KR", { maximumFractionDigits: 8 })}원`;
const errorText = (error: unknown) => (error instanceof Error ? error.message : "요청에 실패했습니다.");

export function CryptoPaperPage() {
  const [params, setParams] = useSearchParams();
  const sourceId = params.get("source");
  const [confirmation, setConfirmation] = useState<"on" | "off" | null>(null);
  const client = useQueryClient();
  const account = useQuery({
    queryKey: ["crypto", "paper"],
    queryFn: ({ signal }) => api<{ account: CryptoPaperAccount | null }>("/crypto/paper", { signal }),
    refetchInterval: (query) => (query.state.data?.account?.active ? 5000 : false),
  });
  const source = useQuery({
    queryKey: ["crypto", "backtest", sourceId],
    queryFn: ({ signal }) =>
      api<CryptoRunDetail>(`/crypto/backtests/${encodeURIComponent(sourceId!)}`, { signal }),
    enabled: !!sourceId,
  });
  const toggle = useMutation({
    mutationFn: (active: boolean) =>
      postJson<{ account: CryptoPaperAccount }>("/crypto/paper/active", { active }),
    onSuccess: (data) => {
      client.setQueryData(["crypto", "paper"], data);
      setConfirmation(null);
    },
  });
  const current = account.data?.account;
  return (
    <div className="space-y-5">
      <PaperNavigation mode="crypto" />
      <div>
        <h2 className="text-lg font-semibold">코인 모의투자</h2>
        <p className="text-sm text-muted-foreground">실제 주문을 보내지 않는 가상 계좌입니다.</p>
      </div>
      {account.isPending && <p>계좌 조회 중...</p>}
      {account.isError && (
        <p role="alert" className="text-destructive">
          계좌 조회 실패: {errorText(account.error)}
        </p>
      )}
      {sourceId && (
        <Card>
          <CardHeader>
            <CardTitle>백테스트 설정 가져오기</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {source.isPending && <p>백테스트 조회 중...</p>}
            {source.isError && (
              <p role="alert" className="text-destructive">
                백테스트 조회 실패: {errorText(source.error)}
              </p>
            )}
            {source.data && source.data.status !== "COMPLETED" && (
              <p role="alert" className="text-destructive">
                완료된 백테스트만 가져올 수 있습니다.
              </p>
            )}
            {source.data?.status === "COMPLETED" && (
              <ImportSettings
                key={source.data.id}
                source={source.data}
                account={current ?? null}
                accountLoaded={account.isSuccess}
                onImported={(data) => {
                  client.setQueryData(["crypto", "paper"], data);
                  setParams({}, { replace: true });
                }}
              />
            )}
          </CardContent>
        </Card>
      )}
      {account.isSuccess && !current && !sourceId && (
        <Card>
          <CardContent className="space-y-3 pt-6">
            <p>설정된 코인 모의투자 계좌가 없습니다. 완료된 코인 백테스트에서 설정을 가져오세요.</p>
            <Button asChild variant="outline">
              <Link to="/backtests/crypto">코인 백테스트 보기</Link>
            </Button>
          </CardContent>
        </Card>
      )}
      {current && (
        <>
          <Card>
            <CardHeader>
              <CardTitle>계좌 현황 · {current.active ? "ON" : "OFF"}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <p className="text-sm text-muted-foreground">
                확정된 UTC 일봉을 기준으로 신호를 확인합니다. 한국 시간 오전 9시부터 5분간 새 시세를 확인해
                모의 체결합니다. 서버 재시작 후 ON 상태는 유지됩니다. 마지막 처리 일자:{" "}
                {current.lastSession ?? "없음"}
              </p>
              {current.error && (
                <p role="alert" className="text-destructive">
                  {current.error}
                </p>
              )}
              <div className="grid gap-3 sm:grid-cols-3">
                <Stat label="총 평가 자산" value={money(current.equity)} />
                <Stat label="현금" value={money(current.cash)} />
                <Stat label="초기 자금" value={money(current.initialCash)} />
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  className={current.active ? "bg-blue-700 hover:bg-blue-800" : "bg-red-600 hover:bg-red-700"}
                  disabled={toggle.isPending}
                  onClick={() => setConfirmation(current.active ? "off" : "on")}
                >
                  {current.active ? "모의투자 OFF" : "모의투자 ON"}
                </Button>
                <Button asChild variant="outline">
                  <Link to="/backtests/crypto">다른 백테스트 보기</Link>
                </Button>
              </div>
              <p className="text-sm text-muted-foreground">
                {current.active
                  ? "ON 상태에서는 전략 설정을 변경할 수 없습니다."
                  : "OFF 상태에서 다른 백테스트 설정을 가져올 수 있습니다. 기존 현금과 보유 자산은 유지됩니다."}
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>전략 설정</CardTitle>
            </CardHeader>
            <CardContent>
              <Settings input={current.input} />
              <p className="mt-3 text-sm text-muted-foreground">
                전략 버전 {current.strategyVersion} ·{" "}
                <Link
                  className="underline"
                  to={`/backtests/crypto/${encodeURIComponent(current.sourceRunId)}`}
                >
                  원본 백테스트
                </Link>
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>보유 자산</CardTitle>
            </CardHeader>
            <CardContent>
              {current.holding ? (
                <p>
                  {current.holding.market} ·{" "}
                  {current.holding.quantity.toLocaleString("ko-KR", { maximumFractionDigits: 8 })}개 · 평가
                  단가 {money(current.holding.lastClose)}
                  {current.valuedAtMs
                    ? ` · 시세 기준 ${new Date(current.valuedAtMs).toLocaleString("ko-KR")}`
                    : ""}
                </p>
              ) : (
                <p>보유 자산이 없습니다.</p>
              )}
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>모의 체결 내역 · 최근 100건</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left">
                      <th>일자</th>
                      <th>마켓</th>
                      <th>구분</th>
                      <th>수량</th>
                      <th>가격</th>
                      <th>수수료</th>
                    </tr>
                  </thead>
                  <tbody>
                    {current.trades.map((trade, index) => (
                      <tr key={index} className="border-b">
                        <td>{trade.date}</td>
                        <td>{trade.market}</td>
                        <td>{trade.side === "BUY" ? "매수" : "매도"}</td>
                        <td>{trade.quantity.toLocaleString("ko-KR", { maximumFractionDigits: 8 })}</td>
                        <td>{money(trade.price)}</td>
                        <td>{money(trade.fee)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {current.trades.length === 0 && <p className="py-3">체결 내역이 없습니다.</p>}
              </div>
            </CardContent>
          </Card>
        </>
      )}
      <Dialog
        open={confirmation !== null}
        onOpenChange={(open) => {
          if (!open && !toggle.isPending) setConfirmation(null);
        }}
      >
        <DialogContent
          className={confirmation === "on" ? "bg-red-50 dark:bg-red-950" : "bg-blue-50 dark:bg-blue-950"}
        >
          <DialogHeader>
            <DialogTitle>코인 모의투자를 {confirmation === "on" ? "시작" : "중지"}할까요?</DialogTitle>
            <DialogDescription>
              {confirmation === "on"
                ? "현재 전략으로 확정 일봉을 평가해 가상 체결합니다. 실제 주문은 보내지 않습니다."
                : "새 신호 처리를 중지합니다. 현금과 보유 자산은 유지됩니다."}
            </DialogDescription>
          </DialogHeader>
          {toggle.isError && (
            <p role="alert" className="text-destructive">
              변경 실패: {errorText(toggle.error)}
            </p>
          )}
          <DialogFooter>
            <Button variant="outline" disabled={toggle.isPending} onClick={() => setConfirmation(null)}>
              취소
            </Button>
            <Button disabled={toggle.isPending} onClick={() => toggle.mutate(confirmation === "on")}>
              {confirmation === "on" ? "ON 확인" : "OFF 확인"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ImportSettings({
  source,
  account,
  accountLoaded,
  onImported,
}: {
  source: CryptoRunDetail;
  account: CryptoPaperAccount | null;
  accountLoaded: boolean;
  onImported: (data: { account: CryptoPaperAccount }) => void;
}) {
  const [initialCash, setInitialCash] = useState(source.input.initialCash);
  const [open, setOpen] = useState(false);
  const mutation = useMutation({
    mutationFn: () =>
      postJson<{ account: CryptoPaperAccount }>("/crypto/paper/settings", {
        sourceRunId: source.id,
        ...(!account ? { initialCash } : {}),
      }),
    onSuccess: onImported,
  });
  return (
    <>
      <Settings input={source.input} />
      <p className="text-sm text-muted-foreground">
        전략 버전 {source.strategyVersion} · 원본 기간 {source.input.startDate} ~ {source.input.endDate}
      </p>
      {!account && (
        <Label className="grid gap-2">
          초기 모의자금 (원)
          <Input
            type="number"
            min={1}
            max={1e15}
            value={Number.isFinite(initialCash) ? initialCash : ""}
            onChange={(e) => setInitialCash(e.target.value ? Number(e.target.value) : NaN)}
          />
        </Label>
      )}
      {account?.active && (
        <p className="text-sm text-destructive">설정을 가져오려면 먼저 모의투자를 OFF로 전환하세요.</p>
      )}
      <Button
        disabled={
          !accountLoaded ||
          !!account?.active ||
          mutation.isPending ||
          (!account && (!Number.isFinite(initialCash) || initialCash <= 0 || initialCash > 1e15))
        }
        onClick={() => setOpen(true)}
      >
        설정 가져오기
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>이 설정을 가져올까요?</DialogTitle>
            <DialogDescription>
              설정은 OFF 상태로 적용됩니다.{" "}
              {account
                ? "기존 현금과 보유 자산은 유지됩니다."
                : `초기 모의자금은 ${money(initialCash)}입니다.`}{" "}
              실제 주문은 보내지 않습니다.
            </DialogDescription>
          </DialogHeader>
          {mutation.isError && (
            <p role="alert" className="text-destructive">
              가져오기 실패: {errorText(mutation.error)}
            </p>
          )}
          <DialogFooter>
            <Button variant="outline" disabled={mutation.isPending} onClick={() => setOpen(false)}>
              취소
            </Button>
            <Button disabled={mutation.isPending} onClick={() => mutation.mutate()}>
              OFF로 가져오기 확인
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
function Settings({ input }: { input: CryptoRunDetail["input"] }) {
  return (
    <dl className="grid gap-3 text-sm sm:grid-cols-2">
      <div>
        <dt className="text-muted-foreground">후보 마켓</dt>
        <dd className="break-words">{input.markets.join(", ")}</dd>
      </div>
      <div>
        <dt className="text-muted-foreground">유니버스 / 모멘텀</dt>
        <dd>
          {input.universeSize}개 / {input.lookbackDays}일
        </dd>
      </div>
      <div>
        <dt className="text-muted-foreground">수수료 / 슬리피지</dt>
        <dd>
          {input.feeBps}bp / {input.slippageBps}bp
        </dd>
      </div>
      <div>
        <dt className="text-muted-foreground">선택 방식</dt>
        <dd>30일 평균 거래대금 상위, 양의 모멘텀 최강</dd>
      </div>
    </dl>
  );
}
function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-muted/50 p-3">
      <p className="text-sm text-muted-foreground">{label}</p>
      <p className="font-semibold tabular-nums">{value}</p>
    </div>
  );
}
