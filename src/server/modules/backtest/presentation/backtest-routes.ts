import { createHash } from 'node:crypto';
import os from 'node:os';
import fs from 'node:fs';
import type { FastifyBaseLogger, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  backtestRequestSchema,
  periodToTsRange,
  type BacktestRequest,
} from '../../../../shared/schemas/backtest-request.js';
import type { ProvenancePin } from '../../../../shared/schemas/provenance-pin.js';
import {
  DEFAULT_TRADE_SORT_DIRECTION,
  DEFAULT_TRADE_SORT_KEY,
  SORT_DIRECTIONS,
  TRADE_SORT_KEYS,
} from '../../../../shared/schemas/trade-sort.js';
import { SECURITY_HEADERS } from '../../../shared/security.js';
import type { Clock } from '../../../shared/clock.js';
import type { AuditLogService } from '../../audit/audit-service.js';
import type { FactRepository } from '../../facts/application/ports.js';
import type { CorporateActionCoverageStore } from '../../facts/application/corporate-action-coverage.js';
import type { ConsumedVersionSnapshot, SymbolService } from '../../market-data/application/symbol-service.js';
import { KrxNotConfiguredError, KrxQuotaError } from '../../market-data/application/ports.js';
import { SymbolMasterNotCoveredError } from '../../market-data/application/symbol-master-service.js';
import { KRX_FILTER_POLICY_VERSION } from '../../market-data/domain/krx-filter-policy.js';
import type {
  CandleCoverageRow,
  CandleCoverageService,
} from '../../market-data/application/candle-coverage-service.js';
import type { StrategyRegistry } from '../../strategy/application/strategy-registry.js';
import { estimateBars, MAX_BACKTEST_BARS } from '../domain/bar-estimate.js';
import {
  getCostProfile,
  getSlippageProfile,
  listCostProfiles,
  listSlippageProfiles,
} from '../domain/cost-profiles.js';
import type { JobOrchestrator, JobEvent } from '../application/job-orchestrator.js';
import type { BacktestJobRow, JobQueue } from '../application/job-queue.js';
import type { ResultsService } from '../application/results-service.js';
import { rebaseStoredRequest } from '../application/stored-request.js';
import { computeRebalanceDates } from '../../../../shared/schemas/rebalance-interval.js';
import {
  type ResolvedUniverse,
  type UniverseRuleResolver,
} from '../application/universe-rule-resolver.js';
import type {
  BacktestPreparationOrchestrator,
  BacktestUniversePreview,
  PreparationInput,
} from '../application/backtest-preparation-orchestrator.js';

type PreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

export interface BacktestRouteDeps {
  readonly queue: JobQueue;
  readonly orchestrator: JobOrchestrator;
  readonly results: ResultsService;
  readonly strategies: StrategyRegistry;
  readonly symbolService: SymbolService;
  /** 종목별 일봉 보유 구간 — `krx_daily_bars` 를 직접 집계한다(Task 6) */
  readonly candleCoverage: CandleCoverageService;
  /** 유니버스 규칙 → 리밸런스 날짜별 멤버십 일정 (스펙 2026-08-05) */
  readonly universeRuleResolver: UniverseRuleResolver;
  readonly preparation: BacktestPreparationOrchestrator;
  readonly audit: AuditLogService;
  readonly factRepository: FactRepository;
  /** 자본변동 수집 커버리지 — 제출 게이트가 대조한다(Task 6) */
  readonly corporateActionCoverage: CorporateActionCoverageStore;
  readonly dataRoot: string;
  readonly maxQueuedBacktests: number;
  readonly clock: Clock;
}

const MIN_FREE_DISK_BYTES = 500 * 1024 * 1024;
const MIN_FREE_MEMORY_BYTES = 75 * 1024 * 1024;

const isoDate = (tsMs: number): string => new Date(tsMs).toISOString().slice(0, 10);

/**
 * 자본변동 수량은 사업보고서의 증자·감자 현황에서 읽는다.
 * 그래서 접수일이 효력발생일보다 최대 15개월 늦다
 * (pit-fact-view.ts 의 PitFactView 생성자 주석 참고).
 * 기간 끝이 이 안에 들면 분할이 이미 일어났어도 아직 DART 에
 * 접수되지 않았을 수 있다. 커버리지가 온전해도 뜨는 경고다(Task 6).
 */
const RECENT_PERIOD_LOOKBACK_MONTHS = 15;

function isRecentPeriodEnd(toTsMs: number, nowMs: number): boolean {
  const cutoff = new Date(nowMs);
  cutoff.setUTCMonth(cutoff.getUTCMonth() - RECENT_PERIOD_LOOKBACK_MONTHS);
  return toTsMs > cutoff.getTime();
}

/**
 * 회수 가능 메모리 (§34 리소스 가드).
 * Linux 의 os.freemem() 은 MemFree 라 페이지 캐시를 제외한다 — 장기 구동 서버에서
 * 항상 낮게 나와 건강한 호스트가 영구적으로 507 을 반환하게 된다.
 * /proc/meminfo 의 MemAvailable 을 우선 사용하고, 없는 플랫폼은 freemem 으로 fallback.
 */
function availableMemoryBytes(): number {
  try {
    const meminfo = fs.readFileSync('/proc/meminfo', 'utf8');
    const match = /MemAvailable:\s+(\d+)\s*kB/.exec(meminfo);
    if (match) return Number(match[1]) * 1024;
  } catch {
    // /proc 이 없는 플랫폼 (Windows, macOS)
  }
  return os.freemem();
}

function serializeJob(job: BacktestJobRow) {
  return {
    id: job.id,
    status: job.status,
    strategyId: job.strategyId,
    request: JSON.parse(job.requestJson) as unknown,
    progressBars: job.progressBars,
    totalBars: job.totalBars,
    progressLabel: job.progressLabel,
    error: job.error,
    createdAtMs: job.createdAtMs,
    startedAtMs: job.startedAtMs,
    completedAtMs: job.completedAtMs,
  };
}

function preparationInputOf(body: BacktestRequest): PreparationInput {
  return {
    universeRule: body.universeRule,
    period: body.period,
    strategyId: body.strategyId,
    parameters: body.parameters,
  };
}

/** 준비 job의 staged schedule을 기존 worker가 소비하는 pin 모양으로 좁힌다. */
function preparedPreviewToResolved(preview: BacktestUniversePreview): ResolvedUniverse {
  const schedule = preview.schedule.map((entry) => ({
    rebalanceDate: entry.rebalanceDate,
    effectiveTradingDate: entry.effectiveDate,
    symbols: entry.members.map((member) => member.symbol),
    excludedNonTradingCount: entry.excludedNonTradingCount,
  }));
  return {
    schedule,
    unionSymbols: [...preview.unionSymbols],
    unionEntries: new Map(),
    // worker가 실제 소비하는 legacy JSON 자체의 hash여야 provenance pin을 독립적으로
    // 재계산할 수 있다. staged hash는 preparation preview 안에 그대로 보존된다.
    scheduleHash: createHash('sha256').update(JSON.stringify(schedule)).digest('hex'),
    uncoveredDates: [...preview.uncoveredDates],
  };
}

/**
 * provenancePinJson 은 저장 시점에 이미 검증된 값이라 정상 상태에서는 항상 파싱된다.
 * 그래도 행이 손상돼 있으면(예: 수동 DB 편집) 상세 조회 전체를 500 으로 죽이는 대신
 * pin 만 null 로 내리고 나머지 응답(job·run·metrics)은 그대로 성공시킨다.
 */
function parseProvenancePin(
  provenancePinJson: string | null,
  jobId: string,
  logger: FastifyBaseLogger,
): ProvenancePin | null {
  if (!provenancePinJson) return null;
  try {
    return JSON.parse(provenancePinJson) as ProvenancePin;
  } catch (error) {
    logger.warn({ event: 'backtest.provenance_pin.parse_failed', jobId, err: error }, 'provenancePinJson 파싱에 실패해 pin 없이 응답한다');
    return null;
  }
}

async function checkResources(dataRoot: string): Promise<string | null> {
  if (availableMemoryBytes() < MIN_FREE_MEMORY_BYTES) {
    return '여유 메모리가 부족해 새 백테스트를 시작할 수 없습니다. 실행 중인 작업이 끝난 뒤 다시 시도하세요.';
  }
  try {
    const stats = await fs.promises.statfs(dataRoot);
    if (stats.bavail * stats.bsize < MIN_FREE_DISK_BYTES) {
      return '디스크 공간이 부족해 새 백테스트를 시작할 수 없습니다. 저장 공간을 확보한 뒤 다시 시도하세요.';
    }
  } catch {
    // statfs 실패 시 가드를 건너뛴다
  }
  return null;
}

/**
 * `UniverseRuleResolver.resolve` (제출 검증·미리보기 공용)는 시총 캐시 미스일 때 KRX 를
 * 부른다 — `symbol-master-routes.ts` 의 `/symbol-master/sync`·`/backfill` 과 같은
 * 호출부다. 같은 관례로 매핑한다: 쿼터 초과는 429(사용자가 기다리면 되는 문제), 미설정은
 * 503(운영이 키를 넣어야 하는 문제). 나머지 오류(분류 불가 등)는 처리하지 않고 그대로
 * 위로 던져 기본 오류 처리기(500)가 받게 한다.
 */
function sendIfKrxError(reply: FastifyReply, error: unknown): boolean {
  if (error instanceof KrxQuotaError) {
    reply.code(429).send({ error: error.message });
    return true;
  }
  if (error instanceof KrxNotConfiguredError) {
    reply.code(503).send({ error: error.message });
    return true;
  }
  return false;
}

/**
 * SymbolMasterNotCoveredError 는 종목 마스터가 그 날짜의 coverage·거래일 anchor를
 * 갖지 못했다는 뜻이다 — 클라이언트가 먼저 동기화해야 하는 409 상황이지 서버 결함(500)이
 * 아니다. sendIfKrxError 와 나란히 둔다: 두 오류 모두 "지금은 KRX/마스터 상태가 준비되지
 * 않았다"는 같은 층위의 신호라 호출부에서 순서를 가리지 않고 둘 다 확인하면 된다.
 */
function sendIfNotCovered(reply: FastifyReply, error: unknown): boolean {
  if (error instanceof SymbolMasterNotCoveredError) {
    reply.code(409).send({ error: error.message });
    return true;
  }
  return false;
}

export function registerBacktestRoutes(app: FastifyInstance, deps: BacktestRouteDeps, requireAuth: PreHandler): void {
  const {
    queue,
    orchestrator,
    results,
    strategies,
    symbolService,
    candleCoverage,
    universeRuleResolver,
    preparation,
    audit,
    factRepository,
    corporateActionCoverage,
    clock,
  } = deps;

  /**
   * 등록되지 않은 종목은 봉이 있어도 없는 것으로 취급한다(리뷰 finding, 2026-08-08).
   * `krx_daily_bars` 는 `symbols` 등록과 무관하게 채워지므로 `candleCoverage` 를
   * 그대로 쓰면 미등록 종목도 제출을 통과한다.
   *
   * 예전 `symbol_coverage` 캐시는 등록된 종목만 채워졌으므로 이 게이트는 캐시의
   * 부작용으로 공짜로 따라왔다. 캐시를 걷어낸 지금은 의도를 코드로 직접 말해야 한다.
   *
   * 이 게이트가 없으면 미등록 유니버스가 제출 시점(400) 이 아니라 큐 소비 후
   * 워커(`backtest-child.ts`)에서 늦게 죽는다.
   */
  const registeredCoverage = (codes: readonly string[]): CandleCoverageRow[] =>
    candleCoverage.getCoverage(codes).map((row) =>
      symbolService.exists(row.code) ? row : { code: row.code, firstTsMs: null, lastTsMs: null, barCount: 0 },
    );

  /**
   * 기간 × 커버리지 검사 (D-025). 커버리지는 메타데이터라 Parquet 을 읽지 않는다.
   * 요청한 종목 **전부** 가 구간 밖일 때만 거부한다 — 신규 상장처럼 이력이 짧은 종목
   * 하나 때문에 유니버스 전체를 막지 않는다. 일부만 비는 경우는 실행 경고로 남는다.
   *
   * 옛 데이터셋 경로가 쓰던 관용 그대로다(스펙 2026-08-05) — 유니버스 규칙으로
   * 재구성한 멤버십도 "지금 이 종목들로 이 기간에 얼마나 소비하나" 는 같은 질문이고,
   * 신규 상장 등으로 일부 종목만 이력이 짧은 상황이 흔하다. `codes` 는 이제
   * `body.universe.symbols` 가 아니라 리밸런스 일정의 합집합(unionSymbols)이다.
   */
  const checkPeriodCoverage = (
    codes: readonly string[],
    period: { from: string; to: string },
  ): string | null => {
    const { fromTsMs, toTsMs } = periodToTsRange(period);
    const bySymbol = new Map(registeredCoverage(codes).map((row) => [row.code, row]));

    const ranges: string[] = [];
    for (const symbol of codes) {
      const row = bySymbol.get(symbol);
      if (!row || row.barCount === 0 || row.firstTsMs === null || row.lastTsMs === null) {
        ranges.push(`${symbol}: 수집된 데이터 없음`);
        continue;
      }
      // 하나라도 겹치면 통과 — 나머지는 실행 경고가 알린다
      if (row.lastTsMs >= fromTsMs && row.firstTsMs <= toTsMs) return null;
      ranges.push(`${symbol}: ${isoDate(row.firstTsMs)} ~ ${isoDate(row.lastTsMs)}`);
    }

    return `선택한 기간에 데이터가 있는 종목이 없습니다. 보유 범위 — ${ranges.join(', ')}`;
  };

  /**
   * 커버리지 확인 + 봉 수 상한 검사. 데이터셋·스냅샷 경로가 공유한다 — 유니버스가
   * 어디서 왔든 "이 종목 집합으로 이 기간에 얼마나 소비하나" 는 같은 질문이다.
   * 두 경로가 갈리는 지점은 기간 커버리지 판정 방식뿐이라 `coverageCheck` 로
   * 주입한다 (D-025 관용 vs REVIEW §9.1 엄격 차단).
   *
   * 소비 timeframe 을 고르는 절차는 없다 — `Timeframe` 이 '1d' 하나뿐이라(Task 4)
   * 예전처럼 슬라이스별 가용성을 견줘 고를 것이 없다.
   */
  const resolveConsumedUniverse = (
    body: BacktestRequest,
    codes: readonly string[],
    errors: string[],
    coverageCheck: (codes: readonly string[]) => string | null,
  ): { universe: ConsumedVersionSnapshot; timeframe: '1d' } | null => {
    const consumed = '1d' as const;

    // 유니버스 전체가 미등록이면 여기서 먼저 끊는다(리뷰 finding, 2026-08-08).
    // registeredCoverage 만 쓰면 이 경우도 "일봉이 없습니다" 로 뭉뚱그려진다.
    // krx_daily_bars 는 등록과 무관해 실제로는 봉이 있을 수 있으므로, 원인을
    // 등록 누락으로 정확히 짚어 준다.
    if (codes.length > 0 && codes.every((code) => !symbolService.exists(code))) {
      errors.push(
        `선택한 종목이 등록돼 있지 않습니다: ${codes.join(', ')} — 유니버스 미리보기를 ` +
          '실행해 종목을 등록한 뒤 다시 제출하세요.',
      );
      return null;
    }

    const hasData = registeredCoverage(codes).some((row) => row.barCount > 0);
    if (!hasData) {
      errors.push('선택한 종목에 수집된 일봉이 없습니다 — 종목 마스터 수집을 먼저 실행하세요.');
      return null;
    }

    const coverageError = coverageCheck(codes);
    if (coverageError !== null) {
      errors.push(coverageError);
      return null;
    }

    // 제출 시점의 종목 버전 스냅샷을 고정 — 대기 중 재무 동기화가 끼어들어도 어긋나지 않는다 (§9.5)
    const universe = symbolService.versionSnapshotFor(codes);

    // 봉 수 상한 — 실행부는 전체 봉을 메모리에 올린다.
    const { fromTsMs, toTsMs } = periodToTsRange(body.period);
    const estimated = estimateBars(
      registeredCoverage(codes).map((row) => ({ ...row, symbol: row.code })),
      codes,
      fromTsMs,
      toTsMs,
    );
    if (estimated > MAX_BACKTEST_BARS) {
      errors.push(
        `예상 봉 수가 상한을 넘습니다 (추정 ${estimated.toLocaleString()}봉 > ` +
          `${MAX_BACKTEST_BARS.toLocaleString()}봉). 기간이나 종목 수를 줄이세요.`,
      );
      return null;
    }

    return { universe, timeframe: consumed };
  };

  /** 유니버스 일정은 전략 파라미터가 아니라 요청의 공유 interval 계약만 따른다. */
  const resolveScheduleForRequest = (body: BacktestRequest): Promise<ResolvedUniverse> => {
    return universeRuleResolver.resolve(
      body.universeRule,
      computeRebalanceDates(body.period, body.universeRule.rebalanceInterval),
    );
  };

  /**
   * 전략 내부 리밸런싱을 Task 8에서 요청 계약으로 완전히 옮기기 전까지의 임시
   * 호환 입력이다. 저장·응답의 parameters에는 되살리지 않아 새 계약을 오염시키지 않는다.
   */
  const parametersForLegacyStrategySchedule = (body: BacktestRequest): Record<string, unknown> => {
    if (typeof body.parameters.rebalanceMonths === 'number') return body.parameters;
    const interval = body.universeRule.rebalanceInterval;
    return {
      ...body.parameters,
      rebalanceMonths: interval.unit === 'MONTH' ? interval.value : 1,
    };
  };

  /**
   * 종목 코드를 "코드(이름)" 형태로 늘어놓는다.
   * 목록이 길면 10종목만 보이고 나머지는 개수로 요약한다.
   * 유니버스 상한이 200종목이라 캡이 없으면 경고가 너무 길어진다.
   * 엔진의 buysDroppedByCap 과 같은 관례다(backtest-child.ts 참고).
   */
  const namedSymbolList = (codes: readonly string[]): string => {
    const localNames = symbolService.getLocalNames(codes);
    const labels = codes.map((code) => {
      const local = localNames.get(code);
      return local ? `${code}(${local.name})` : code;
    });
    const shown = labels.slice(0, 10).join(', ');
    return labels.length > 10 ? `${shown} 외 ${labels.length - 10}종목` : shown;
  };

  /**
   * 자본변동 수집 게이트(Task 6)다.
   * 팩트 0건은 세 상태를 가릴 수 있다: 수집했고 분할이 없었다,
   * 수집했는데 DART 가 응답하지 못했다, 아예 수집하지 않았다.
   * 커버리지가 셋째를 앞의 둘과 가르고, gap 이 첫째와 둘째를 가른다
   * (corporate-action-coverage.ts 헤더 참고).
   *
   * gap 이 난 종목은 막지 않는다.
   * DART 가 못 답하는 종목은 대체로 상장폐지 종목이다.
   * 여기서 막으면 생존편향을 없애려고 들여온 종목이 영원히 막힌다.
   *
   * 필요 연도는 백테스트 기간이 걸치는 연도 전부다.
   * 그중 한 연도라도 커버리지에 없으면 그 종목은 아예 수집하지 않은 것으로 본다.
   */
  const checkCorporateActionCoverage = (
    codes: readonly string[],
    period: { from: string; to: string },
  ): {
    error: string | null;
    warning: string | null;
    /** 미수집 종목 전체 목록 — 위저드 게이트 화면(Task 8)이 그대로 받아 쓴다.
     *  `error` 문구의 `namedSymbolList` 는 10종목에서 접으므로 화면에는 못 쓴다. */
    uncollectedSymbols: readonly string[];
    fromYear: number;
    toYear: number;
  } => {
    const { fromTsMs, toTsMs } = periodToTsRange(period);
    const fromYear = new Date(fromTsMs).getUTCFullYear();
    const toYear = new Date(toTsMs).getUTCFullYear();
    const neededYears: number[] = [];
    for (let year = fromYear; year <= toYear; year += 1) neededYears.push(year);

    const coveredBySymbol = corporateActionCoverage.getCoveredYears(codes);
    const gapsBySymbol = corporateActionCoverage.getGapYears(codes);

    const uncollected: string[] = [];
    const gapped: string[] = [];
    for (const code of codes) {
      const coveredYears = coveredBySymbol.get(code) ?? [];
      if (neededYears.some((year) => !coveredYears.includes(year))) {
        uncollected.push(code);
        continue;
      }
      // 필요 연도로 좁히지 않는다 — gap 연도는 요청 연도의 부분집합이 아니다
      // (fact-sync-service.ts 의 uniqueYearsFromGaps 주석 참고). 좁히면
      // 실제 위험이 있는 gap 을 조용히 숨길 수 있다. 노이즈보다 그쪽이 더 위험하다.
      if ((gapsBySymbol.get(code) ?? []).length > 0) gapped.push(code);
    }

    if (uncollected.length > 0) {
      return {
        error:
          `다음 종목은 자본변동(액면분할 등) 이력을 수집한 적이 없습니다: ${namedSymbolList(uncollected)}. ` +
          '분할이 있었다면 결과가 틀어집니다. 종목 화면에서 자본변동을 동기화한 뒤 다시 제출하세요.',
        warning: null,
        uncollectedSymbols: uncollected,
        fromYear,
        toYear,
      };
    }
    if (gapped.length === 0) {
      return { error: null, warning: null, uncollectedSymbols: [], fromYear, toYear };
    }
    return {
      error: null,
      warning:
        `다음 종목은 DART 가 자본변동 이력 일부에 응답하지 못했습니다: ${namedSymbolList(gapped)}. ` +
        '분할이 있었다면 결과가 틀어질 수 있습니다.',
      uncollectedSymbols: [],
      fromYear,
      toYear,
    };
  };

  type ValidationResult =
    | {
        readonly ok: true;
        readonly universe: ConsumedVersionSnapshot;
        readonly timeframe: '1d';
        readonly provenancePin: ProvenancePin;
        readonly resolved: ResolvedUniverse;
        readonly warnings: readonly string[];
      }
    | {
        readonly ok: false;
        readonly status: 400;
        readonly errors: string[];
        /**
         * 자본변동 미수집 게이트(Task 6)에 걸렸을 때만 있다. 위저드 게이트 화면
         * (Task 8)이 종목·연도를 다시 계산하지 않고 이 값을 그대로 받아 쓴다.
         */
        readonly corporateActionGate?: {
          readonly symbols: readonly string[];
          readonly fromYear: number;
          readonly toYear: number;
        };
      }
    | { readonly ok: false; readonly status: 422; readonly errors: string[]; readonly uncoveredDates: readonly string[] };

  /** 준비 hash를 조회하기 전에 끝낼 수 있는 요청 자체의 검증. */
  const validateStaticSubmission = (body: BacktestRequest): string[] => {
    const errors: string[] = [];
    const strategy = strategies.get(body.strategyId);
    if (!strategy) {
      errors.push(`알 수 없는 전략: ${body.strategyId}`);
    } else {
      const paramCheck = strategies.validateParameters(
        body.strategyId,
        parametersForLegacyStrategySchedule(body),
      );
      if (!paramCheck.ok) errors.push(paramCheck.error);
    }
    if (body.period.from > body.period.to) {
      errors.push('기간이 올바르지 않습니다 (from > to)');
    }
    if (!getCostProfile(body.execution.commissionProfileId)) {
      errors.push('알 수 없는 수수료 프로파일');
    }
    if (!getSlippageProfile(body.execution.slippageProfileId)) {
      errors.push('알 수 없는 슬리피지 프로파일');
    }
    return errors;
  };

  /**
   * 제출 검증 — 신규 제출(POST)·복제(clone)·초안(clone-draft)이 동일한 기준을 거친다.
   * 통과 시 제출 시점의 유니버스 버전과 서버 소유 provenance pin(Task 12)을 함께
   * 반환한다 (재현성 §9.5, REVIEW §9.2). 400 메시지는 `errors[0]` 이므로 검사 순서가
   * 곧 우선순위다.
   *
   * 전략·기간·프로파일처럼 요청 자체의 형식 오류는 유니버스 해소보다 먼저 걸러
   * 반환한다. 어차피 거부할 요청 때문에 KRX 호출 예산(종목 마스터 조회·시총
   * join)을 쓰지 않기 위해서다.
   * 순서는 uncovered 리밸런스 날짜(422) → 캔들 존재 검증(400) → 자본변동
   * 수집 검증(400) 이다(①②③, Task 6 이 ③을 더했다).
   */
  const validateSubmission = async (
    body: BacktestRequest,
    preparedPreview?: BacktestUniversePreview,
  ): Promise<ValidationResult> => {
    // 전략 버전은 검사하지 않는다 (D-029) — 요청이 버전을 들고 다니지 않는다.
    // 실행되는 것은 언제나 지금 등록된 전략이다.
    const errors = validateStaticSubmission(body);

    if (errors.length > 0) {
      return { ok: false, status: 400, errors };
    }

    // ① 유니버스 규칙 → 리밸런스 날짜별 멤버십 일정. 커버 밖 날짜가 있으면 캔들
    // 검증으로 넘어가지 않고 바로 422 로 알린다 — 종목 구성 자체를 모르는 날짜의
    // 캔들을 따질 수 없다.
    const resolved = preparedPreview
      ? preparedPreviewToResolved(preparedPreview)
      : await resolveScheduleForRequest(body);
    if (resolved.uncoveredDates.length > 0) {
      return {
        ok: false,
        status: 422,
        errors: [
          `종목 마스터가 다음 리밸런스 날짜를 커버하지 않습니다: ${resolved.uncoveredDates.join(', ')} — ` +
            '데이터 탭에서 해당 날짜를 동기화한 뒤 다시 시도하세요.',
        ],
        uncoveredDates: resolved.uncoveredDates,
      };
    }

    // ② unionSymbols 캔들 존재 검증 — 옛 데이터셋 분기의 관용(D-025)을 그대로 재사용한다.
    const universeErrors: string[] = [];
    const resolvedConsumption = resolveConsumedUniverse(
      body,
      resolved.unionSymbols,
      universeErrors,
      (codes) => checkPeriodCoverage(codes, body.period),
    );
    if (universeErrors.length > 0 || resolvedConsumption === null) {
      return {
        ok: false,
        status: 400,
        errors: universeErrors.length > 0 ? universeErrors : ['제출을 검증할 수 없습니다'],
      };
    }

    // ③ 자본변동 수집 게이트(Task 6) — 캔들은 있어도 분할 이력을 모르면 조용히
    // 틀린 결과를 낸다. unionSymbols·기간 기준으로 ②와 같은 층위에서 검사한다.
    const actionGate = checkCorporateActionCoverage(resolved.unionSymbols, body.period);
    if (actionGate.error !== null) {
      return {
        ok: false,
        status: 400,
        errors: [actionGate.error],
        corporateActionGate: {
          symbols: actionGate.uncollectedSymbols,
          fromYear: actionGate.fromYear,
          toYear: actionGate.toYear,
        },
      };
    }
    const warnings: string[] = [];
    if (actionGate.warning !== null) warnings.push(actionGate.warning);
    if (isRecentPeriodEnd(periodToTsRange(body.period).toTsMs, clock.now())) {
      warnings.push(
        '선택한 기간이 최근이라 아직 DART 에 공시되지 않은 자본변동이 있을 수 있습니다. ' +
          '분할이 최근에 있었다면 결과에 반영되지 않았을 수 있습니다.',
      );
    }

    // ④ 종목 버전 pin 은 기존 universeJson 메커니즘을 그대로 쓴다 — unionSymbols 기준.
    // ⑤ provenancePin — 유니버스 규칙 경로(스펙 2026-08-05)는 늘 이 모양이다.
    const provenancePin: ProvenancePin = {
      sourceKind: 'SYMBOL_MASTER',
      filterPolicyVersion: KRX_FILTER_POLICY_VERSION,
      selectionMethod: body.universeRule.stages.map((stage) => stage.criterion).join(' → '),
      scheduleHash: resolved.scheduleHash,
    };

    return {
      ok: true,
      universe: resolvedConsumption.universe,
      timeframe: resolvedConsumption.timeframe,
      provenancePin,
      resolved,
      warnings,
    };
  };

  /**
   * 재무 전략 데이터 요구 검사 — 통과시키면 실행 후 "거래 0건" 으로 끝나 원인을 알 수
   * 없다 (D-025 와 같은 원칙: 조용히 빠지지 않는다). `validateSubmission` 이 만드는
   * `errors` 배열에 합류시키지 않는 이유: 그 배열은 항상 400 으로 변환되는데, 이 조건은
   * 요청 형식·데이터셋 상태가 아니라 "전략과 유니버스의 조합" 문제라 422 여야 한다.
   * POST 신규 제출뿐 아니라 clone·clone-draft 도 같은 검사를 거친다 — 데이터가 제출
   * 이후 지워진 job 을 clone 하면 이 관문에서 다시 걸린다.
   */
  const checkFundamentalsRequirement = (
    body: BacktestRequest,
    unionSymbols: readonly string[],
  ): string | null => {
    if (!strategies.requiresFundamentals(body.strategyId)) return null;
    /**
     * **전 종목이 비었을 때만** 막는다. 일부 종목만 재무가 없는 경우는 거부 사유가
     * 아니다 — 신규 상장처럼 이력이 짧은 종목 하나 때문에 유니버스 전체를 막지 않는
     * `checkPeriodCoverage` 와 같은 원칙이고(D-025), 빠진 종목은 워커가 실행 경고에
     * **이름으로** 남긴다. 여기서 전부 422 로 바꾸면 그 경고 경로가 죽는다.
     */
    if (unionSymbols.some((code) => factRepository.hasFacts('SYMBOL', code))) return null;
    return (
      '이 전략은 상장시점 재무 데이터가 필요하지만 선택한 종목에는 아직 없습니다: ' +
      `${unionSymbols.join(', ')} — 종목 화면에서 해당 종목을 선택해 "재무" 를 함께 ` +
      '동기화하세요.'
    );
  };

  /**
   * 보유 종목 수(topN) × 동시 보유 상한(maxPositions) 정합성 검사.
   *
   * 두 값이 어긋나면 결과가 조용히 틀린다: 매수 단계는 topN 건의 주문을 각각
   * `equity / topN` 으로 내는데, 엔진의 리스크 검증은 상한을 넘는 주문을 `null` 로
   * 떨어뜨린다. 초과분은 폐기되고 `pendingBuys` 는 이미 비워졌으므로 다음 리밸런스까지
   * 재시도되지 않는다 — 자본의 (topN-maxPositions)/topN 이 영구히 현금으로 남는데
   * 자산 곡선은 정상적으로 보인다. 기본값 조합(value-quality-rank topN=20, 웹 마법사
   * maxPositions=10)이 정확히 이 상태다.
   *
   * 전략 id 를 특별 취급하지 않고 **검증된 파라미터에 숫자 `topN` 이 있으면** 본다 —
   * range-breakout 처럼 이 파라미터가 없는 전략은 자연히 통과한다.
   * `checkFundamentalsRequirement` 와 같은 이유로 400(요청 형식)이 아니라 422 다:
   * 요청 자체는 유효하고 "전략 파라미터와 리스크 설정의 조합" 이 문제다.
   */
  const checkPositionCapacity = (body: BacktestRequest): string | null => {
    const validated = strategies.validateParameters(
      body.strategyId,
      parametersForLegacyStrategySchedule(body),
    );
    // 파라미터 자체가 스키마를 통과하지 못하는 경우는 validateSubmission 이 400 으로 말한다
    if (!validated.ok || typeof validated.value !== 'object' || validated.value === null) {
      return null;
    }
    const topN = (validated.value as Record<string, unknown>)['topN'];
    if (typeof topN !== 'number' || !Number.isFinite(topN)) return null;
    if (topN <= body.risk.maxPositions) return null;
    return (
      `보유 종목 수(${topN})가 최대 동시 보유 종목 수(${body.risk.maxPositions})보다 큽니다. ` +
      `초과분 ${topN - body.risk.maxPositions}종목은 편입되지 못하고 그만큼 자본이 현금으로 남습니다. ` +
      '보유 종목 수를 줄이거나 최대 동시 보유 종목 수를 그 이상으로 올리세요.'
    );
  };

  /**
   * 대기열 깊이 상한 (D-025). QUEUED 만 센다 — 실행 중은 동시 실행 상한이 이미 묶고 있다.
   * 429 는 507(호스트 자원 부족)과 구분한다: 사용자가 할 일이 다르다(기다리거나 취소).
   */
  const queueDepthError = (): string | null => {
    const queued = queue.countByStatus(['QUEUED']);
    if (queued < deps.maxQueuedBacktests) return null;
    return `대기 중인 백테스트가 ${queued}건으로 상한(${deps.maxQueuedBacktests})에 도달했습니다. 완료되거나 취소된 뒤 제출하세요.`;
  };

  app.get('/backtests/profiles', { preHandler: requireAuth }, async () => ({
    commissionProfiles: listCostProfiles(),
    slippageProfiles: listSlippageProfiles(),
  }));

  app.post('/backtests', { preHandler: requireAuth }, async (request, reply) => {
    const parsed = backtestRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      });
    }
    const body = parsed.data;

    // 잘못된 요청을 PREPARATION_REQUIRED로 가리면 사용자는 완료할 수 없는 준비를
    // 시작하게 된다. 외부 데이터와 무관한 검증은 preparation hash 조회보다 먼저 한다.
    const staticErrors = validateStaticSubmission(body);
    if (staticErrors.length > 0) {
      return reply.code(400).send({ error: staticErrors[0] });
    }

    const prepared = await preparation.getReadyPreview(preparationInputOf(body));
    if (!prepared) {
      return reply.code(409).send({
        error: 'PREPARATION_REQUIRED',
        message: '동일한 조건의 데이터 준비를 먼저 완료하세요.',
      });
    }

    let validated: Awaited<ReturnType<typeof validateSubmission>>;
    try {
      validated = await validateSubmission(body, prepared);
    } catch (error) {
      if (sendIfKrxError(reply, error)) return reply;
      if (sendIfNotCovered(reply, error)) return reply;
      throw error;
    }
    if (!validated.ok) {
      return reply.code(validated.status).send({
        error: validated.errors[0] ?? '제출을 검증할 수 없습니다',
        ...('uncoveredDates' in validated ? { uncoveredDates: validated.uncoveredDates } : {}),
        ...('corporateActionGate' in validated && validated.corporateActionGate
          ? { corporateActionGate: validated.corporateActionGate }
          : {}),
      });
    }

    const fundamentalsError = checkFundamentalsRequirement(body, validated.resolved.unionSymbols);
    if (fundamentalsError) {
      return reply.code(422).send({ error: fundamentalsError });
    }

    const capacityError = checkPositionCapacity(body);
    if (capacityError) {
      return reply.code(422).send({ error: capacityError });
    }

    const queueError = queueDepthError();
    if (queueError) return reply.code(429).send({ error: queueError });

    const resourceError = await checkResources(deps.dataRoot);
    if (resourceError) return reply.code(507).send({ error: resourceError });

    // 해소한 소비 봉을 요청에 박아 저장한다 — 워커가 다시 추론하면 두 곳의 규칙이
    // 갈라질 수 있고, 실행 기록도 "무엇을 소비했나" 에 답하지 못한다.
    // provenancePin 은 여기서 조립한 것 그대로 저장한다 — 클라이언트가 준 값이 아니다.
    const job = queue.enqueue(
      { ...body, timeframe: validated.timeframe },
      validated.resolved.schedule,
      validated.universe,
      validated.provenancePin,
      validated.warnings,
    );
    audit.record(request.authUser?.username ?? 'admin', 'backtest.created', {
      jobId: job.id,
      strategyId: body.strategyId,
      universeRule: body.universeRule,
      scheduleHash: validated.provenancePin.scheduleHash,
    });
    return reply.code(201).send({ job: serializeJob(job), warnings: validated.warnings });
  });

  app.get('/backtests', { preHandler: requireAuth }, async (request, reply) => {
    const parsedQuery = z
      .object({
        limit: z.coerce.number().int().min(1).max(200).default(50),
        offset: z.coerce.number().int().min(0).default(0),
      })
      .safeParse(request.query ?? {});
    if (!parsedQuery.success) {
      return reply.code(400).send({ error: '쿼리 파라미터가 올바르지 않습니다 (limit/offset)' });
    }
    const query = parsedQuery.data;
    const jobs = queue.listJobs(query.limit, query.offset);
    return {
      jobs: jobs.map((job) => ({
        ...serializeJob(job),
        metrics: job.status === 'COMPLETED' ? results.getMetrics(job.id) : null,
      })),
    };
  });

  app.get('/backtests/:id', { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const job = queue.getJob(id);
    if (!job) return reply.code(404).send({ error: '작업을 찾을 수 없습니다' });
    return {
      job: serializeJob(job),
      run: results.getRun(id),
      metrics: results.getMetrics(id),
      // job 이 제출 시점부터 갖고 있다 — run 완료를 기다릴 필요가 없다 (Task 12).
      // 완료 후에는 backtestRuns.provenancePinJson 에 같은 값이 복사돼 있다.
      provenancePin: parseProvenancePin(job.provenancePinJson, id, request.log),
    };
  });

  app.post('/backtests/:id/cancel', { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const outcome = orchestrator.cancel(id);
    if (outcome === 'NOT_CANCELLABLE') {
      return reply.code(409).send({ error: '취소할 수 없는 상태입니다' });
    }
    return { status: outcome };
  });

  app.post('/backtests/:id/clone', { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const job = queue.getJob(id);
    if (!job) return reply.code(404).send({ error: '작업을 찾을 수 없습니다' });
    // 복제는 §10 이 지정한 중단 작업 복구 경로다 — 스키마·전략 버전이 올라갔다고 막지 않고,
    // 현재 기준으로 재기준한 뒤 무엇이 달라졌는지 경고로 알린다.
    const rebased = rebaseStoredRequest(
      job.requestJson,
      strategies.get(job.strategyId)?.version ?? null,
    );
    if (!rebased.ok) return reply.code(400).send({ error: rebased.error });
    const cloneRequest = rebased.request;
    const prepared = await preparation.getReadyPreview(preparationInputOf(cloneRequest));
    if (!prepared) {
      return reply.code(409).send({
        error: 'PREPARATION_REQUIRED',
        message: '동일한 조건의 데이터 준비를 먼저 완료하세요.',
      });
    }
    // 재기준 후에도 새 제출이다 — POST 와 동일한 검증 관문을 거치고 버전을 다시 고정한다.
    let validated: Awaited<ReturnType<typeof validateSubmission>>;
    try {
      // 완료된 preparation이 같은 staged schedule을 이미 등록·고정했다.
      validated = await validateSubmission(cloneRequest, prepared);
    } catch (error) {
      if (sendIfKrxError(reply, error)) return reply;
      if (sendIfNotCovered(reply, error)) return reply;
      throw error;
    }
    if (!validated.ok) {
      return reply.code(validated.status).send({
        error: validated.errors[0] ?? '제출을 검증할 수 없습니다',
        ...('uncoveredDates' in validated ? { uncoveredDates: validated.uncoveredDates } : {}),
      });
    }

    const fundamentalsError = checkFundamentalsRequirement(cloneRequest, validated.resolved.unionSymbols);
    if (fundamentalsError) {
      return reply.code(422).send({ error: fundamentalsError });
    }

    const capacityError = checkPositionCapacity(cloneRequest);
    if (capacityError) {
      return reply.code(422).send({ error: capacityError });
    }

    const queueError = queueDepthError();
    if (queueError) return reply.code(429).send({ error: queueError });

    // §34 리소스 가드도 관문의 일부다 — 복제라고 디스크·메모리 한계를 넘어설 이유는 없다
    const resourceError = await checkResources(deps.dataRoot);
    if (resourceError) return reply.code(507).send({ error: resourceError });

    // 응답과 저장이 같은 합집합을 써야 한다 — 한쪽만 고치면 화면과 기록이 갈라진다
    const cloneWarnings = [...rebased.warnings, ...validated.warnings];
    const cloned = queue.enqueue(
      { ...cloneRequest, timeframe: validated.timeframe },
      validated.resolved.schedule,
      validated.universe,
      validated.provenancePin,
      cloneWarnings,
    );
    audit.record(request.authUser?.username ?? 'admin', 'backtest.cloned', {
      sourceJobId: id,
      jobId: cloned.id,
      ...(rebased.warnings.length > 0 ? { rebaseWarnings: rebased.warnings } : {}),
    });
    return reply
      .code(201)
      .send({ job: serializeJob(cloned), warnings: cloneWarnings });
  });

  /**
   * 재설정 및 복제용 초안 (D-025). 읽기 전용 — 대기열에 넣지 않고 유니버스 버전도 고정하지 않는다.
   * 검증을 **돌리되 막지 않는다**: 여기서 400 으로 끊으면 조건이 틀어진 백테스트를 고칠
   * 화면 자체가 열리지 않는다. 실제 차단은 제출 시점 POST /backtests 가 그대로 지킨다.
   */
  app.get('/backtests/:id/clone-draft', { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const job = queue.getJob(id);
    if (!job) return reply.code(404).send({ error: '작업을 찾을 수 없습니다' });

    const rebased = rebaseStoredRequest(
      job.requestJson,
      strategies.get(job.strategyId)?.version ?? null,
    );
    if (!rebased.ok) return reply.code(400).send({ error: rebased.error });

    let validated: Awaited<ReturnType<typeof validateSubmission>>;
    let resolvedUniverse: ResolvedUniverse;
    try {
      validated = await validateSubmission(rebased.request);
      // 검증이 실패해도 재무·상한 검사에는 unionSymbols 이 필요하다 — blockers 목록이
      // 완전하려면 이 값을 다시 구해야 한다. resolve 는 uncovered 여도 예외를 던지지
      // 않으므로 안전하게 재사용한다.
      resolvedUniverse = validated.ok ? validated.resolved : await resolveScheduleForRequest(rebased.request);
    } catch (error) {
      if (sendIfKrxError(reply, error)) return reply;
      if (sendIfNotCovered(reply, error)) return reply;
      throw error;
    }
    const blockers = validated.ok ? [] : [...validated.errors];
    const fundamentalsError = checkFundamentalsRequirement(rebased.request, resolvedUniverse.unionSymbols);
    if (fundamentalsError) blockers.push(fundamentalsError);
    const capacityError = checkPositionCapacity(rebased.request);
    if (capacityError) blockers.push(capacityError);
    // 검증이 실패하면 그 사유는 blockers 로 이미 나간다 — warnings 는 통과했을 때만 있다.
    // POST /backtests/:id/clone 핸들러와 같은 합류 방식이다 — 두 경로가 갈리면
    // 위저드에서 자본변동 경고가 조용히 사라진다(리뷰 finding, 2026-08-08).
    return {
      request: rebased.request,
      warnings: [...rebased.warnings, ...(validated.ok ? validated.warnings : [])],
      blockers,
    };
  });

  app.delete('/backtests/:id', { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const deleted = queue.deleteJob(id);
    if (!deleted) {
      return reply.code(409).send({ error: '실행 중이거나 존재하지 않는 작업은 삭제할 수 없습니다' });
    }
    audit.record(request.authUser?.username ?? 'admin', 'backtest.deleted', { jobId: id });
    return reply.code(204).send();
  });

  app.get('/backtests/:id/trades', { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!queue.getJob(id)) return reply.code(404).send({ error: '작업을 찾을 수 없습니다' });
    const parsedQuery = z
      .object({
        limit: z.coerce.number().int().min(1).max(500).default(100),
        offset: z.coerce.number().int().min(0).default(0),
        symbol: z.string().optional(),
        // 모르는 축은 400 이다 — 조용히 기본 정렬로 떨어뜨리면 화면은 「순손익순」을
        // 표시한 채 청산순 목록을 보여 주고, 그 어긋남은 아무 데도 적히지 않는다.
        sort: z.enum(TRADE_SORT_KEYS).default(DEFAULT_TRADE_SORT_KEY),
        dir: z.enum(SORT_DIRECTIONS).default(DEFAULT_TRADE_SORT_DIRECTION),
      })
      .safeParse(request.query ?? {});
    if (!parsedQuery.success) {
      return reply
        .code(400)
        .send({ error: '쿼리 파라미터가 올바르지 않습니다 (limit/offset/symbol/sort/dir)' });
    }
    const query = parsedQuery.data;
    return results.getTrades(id, {
      limit: query.limit,
      offset: query.offset,
      sort: query.sort,
      direction: query.dir,
      ...(query.symbol !== undefined ? { symbol: query.symbol } : {}),
    });
  });

  app.get('/backtests/:id/series', { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!queue.getJob(id)) return reply.code(404).send({ error: '작업을 찾을 수 없습니다' });
    return results.getChartSeries(id);
  });

  app.get('/backtests/:id/export', { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const job = queue.getJob(id);
    if (!job) return reply.code(404).send({ error: '작업을 찾을 수 없습니다' });
    reply.header('content-disposition', `attachment; filename="backtest-${id}.json"`);
    const fullExport = results.getFullExport(id);
    return { job: serializeJob(job), ...fullExport };
  });

  /** SSE 진행률 (스펙 §14). 연결이 끊기면 클라이언트는 polling 으로 fallback 한다. */
  app.get('/backtests/:id/events', { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const job = queue.getJob(id);
    if (!job) return reply.code(404).send({ error: '작업을 찾을 수 없습니다' });

    reply.hijack();
    // hijack 은 onSend hook 을 우회하므로 §16 보안 헤더를 직접 포함한다
    reply.raw.writeHead(200, {
      ...SECURITY_HEADERS,
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });

    const writeSnapshot = (): BacktestJobRow | null => {
      const current = queue.getJob(id);
      if (current) {
        reply.raw.write(`data: ${JSON.stringify(serializeJob(current))}\n\n`);
      }
      return current;
    };

    const first = writeSnapshot();
    if (!first || queue.isTerminal(first.status)) {
      reply.raw.end();
      return;
    }

    const listener = (event: JobEvent): void => {
      if (event.jobId !== id) return;
      const current = writeSnapshot();
      if (current && queue.isTerminal(current.status)) cleanup();
    };
    const heartbeat = setInterval(() => reply.raw.write(':heartbeat\n\n'), 15_000);
    heartbeat.unref();

    const cleanup = (): void => {
      clearInterval(heartbeat);
      orchestrator.events.off('job', listener);
      reply.raw.end();
    };

    orchestrator.events.on('job', listener);
    request.raw.on('close', () => {
      clearInterval(heartbeat);
      orchestrator.events.off('job', listener);
    });
  });
}
