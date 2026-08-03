import { z } from 'zod';
import { MAX_UNIVERSE_SYMBOLS } from './universe-limit.js';

export { MAX_UNIVERSE_SYMBOLS };

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
 * `datasetId` xor `universeSnapshotId` (Task 12). 유니버스가 "지금 등록된 종목 집합"
 * (datasetId)인지 "과거 어느 시점에 고정된 KRX 유니버스" (universeSnapshotId)인지는
 * 섞일 수 없다 — 둘 다 있으면 어느 쪽을 신뢰할지 서버가 임의로 골라야 하고, 둘 다
 * 없으면 실행할 유니버스가 없다. `datasetId` 만 있던 시절의 저장된 요청은 그대로
 * 통과한다.
 */
export const backtestRequestSchema = z
  .object({
    strategyId: z.string().min(1),
    parameters: z.record(z.string(), z.unknown()),
    datasetId: z.string().min(1).optional(),
    /** 과거 시점 고정 유니버스 참조 (설계 2026-08-03-krx-historical-universe, Task 12) */
    universeSnapshotId: z.string().min(1).optional(),
    /**
     * 소비 봉 주기 (설계 2026-07-29-backtest-timeframe-design.md).
     * 미지정 = 데이터셋 timeframe (기존 동작). optional 인 이유: 이 필드가 없던
     * 시절의 저장된 요청(복제·재실행)이 현재 스키마로도 파싱돼야 한다.
     */
    timeframe: z.enum(['1m', '1h', '1d']).optional(),
    universe: z.object({
      type: z.literal('SYMBOLS'),
      /** 상한의 근거는 `MAX_UNIVERSE_SYMBOLS` 주석에 있다 */
      symbols: z
        .array(z.string().regex(/^[A-Za-z0-9._-]{1,20}$/))
        .min(1)
        .max(MAX_UNIVERSE_SYMBOLS),
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
  })
  .refine((value) => (value.datasetId !== undefined) !== (value.universeSnapshotId !== undefined), {
    message: 'datasetId와 universeSnapshotId 중 정확히 하나를 지정해야 합니다.',
    path: ['datasetId'],
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
