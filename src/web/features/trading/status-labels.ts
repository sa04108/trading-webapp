import type { TradingOrderStatus, TradingStatus } from "@shared/schemas/trading";
export const tradingStatusLabel: Record<TradingStatus, string> = { INACTIVE: "비활성", ACTIVE: "활성", STOPPING: "중지 중", ERROR: "오류" };
export const orderStatusLabel: Record<TradingOrderStatus, string> = { CREATED: "주문 준비", SENDING: "전송 중", UNKNOWN: "접수 확인 필요", OPEN: "접수", PARTIAL: "부분 체결", FILLED: "체결 완료", CANCEL_REQUESTED: "취소 중", CANCELLED: "잔량 종료", REJECTED: "거절" };
