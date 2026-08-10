import type { UniverseCriterion, UniverseStage } from '../../../shared/schemas/universe-rule.js';

/** 첫 단계만 이 값까지 허용한다 — 뒤 단계는 항상 직전 단계 값이 상한이다 (스키마와 같은 값) */
export const FIRST_STAGE_LIMIT_MAX = 200;

/** 급하락 단계를 새로 추가할 때 붙이는 기본 조회기간 — 편집기가 곧바로 유효한 값을 보여주기 위함 */
export const DEFAULT_DECLINE_LOOKBACK_TRADING_DAYS = 20;

const MAX_STAGE_COUNT = 5;

export interface PipelineUpdate {
  stages: UniverseStage[];
  changedIndices: number[];
}

/**
 * 앞 단계보다 큰 N 을 만나면 `min(existing, previous)` 로 뒤 단계까지 깎는다.
 *
 * 첫 원소는 절대 건드리지 않는다 — 상한이 없는 유일한 단계다. 편집기가 add·remove·
 * move·changeLimit 뒤 항상 이 함수를 거치므로, 어느 조작을 거쳐도 "다음 단계 N 은
 * 직전 단계 N 이하" 라는 스키마 불변식이 화면에서도 항상 성립한다.
 */
function cascadeLimits(stages: readonly UniverseStage[]): PipelineUpdate {
  const result = stages.map((stage) => ({ ...stage }));
  const changedIndices: number[] = [];
  for (let i = 1; i < result.length; i += 1) {
    const cap = result[i - 1]!.limit;
    if (result[i]!.limit > cap) {
      result[i] = { ...result[i]!, limit: cap };
      changedIndices.push(i);
    }
  }
  return { stages: result, changedIndices };
}

export function addStage(
  stages: readonly UniverseStage[],
  criterion: UniverseCriterion,
): PipelineUpdate {
  if (stages.some((stage) => stage.criterion === criterion)) {
    throw new Error(`이미 사용한 기준은 다시 추가할 수 없습니다: ${criterion}`);
  }
  if (stages.length >= MAX_STAGE_COUNT) {
    throw new Error(`유니버스 단계는 최대 ${MAX_STAGE_COUNT}개까지 추가할 수 있습니다.`);
  }
  const previous = stages[stages.length - 1];
  const limit = previous ? previous.limit : FIRST_STAGE_LIMIT_MAX;
  const newStage: UniverseStage =
    criterion === 'DECLINE'
      ? { criterion, limit, lookbackTradingDays: DEFAULT_DECLINE_LOOKBACK_TRADING_DAYS }
      : { criterion, limit };
  return cascadeLimits([...stages, newStage]);
}

export function removeStage(stages: readonly UniverseStage[], index: number): PipelineUpdate {
  if (stages.length <= 1) {
    throw new Error('유니버스 단계는 최소 1개가 있어야 합니다.');
  }
  return cascadeLimits(stages.filter((_, i) => i !== index));
}

export function moveStage(
  stages: readonly UniverseStage[],
  from: number,
  to: number,
): PipelineUpdate {
  const next = [...stages];
  const moved = next[from];
  if (moved === undefined || to < 0 || to >= next.length) {
    return { stages: next, changedIndices: [] };
  }
  next.splice(from, 1);
  next.splice(to, 0, moved);
  return cascadeLimits(next);
}

export function changeStageLimit(
  stages: readonly UniverseStage[],
  index: number,
  limit: number,
): PipelineUpdate {
  const next = stages.map((stage, i) => (i === index ? { ...stage, limit } : stage));
  return cascadeLimits(next);
}
