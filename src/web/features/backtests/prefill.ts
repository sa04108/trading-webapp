// 확장자 .js 는 실수가 아니다 — tests/unit/prefill.test.ts 가 이 모듈을 import 해
// tsconfig.server.json 의 NodeNext 프로그램에 편입되는데, 거기서는 확장자 없는 상대
// import 가 에러다 (tests/unit/api-client.test.ts 와 같은 이유). 따라서 이
// 모듈은 계속 DOM 을 쓰지 않고 별칭(@/) import 도 쓰지 않아야 한다.
import type { UniverseRule } from '../../../shared/schemas/universe-rule.js';
import type { BacktestRequestBody } from './types.js';
import type { BenchmarkId } from '../../../shared/schemas/benchmark.js';

/** 위저드 입력 상태 — 폼이므로 전부 문자열로 보관한다 (universeRule 은 예외다, 아래 참고) */
export interface WizardFormState {
  strategyId: string | null;
  parameters: Record<string, string>;
  /** 소비 봉 주기 — '' 는 유니버스 기본 */
  timeframe: string;
  /**
   * 유니버스 규칙 (스펙 2026-08-05) — 문자열로 흩어 두지 않는다. 시장·상위 N 은 이미
   * `UniverseRuleStep` 이 유효한 값만 커밋하는 controlled 값이라, 여기서 다시 문자열로
   * 풀었다 파싱하면 그 유효성 보장이 두 곳에서 따로 반복된다.
   */
  universeRule: UniverseRule;
  benchmarkId: BenchmarkId;
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
}

export interface CloneSchemaPrefillState {
  sourceJobId: string | null;
  prefilledSourceJobId: string | null;
  strategyId: string | null;
  schemaReady: boolean;
  schemaFailed: boolean;
}

/**
 * 복제 초안이 폼에 들어간 뒤에도 원본 전략 스키마가 도착할 때까지 프리필을 끝내지 않는다.
 * 스키마 없이 원본 파라미터를 파싱하면 빈 객체가 되어, 재사용 가능한 원본 미리보기를
 * 다른 설정으로 오판하고 URL 단계까지 앞쪽으로 접는 경합이 생긴다.
 */
export function isCloneStrategySchemaPending(state: CloneSchemaPrefillState): boolean {
  return (
    state.sourceJobId !== null &&
    state.prefilledSourceJobId === state.sourceJobId &&
    state.strategyId !== null &&
    !state.schemaReady &&
    !state.schemaFailed
  );
}

/**
 * 저장된 요청을 위저드 폼 상태로 옮긴다 (D-025).
 *
 * 원본이 가리키는 전략이 그 사이 사라질 수 있다 — 조용히 통과시키면 사용자가 모르고
 * 제출한다. 없는 전략은 비우고 무엇이 빠졌는지 notes 로 알린다.
 *
 * 유니버스는 더 이상 참조가 아니라 규칙(`universeRule`)이라 "사라짐" 이 없다 — 시장·
 * 상위 N 은 그 자체로 완결된 값이고, 실제 종목 구성은 위저드가 유니버스 단계에서 다시
 * 미리보기해야 얻는다(제출 시점에 서버가 새로 재구성하므로, 프리필이 옛 종목 목록을
 * 들고 있어도 의미가 없다).
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

  return {
    state: {
      strategyId: strategyExists ? request.strategyId : null,
      // 전략이 없으면 파라미터도 의미가 없다 — 새로 고른 전략의 기본값이 채워진다
      parameters: strategyExists
        ? Object.fromEntries(
            Object.entries(request.parameters).map(([key, value]) => [key, String(value)]),
          )
        : {},
      timeframe: request.timeframe ?? '',
      universeRule: request.universeRule,
      benchmarkId: request.benchmarkId ?? 'KOSPI',
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
