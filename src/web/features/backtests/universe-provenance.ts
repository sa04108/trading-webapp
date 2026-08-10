// 확장자 .js 는 실수가 아니다 — tests/unit/universe-provenance-label.test.ts 가 이 모듈을
// import 해 tsconfig.server.json 의 NodeNext 프로그램에 편입되는데, 거기서는 확장자 없는
// 상대 import 가 에러다 (prefill.ts·wizard-steps.ts 와 같은 이유). 이 모듈은 DOM 을
// 쓰지 않고 별칭(@/) import 도 쓰지 않는다.
import type {
  ProvenancePin,
  RebalanceDiagnosticSnapshot,
} from '../../../shared/schemas/provenance-pin.js';

/**
 * 백테스트 결과 화면에 쓰는 유니버스 출처 문구 (Task 14, REVIEW §9.3).
 *
 * 아래 함수는 **제출된 잡의 `ProvenancePin`** 을 입력으로 삼는다. pin 은 제출
 * 시점에 서버가 조립해 저장하는 값이라(Task 12) 아직 제출하지 않은 위저드 검토
 * 단계에는 존재하지 않는다 — 그래서 이 함수들은 결과 화면 전용이고, 위저드 검토
 * 단계는 호출하지 않는다.
 *
 * 손으로 고정한 KRX 스냅샷·데이터셋 경로(옛 `sourceKind: 'KRX_HISTORICAL' | 'DATASET'`)는
 * 데이터셋·스냅샷 개념 전체와 함께 제거됐다(T6, 스펙 2026-08-05) — 지금 서버가 만드는
 * pin 은 늘 `SYMBOL_MASTER` 다. 그래서 이 함수들은 출처별로 분기하지 않는다.
 *
 * "생존자 편향 제거"라는 문구는 어디에도 쓰지 않는다 — 이 기능이 해결하지 않는 항목
 * (신규 상장·상장폐지 반영, 거래정지 구분, 상장폐지 처리, 과거 지수 구성원 복원)이
 * 남아 있어 "제거 완료"라고 말하면 사실과 어긋난다 (REVIEW §9.3).
 *
 * 시점 적합성 경고(`timepointWarning`)를 실을 `provenanceNotice` 는 T6 최종 리뷰에서
 * 제거했다 — `SYMBOL_MASTER` 경로는 그 필드를 채운 적이 없어 늘 빈 배지·문장·경고만
 * 반환하는 죽은 함수였다.
 *
 * `ORDERED_UNIVERSE_PIPELINE` (Task 11, 스펙 2026-08-09)이 새 run 의 유일한
 * `selectionMethod` 값이다. `TOP_MARKET_CAP_N`·`MANUAL_FROM_KRX_SNAPSHOT` 은 그
 * 이전 완료 run 을 읽을 때만 나온다 — 기존 완료 백테스트 결과는 다시 쓰지 않으므로
 * (2026-08-10 결정) 이 분기를 지우지 않는다.
 */

/** RunMetadataCard 「유니버스 출처」행 값. */
export function universeSourceLabel(pin: ProvenancePin | null): string {
  if (pin === null) return '-';
  return '종목 마스터 (유니버스 규칙)';
}

/** RunMetadataCard 「선정 방식」행 값 — 서버 코드값을 사람이 읽는 문구로 바꾼다. */
export function selectionMethodLabel(method: string | null): string {
  if (method === 'ORDERED_UNIVERSE_PIPELINE') return '순서형 유니버스 파이프라인';
  if (method === 'TOP_MARKET_CAP_N') return '시가총액 상위 N종목';
  if (method === 'MANUAL_FROM_KRX_SNAPSHOT') return '수동 선택';
  return '-';
}

/**
 * 리밸런스별 단계 진단 — `ORDERED_UNIVERSE_PIPELINE` pin 에만 있다.
 *
 * 옛 pin·pin 없음은 빈 배열을 답한다. 결과 상세 화면이 리밸런스마다 어느 단계에서
 * 몇 종목이 걸러졌는지, 기준일(`effectiveDate`)이 리밸런스일과 달랐는지를 그대로
 * 보여주려면 이 값을 저장·조회 과정에서 잃지 않아야 한다.
 */
export function provenanceDiagnostics(
  pin: ProvenancePin | null,
): readonly RebalanceDiagnosticSnapshot[] {
  if (pin === null) return [];
  return 'diagnostics' in pin ? pin.diagnostics : [];
}
