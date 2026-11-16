import { InfoHint } from "@/components/info-hint";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useStrategies } from "./api";
import { INTRADAY_STRATEGIES } from "@shared/schemas/intraday-strategies";
import type { ExperimentMode } from "./experiment-paths";

export const VALIDATION_MODE_HELP = {
  HOLDOUT: "기간을 IS와 OOS로 한 번 나누고 원본 설정을 각각 실행합니다. OOS는 설정을 고르지 않은 구간의 성과를 확인합니다.",
  OPTIMIZED_HOLDOUT: "IS에서 후보 설정을 비교해 조건을 만족하는 최선의 후보를 고르고, 뒤의 OOS에서 평가합니다. 원본 고정 설정의 OOS도 함께 비교합니다.",
  WALK_FORWARD: "학습과 평가 구간을 앞으로 이동하며 회차마다 IS에서 후보를 선택하고 이어지는 OOS에서 평가합니다. 각 회차의 고정 설정 OOS도 비교합니다.",
} as const;

const STRATEGY_SEED_HELP: Record<string, string> = {
  "range-breakout": "전략 자체에서는 난수로 후보를 고르지 않습니다.",
  "cross-sectional-momentum": "모멘텀 점수가 같은 종목끼리 순서를 정할 때 시드를 사용합니다.",
  "value-quality-rank": "이익수익률과 자본수익률 각각의 동점, 두 순위 합의 동점을 정할 때 시드를 사용합니다.",
  "earnings-acceleration-rank": "이익 성장률과 가격 모멘텀 각각의 동점, 두 순위 합의 동점을 정할 때 시드를 사용합니다.",
  "low-per-high-roe-rank": "PER과 ROE 각각의 동점, 두 순위 합의 동점을 정할 때 시드를 사용합니다.",
  "ema-trend-switch": "비어 있는 같은 상관 그룹에서 같은 봉에 여러 종목이 진입 자격을 얻으면 시드로 한 종목을 고릅니다.",
  "rsi-reversion": "비어 있는 같은 상관 그룹에서 같은 봉에 여러 종목이 진입 자격을 얻으면 시드로 한 종목을 고릅니다.",
};

export function StrategySeedExplanation({ mode = "daily", ...props }: { strategyId: string; strategyVersion?: string; mode?: ExperimentMode }) {
  if (mode === "daily") return <DailyStrategySeedExplanation {...props} />;
  const strategy = INTRADAY_STRATEGIES.find((item) => item.id === props.strategyId);
  return <Card>
    <CardHeader><CardTitle className="flex items-center gap-2 text-base">이 전략의 난수 영향<InfoHint label="난수 시드 설명">현재 분봉 엔진과 기본 분봉 전략은 난수를 사용하지 않습니다.</InfoHint></CardTitle></CardHeader>
    <CardContent className="space-y-2 text-sm">
      <p>{strategy?.name ?? props.strategyId} 전략은 가격·거래량과 설정한 매개변수로 신호를 결정합니다. {strategy?.entry}</p>
      <p>분봉 엔진은 주문 순서를 난수로 섞지 않습니다. 같은 데이터·설정·실행 버전에서는 시드만 바꿔 결과 민감도를 비교할 수 없습니다.</p>
      <p className="text-muted-foreground">현재 등록된 전략{strategy ? ` (${strategy.version})` : ""} 기준입니다.{props.strategyVersion && props.strategyVersion !== strategy?.version ? ` 이 결과의 전략 버전은 ${props.strategyVersion}입니다.` : ""}</p>
    </CardContent>
  </Card>;
}

function DailyStrategySeedExplanation({ strategyId, strategyVersion }: { strategyId: string; strategyVersion?: string }) {
  const strategies = useStrategies();
  const current = strategies.data?.strategies.find((strategy) => strategy.id === strategyId);
  const explanation = STRATEGY_SEED_HELP[strategyId];
  const versionDiffers = strategyVersion && current && strategyVersion !== current.version;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          이 전략의 난수 영향
          <InfoHint label="난수 시드 설명">같은 입력과 시드는 같은 난수 순서를 재현합니다. 전략 선택과 매수 처리 순서는 별도의 난수 흐름을 사용합니다.</InfoHint>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        <p>{explanation ?? "이 전략의 난수 사용 방식은 확인할 수 없습니다."}</p>
        <p>공통 엔진은 같은 시점의 매수 주문 순서를 시드로 섞습니다. 현금이나 보유 한도가 부족하면 실제 매수 종목이 달라질 수 있습니다.</p>
        <p>동점이나 매수 경쟁이 없으면 시드를 바꿔도 결과가 같을 수 있습니다.</p>
        {explanation ? <p className="text-muted-foreground">위 설명은 현재 등록된 전략{current ? ` (${current.version})` : ""} 기준입니다.{versionDiffers ? ` 이 실행의 전략 버전은 ${strategyVersion}으로 달라 동작이 다를 수 있습니다.` : !strategyVersion ? " 이 실행의 전략 버전은 확인되지 않았습니다." : !current ? ` 실행 버전은 ${strategyVersion}이며 현재 버전은 확인되지 않았습니다.` : ""}</p> : null}
      </CardContent>
    </Card>
  );
}
