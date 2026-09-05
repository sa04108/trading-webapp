import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

export const DEFAULT_BENCHMARK_REQUEST = {
  universeRule: {
    markets: ['KOSDAQ'],
    stages: [
      { criterion: 'MARKET_CAP', direction: 'HIGH', limit: 200 },
      { criterion: 'DECLINE', direction: 'HIGH', limit: 50, lookbackTradingDays: 20 },
    ],
    rebalanceInterval: { unit: 'MONTH', value: 1 },
  },
  period: { from: '2016-09-01', to: '2026-09-02' },
  strategyId: 'rsi-reversion',
  parameters: {
    rsiPeriod: 14,
    entryRsi: 30,
    exitRsi: 55,
    atrPeriod: 14,
    stopAtrMultiplier: 2,
    riskPerTradePercent: 1,
    correlationBars: 60,
    correlationThreshold: 0.5,
  },
} as const;

export interface BenchmarkOptions {
  readonly databasePath: string;
  readonly outputPath: string | null;
  readonly comparePath: string | null;
  readonly timeoutMs: number;
  readonly memoryLimitMiB: number;
  readonly preparationChildMaxRssMiB: number;
  readonly preparationChildOldSpaceMiB: number;
  readonly heartbeatIntervalMs: number;
  readonly readinessMaxLatencyMs: number;
  readonly readinessP95LatencyMs: number;
  readonly cancelAfterMs: number;
  readonly syntheticSymbols: number | null;
  readonly keepTemp: boolean;
  readonly execution: 'inline' | 'forked';
  readonly serverRuntime: 'source' | 'built';
}

export interface HttpSampleSummary {
  readonly requests: number;
  readonly failures: number;
  readonly maxLatencyMs: number | null;
  readonly p95LatencyMs: number | null;
  readonly maxGapMs: number | null;
}

export interface ParentMemorySummary {
  readonly samples: number;
  readonly maxRssBytes: number;
  readonly maxHeapUsedBytes: number;
  readonly maxHeapTotalBytes: number;
  readonly maxExternalBytes: number;
  readonly maxArrayBuffersBytes: number;
  readonly maxPssBytes: number;
  readonly maxPssAnonBytes: number;
  readonly maxPssFileBytes: number;
}

export interface JobRunReport {
  readonly startStatus: number;
  readonly startLatencyMs: number;
  readonly terminalStatus: string | null;
  readonly terminalError: string | null;
  readonly runningObserved: boolean;
  readonly resolvingStagesObserved: boolean;
  readonly preparationChildObserved: boolean;
  readonly totalMs: number;
  readonly cancelRequestLatencyMs: number | null;
  readonly cancelStatus: number | null;
  readonly sseOpenLatencyMs: number | null;
  readonly sseEvents: number;
  readonly phaseDurationsMs: Readonly<Record<string, number>>;
}

export interface BenchmarkReport {
  readonly schemaVersion: 2;
  readonly status: 'COMPLETED' | 'FAILED';
  readonly repository: {
    readonly gitSha: string;
    readonly dirty: boolean;
    readonly diffFingerprint: string;
  };
  readonly request: typeof DEFAULT_BENCHMARK_REQUEST;
  readonly source: {
    readonly databaseBytes: number;
    readonly workingDatabaseBytes: number;
    readonly inputFingerprint: string;
    readonly sourceSha256: string;
    readonly fixtureVersion: string | null;
    readonly syntheticSymbols: number | null;
    readonly execution: 'inline' | 'forked';
    readonly serverRuntime: 'source' | 'built';
    readonly memoryLimitMiB: number;
    readonly preparationChildMaxRssMiB: number;
    readonly preparationChildOldSpaceMiB: number;
    readonly readinessMaxLatencyMs: number;
    readonly readinessP95LatencyMs: number;
  };
  readonly inventory: Readonly<Record<string, {
    readonly rows: number;
    readonly min: string | null;
    readonly max: string | null;
  }>>;
  readonly cancelledRun: JobRunReport | null;
  readonly completedRun: JobRunReport | null;
  readonly readyReplayLatencyMs: number | null;
  readonly readiness: HttpSampleSummary;
  readonly maxProcessTreeRssBytes: number;
  readonly maxServerRssBytes: number;
  readonly maxPreparationDescendantsRssBytes: number;
  readonly maxProcessTreePssBytes: number;
  readonly maxProcessTreePssAnonBytes: number;
  readonly maxProcessTreePssFileBytes: number;
  readonly parentMemoryByStage: Readonly<Record<string, ParentMemorySummary>>;
  readonly maxProcessTreeCount: number;
  readonly result: {
    readonly scheduleHash: string;
    readonly scheduleEntries: number;
    readonly unionSymbols: number;
    readonly diagnosticEntries: number;
    readonly warnings: number;
    readonly semanticHash: string;
  } | null;
  readonly failure: {
    readonly stage: string;
    readonly reason: string;
    readonly externalDataRequired: boolean;
    readonly lastPreparationStatus: string | null;
    readonly lastPreparationPhase: string | null;
  } | null;
  readonly comparison?: {
    readonly reportPath: string;
    readonly scheduleHashEqual: boolean;
    readonly semanticHashEqual: boolean;
    readonly inputFingerprintEqual: boolean;
    readonly fixtureEqual: boolean;
    readonly requestEqual: boolean;
  };
}

const SENSITIVE_OR_RUNTIME_TABLES = [
  'users', 'sessions', 'login_attempts', 'audit_logs', 'notifications',
  'external_api_daily_usage', 'data_sync_jobs', 'backtest_preparation_jobs',
  'backtest_wizard_drafts', 'backtest_jobs', 'backtest_clone_batches',
  'backtest_clone_batch_items', 'backtest_runs', 'backtest_metrics',
  'backtest_equity_points', 'backtest_drawdown_points', 'backtest_trades',
  'backtest_monthly_returns',
] as const;

const INVENTORY_QUERIES: Readonly<Record<string, {
  table: string; column: string; where?: string;
}>> = {
  krxDailyBars: { table: 'krx_daily_bars', column: 'date' },
  dailySelectionMetrics: { table: 'daily_selection_metrics', column: 'date' },
  dailySelectionMetricCoverage: { table: 'daily_selection_metric_coverage', column: 'date' },
  symbolMasterVersions: { table: 'symbol_master_versions', column: 'valid_from_date' },
  symbolMasterCoverage: { table: 'symbol_master_coverage', column: 'start_date' },
  symbolMasterTradingDays: { table: 'symbol_master_trading_days', column: 'date' },
  krxNonTradingDays: { table: 'krx_non_trading_days', column: 'date' },
  symbols: { table: 'symbols', column: 'created_at_ms' },
  facts: { table: 'facts', column: 'period_key' },
  corporateActionFacts: {
    table: 'facts', column: 'period_key', where: "field = 'SPLIT_RATIO'",
  },
  symbolFactsState: { table: 'symbol_facts_state', column: 'code' },
};

export function parseBenchmarkOptions(argv: readonly string[]): BenchmarkOptions {
  let databasePath: string | null = null;
  let outputPath: string | null = null;
  let comparePath: string | null = null;
  let timeoutMs = 15 * 60_000;
  // process별 RSS 합은 공유 페이지를 중복계상하므로 운영 hard limit(640MiB)을
  // 보수 진단 기준으로 삼는다. MemoryHigh=512MiB는 systemd cgroup 계측으로 검증한다.
  let memoryLimitMiB = 640;
  // 운영 기본값을 그대로 두고, source(tsx) 오버헤드 실험만 명시적으로 올릴 수 있다.
  let preparationChildMaxRssMiB = 320;
  let preparationChildOldSpaceMiB = 128;
  let heartbeatIntervalMs = 100;
  let readinessMaxLatencyMs = 2_000;
  let readinessP95LatencyMs = 500;
  let cancelAfterMs = 250;
  let syntheticSymbols: number | null = null;
  let keepTemp = false;
  let execution: 'inline' | 'forked' = 'forked';
  let serverRuntime: 'source' | 'built' = 'built';

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--keep-temp') {
      keepTemp = true;
      continue;
    }
    const raw = argv[index + 1];
    if (raw === undefined) throw new Error(`${flag ?? '(없음)'} 옵션 값이 없습니다.`);
    index += 1;
    switch (flag) {
      case '--database': databasePath = raw; break;
      case '--output': outputPath = raw; break;
      case '--compare': comparePath = raw; break;
      case '--timeout-ms': timeoutMs = positiveInteger(flag, raw); break;
      case '--memory-limit-mib': memoryLimitMiB = positiveInteger(flag, raw); break;
      case '--preparation-child-max-rss-mib':
        preparationChildMaxRssMiB = positiveInteger(flag, raw);
        break;
      case '--preparation-child-old-space-mib':
        preparationChildOldSpaceMiB = positiveInteger(flag, raw);
        break;
      case '--heartbeat-interval-ms': heartbeatIntervalMs = positiveInteger(flag, raw); break;
      case '--readiness-max-latency-ms': readinessMaxLatencyMs = positiveInteger(flag, raw); break;
      case '--readiness-p95-latency-ms': readinessP95LatencyMs = positiveInteger(flag, raw); break;
      case '--cancel-after-ms': cancelAfterMs = positiveInteger(flag, raw); break;
      case '--synthetic-symbols': syntheticSymbols = positiveInteger(flag, raw); break;
      case '--execution': {
        if (raw !== 'inline' && raw !== 'forked') {
          throw new Error('--execution은 inline 또는 forked여야 합니다.');
        }
        execution = raw;
        break;
      }
      case '--server-runtime': {
        if (raw !== 'source' && raw !== 'built') {
          throw new Error('--server-runtime은 source 또는 built여야 합니다.');
        }
        serverRuntime = raw;
        break;
      }
      default: throw new Error(`지원하지 않는 옵션입니다: ${flag ?? '(없음)'}`);
    }
  }
  if (databasePath === null) {
    throw new Error('--database <sanitized-snapshot.sqlite>를 반드시 지정해야 합니다.');
  }
  if (memoryLimitMiB < 128) throw new Error('--memory-limit-mib는 최소 128입니다.');
  if (preparationChildMaxRssMiB < 128 || preparationChildMaxRssMiB > 768) {
    throw new Error('--preparation-child-max-rss-mib는 128..768 범위여야 합니다.');
  }
  if (preparationChildOldSpaceMiB < 64 || preparationChildOldSpaceMiB > 256) {
    throw new Error('--preparation-child-old-space-mib는 64..256 범위여야 합니다.');
  }
  if (syntheticSymbols !== null && syntheticSymbols < 200) {
    throw new Error('--synthetic-symbols는 MARKET_CAP 200 단계를 위해 최소 200이어야 합니다.');
  }
  const resolvedDatabasePath = path.resolve(databasePath);
  const resolvedOutputPath = outputPath === null ? null : path.resolve(outputPath);
  if (resolvedOutputPath !== null) {
    if (resolvedOutputPath === resolvedDatabasePath) {
      throw new Error('--output은 --database와 같은 경로일 수 없습니다.');
    }
    if (fs.existsSync(resolvedOutputPath) && fs.existsSync(resolvedDatabasePath)) {
      const sourceStat = fs.statSync(resolvedDatabasePath);
      const outputStat = fs.statSync(resolvedOutputPath);
      if (sourceStat.dev === outputStat.dev && sourceStat.ino === outputStat.ino) {
        throw new Error('--output이 --database의 symlink/hardlink를 가리킵니다.');
      }
    }
  }
  return {
    databasePath: resolvedDatabasePath,
    outputPath: resolvedOutputPath,
    comparePath: comparePath === null ? null : path.resolve(comparePath),
    timeoutMs,
    memoryLimitMiB,
    preparationChildMaxRssMiB,
    preparationChildOldSpaceMiB,
    heartbeatIntervalMs,
    readinessMaxLatencyMs,
    readinessP95LatencyMs,
    cancelAfterMs,
    syntheticSymbols,
    keepTemp,
    execution,
    serverRuntime,
  };
}

function positiveInteger(flag: string | undefined, raw: string): number {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${flag ?? '(옵션)'}에는 0보다 큰 정수가 필요합니다.`);
  }
  return value;
}

function tableExists(db: Database.Database, table: string): boolean {
  return db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
  ).get(table) !== undefined;
}

/** 민감·실행 상태를 한 행도 반출하지 않은 market/fact 전용 스냅샷만 허용한다. */
export function assertSanitizedSnapshot(db: Database.Database): void {
  for (const table of SENSITIVE_OR_RUNTIME_TABLES) {
    if (!tableExists(db, table)) continue;
    const count = (db.prepare(`SELECT count(*) AS count FROM "${table}"`).get() as { count: number }).count;
    if (count > 0) {
      throw new Error(
        `입력 DB의 ${table} 테이블에 ${count}행이 있습니다. `
        + '운영 DB를 직접 사용하지 말고 market/facts/coverage 전용 sanitized export를 만드세요.',
      );
    }
  }
}

export function readInventory(db: Database.Database): BenchmarkReport['inventory'] {
  const result: Record<string, { rows: number; min: string | null; max: string | null }> = {};
  for (const [name, query] of Object.entries(INVENTORY_QUERIES)) {
    if (!tableExists(db, query.table)) {
      result[name] = { rows: 0, min: null, max: null };
      continue;
    }
    result[name] = db.prepare(
      `SELECT count(*) AS rows, min("${query.column}") AS min, max("${query.column}") AS max `
      + `FROM "${query.table}"${query.where ? ` WHERE ${query.where}` : ''}`,
    ).get() as { rows: number; min: string | null; max: string | null };
  }
  return result;
}

export async function createDisposableDatabase(
  sourcePath: string,
): Promise<{ dir: string; databasePath: string; sourceBytes: number; sourceSha256: string }> {
  const resolved = path.resolve(sourcePath);
  const isProductionPath = (candidate: string): boolean => (
    candidate === '/var/lib/quant-platform/app.sqlite'
    || candidate.startsWith('/var/lib/quant-platform/')
  );
  if (isProductionPath(resolved)) {
    throw new Error('운영 DB 경로는 직접 실행할 수 없습니다. sanitized 로컬 export를 지정하세요.');
  }
  const realSource = fs.realpathSync(resolved);
  if (isProductionPath(realSource)) {
    throw new Error('운영 DB 경로는 직접 실행할 수 없습니다. sanitized 로컬 export를 지정하세요.');
  }
  const sourceStat = fs.statSync(realSource);
  if (!sourceStat.isFile()) throw new Error(`DB 파일이 아닙니다: ${resolved}`);
  const source = new Database(realSource, { readonly: true, fileMustExist: true });
  source.pragma('query_only = ON');
  try {
    assertSanitizedSnapshot(source);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qp-universe-benchmark-'));
    const databasePath = path.join(dir, 'app.sqlite');
    await source.backup(databasePath);
    const copied = new Database(databasePath, { readonly: true, fileMustExist: true });
    copied.pragma('query_only = ON');
    try {
      // source 사전검사와 backup 사이 변경도 fail-closed로 잡는다.
      assertSanitizedSnapshot(copied);
    } finally {
      copied.close();
    }
    // WAL까지 반영된 일관된 backup bytes가 baseline/proposed snapshot identity다.
    const sourceHash = createHash('sha256');
    for await (const chunk of fs.createReadStream(databasePath)) sourceHash.update(chunk);
    return {
      dir,
      databasePath,
      sourceBytes: sourceStat.size,
      sourceSha256: sourceHash.digest('hex'),
    };
  } finally {
    source.close();
  }
}

export function semanticPreviewHash(body: unknown): string {
  const value = body as Record<string, unknown>;
  return createHash('sha256').update(JSON.stringify({
    scheduleHash: value.scheduleHash,
    schedule: value.schedule,
    unionSymbols: value.unionSymbols,
    diagnostics: value.diagnostics,
    warnings: value.warnings,
  })).digest('hex');
}

export function summarizeSamples(
  latencies: readonly number[], gaps: readonly number[], failures: number,
): HttpSampleSummary {
  const sorted = [...latencies].sort((left, right) => left - right);
  return {
    requests: latencies.length + failures,
    failures,
    maxLatencyMs: sorted.length === 0 ? null : Math.max(...sorted),
    p95LatencyMs: sorted.length === 0
      ? null
      : sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]!,
    maxGapMs: gaps.length === 0 ? null : Math.max(...gaps),
  };
}
