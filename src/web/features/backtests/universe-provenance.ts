// 확장자 .js 는 실수가 아니다 — tests/unit/universe-provenance-label.test.ts 가 이 모듈을
// import 해 tsconfig.server.json 의 NodeNext 프로그램에 편입되는데, 거기서는 확장자 없는
// 상대 import 가 에러다 (krx-selection.ts·wizard-steps.ts 와 같은 이유). 이 모듈은 DOM 을
// 쓰지 않고 별칭(@/) import 도 쓰지 않는다.
import type { ProvenancePin } from '../../../shared/schemas/provenance-pin.js';

/**
 * 백테스트 결과 화면에 쓰는 유니버스 출처 문구 (Task 14, REVIEW §9.3).
 *
 * `provenanceNotice` 는 **제출된 잡의 `ProvenancePin`** 을 입력으로 삼는다. pin 은
 * 제출 시점에 서버가 조립해 저장하는 값이라(Task 12) 아직 제출하지 않은 위저드 검토
 * 단계에는 존재하지 않는다 — 그래서 이 함수는 결과 화면 전용이고, 위저드 검토 단계는
 * 이 함수를 호출하지 않는다.
 *
 * 위저드가 KRX 스냅샷을 직접 골라 `krxFixedUniverseBadge` 를 검토 화면에서 함께 부르던
 * 시절이 있었다 — 위저드가 유니버스 규칙 방식으로 바뀌면서(스펙 2026-08-05) 그 경로는
 * 사라졌다. `krxFixedUniverseBadge`·`KRX_HISTORICAL` 분기는 지금도 여기 남아 있는데,
 * 서버가 그 sourceKind 를 더 이상 만들지 않기 때문이다(T6 가 관련 시스템을 통째로
 * 제거하면서 함께 정리한다) — `ProvenancePin.sourceKind` 타입에서 옛 리터럴을 지금
 * 빼면 이 파일이 참조하는 다른 테스트(`universe-provenance-label.test.ts`)가 그 리터럴로
 * pin 을 만들고 있어 함께 깨진다.
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

/**
 * KRX 고정 유니버스 배지 문구 — 결과 화면(`provenanceNotice`, pin 기반)과 위저드 검토
 * 단계(snapshot dto 기반)가 함께 쓴다. 두 화면의 입력이 다르므로 각자 effectiveTradingDate
 * 만 뽑아 이 함수에 넘긴다 — 그래야 문구가 한쪽만 바뀌는 일이 없다.
 */
export function krxFixedUniverseBadge(effectiveTradingDate: string | null): string {
  return `KRX ${effectiveTradingDate ?? '알 수 없는 날짜'} 기준·고정 유니버스`;
}

export function provenanceNotice(pin: ProvenancePin | null): ProvenanceNotice {
  if (pin === null) return { badges: [], sentence: null, warning: null };

  if (pin.sourceKind === 'KRX_HISTORICAL') {
    const date = pin.effectiveTradingDate ?? '알 수 없는 날짜';
    return {
      badges: [krxFixedUniverseBadge(pin.effectiveTradingDate)],
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
