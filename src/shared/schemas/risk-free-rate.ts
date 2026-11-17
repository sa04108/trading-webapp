import { z } from "zod";

const date = z.iso.date();
const rate = z.number().finite().min(-100).max(100);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const series = z.enum(["KRW_MSB_91D", "KRW_CD_91D"]);

export const rateChangeSchema = z.object({ date, annualRatePct: rate });
export type RateChange = z.infer<typeof rateChangeSchema>;

/** 변경일 이후 다음 변경 전까지 같은 금리를 적용한다. 조회 범위 밖으로는 연장하지 않는다. */
export const riskFreeRateHistorySchema = z.object({
  series,
  coveredFrom: date,
  coveredTo: date,
  source: z.enum(["USER_CSV", "USER_CSV_AND_ECOS"]),
  sourceSha256: hash,
  version: hash,
  changes: z.array(rateChangeSchema).min(1).max(100_000),
}).superRefine((value, ctx) => {
  if (value.coveredFrom > value.coveredTo || value.changes[0]?.date !== value.coveredFrom ||
    value.changes.some((entry, index) => entry.date > value.coveredTo ||
      (index > 0 && (entry.date <= value.changes[index - 1]!.date || entry.annualRatePct === value.changes[index - 1]!.annualRatePct)))) {
    ctx.addIssue({ code: "custom", message: "금리 변경 이력의 날짜·범위·변경 순서가 올바르지 않습니다" });
  }
});
export type RiskFreeRateHistory = z.infer<typeof riskFreeRateHistorySchema>;

/** 조회 때 금리를 다시 계산하지 않도록 실행 당시 적용 범위와 이력 식별자를 보존한다. */
export const sharpeBasisSchema = z.object({
  method: z.literal("DATED_RATE_CHANGES"),
  convention: z.literal("DAILY_SAMPLE_SD_ANNUALIZED_252"),
  series,
  averageAnnualRatePct: rate.nullable(),
  minAnnualRatePct: rate.nullable(),
  maxAnnualRatePct: rate.nullable(),
  observationCount: z.number().int().nonnegative(),
  missingRateDays: z.number().int().nonnegative(),
  coveredFrom: date,
  coveredTo: date,
  historyVersion: hash,
  source: z.enum(["USER_CSV", "USER_CSV_AND_ECOS"]),
});
export type SharpeBasis = z.infer<typeof sharpeBasisSchema>;

export function rateSeriesLabel(value: SharpeBasis["series"]): string {
  return value === "KRW_MSB_91D" ? "통안증권 91일물" : "CD 91일물";
}
