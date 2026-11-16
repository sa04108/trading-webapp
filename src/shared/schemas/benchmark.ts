import { z } from "zod";

export const KRX_BENCHMARK_IDS = ["KOSPI", "KOSDAQ"] as const;
export const FRED_BENCHMARK_IDS = [
  "SP500",
  "NASDAQCOM",
  "NASDAQ100",
  "DJIA",
] as const;
export const BENCHMARK_IDS = [
  ...KRX_BENCHMARK_IDS,
  ...FRED_BENCHMARK_IDS,
] as const;
export const benchmarkIdSchema = z.enum(BENCHMARK_IDS);
export type BenchmarkId = z.infer<typeof benchmarkIdSchema>;
export type KrxBenchmarkId = (typeof KRX_BENCHMARK_IDS)[number];
export type FredBenchmarkId = (typeof FRED_BENCHMARK_IDS)[number];

export const benchmarkSelectionSchema = z.object({
  benchmarkIds: z.array(benchmarkIdSchema).max(BENCHMARK_IDS.length)
    .refine((ids) => new Set(ids).size === ids.length, "벤치마크가 중복되었습니다."),
}).strict();

export interface BenchmarkComparison {
  benchmarkId: BenchmarkId;
  name: string;
  available: boolean;
  unavailableReason: string | null;
  totalReturnPct: number | null;
  maxDrawdownPct: number | null;
  excessReturnPct: number | null;
  /** 조회 기간 첫 값을 0%로 맞춘 표시용 수익률이다. 결과에는 저장하지 않는다. */
  points: Array<{ tsMs: number; value: number }>;
}

export interface BenchmarkComparisons {
  benchmarkIds: BenchmarkId[];
  comparisons: BenchmarkComparison[];
  backfill: {
    benchmarkId: BenchmarkId | null;
    state: "IDLE" | "RUNNING" | "FAILED";
    cursorDate: string | null;
    from: string | null;
    to: string | null;
    error: string | null;
  };
}

export const BENCHMARK_NAMES: Record<BenchmarkId, string> = {
  KOSPI: "코스피",
  KOSDAQ: "코스닥",
  SP500: "S&P 500",
  NASDAQCOM: "나스닥 종합",
  NASDAQ100: "나스닥 100",
  DJIA: "다우존스 산업평균",
};

export const BENCHMARK_SOURCES = {
  KOSPI: "KRX_OPEN_API",
  KOSDAQ: "KRX_OPEN_API",
  SP500: "FRED_API",
  NASDAQCOM: "FRED_API",
  NASDAQ100: "FRED_API",
  DJIA: "FRED_API",
} as const satisfies Record<BenchmarkId, "KRX_OPEN_API" | "FRED_API">;

export const benchmarkPointSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  close: z.number().positive(),
});
export type BenchmarkPoint = z.infer<typeof benchmarkPointSchema>;
