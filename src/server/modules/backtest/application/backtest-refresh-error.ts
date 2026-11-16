/** 최신 기준으로 다시 준비하는 실행은 사용자의 확인 후 별도 작업으로 접수한다. */
export class BacktestRefreshRequiredError extends Error {
  readonly statusCode = 409;
  readonly code = "PREPARATION_REQUIRED";
}
