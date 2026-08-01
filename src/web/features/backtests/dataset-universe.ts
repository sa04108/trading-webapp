/**
 * 데이터셋 → 백테스트 유니버스.
 *
 * 데이터셋은 1,000종목까지 담을 수 있고 백테스트 유니버스 상한은 200종목이다. 넘는
 * 데이터셋을 고르면 **정렬 상위 200종목만** 담는다 — 앞에서 200개를 자르면 그 200개는
 * 가나다순 앞자리일 뿐이고, 「거래대금 상위 200종목으로 돌린다」 와는 완전히 다른 실험이 된다.
 *
 * 자르는 순서는 종목 화면의 정렬과 **같은 함수**를 쓴다. 위저드가 자기 정렬을 들면
 * 사용자가 데이터 화면에서 확인한 상위 200종목과 실제로 돌아간 200종목이 달라진다.
 *
 * 위저드가 종목을 하나씩 고르는 UI 를 없앴으므로(D-038) 이것이 유니버스가 정해지는
 * 유일한 경로다. 순수 함수로 떼어 둔 이유도 그것이다 — 컴포넌트 테스트 환경 없이
 * "무엇이 담기는가" 를 직접 검사할 수 있어야 한다. 확장자 .js 는 wizard-steps.ts 와
 * 같은 이유다(tests/unit 이 NodeNext 로 이 모듈을 편입한다).
 */
import { MAX_UNIVERSE_SYMBOLS } from '../../../shared/schemas/universe-limit.js';
import {
  sortSymbols,
  type SortableSymbol,
  type SymbolMetricsMap,
  type SymbolSortKey,
} from '../datasets/symbol-sort.js';

export { MAX_UNIVERSE_SYMBOLS };

export interface UniverseSelection {
  /** 요청에 담을 종목 코드 (정렬 순서) */
  readonly symbols: string[];
  /** 데이터셋 참조 종목 수 */
  readonly total: number;
  /** 상한을 넘어 잘렸는지 */
  readonly truncated: boolean;
  /** 잘려 나간 종목 수 */
  readonly droppedCount: number;
}

export function selectUniverse(
  members: readonly SortableSymbol[],
  sortKey: SymbolSortKey,
  metrics: SymbolMetricsMap,
  limit: number = MAX_UNIVERSE_SYMBOLS,
): UniverseSelection {
  const sorted = sortSymbols(members, sortKey, metrics);
  const symbols = sorted.slice(0, limit).map((member) => member.code);
  return {
    symbols,
    total: members.length,
    truncated: members.length > limit,
    droppedCount: Math.max(0, members.length - limit),
  };
}
