export interface RebalanceActivation {
  /** 실제로 전략에 isRebalanceBar=true가 전달되는 봉 시각 */
  readonly tsMs: number;
  /** 정렬된 전체 거래 타임라인에서의 위치 */
  readonly timelineIndex: number;
  /** 같은 봉까지 활성화된 가장 마지막 schedule 항목의 위치 */
  readonly scheduleIndex: number;
}

export interface RebalanceSpacingViolation {
  readonly previous: RebalanceActivation;
  readonly current: RebalanceActivation;
  /** 두 리밸런스 봉 사이의 비리밸런스 실제 거래 봉 수 */
  readonly gapBars: number;
}

/**
 * 엔진의 schedule 활성화 규칙을 부작용 없이 그대로 계산한다.
 *
 * - 휴일 schedule은 그 이후 첫 실제 봉에서 활성화된다.
 * - 실제 봉 하나 사이에 schedule이 여러 번 바뀌면 가장 마지막 항목만 활성화된다.
 * - warm-up 구간은 멤버십만 전진시키고 리밸런스 신호를 소비하지 않는다.
 */
export function computeRebalanceActivations(
  timeline: readonly number[],
  schedule: readonly { readonly fromTsMs: number }[],
  tradeFromTsMs?: number,
): RebalanceActivation[] {
  if (timeline.length === 0 || schedule.length === 0) return [];

  const sortedTimeline = [...new Set(timeline)].sort((a, b) => a - b);
  const sortedSchedule = [...schedule].sort((a, b) => a.fromTsMs - b.fromTsMs);
  const activations: RebalanceActivation[] = [];
  let scheduleIndex = 0;
  let activatedScheduleIndex = -1;

  for (let timelineIndex = 0; timelineIndex < sortedTimeline.length; timelineIndex += 1) {
    const tsMs = sortedTimeline[timelineIndex] as number;
    while (
      scheduleIndex + 1 < sortedSchedule.length
      && (sortedSchedule[scheduleIndex + 1] as { fromTsMs: number }).fromTsMs <= tsMs
    ) {
      scheduleIndex += 1;
    }

    if (tradeFromTsMs !== undefined && tsMs < tradeFromTsMs) continue;
    if (activatedScheduleIndex === scheduleIndex) continue;
    if ((sortedSchedule[scheduleIndex] as { fromTsMs: number }).fromTsMs > tsMs) continue;

    activations.push({ tsMs, timelineIndex, scheduleIndex });
    activatedScheduleIndex = scheduleIndex;
  }

  return activations;
}

/** 첫 번째 간격 위반만 반환한다 — 제출 오류는 사용자가 바로 고칠 한 사례면 충분하다. */
export function findRebalanceSpacingViolation(
  timeline: readonly number[],
  schedule: readonly { readonly fromTsMs: number }[],
  requiredGapBars: number,
  tradeFromTsMs?: number,
): RebalanceSpacingViolation | null {
  if (requiredGapBars <= 0) return null;
  const activations = computeRebalanceActivations(timeline, schedule, tradeFromTsMs);
  for (let index = 1; index < activations.length; index += 1) {
    const previous = activations[index - 1] as RebalanceActivation;
    const current = activations[index] as RebalanceActivation;
    const gapBars = current.timelineIndex - previous.timelineIndex - 1;
    if (gapBars < requiredGapBars) return { previous, current, gapBars };
  }
  return null;
}

export function rebalanceSpacingViolationMessage(
  strategyName: string,
  requiredGapBars: number,
  violation: RebalanceSpacingViolation,
): string {
  const previousDate = new Date(violation.previous.tsMs).toISOString().slice(0, 10);
  const currentDate = new Date(violation.current.tsMs).toISOString().slice(0, 10);
  return (
    `${strategyName} 전략은 매도 다음 실제 거래 봉을 매수 단계로 사용하므로 연속 리밸런스를 처리할 수 없습니다. `
    + `${previousDate}와 ${currentDate} 활성화 사이의 비리밸런스 거래 봉은 `
    + `${violation.gapBars}개입니다(최소 ${requiredGapBars}개 필요). 리밸런싱 주기를 늘리세요.`
  );
}
