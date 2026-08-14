import { z } from 'zod';

export const KRX_BENCHMARK_IDS = ['KOSPI', 'KOSDAQ'] as const;
export const FRED_BENCHMARK_IDS = ['SP500', 'NASDAQCOM', 'NASDAQ100', 'DJIA'] as const;
export const BENCHMARK_IDS = [...KRX_BENCHMARK_IDS, ...FRED_BENCHMARK_IDS] as const;
export const benchmarkIdSchema = z.enum(BENCHMARK_IDS);
export type BenchmarkId = z.infer<typeof benchmarkIdSchema>;
export type KrxBenchmarkId = (typeof KRX_BENCHMARK_IDS)[number];
export type FredBenchmarkId = (typeof FRED_BENCHMARK_IDS)[number];

export const BENCHMARK_NAMES: Record<BenchmarkId, string> = {
  KOSPI: '코스피',
  KOSDAQ: '코스닥',
  SP500: 'S&P 500',
  NASDAQCOM: '나스닥 종합',
  NASDAQ100: '나스닥 100',
  DJIA: '다우존스 산업평균',
};

export const BENCHMARK_SOURCES = {
  KOSPI: 'KRX_OPEN_API',
  KOSDAQ: 'KRX_OPEN_API',
  SP500: 'FRED_API',
  NASDAQCOM: 'FRED_API',
  NASDAQ100: 'FRED_API',
  DJIA: 'FRED_API',
} as const satisfies Record<BenchmarkId, 'KRX_OPEN_API' | 'FRED_API'>;

export const benchmarkPointSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  close: z.number().positive(),
});
export type BenchmarkPoint = z.infer<typeof benchmarkPointSchema>;

export const benchmarkPinSchema = z.object({
  benchmarkId: benchmarkIdSchema,
  name: z.string().min(1),
  source: z.enum(['KRX_OPEN_API', 'FRED_API']),
  sourceVersion: z.literal('v1'),
  period: z.object({ from: z.string(), to: z.string() }),
  points: z.array(benchmarkPointSchema),
  covered: z.boolean(),
});

export type BenchmarkPin = z.infer<typeof benchmarkPinSchema>;
