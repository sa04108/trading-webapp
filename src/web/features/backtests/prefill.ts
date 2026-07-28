// 확장자 .js 는 실수가 아니다 — tests/unit/prefill.test.ts 가 이 모듈을 import 해
// tsconfig.server.json 의 NodeNext 프로그램에 편입되는데, 거기서는 확장자 없는
// 상대 import 가 에러다 (tests/unit/api-client.test.ts 와 같은 이유). 따라서 이
// 모듈은 계속 DOM 을 쓰지 않고 별칭(@/) import 도 쓰지 않아야 한다.
import type { BacktestRequestBody } from './types.js';

/** 위저드 입력 상태 — 폼이므로 전부 문자열로 보관한다 */
export interface WizardFormState {
  strategyId: string | null;
  parameters: Record<string, string>;
  datasetId: string | null;
  symbols: string[];
  from: string;
  to: string;
  initialCash: string;
  maxPositions: string;
  commissionProfileId: string;
  slippageProfileId: string;
  randomSeed: string;
}

/** 지금 고를 수 있는 것들 — 사라진 참조를 판정하는 기준 */
export interface PrefillCatalog {
  strategyIds: readonly string[];
  datasets: readonly { id: string; symbols: string[] }[];
}

/**
 * 저장된 요청을 위저드 폼 상태로 옮긴다 (D-025).
 * 원본이 가리키는 전략·데이터셋·종목이 그 사이 사라질 수 있다 — 조용히 통과시키면
 * 사용자가 모르고 제출한다. 없는 참조는 비우고 무엇이 빠졌는지 notes 로 알린다.
 */
export function requestToFormState(
  request: BacktestRequestBody,
  catalog: PrefillCatalog,
): { state: WizardFormState; notes: string[] } {
  const notes: string[] = [];

  const strategyExists = catalog.strategyIds.includes(request.strategyId);
  if (!strategyExists) {
    notes.push(`전략 ${request.strategyId} 이 더 이상 등록돼 있지 않습니다 — 다시 고르세요.`);
  }

  const dataset = catalog.datasets.find((d) => d.id === request.datasetId) ?? null;
  let symbols: string[] = [];
  if (!dataset) {
    notes.push('원본 데이터셋이 더 이상 없습니다 — 다시 고르세요.');
  } else {
    const available = new Set(dataset.symbols);
    symbols = request.universe.symbols.filter((s: string) => available.has(s));
    const dropped = request.universe.symbols.filter((s: string) => !available.has(s));
    if (dropped.length > 0) {
      notes.push(`데이터셋에서 사라진 종목을 제외했습니다: ${dropped.join(', ')}`);
    }
  }

  return {
    state: {
      strategyId: strategyExists ? request.strategyId : null,
      // 전략이 없으면 파라미터도 의미가 없다 — 새로 고른 전략의 기본값이 채워진다
      parameters: strategyExists
        ? Object.fromEntries(
            Object.entries(request.parameters).map(([key, value]) => [key, String(value)]),
          )
        : {},
      datasetId: dataset?.id ?? null,
      symbols,
      from: request.period.from,
      to: request.period.to,
      initialCash: String(request.capital.initialCash),
      maxPositions: String(request.risk.maxPositions),
      commissionProfileId: request.execution.commissionProfileId,
      slippageProfileId: request.execution.slippageProfileId,
      randomSeed: String(request.randomSeed),
    },
    notes,
  };
}
