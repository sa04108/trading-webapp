/**
 * 종목 코드 형식 — 웹과 서버가 공유하는 계약.
 *
 * 여기 두는 이유: 일괄 추가(쉼표 구분 입력)를 화면이 먼저 검증해야 하는데, 화면과
 * 라우트가 각자 정규식을 들고 있으면 한쪽만 고쳐져 "화면은 통과시키고 서버가 400" 이
 * 되거나 그 반대가 된다. 웹은 `src/server` 를 import 할 수 없어(§7) 공유는 여기뿐이다.
 *
 * zod 를 쓰지 않는다 — 서버 라우트는 이 정규식으로 zod 스키마를 만들고, 화면은
 * 정규식만 쓴다. 프레임워크 없는 모듈이라 어느 쪽에서든 부담 없이 import 한다.
 */
export const SYMBOL_CODE_PATTERN = /^[A-Za-z0-9._-]{1,20}$/;

export function isSymbolCode(value: string): boolean {
  return SYMBOL_CODE_PATTERN.test(value);
}
