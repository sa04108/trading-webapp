import os from 'node:os';
import fs from 'node:fs';
import type { FastifyBaseLogger, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  backtestRequestSchema,
  periodToTsRange,
  type BacktestRequest,
} from '../../../../shared/schemas/backtest-request.js';
import { universeRuleSchema } from '../../../../shared/schemas/universe-rule.js';
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
import type { ConsumedVersionSnapshot, SymbolService } from '../../market-data/application/symbol-service.js';
import { KrxNotConfiguredError, KrxQuotaError } from '../../market-data/application/ports.js';
import { KRX_FILTER_POLICY_VERSION } from '../../market-data/domain/krx-filter-policy.js';
import {
  sliceForTimeframe,
  sliceTimeframes,
  type DatasetSlice,
} from '../../market-data/domain/dataset-slice.js';
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
import {
  computeRebalanceDates,
  type ResolvedUniverse,
  type UniverseRuleResolver,
} from '../application/universe-rule-resolver.js';

type PreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

export interface BacktestRouteDeps {
  readonly queue: JobQueue;
  readonly orchestrator: JobOrchestrator;
  readonly results: ResultsService;
  readonly strategies: StrategyRegistry;
  readonly symbolService: SymbolService;
  /** 유니버스 규칙 → 리밸런스 날짜별 멤버십 일정 (스펙 2026-08-05) */
  readonly universeRuleResolver: UniverseRuleResolver;
  readonly audit: AuditLogService;
  readonly factRepository: FactRepository;
  readonly dataRoot: string;
  readonly maxQueuedBacktests: number;
  readonly clock: Clock;
}

const MIN_FREE_DISK_BYTES = 500 * 1024 * 1024;
const MIN_FREE_MEMORY_BYTES = 75 * 1024 * 1024;

const isoDate = (tsMs: number): string => new Date(tsMs).toISOString().slice(0, 10);

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

export function registerBacktestRoutes(app: FastifyInstance, deps: BacktestRouteDeps, requireAuth: PreHandler): void {
  const {
    queue,
    orchestrator,
    results,
    strategies,
    symbolService,
    universeRuleResolver,
    audit,
    factRepository,
  } = deps;

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
    slice: DatasetSlice,
    period: { from: string; to: string },
  ): string | null => {
    const { fromTsMs, toTsMs } = periodToTsRange(period);
    const bySymbol = new Map(
      symbolService
        .getCoverage(codes)
        .filter((row) => row.slice === slice)
        .map((row) => [row.code, row]),
    );

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
   * 소비 timeframe 해소 + 슬라이스 봉 존재 확인 + 봉 수 상한 검사. 데이터셋·스냅샷
   * 경로가 공유한다 — 유니버스가 어디서 왔든 "이 종목 집합으로 이 기간에 얼마나
   * 소비하나" 는 같은 질문이다. 두 경로가 갈리는 지점은 기간 커버리지 판정 방식뿐이라
   * `coverageCheck` 로 주입한다 (D-025 관용 vs REVIEW §9.1 엄격 차단).
   */
  const resolveConsumedUniverse = (
    body: BacktestRequest,
    codes: readonly string[],
    errors: string[],
    coverageCheck: (codes: readonly string[], slice: DatasetSlice) => string | null,
  ): { universe: ConsumedVersionSnapshot; timeframe: '1m' | '1h' | '1d' } | null => {
    /**
     * 소비 timeframe 검사. 데이터셋에 `defaultTimeframe` 이 없어졌으므로(설계
     * 2026-07-31-symbol-as-first-class) 미지정 요청의 기준을 **데이터에서** 찾는다:
     * 유니버스가 가진 슬라이스가 하나면 그것으로 정하고, 둘 다 있거나 둘 다 없으면
     * 거부한다 — 임의로 하나를 골라 주면 사용자가 의도하지 않은 봉으로 돌아간다.
     * 위저드는 항상 명시값을 보내므로 이 경로는 옛 저장 요청·API 직접 호출용이다.
     */
    const available = (['1d', '1m'] as const).filter((candidate) =>
      symbolService.getCoverage(codes).some((row) => row.slice === candidate && row.barCount > 0),
    );
    let consumed = body.timeframe;
    if (consumed === undefined) {
      if (available.length === 1) {
        consumed = available[0] === '1m' ? '1h' : '1d';
      } else {
        errors.push(
          available.length === 0
            ? '선택한 종목에 수집된 봉이 없습니다 — 종목 화면에서 먼저 동기화하세요.'
            : '소비할 봉 주기를 지정하세요 (1d/1h/1m) — 이 종목들은 일봉과 분봉을 모두 갖고 있습니다.',
        );
      }
    }
    if (consumed === undefined) return null;

    const slice = sliceForTimeframe(consumed);
    const allowedTimeframes = sliceTimeframes(slice);
    const sliceCoverageRows = symbolService.getCoverage(codes).filter((row) => row.slice === slice);
    const sliceHasData = sliceCoverageRows.some((row) => row.barCount > 0);

    if (!allowedTimeframes.includes(consumed)) {
      // 방어적 분기 — zod 스키마가 이미 consumed 를 '1m'|'1h'|'1d' 로 제한하고
      // sliceForTimeframe/sliceTimeframes 는 그 timeframe 이 속한 슬라이스를
      // 되돌리므로 이 분기는 현재 값 범위에서 도달하지 않는다.
      errors.push(`이 유니버스는 timeframe ${allowedTimeframes.join('/')} 만 제공합니다 (요청: ${consumed})`);
      return null;
    }
    if (!sliceHasData) {
      // 실제로 도달 가능한 경우 — timeframe 자체는 존재할 수 있지만(예: 1d 전용
      // 유니버스에 1m 요청) 그 슬라이스로 아직 수집된 데이터가 없다. "timeframe X 만
      // 제공합니다" 처럼 스스로 모순되는 메시지를 내지 않도록 원인을 구분해 말한다.
      errors.push(
        `선택한 종목에 아직 ${consumed} 데이터가 없습니다: ` +
          `${codes.join(', ')} — 종목 화면에서 해당 봉을 동기화(또는 CSV 가져오기)한 뒤 다시 시도하세요.`,
      );
      return null;
    }

    const coverageError = coverageCheck(codes, slice);
    if (coverageError !== null) {
      errors.push(coverageError);
      return null;
    }

    // 제출 시점의 종목 버전 스냅샷을 고정 — 대기 중 동기화가 끼어들어도 어긋나지 않는다 (§9.5)
    const universe = symbolService.versionSnapshotFor(codes, slice);

    // 봉 수 상한 — 실행부는 전체 봉을 메모리에 올린다. 1m 소비를 열면서 생긴 밸브.
    // coverage 는 슬라이스 기준 timeframe 으로 세므로 1m 소비만 배율 60 으로 추정한다.
    const { fromTsMs, toTsMs } = periodToTsRange(body.period);
    const estimated = estimateBars(
      sliceCoverageRows.map((row) => ({ ...row, symbol: row.code })),
      codes,
      fromTsMs,
      toTsMs,
      consumed === '1m' ? 60 : 1,
    );
    if (estimated > MAX_BACKTEST_BARS) {
      errors.push(
        `예상 봉 수가 상한을 넘습니다 (추정 ${estimated.toLocaleString()}봉 > ` +
          `${MAX_BACKTEST_BARS.toLocaleString()}봉). 기간이나 종목 수를 줄이거나 1h 봉을 사용하세요.`,
      );
      return null;
    }

    return { universe, timeframe: consumed };
  };

  /**
   * 전략 파라미터에서 `rebalanceMonths` 를 읽어 리밸런스 날짜를 만든다 — 그 파라미터가
   * 없는 전략(예: range-breakout)은 리밸런스가 하나(`period.from`)뿐이라고 본다
   * (브리프 외 결정, 스펙 2026-08-05). 파라미터가 스키마를 통과하지 못해도(전략 미지정
   * 등) 여기서는 실패시키지 않는다 — 그 오류는 `validateSubmission` 의 다른 검사가
   * 이미 잡으므로, 유니버스 해소 자체는 관대한 기본값(1회 리밸런스)으로 계속 진행해
   * clone-draft 같은 읽기 전용 경로도 unionSymbols 를 얻을 수 있게 한다.
   */
  const resolveScheduleForRequest = (body: BacktestRequest): Promise<ResolvedUniverse> => {
    const paramCheck = strategies.validateParameters(body.strategyId, body.parameters);
    const rebalanceMonthsRaw =
      paramCheck.ok && typeof paramCheck.value === 'object' && paramCheck.value !== null
        ? (paramCheck.value as Record<string, unknown>)['rebalanceMonths']
        : undefined;
    const rebalanceDates =
      typeof rebalanceMonthsRaw === 'number' && Number.isFinite(rebalanceMonthsRaw)
        ? computeRebalanceDates(body.period, rebalanceMonthsRaw)
        : [body.period.from];
    return universeRuleResolver.resolve(body.universeRule, rebalanceDates);
  };

  type ValidationResult =
    | {
        readonly ok: true;
        readonly universe: ConsumedVersionSnapshot;
        readonly timeframe: '1m' | '1h' | '1d';
        readonly provenancePin: ProvenancePin;
        readonly resolved: ResolvedUniverse;
      }
    | { readonly ok: false; readonly status: 400; readonly errors: string[] }
    | { readonly ok: false; readonly status: 422; readonly errors: string[]; readonly uncoveredDates: readonly string[] };

  /**
   * 제출 검증 — 신규 제출(POST)·복제(clone)·초안(clone-draft)이 동일한 기준을 거친다.
   * 통과 시 제출 시점의 유니버스 버전과 서버 소유 provenance pin(Task 12)을 함께
   * 반환한다 (재현성 §9.5, REVIEW §9.2). 400 메시지는 `errors[0]` 이므로 검사 순서가
   * 곧 우선순위다.
   *
   * 전략·기간·프로파일처럼 요청 자체의 형식 오류는 유니버스 해소(종목 마스터 조회·
   * 시총 join)보다 먼저 걸러 반환한다 — 어차피 거부할 요청 때문에 KRX 호출 예산을
   * 쓰지 않기 위해서다. uncovered 리밸런스 날짜(422)는 그다음, 캔들 존재 검증(400)은
   * 그다음이다(브리프의 ①②③④ 순서).
   */
  const validateSubmission = async (body: BacktestRequest): Promise<ValidationResult> => {
    const errors: string[] = [];

    // 전략 — 파라미터 검증의 전제다
    const strategy = strategies.get(body.strategyId);
    if (!strategy) {
      errors.push(`알 수 없는 전략: ${body.strategyId}`);
    } else {
      // 전략 버전은 검사하지 않는다 (D-029) — 요청이 버전을 들고 다니지 않는다.
      // 실행되는 것은 언제나 지금 등록된 전략이고, 파라미터가 그 전략과 안 맞으면
      // 바로 아래 검증이 잡는다.
      const paramCheck = strategies.validateParameters(body.strategyId, body.parameters);
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

    if (errors.length > 0) {
      return { ok: false, status: 400, errors };
    }

    // ① 유니버스 규칙 → 리밸런스 날짜별 멤버십 일정. 커버 밖 날짜가 있으면 캔들
    // 검증으로 넘어가지 않고 바로 422 로 알린다 — 종목 구성 자체를 모르는 날짜의
    // 캔들을 따질 수 없다.
    const resolved = await resolveScheduleForRequest(body);
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
      (codes, slice) => checkPeriodCoverage(codes, slice, body.period),
    );
    if (universeErrors.length > 0 || resolvedConsumption === null) {
      return {
        ok: false,
        status: 400,
        errors: universeErrors.length > 0 ? universeErrors : ['제출을 검증할 수 없습니다'],
      };
    }

    // ③ 종목 버전 pin 은 기존 universeJson 메커니즘을 그대로 쓴다 — unionSymbols 기준.
    // ④ provenancePin — 유니버스 규칙 경로(스펙 2026-08-05)는 늘 이 모양이다.
    const provenancePin: ProvenancePin = {
      sourceKind: 'SYMBOL_MASTER',
      filterPolicyVersion: KRX_FILTER_POLICY_VERSION,
      selectionMethod: 'TOP_MARKET_CAP_N',
      scheduleHash: resolved.scheduleHash,
    };

    return {
      ok: true,
      universe: resolvedConsumption.universe,
      timeframe: resolvedConsumption.timeframe,
      provenancePin,
      resolved,
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
    const validated = strategies.validateParameters(body.strategyId, body.parameters);
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

  const universePreviewRequestSchema = z.object({
    universeRule: universeRuleSchema,
    period: z.object({
      from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    }),
    rebalanceMonths: z.number().int().positive().default(1),
  });

  /**
   * unionSymbols 중 이 화면이 아직 실행할 수 없는 종목 — 종목 마스터에는 있지만
   * (1) 로컬 `symbols` 테이블에 등록돼 있지 않거나 (2) 등록은 됐지만 어느 슬라이스로도
   * 봉을 하나도 수집하지 않은 경우다. `missingCandleSymbols` 의 정확한 정의는 브리프에
   * timeframe 을 명시하지만(이 미리보기 요청 바디에는 timeframe 이 없다), 위저드가
   * 미리보기 단계에서 아직 timeframe 을 고르지 않은 시점에도 쓸 수 있어야 하므로
   * "어느 슬라이스에도 봉이 없다" 로 일반화한다(브리프 외 결정).
   */
  const missingCandleSymbolsOf = (codes: readonly string[]): string[] => {
    const hasBars = new Set(
      symbolService
        .getCoverage(codes)
        .filter((row) => row.barCount > 0)
        .map((row) => row.code),
    );
    return codes.filter((code) => !symbolService.exists(code) || !hasBars.has(code));
  };

  app.post('/backtests/universe-preview', { preHandler: requireAuth }, async (request, reply) => {
    const parsed = universePreviewRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      });
    }
    const { universeRule, period, rebalanceMonths } = parsed.data;
    if (period.from > period.to) {
      return reply.code(400).send({ error: '기간이 올바르지 않습니다 (from > to)' });
    }

    const rebalanceDates = computeRebalanceDates(period, rebalanceMonths);
    try {
      const resolved = await universeRuleResolver.resolve(universeRule, rebalanceDates);
      return {
        schedule: resolved.schedule,
        unionSymbols: resolved.unionSymbols,
        scheduleHash: resolved.scheduleHash,
        uncoveredDates: resolved.uncoveredDates,
        missingCandleSymbols: missingCandleSymbolsOf(resolved.unionSymbols),
      };
    } catch (error) {
      if (sendIfKrxError(reply, error)) return reply;
      throw error;
    }
  });

  app.post('/backtests', { preHandler: requireAuth }, async (request, reply) => {
    const parsed = backtestRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      });
    }
    const body = parsed.data;

    let validated: Awaited<ReturnType<typeof validateSubmission>>;
    try {
      validated = await validateSubmission(body);
    } catch (error) {
      if (sendIfKrxError(reply, error)) return reply;
      throw error;
    }
    if (!validated.ok) {
      return reply.code(validated.status).send({
        error: validated.errors[0] ?? '제출을 검증할 수 없습니다',
        ...('uncoveredDates' in validated ? { uncoveredDates: validated.uncoveredDates } : {}),
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
    );
    audit.record(request.authUser?.username ?? 'admin', 'backtest.created', {
      jobId: job.id,
      strategyId: body.strategyId,
      universeRule: body.universeRule,
      scheduleHash: validated.provenancePin.scheduleHash,
    });
    return reply.code(201).send({ job: serializeJob(job) });
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
    // 재기준 후에도 새 제출이다 — POST 와 동일한 검증 관문을 거치고 버전을 다시 고정한다.
    let validated: Awaited<ReturnType<typeof validateSubmission>>;
    try {
      validated = await validateSubmission(cloneRequest);
    } catch (error) {
      if (sendIfKrxError(reply, error)) return reply;
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

    const cloned = queue.enqueue(
      { ...cloneRequest, timeframe: validated.timeframe },
      validated.resolved.schedule,
      validated.universe,
      validated.provenancePin,
    );
    audit.record(request.authUser?.username ?? 'admin', 'backtest.cloned', {
      sourceJobId: id,
      jobId: cloned.id,
      ...(rebased.warnings.length > 0 ? { rebaseWarnings: rebased.warnings } : {}),
    });
    return reply.code(201).send({ job: serializeJob(cloned), warnings: rebased.warnings });
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
      throw error;
    }
    const blockers = validated.ok ? [] : [...validated.errors];
    const fundamentalsError = checkFundamentalsRequirement(rebased.request, resolvedUniverse.unionSymbols);
    if (fundamentalsError) blockers.push(fundamentalsError);
    const capacityError = checkPositionCapacity(rebased.request);
    if (capacityError) blockers.push(capacityError);
    return {
      request: rebased.request,
      warnings: rebased.warnings,
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
