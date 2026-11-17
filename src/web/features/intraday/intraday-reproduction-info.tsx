import { ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { InfoHint } from "@/components/info-hint";
import { getIntradayStrategy } from "@shared/schemas/intraday-strategies";
import type { IntradayResult } from "@shared/schemas/intraday";
import { ReproductionInfoCard, ReproductionInfoRows } from "../backtests/reproduction-info-card";
import { SharpeBasisInfo } from "../backtests/sharpe-basis-info";

const number = (value: number) => value.toLocaleString("ko-KR", { maximumSignificantDigits: 15 });
// %로 환산한 값과 저장된 bp 원값을 함께 보여 작은 요율도 0으로 오해하지 않게 한다.
const rate = (bps: number) => `${number(bps / 100)}% (${bps}bp)`;

export function IntradayReproductionInfo({ result }: {
  result: Pick<IntradayResult, "request" | "strategyVersion" | "dataRevision" | "executionVersion"> & Partial<Pick<IntradayResult, "metrics">>;
}) {
  const { request } = result;
  const strategy = getIntradayStrategy(request.strategyId);
  const execution = request.execution;
  const parameters = Object.entries(request.parameters).map(([key, value]): [string, string] => {
    if (key === "allocationPct") return ["매수 비중", `현재 현금의 ${number(value)}%`];
    if (key === "stopLossPct") return ["손절 기준", `평균 매수가 대비 −${number(value)}%`];
    if (key === "takeProfitPct") return ["익절 기준", `평균 매수가 대비 +${number(value)}%`];
    const field = strategy.fields.find((candidate) => candidate.key === key);
    if (key === "breakoutBps") return ["돌파 여유", rate(value)];
    const label = field?.label.replace(/ \((분|봉|배)\)$/, "") ?? key;
    const unit = field?.label.match(/\((분|봉|배)\)$/)?.[1]
      ?? (key === "fast" || key === "slow" ? "봉" : key === "bandStdDev" ? "배" : "");
    return [label, `${number(value)}${unit}`];
  });
  return <ReproductionInfoCard>
    <div className="grid gap-6 md:grid-cols-2">
      <section className="min-w-0 space-y-3" aria-label="전략 설정">
        <h3 className="font-medium">전략 설정</h3>
        <ReproductionInfoRows rows={[
          ["전략", `${strategy.name} · v${result.strategyVersion}`],
          ["봉 주기", `${Number.parseInt(request.timeframe, 10)}분봉`],
          ["초기 자금", `${number(request.initialCash)}원`],
          ...parameters,
        ]} />
      </section>
      <section className="min-w-0 space-y-3" aria-label="체결 가정">
        <h3 className="flex items-center gap-1 font-medium">체결 가정<InfoHint label="체결 가정 설명">
          <p>체결 지연 이후 관측되는 분봉에서 체결을 시도합니다. 주문 유효기간은 체결 가능 시각부터 계산하며 진입 마감·장 종료가 더 빠르면 먼저 종료됩니다.</p>
          <p>매수 주문 수량은 신호 시점의 1분봉, 각 체결 수량은 체결 시점의 1분봉 거래량을 기준으로 제한합니다. 슬리피지는 매수 가격을 높이고 매도 가격을 낮추며, 호가 단위도 반영합니다.</p>
          <p>손절·익절은 신호 봉 종가로 판단합니다. 당일 청산이 미체결되면 보유 상태로 계산을 마치므로 청산을 보장하지 않습니다.</p>
        </InfoHint></h3>
        <ReproductionInfoRows rows={[
          ["보유 정책", "당일 청산 시도"],
          ["수수료 (매수·매도)", rate(execution.commissionBps)],
          ["세금 (매도)", rate(execution.taxBps)],
          ["슬리피지", rate(execution.slippageBps)],
          ["최소 체결 대기", `${number(execution.latencyMs / 1000)}초`],
          ["주문 유효기간", `체결 가능 시각부터 ${number(execution.orderExpiryMinutes)}분`],
          ["거래량 참여 한도", `1분봉 거래량의 ${number(execution.maxParticipationPct)}%`],
        ]} />
      </section>
    </div>
    <SharpeBasisInfo basis={result.metrics?.sharpeBasis} />
    <Collapsible className="border-t pt-3">
      <CollapsibleTrigger asChild><Button variant="ghost" size="sm" className="data-[state=open]:[&_svg]:rotate-180"><ChevronDown className="transition-transform" />버전 식별자 보기</Button></CollapsibleTrigger>
      <CollapsibleContent className="space-y-3 pt-3">
        <p className="text-xs text-muted-foreground">입력 자료와 실행 코드가 같은지 비교하는 식별자입니다. 새 결과의 입력 자료에는 시세와 금리표가 포함됩니다.</p>
        <ReproductionInfoRows rows={[["입력 자료 식별자", result.dataRevision], ["실행 식별자", result.executionVersion ?? "기록 없음"]]} monospace />
      </CollapsibleContent>
    </Collapsible>
  </ReproductionInfoCard>;
}
