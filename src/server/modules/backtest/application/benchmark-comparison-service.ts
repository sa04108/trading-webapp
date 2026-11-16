import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { AppDatabase } from "../../../../runtime/shared/db/database.js";
import { backtestJobs } from "../../../../runtime/shared/db/operations-schema.js";
import { isoDateSchema } from "../../../../shared/schemas/backtest-request.js";
import { BENCHMARK_NAMES, benchmarkSelectionSchema, type BenchmarkComparison, type BenchmarkComparisons, type BenchmarkId } from "../../../../shared/schemas/benchmark.js";
import { backtestBenchmarkSelections } from "../../../shared/db/backtest-benchmark-schema.js";
import type { BenchmarkService } from "../../market-data/application/benchmark-service.js";
import { downsampleLttb } from "./downsample.js";
import type { ResultsService } from "./results-service.js";

const periodSchema = z.object({ from: isoDateSchema, to: isoDateSchema }).refine((period) => period.from <= period.to);

export class BenchmarkComparisonService {
  constructor(private readonly db: AppDatabase, private readonly benchmarks: BenchmarkService, private readonly results: ResultsService) {}

  selection(userId: string, jobId: string): BenchmarkId[] {
    const row = this.db.select().from(backtestBenchmarkSelections).where(and(
      eq(backtestBenchmarkSelections.userId, userId), eq(backtestBenchmarkSelections.jobId, jobId),
    )).get();
    // 선택 기록이 없는 기존 결과도 빈 목록으로 시작한다. 옛 실행 요청과 pin은 읽지 않는다.
    if (!row) return [];
    return benchmarkSelectionSchema.parse({ benchmarkIds: JSON.parse(row.benchmarkIdsJson) }).benchmarkIds;
  }

  save(userId: string, jobId: string, benchmarkIds: BenchmarkId[]): void {
    this.db.insert(backtestBenchmarkSelections).values({ userId, jobId, benchmarkIdsJson: JSON.stringify(benchmarkIds) })
      .onConflictDoUpdate({ target: [backtestBenchmarkSelections.userId, backtestBenchmarkSelections.jobId], set: { benchmarkIdsJson: JSON.stringify(benchmarkIds) } }).run();
  }

  get(userId: string, jobId: string): BenchmarkComparisons {
    const benchmarkIds = this.selection(userId, jobId);
    const job = this.db.select({ requestJson: backtestJobs.requestJson }).from(backtestJobs).where(eq(backtestJobs.id, jobId)).get()!;
    const metrics = this.results.getMetrics(jobId);
    const strategyReturn = metrics?.totalReturnPct;
    const comparisons = benchmarkIds.map((benchmarkId): BenchmarkComparison => {
      const empty: BenchmarkComparison = { benchmarkId, name: BENCHMARK_NAMES[benchmarkId], available: false, unavailableReason: null, totalReturnPct: null, maxDrawdownPct: null, excessReturnPct: null, points: [] };
      if (typeof strategyReturn !== "number" || !Number.isFinite(strategyReturn)) return { ...empty, unavailableReason: "백테스트 수익률이 없습니다." };
      try {
        const period = periodSchema.parse(JSON.parse(job.requestJson).period);
        const { points, covered } = this.benchmarks.status(benchmarkId, period.from, period.to);
        if (!covered) return { ...empty, unavailableReason: "조회 기간의 벤치마크 데이터가 부족합니다." };
        if (points.length < 2) return { ...empty, unavailableReason: "비교에 필요한 거래일 데이터가 2개 미만입니다." };
        if (points.some((point) => !Number.isFinite(point.close) || point.close <= 0)) return { ...empty, unavailableReason: "벤치마크 가격이 올바르지 않습니다." };
        const first = points[0]!.close;
        const totalReturnPct = (points.at(-1)!.close / first - 1) * 100;
        const normalized = points.map((point) => ({ tsMs: Date.parse(`${point.date}T00:00:00Z`), value: (point.close / first - 1) * 100 }));
        if (!Number.isFinite(strategyReturn - totalReturnPct) || normalized.some((point) => !Number.isFinite(point.tsMs) || !Number.isFinite(point.value))) return { ...empty, unavailableReason: "벤치마크 수익률을 계산할 수 없습니다." };
        let peak = first;
        let maxDrawdownPct = 0;
        for (const { close } of points) {
          peak = Math.max(peak, close);
          maxDrawdownPct = Math.min(maxDrawdownPct, (close / peak - 1) * 100);
        }
        return { ...empty, available: true, totalReturnPct, maxDrawdownPct, excessReturnPct: strategyReturn - totalReturnPct,
          points: downsampleLttb(normalized, 1_000) };
      } catch {
        return { ...empty, unavailableReason: "벤치마크 비교 데이터를 읽을 수 없습니다." };
      }
    });
    return { benchmarkIds, comparisons, backfill: this.benchmarks.backfillStatus() };
  }
}
