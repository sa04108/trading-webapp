/** 테스트가 실 공급자 키나 외부 네트워크에 의존하지 못하게 기본 fetch를 차단한다. */
const originalFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const raw = input instanceof Request ? input.url : String(input);
  const url = new URL(raw);
  if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
    return Promise.reject(new Error(`테스트 외부 HTTP 차단: ${url.origin}${url.pathname}`));
  return originalFetch(input, init);
};
