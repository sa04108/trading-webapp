import { z } from 'zod';

/**
 * 종목 마스터 API DTO — 웹과 서버가 공유한다.
 *
 * 다른 shared/schemas 파일과 달리 zod 로 정의한다. 태스크 계획이 이 계약을 zod
 * 스키마로 명시했고, 라우트가 응답 형태를 스키마 하나로 검증·타입 추론 양쪽에
 * 쓸 수 있어야 하기 때문이다.
 */
export const symbolMasterEntryDtoSchema = z.object({
  standardCode: z.string(),
  shortCode: z.string(),
  name: z.string(),
  market: z.enum(['KOSPI', 'KOSDAQ']),
  sharesOutstanding: z.string(),
  instrumentType: z.string(),
  listedDate: z.string().nullable(),
});
export type SymbolMasterEntryDto = z.infer<typeof symbolMasterEntryDtoSchema>;

export const symbolMasterUniverseDtoSchema = z.object({
  date: z.string(),
  covered: z.boolean(),
  // covered=false 면 빈 배열이다 — SymbolMasterNotCoveredError 를 던지는 대신 이 형태로 응답한다.
  symbols: z.array(symbolMasterEntryDtoSchema),
});
export type SymbolMasterUniverseDto = z.infer<typeof symbolMasterUniverseDtoSchema>;

export const symbolMasterCoverageDtoSchema = z.object({
  ranges: z.array(z.object({ startDate: z.string(), endDate: z.string() })),
  checkpoints: z.array(
    z.object({
      checkpointDate: z.string(),
      verified: z.boolean(),
      mismatch: z.boolean(),
    }),
  ),
  lastSyncedAtMs: z.number().nullable(),
  backfill: z.object({
    state: z.enum(['IDLE', 'RUNNING', 'BUDGET_EXHAUSTED', 'FAILED']),
    cursorDate: z.string().nullable(),
    error: z.string().nullable(),
  }),
});
export type SymbolMasterCoverageDto = z.infer<typeof symbolMasterCoverageDtoSchema>;

export const symbolMasterSyncDtoSchema = z.object({
  requestedDate: z.string(),
  // 상한까지 거슬러도 재구성 앵커를 못 찾으면 null 이다 — 오류가 아니라 정상 응답이다.
  effectiveTradingDate: z.string().nullable(),
  ingestedDates: z.array(z.string()),
});
export type SymbolMasterSyncDto = z.infer<typeof symbolMasterSyncDtoSchema>;

export const symbolMasterEventDtoSchema = z.object({
  id: z.number(),
  effectiveDate: z.string(),
  standardCode: z.string(),
  eventType: z.string(),
  oldValue: z.string().nullable(),
  newValue: z.string().nullable(),
  observedSpanStart: z.string(),
});
export type SymbolMasterEventDto = z.infer<typeof symbolMasterEventDtoSchema>;
