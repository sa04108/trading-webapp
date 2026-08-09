/** 청산 사유 한국어 표기 — 엔진의 exitReason 코드를 화면에 그대로 노출하지 않는다 */
const LABELS: Record<string, string> = {
  STOP: '손절',
  // 트레일링 스톱이 진입가 위에서 걸린 청산 — 손절이 아니라 이익 확정
  TRAIL_STOP: '추적 익절',
  TAKE_PROFIT: '익절',
  TREND_END: '추세 반전',
  TIME: '보유 기간 만료',
  RSI_EXIT: 'RSI 회복',
  // 엔진이 강제로 낸 청산 — 전략 신호가 아니다 (Task 8)
  DELISTED: '상장폐지',
  REBALANCE_EXIT: '리밸런스 유니버스 이탈',
};

export function exitReasonLabel(reason: string | null): string {
  if (reason === null) return '-';
  return LABELS[reason] ?? reason;
}
