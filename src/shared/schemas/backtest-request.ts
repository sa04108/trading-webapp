import { z } from 'zod';
import { universeRuleSchema } from './universe-rule.js';

/**
 * 백테스트 요청 (스펙 §15) — 웹과 서버가 공유하는 계약.
 *
 * 전략 버전은 요청에 담지 않는다 (D-029). 클라이언트가 보내 봐야 서버가 실행하는 것은
 * 어차피 레지스트리에 등록된 그 시점의 전략이고, 실행 기록(`backtest_runs.strategy_version`)
 * 도 워커가 등록 버전에서 직접 남긴다. 요청이 버전을 들고 있으면 배포로 버전이 올라간 뒤
 * 열어 둔 화면의 제출이 "버전 불일치" 로 막히기만 했다 — 파라미터가 실제로 안 맞으면
 * 아래 parameters 검증이 잡는다.
 *
 * 이 필드가 있던 시절의 저장된 요청은 그대로 파싱된다 — z.object 는 모르는 키를 버린다.
 *
 * `universeRule` (스펙 2026-08-05) — `datasetId`/`universeSnapshotId`/`universe` 를
 * 대신한다. 유니버스를 "지금 등록된 종목 집합"이나 "과거 어느 시점에 손으로 고정한
 * 스냅샷"으로 들고 다니는 대신, 시총 상위 N 같은 **규칙**만 담는다 — 실제 종목 구성은
 * 제출 시점에 서버가 종목 마스터로 리밸런스 날짜별로 재구성해 잡에 pin 한다
 * (`UniverseRuleResolver`). 옛 필드로 저장된 요청은 이 스키마로 파싱되지 않는다 —
 * 기존 백테스트 잡·런 데이터는 이 변경과 함께 마이그레이션이 정리한다(보존 대상 아님).
 */
export const backtestRequestSchema = z.object({
  strategyId: z.string().min(1),
  parameters: z.record(z.string(), z.unknown()),
  universeRule: universeRuleSchema,
  /** 소비 봉 주기. KRX 일봉이 유일한 출처라 일봉뿐이다 (설계 2026-08-07-price-data-removal). */
  timeframe: z.literal('1d').optional(),
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
