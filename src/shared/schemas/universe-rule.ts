import { z } from 'zod';
import { MAX_UNIVERSE_SYMBOLS } from './universe-limit.js';

/**
 * 백테스트 유니버스 규칙 — 시총 상위 N 만 지원한다(PER·PBR 등은 원자료 미수집).
 *
 * markets 를 배열로 두면서 길이를 1로 제약하는 이유는 워커가 봉 캘린더를 단일
 * 시장 기준으로만 다루기 때문이다(멀티 시장 봉 병합은 아직 없다). 스키마를
 * 배열로 둔 것은 이 제약이 풀릴 때 필드 형태를 바꾸지 않고 length 검증만 없애면
 * 되게 하려는 선택이다.
 */
export const universeRuleSchema = z.object({
  markets: z.array(z.enum(['KOSPI', 'KOSDAQ'])).length(1),
  topN: z.number().int().min(1).max(MAX_UNIVERSE_SYMBOLS),
  sortKey: z.literal('MKTCAP'),
});
export type UniverseRule = z.infer<typeof universeRuleSchema>;
