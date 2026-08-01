// 별칭(`@shared`) 이 아니라 상대 경로 + `.js` 인 이유: 이 모듈의 단위 테스트는
// tsconfig.server.json(NodeNext) 이 타입 검사하고 화면은 tsconfig.web.json(bundler) 이
// 검사한다. 확장자 붙은 상대 경로만 두 해석 방식에서 같이 풀린다.
import { isSymbolCode } from '../../../shared/schemas/symbol-code.js';

/**
 * 일괄 추가 입력 파싱 — 쉼표로 구분된 코드를 목록으로 나눈다.
 *
 * 쉼표만이 아니라 줄바꿈·공백·탭도 구분자로 본다. 코드 목록의 출처는 대개 스프레드시트
 * 한 열이고, 거기서 복사하면 쉼표 대신 줄바꿈으로 온다 — 사용자가 붙여넣기 전에 손으로
 * 쉼표를 넣게 만들 이유가 없다. 뒤에 붙는 쉼표(`005930,`)도 빈 항목을 만들지 않는다.
 *
 * CSV 가져오기와 다른 것: 여기는 **심볼만** 받는다. tohlcv 봉 파일이 아니라 "어떤 종목을
 * 등록할지" 의 목록이므로 파일도 파서도 필요하지 않다.
 *
 * 형식 위반을 조용히 버리지 않고 따로 돌려준다 — 20개를 붙였는데 19개만 들어가면
 * 사용자는 어느 하나가 왜 빠졌는지 알 수 없다.
 */
export interface ParsedSymbolCodes {
  /** 형식이 맞고 중복이 걷힌 코드 — 입력 순서를 지킨다 */
  readonly codes: readonly string[];
  /** 형식 위반 토큰 (중복 제거) */
  readonly invalid: readonly string[];
  /** 입력에서 중복으로 걸러낸 개수 */
  readonly duplicates: number;
}

export function parseSymbolCodes(text: string): ParsedSymbolCodes {
  const tokens = text.split(/[\s,]+/).filter((token) => token.length > 0);
  const codes: string[] = [];
  const invalid: string[] = [];
  const seen = new Set<string>();
  let duplicates = 0;

  for (const token of tokens) {
    if (!isSymbolCode(token)) {
      if (!invalid.includes(token)) invalid.push(token);
      continue;
    }
    if (seen.has(token)) {
      duplicates += 1;
      continue;
    }
    seen.add(token);
    codes.push(token);
  }

  return { codes, invalid, duplicates };
}

/**
 * 이미 등록된 코드를 미리 갈라낸다. 서버도 중복을 건너뛰고 이유를 돌려주지만, 보내기
 * 전에 화면이 먼저 말하는 편이 낫다 — 목록은 이미 받아 둔 것이라 물어볼 필요가 없다.
 */
export function splitRegistered(
  codes: readonly string[],
  registered: ReadonlySet<string>,
): { fresh: readonly string[]; already: readonly string[] } {
  return {
    fresh: codes.filter((code) => !registered.has(code)),
    already: codes.filter((code) => registered.has(code)),
  };
}
