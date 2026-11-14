const MIB = 1024 ** 2;

/** 부모와 각 isolate의 native/SQLite 여유까지 확보한 뒤에만 내부 병렬화를 켠다. */
export function universeParallelism(budgetBytes: number, cpuBudget: number): number {
  const count = Math.min(4, Math.floor(cpuBudget), Math.floor((budgetBytes - 192 * MIB) / (256 * MIB)));
  return Number.isFinite(count) && count >= 2 ? count : 0;
}

/** 전체 예산의 일부만 isolate 힙에 배정하고 나머지는 부모와 공유·native 메모리에 남긴다. */
export function universeThreadHeapMb(budgetBytes: number, parallelism: number): number {
  return Math.min(1024, Math.max(128, Math.floor(budgetBytes / parallelism / 4 / MIB)));
}

/** 병렬 준비의 부모와 워커가 같은 실제 old-space 한도를 사용한다. */
export function preparationHeapMb(budgetBytes: number, cpuBudget: number, fallbackHeapMb: number): number {
  const parallelism = universeParallelism(budgetBytes, cpuBudget);
  return parallelism ? Math.min(fallbackHeapMb, universeThreadHeapMb(budgetBytes, parallelism)) : fallbackHeapMb;
}
