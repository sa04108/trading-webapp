import {
  KRX_CONTRACT_VERSION,
  type KrxDailyTradeRow,
  type KrxIssueBaseInfoRow,
  type KrxMarket,
} from './krx-universe-types.js';
import { classifyKrxIssue, KRX_FILTER_POLICY_VERSION } from './krx-filter-policy.js';
import type { UniverseSortKey } from '../../../../shared/schemas/universe-sort.js';

export interface EligibleCandidate {
  readonly standardCode: string;
  readonly shortCode: string;
  readonly name: string;
  readonly market: KrxMarket;
  readonly marketCapKrw: bigint | null;
  readonly rank: number | null;
}

export interface UniverseCandidateSet {
  readonly effectiveTradingDate: string;
  readonly candidates: readonly EligibleCandidate[];
  readonly rawCounts: Readonly<Record<KrxMarket, number>>;
  readonly eligibleCount: number;
  readonly unknownMarketCapCount: number;
  readonly excludedByType: Readonly<Record<string, number>>;
  readonly filterPolicyVersion: string;
  readonly contractVersion: string;
  readonly canonicalPayload: string;
}

export class UniverseJoinError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UniverseJoinError';
  }
}

interface MarketInput {
  readonly market: KrxMarket;
  readonly baseRows: readonly KrxIssueBaseInfoRow[];
  readonly dailyRows: readonly KrxDailyTradeRow[];
}

interface PreparedMarketInput extends MarketInput {
  readonly baseByShortCode: ReadonlyMap<string, KrxIssueBaseInfoRow>;
  readonly dailyByShortCode: ReadonlyMap<string, KrxDailyTradeRow>;
}

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function compareCandidateIdentity(left: EligibleCandidate, right: EligibleCandidate): number {
  return compareText(left.shortCode, right.shortCode)
    || compareText(left.standardCode, right.standardCode)
    || compareText(left.market, right.market);
}

function marketCapOf(market: KrxMarket, row: KrxDailyTradeRow | undefined): bigint | null {
  if (row === undefined || row.marketCapRaw === null) return null;
  if (!/^(0|[1-9]\d*)$/.test(row.marketCapRaw)) {
    throw new UniverseJoinError(
      `KRX ${market} 단축코드 ${row.shortCode}의 시가총액 내부 값이 정규화된 정수가 아닙니다`,
    );
  }

  return BigInt(row.marketCapRaw);
}

function prepareInputs(inputs: readonly MarketInput[]): PreparedMarketInput[] {
  const seenMarkets = new Set<KrxMarket>();
  const standardCodeOwners = new Map<string, { market: KrxMarket; shortCode: string }>();
  const prepared: PreparedMarketInput[] = [];

  for (const input of inputs) {
    if (seenMarkets.has(input.market)) {
      throw new UniverseJoinError(`KRX 시장 입력이 중복되었습니다: ${input.market}`);
    }
    seenMarkets.add(input.market);

    const baseByShortCode = new Map<string, KrxIssueBaseInfoRow>();
    for (const row of input.baseRows) {
      if (baseByShortCode.has(row.shortCode)) {
        throw new UniverseJoinError(
          `KRX ${input.market} 기본정보 단축코드가 중복되었습니다: ${row.shortCode}`,
        );
      }
      baseByShortCode.set(row.shortCode, row);

      const owner = standardCodeOwners.get(row.standardCode);
      if (owner !== undefined) {
        throw new UniverseJoinError(
          `KRX 표준코드가 중복되었습니다: ${row.standardCode}, `
          + `${owner.market} ${owner.shortCode}, ${input.market} ${row.shortCode}`,
        );
      }
      standardCodeOwners.set(row.standardCode, { market: input.market, shortCode: row.shortCode });
    }

    const dailyByShortCode = new Map<string, KrxDailyTradeRow>();
    for (const row of input.dailyRows) {
      if (dailyByShortCode.has(row.shortCode)) {
        throw new UniverseJoinError(
          `KRX ${input.market} 일별 단축코드가 중복되었습니다: ${row.shortCode}`,
        );
      }
      if (!baseByShortCode.has(row.shortCode)) {
        throw new UniverseJoinError(
          `KRX ${input.market} 일별 단축코드 ${row.shortCode}에 대응하는 기본정보가 없습니다`,
        );
      }
      dailyByShortCode.set(row.shortCode, row);
    }

    prepared.push({ ...input, baseByShortCode, dailyByShortCode });
  }

  return prepared;
}

function canonicalPayloadOf(
  effectiveTradingDate: string,
  candidates: readonly EligibleCandidate[],
): string {
  const header = `${effectiveTradingDate}|${KRX_FILTER_POLICY_VERSION}|${KRX_CONTRACT_VERSION}`;
  const lines = candidates.map((candidate) => [
    candidate.standardCode,
    candidate.shortCode,
    candidate.market,
    candidate.marketCapKrw?.toString() ?? 'unknown',
  ].join('|'));
  return [header, ...lines].join('\n');
}

export function combineMarketSnapshots(args: {
  effectiveTradingDate: string;
  inputs: ReadonlyArray<MarketInput>;
}): UniverseCandidateSet {
  const prepared = prepareInputs(args.inputs);
  const rawCounts: Record<KrxMarket, number> = { KOSPI: 0, KOSDAQ: 0 };
  const excludedCounts = new Map<string, number>();
  const candidates: EligibleCandidate[] = [];

  for (const input of prepared) {
    rawCounts[input.market] = input.baseRows.length;

    for (const baseRow of input.baseRows) {
      const decision = classifyKrxIssue(baseRow);
      if (decision.kind === 'EXCLUDE') {
        excludedCounts.set(decision.reason, (excludedCounts.get(decision.reason) ?? 0) + 1);
        continue;
      }

      candidates.push({
        standardCode: baseRow.standardCode,
        shortCode: baseRow.shortCode,
        name: baseRow.name,
        market: input.market,
        marketCapKrw: marketCapOf(input.market, input.dailyByShortCode.get(baseRow.shortCode)),
        rank: null,
      });
    }
  }

  const known = candidates
    .filter((candidate): candidate is EligibleCandidate & { marketCapKrw: bigint } => (
      candidate.marketCapKrw !== null
    ))
    .sort((left, right) => {
      if (left.marketCapKrw > right.marketCapKrw) return -1;
      if (left.marketCapKrw < right.marketCapKrw) return 1;
      return compareCandidateIdentity(left, right);
    })
    .map((candidate, index) => ({ ...candidate, rank: index + 1 }));
  const unknown = candidates
    .filter((candidate) => candidate.marketCapKrw === null)
    .sort(compareCandidateIdentity);
  const rankedCandidates: EligibleCandidate[] = [...known, ...unknown];
  const excludedByType = Object.fromEntries(
    [...excludedCounts.entries()].sort(([left], [right]) => compareText(left, right)),
  );

  return {
    effectiveTradingDate: args.effectiveTradingDate,
    candidates: rankedCandidates,
    rawCounts,
    eligibleCount: rankedCandidates.length,
    unknownMarketCapCount: unknown.length,
    excludedByType,
    filterPolicyVersion: KRX_FILTER_POLICY_VERSION,
    contractVersion: KRX_CONTRACT_VERSION,
    canonicalPayload: canonicalPayloadOf(args.effectiveTradingDate, rankedCandidates),
  };
}

export interface SortedUniverseCandidateSet extends UniverseCandidateSet {
  readonly sortKey: UniverseSortKey;
  readonly unknownSortValueCount: number;
  /** standardCode → 정렬 값 문자열 (값 있는 후보만) */
  readonly sortValues: ReadonlyMap<string, string>;
}

/**
 * 후보 집합에 정렬 기준을 적용한다.
 *
 * MKTCAP 은 combineMarketSnapshots 가 이미 매긴 rank·payload 를 그대로 쓴다 — 기존
 * 스냅샷의 candidateCanonicalHash·selectionHash 와 바이트 단위로 호환돼야 한다.
 * 다른 정렬은 rank 를 다시 매기고 payload 에 정렬 구획을 덧붙인다 — 같은 후보
 * 집합이라도 정렬 기준·값이 다르면 재현 해시가 달라야 한다.
 */
export function applySortKey(
  set: UniverseCandidateSet,
  sortKey: UniverseSortKey,
  /** OPERATING_INCOME 일 때 필수 — shortCode → TTM 영업이익(원) */
  operatingIncomeByShortCode?: ReadonlyMap<string, number>,
): SortedUniverseCandidateSet {
  if (sortKey === 'MKTCAP') {
    const sortValues = new Map<string, string>();
    for (const candidate of set.candidates) {
      if (candidate.marketCapKrw !== null) {
        sortValues.set(candidate.standardCode, candidate.marketCapKrw.toString());
      }
    }
    return { ...set, sortKey, unknownSortValueCount: set.unknownMarketCapCount, sortValues };
  }

  const values = operatingIncomeByShortCode ?? new Map<string, number>();
  const known = set.candidates
    .filter((candidate) => values.has(candidate.shortCode))
    .sort((left, right) => {
      const diff = (values.get(right.shortCode) as number) - (values.get(left.shortCode) as number);
      return diff !== 0 ? Math.sign(diff) : compareCandidateIdentity(left, right);
    })
    .map((candidate, index) => ({ ...candidate, rank: index + 1 }));
  const unknown = set.candidates
    .filter((candidate) => !values.has(candidate.shortCode))
    .sort(compareCandidateIdentity)
    .map((candidate) => ({ ...candidate, rank: null }));
  const candidates = [...known, ...unknown];

  const sortValues = new Map<string, string>();
  for (const candidate of known) {
    sortValues.set(candidate.standardCode, String(values.get(candidate.shortCode)));
  }
  const sortLines = known.map(
    (candidate) => `${candidate.standardCode}|${sortValues.get(candidate.standardCode)}`,
  );
  return {
    ...set,
    candidates,
    sortKey,
    unknownSortValueCount: unknown.length,
    sortValues,
    canonicalPayload: [set.canonicalPayload, '--sort--', sortKey, ...sortLines].join('\n'),
  };
}

export function selectionPayloadOf(
  canonicalPayload: string,
  standardCodes: readonly string[],
): string {
  return [canonicalPayload, '--selection--', ...[...standardCodes].sort(compareText)].join('\n');
}
