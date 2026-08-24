import { describe, expect, it } from 'vitest';
import {
  computeRebalanceActivations,
  findRebalanceSpacingViolation,
} from '../../src/server/modules/backtest/domain/rebalance-spacing.js';

const DAY = 86_400_000;
const MONDAY = Date.UTC(2026, 0, 5);

describe('리밸런스 실제 거래 봉 간격', () => {
  it('휴일 schedule은 다음 실제 거래 봉에서 활성화한다', () => {
    const timeline = [MONDAY, MONDAY + DAY, MONDAY + 2 * DAY];
    const activations = computeRebalanceActivations(
      timeline,
      [
        { fromTsMs: MONDAY - 2 * DAY }, // 토요일 → 월요일
        { fromTsMs: MONDAY + DAY },
      ],
    );

    expect(activations.map(({ tsMs }) => tsMs)).toEqual([MONDAY, MONDAY + DAY]);
  });

  it('실제 봉 하나 사이에서 schedule이 여러 번 바뀌면 마지막 항목만 활성화한다', () => {
    const timeline = [MONDAY, MONDAY + 3 * DAY];
    const activations = computeRebalanceActivations(
      timeline,
      [
        { fromTsMs: MONDAY },
        { fromTsMs: MONDAY + DAY },
        { fromTsMs: MONDAY + 2 * DAY },
      ],
    );

    expect(activations).toEqual([
      { tsMs: MONDAY, timelineIndex: 0, scheduleIndex: 0 },
      { tsMs: MONDAY + 3 * DAY, timelineIndex: 1, scheduleIndex: 2 },
    ]);
  });

  it('warm-up 중 바뀐 schedule은 거래 시작 첫 봉에서 최신 항목 하나만 활성화한다', () => {
    const timeline = [MONDAY, MONDAY + DAY, MONDAY + 2 * DAY];
    const activations = computeRebalanceActivations(
      timeline,
      [{ fromTsMs: MONDAY }, { fromTsMs: MONDAY + DAY }],
      MONDAY + 2 * DAY,
    );

    expect(activations).toEqual([
      { tsMs: MONDAY + 2 * DAY, timelineIndex: 2, scheduleIndex: 1 },
    ]);
  });

  it('연속 실제 거래 봉의 리밸런스를 간격 위반으로 찾는다', () => {
    const violation = findRebalanceSpacingViolation(
      [MONDAY, MONDAY + DAY, MONDAY + 2 * DAY],
      [{ fromTsMs: MONDAY }, { fromTsMs: MONDAY + DAY }],
      1,
    );

    expect(violation?.gapBars).toBe(0);
    expect(violation?.previous.tsMs).toBe(MONDAY);
    expect(violation?.current.tsMs).toBe(MONDAY + DAY);
  });

  it('리밸런스 사이에 비리밸런스 실제 거래 봉이 하나 있으면 허용한다', () => {
    const violation = findRebalanceSpacingViolation(
      [MONDAY, MONDAY + DAY, MONDAY + 2 * DAY],
      [{ fromTsMs: MONDAY }, { fromTsMs: MONDAY + 2 * DAY }],
      1,
    );

    expect(violation).toBeNull();
  });

  it('입력 순서·중복과 기간 뒤 schedule은 판정을 바꾸지 않는다', () => {
    const activations = computeRebalanceActivations(
      [MONDAY + 2 * DAY, MONDAY, MONDAY + DAY, MONDAY + DAY],
      [
        { fromTsMs: MONDAY + 10 * DAY },
        { fromTsMs: MONDAY + 2 * DAY },
        { fromTsMs: MONDAY },
      ],
    );

    expect(activations.map(({ tsMs }) => tsMs)).toEqual([MONDAY, MONDAY + 2 * DAY]);
  });

  it('간격 요구가 없는 전략은 연속 활성화도 제한하지 않는다', () => {
    expect(findRebalanceSpacingViolation(
      [MONDAY, MONDAY + DAY],
      [{ fromTsMs: MONDAY }, { fromTsMs: MONDAY + DAY }],
      0,
    )).toBeNull();
  });
});
