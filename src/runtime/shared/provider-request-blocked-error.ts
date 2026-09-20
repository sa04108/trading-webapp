/** 입력 무결성 오류와 게시·재시도 대기를 일반 실패로 바꾸지 않는다. */
export class ProviderRequestBlockedError extends Error {
  readonly statusCode = 409;
  constructor(readonly reason: string, readonly requestKey: string, readonly evidence: string, readonly retryAfterMs?: number) {
    super(`${reason}: ${requestKey} (${evidence})`);
  }
}
