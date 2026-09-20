/** 승인·로컬 복구가 필요한 입력을 일반 오류나 quota 재시도로 바꾸지 않는다. */
export class ProviderRequestBlockedError extends Error {
  readonly statusCode = 409;
  constructor(readonly reason: string, readonly requestKey: string, readonly evidence: string) {
    super(`${reason}: ${requestKey} (${evidence})`);
  }
}
