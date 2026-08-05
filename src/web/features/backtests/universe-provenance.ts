// 확장자 .js 는 실수가 아니다 — tests/unit/universe-provenance-label.test.ts 가 이 모듈을
// import 해 tsconfig.server.json 의 NodeNext 프로그램에 편입되는데, 거기서는 확장자 없는
// 상대 import 가 에러다 (prefill.ts·wizard-steps.ts 와 같은 이유). 이 모듈은 DOM 을
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
 * 손으로 고정한 KRX 스냅샷·데이터셋 경로(옛 `sourceKind: 'KRX_HISTORICAL' | 'DATASET'`)는
 * 데이터셋·스냅샷 개념 전체와 함께 제거됐다(T6, 스펙 2026-08-05) — 지금 서버가 만드는
 * pin 은 늘 `SYMBOL_MASTER` 다. 그래서 이 함수는 더 이상 출처별로 분기하지 않는다.
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
  return { badges: [], sentence: null, warning: pin.timepointWarning };
}

/** RunMetadataCard 「유니버스 출처」행 값. */
export function universeSourceLabel(pin: ProvenancePin | null): string {
  if (pin === null) return '-';
  return '종목 마스터 (유니버스 규칙)';
}

/** RunMetadataCard 「선정 방식」행 값 — 서버 코드값을 사람이 읽는 문구로 바꾼다. */
export function selectionMethodLabel(method: string | null): string {
  if (method === 'TOP_MARKET_CAP_N') return '시가총액 상위 N종목';
  if (method === 'MANUAL_FROM_KRX_SNAPSHOT') return '수동 선택';
  return '-';
}
