import { z } from 'zod';

export const BENCHMARK_IDS = ['KOSPI', 'KOSDAQ'] as const;
export const benchmarkIdSchema = z.enum(BENCHMARK_IDS);
export type BenchmarkId = z.infer<typeof benchmarkIdSchema>;

export const BENCHMARK_NAMES: Record<BenchmarkId, string> = {
  KOSPI: '코스피',
  KOSDAQ: '코스닥',
};

export const benchmarkPointSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  close: z.number().positive(),
});

export const benchmarkPinSchema = z.object({
  benchmarkId: benchmarkIdSchema,
  name: z.string().min(1),
  source: z.literal('KRX_OPEN_API'),
  sourceVersion: z.literal('v1'),
  period: z.object({ from: z.string(), to: z.string() }),
  points: z.array(benchmarkPointSchema),
  covered: z.boolean(),
  missingTradingDays: z.number().int().nonnegative(),
});

export type BenchmarkPin = z.infer<typeof benchmarkPinSchema>;
