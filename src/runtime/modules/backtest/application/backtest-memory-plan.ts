import { StrategyRegistry } from "../../strategy/application/strategy-registry.js";
import { backtestRequestSchema } from "../../../../shared/schemas/backtest-request.js";

const MIB = 1024 ** 2;
const registry = new StrategyRegistry();
class MemorySamplingError extends Error {}

export interface BacktestMemoryPlan {
  requiredBytes: number;
  minimumBatchBars: number;
}

/** 봉 총량 대신 상주 입력·전략 이력·결과의 크기로 분할 실행의 시작 예산을 추정한다. */
export function backtestMemoryPlan(
  payload: Record<string, unknown>,
  countFacts?: (symbols: readonly string[], throughTsMs: number) => number,
): BacktestMemoryPlan {
  const minimumBatchBars = 256;
  // 런타임·SQLite의 기본 몫과 GC/네이티브 할당 여유다. 추정과 별도로 실행 중 RSS를 감시한다.
  const baselineBytes = 160 * MIB;
  const safetyBytes = 32 * MIB;
  const fallback = { requiredBytes: baselineBytes + safetyBytes + MIB, minimumBatchBars };
  try {
    const request = backtestRequestSchema.parse(JSON.parse(String(payload.requestJson)));
    const schedule: unknown = JSON.parse(String(payload.universeScheduleJson));
    if (!Array.isArray(schedule)) return fallback;
    const symbols = new Set<string>();
    for (const entry of schedule) {
      if (!entry || !Array.isArray(entry.symbols)) return fallback;
      for (const symbol of entry.symbols) symbols.add(String(symbol));
    }
    const strategy = registry.get(request.strategyId);
    const parameters = registry.validateParameters(request.strategyId, request.parameters);
    if (!strategy?.historyLookbackBars || !parameters.ok) return fallback;
    const lookback = strategy.historyLookbackBars(parameters.value);
    if (!Number.isSafeInteger(lookback) || lookback < 1) return fallback;
    const days = Math.max(1, Math.ceil((Date.parse(request.period.to) - Date.parse(request.period.from)) / 86_400_000) + 1);
    const years = Math.ceil(days / 365) + 4;
    const batchBars = Math.max(minimumBatchBars, symbols.size);
    const pinnedBytes = ["requestJson", "universeScheduleJson", "universeJson", "benchmarkJson"]
      .reduce((bytes, key) => bytes + Buffer.byteLength(String(payload[key] ?? "")), 0);
    // 최근 이력은 typed array, 결과는 날짜별 평가와 포지션별 거래가 누적된다.
    // 가격 전략도 현재 워커에서는 재무 팩트를 읽는다. 게시 스냅샷의 행 수로 몫을 잡는다.
    const historyBytes = symbols.size * lookback * 64;
    const resultBytes = days * (512 + request.risk.maxPositions * 256);
    let factsBytes = symbols.size * years * 8 * 1024;
    if (countFacts) {
      try {
        const rows = countFacts([...symbols], Date.parse(request.period.to) + 86_400_000 - 1);
        if (!Number.isSafeInteger(rows) || rows < 0) throw new Error("잘못된 팩트 행 수");
        factsBytes = rows * 512;
      } catch (error) {
        throw new MemorySamplingError("게시 스냅샷의 입력 메모리를 확인하지 못했습니다", { cause: error });
      }
    }
    const requiredBytes = baselineBytes + safetyBytes + pinnedBytes * 4 + historyBytes +
      resultBytes + factsBytes + symbols.size * 2048 + batchBars * 1024;
    return { requiredBytes: Math.ceil(requiredBytes / MIB) * MIB, minimumBatchBars: batchBars };
  } catch (error) {
    // 측정 실패를 작은 입력으로 간주하면 같은 작업을 과소 배정하게 된다.
    if (error instanceof MemorySamplingError) throw error;
    // 손상된 입력을 자원 대기에 영구 가두지 않고 워커의 기존 입력 검증으로 보낸다.
    return fallback;
  }
}

/** 하루의 전체 종목은 유지하고 상주 상태를 제외한 예산만 다음 조회 묶음에 쓴다. */
export function backtestBatchBars(budgetBytes: number, plan: BacktestMemoryPlan): number {
  const residentBytes = plan.requiredBytes - plan.minimumBatchBars * 1024;
  return Math.max(plan.minimumBatchBars, Math.min(8192, Math.floor((budgetBytes - residentBytes) / 1024)));
}
