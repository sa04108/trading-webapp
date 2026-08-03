// 확장자 .js 는 실수가 아니다 — tests/unit/universe-provenance-label.test.ts 가 이 모듈을
// import 해 tsconfig.server.json 의 NodeNext 프로그램에 편입되는데, 거기서는 확장자 없는
// 상대 import 가 에러다 (krx-selection.ts·wizard-steps.ts 와 같은 이유). 이 모듈은 DOM 을
// 쓰지 않고 별칭(@/) import 도 쓰지 않는다.
import type { ProvenancePin } from '../../../shared/schemas/provenance-pin.js';

/**
 * 결과·검토 화면에 쓰는 유니버스 출처 문구 (Task 14, REVIEW §9.3).
 *
 * `provenancePin` 하나로 배지·안내문·경고를 함께 만든다 — 위저드 검토 단계와 결과
 * 페이지가 같은 규칙으로 문구를 만들게 하려면 순수 함수 하나로 모아야 나중에 두 화면의
 * 표현이 갈라지지 않는다.
 *
 * "생존자 편향 제거"라는 문구는 어디에도 쓰지 않는다 — 이 기능이 해결하지 않는 항목
 * (신규 상장·상장폐지 반영, 거래정지 구분, 상장폐지 처리, 과거 지수 구성원 복원)이
 * 남아 있어 "제거 완료"라고 말하면 사실과 어긋난다 (REVIEW §9.3).
 */
export interface ProvenanceNotice {
  readonly badges: readonly string[];
  readonly sentence: string | null;
  readonly warning: string | null;
}

export function provenanceNotice(pin: ProvenancePin | null): ProvenanceNotice {
  if (pin === null) return { badges: [], sentence: null, warning: null };

  if (pin.sourceKind === 'KRX_HISTORICAL') {
    const date = pin.effectiveTradingDate ?? '알 수 없는 날짜';
    return {
      badges: [`KRX ${date} 기준·고정 유니버스`],
      sentence:
        `이 실행은 ${date}의 KRX 종목·시가총액으로 구성한 고정 유니버스를 전체 ` +
        '기간에 사용했습니다. 기간 중 시가총액 재산정이나 종목 편입·편출은 수행하지 ' +
        '않았습니다.',
      warning: pin.timepointWarning,
    };
  }

  // DATASET 경로 — 과거 시점 적합성을 보증할 방법이 없다는 사실 자체가 안내문이다.
  // 「고정 유니버스」 배지·문장은 KRX 스냅샷 전용이라 여기서는 만들지 않는다.
  return { badges: [], sentence: null, warning: pin.timepointWarning };
}

/** RunMetadataCard 「유니버스 출처」행 값. pin 이 없으면 데이터셋 경로로 취급한다. */
export function universeSourceLabel(pin: ProvenancePin | null): string {
  if (pin?.sourceKind === 'KRX_HISTORICAL') {
    return `KRX ${pin.effectiveTradingDate ?? '알 수 없는 날짜'} 스냅샷`;
  }
  return '데이터셋';
}

/** RunMetadataCard 「선정 방식」행 값 — 서버 코드값을 사람이 읽는 문구로 바꾼다. */
export function selectionMethodLabel(method: string | null): string {
  if (method === 'TOP_MARKET_CAP_N') return '시가총액 상위 N종목';
  if (method === 'MANUAL_FROM_KRX_SNAPSHOT') return '수동 선택';
  return '-';
}
