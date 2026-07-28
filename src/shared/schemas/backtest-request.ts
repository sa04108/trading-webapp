import { z } from 'zod';

/** 백테스트 요청 (스펙 §15) — 웹과 서버가 공유하는 계약 */
export const backtestRequestSchema = z.object({
  strategyId: z.string().min(1),
  strategyVersion: z.string().min(1),
  parameters: z.record(z.string(), z.unknown()),
  datasetId: z.string().min(1),
  universe: z.object({
    type: z.literal('SYMBOLS'),
    symbols: z.array(z.string().regex(/^[A-Za-z0-9._-]{1,20}$/)).min(1).max(50),
  }),
  period: z.object({
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  }),
  capital: z.object({
    initialCash: z.number().positive(),
    currency: z.literal('KRW'),
  }),
  execution: z.object({
    fillTiming: z.literal('NEXT_BAR_OPEN'),
    commissionProfileId: z.string().min(1),
    slippageProfileId: z.string().min(1),
  }),
  /** 엔진 리스크 상한 (§9.2-6) — 전략 파라미터가 아니라 요청의 명시 필드다 */
  risk: z.object({
    maxPositions: z.number().int().min(1).max(20),
  }),
  randomSeed: z.number().int().nonnegative().default(42),
});

export type BacktestRequest = z.infer<typeof backtestRequestSchema>;

/**
 * 요청 기간을 UTC epoch ms 구간으로 바꾼다.
 * 제출 검증(backtest-routes)과 실행부(backtest-child)가 **같은 함수**를 써야 한다 —
 * 각자 계산하면 제출 검증은 통과시키는데 실행부는 0봉을 보는 어긋남이 생긴다 (D-024 와 같은 종류).
 */
export function periodToTsRange(period: { from: string; to: string }): {
  fromTsMs: number;
  toTsMs: number;
} {
  return {
    fromTsMs: Date.parse(`${period.from}T00:00:00Z`),
    toTsMs: Date.parse(`${period.to}T23:59:59.999Z`),
  };
}
