import { z } from 'zod';

/** 백테스트 요청 (스펙 §15) — 웹과 서버가 공유하는 계약 */
export const backtestRequestSchema = z.object({
  strategyId: z.string().min(1),
  strategyVersion: z.string().min(1),
  parameters: z.record(z.string(), z.unknown()),
  datasetId: z.string().min(1),
  /**
   * 소비 봉 주기 (설계 2026-07-29-backtest-timeframe-design.md).
   * 미지정 = 데이터셋 timeframe (기존 동작). optional 인 이유: 이 필드가 없던
   * 시절의 저장된 요청(복제·재실행)이 현재 스키마로도 파싱돼야 한다.
   */
  timeframe: z.enum(['1m', '1h', '1d']).optional(),
  universe: z.object({
    type: z.literal('SYMBOLS'),
    /**
     * 상한 200 — 횡단면 랭킹 전략은 유니버스가 좁으면 '상위 N 선별' 이 의미를 잃는다
     * (설계 2026-07-29-quant-strategies-and-fact-store-design.md). 확대이므로
     * 저장된 과거 요청(복제·재실행)은 그대로 유효하다.
     * 메모리 상한은 여기가 아니라 MAX_BACKTEST_BARS 가 지킨다 (bar-estimate.ts).
     */
    symbols: z.array(z.string().regex(/^[A-Za-z0-9._-]{1,20}$/)).min(1).max(200),
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
