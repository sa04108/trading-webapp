import { quarterOrdinal } from '../../../facts/domain/pit-fact-view.js';
import { KR_SESSION, toLocalTime } from '../../../market-data/domain/exchange-session.js';
import { shuffleInPlace, type Rng } from '../../../backtest/domain/seeded-rng.js';

export interface EarningsAccelerationInput {
  q0: number;
  q1: number;
  q2: number;
  q3: number;
  q4: number;
  q5: number;
  q6: number;
  q7: number;
  priceMomentum: number;
}

export interface LowPerHighRoeInput {
  marketCapKrw: string;
  netIncomeTtm: number;
  totalEquity: number;
}

export interface LowPerHighRoeCandidate extends LowPerHighRoeInput {
  symbol: string;
}

const MS_PER_DAY = 86_400_000;
const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

/** 봉 시각의 KST 월을 분기 서수로 접는다 (quarterOrdinal 과 같은 눈금). */
export function currentQuarterOrdinal(atTsMs: number): number {
  const { dayIndex } = toLocalTime(atTsMs, KR_SESSION);
  const localDate = new Date(dayIndex * MS_PER_DAY);
  return localDate.getUTCFullYear() * 4 + Math.floor(localDate.getUTCMonth() / 3);
}

export function isFreshQuarter(
  periodKey: string | null,
  atTsMs: number,
  staleQuarters: number,
): boolean {
  if (
    periodKey === null
    || !Number.isFinite(atTsMs)
    || !Number.isInteger(staleQuarters)
    || staleQuarters < 0
  ) {
    return false;
  }
  const disclosedQuarter = quarterOrdinal(periodKey);
  if (disclosedQuarter === null) return false;
  const lag = currentQuarterOrdinal(atTsMs) - disclosedQuarter;
  return lag >= 0 && lag <= staleQuarters;
}

function compareCodes(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function shuffleEqualRanges<T>(
  sorted: T[],
  equal: (left: T, right: T) => boolean,
  rng: Rng | undefined,
): void {
  if (rng === undefined) return;
  for (let start = 0; start < sorted.length;) {
    let end = start + 1;
    while (
      end < sorted.length
      && equal(sorted[start] as T, sorted[end] as T)
    ) end += 1;
    if (end - start > 1) {
      const tied = sorted.slice(start, end);
      shuffleInPlace(tied, rng);
      sorted.splice(start, tied.length, ...tied);
    }
    start = end;
  }
}

export function ordinalRank<T>(
  rows: readonly T[],
  value: (row: T) => number,
  direction: 'ASC' | 'DESC',
  code: (row: T) => string,
  rng?: Rng,
): Map<T, number> {
  const sorted = [...rows].sort((left, right) => {
    const leftValue = value(left);
    const rightValue = value(right);
    const leftFinite = Number.isFinite(leftValue);
    const rightFinite = Number.isFinite(rightValue);
    if (leftFinite !== rightFinite) return leftFinite ? -1 : 1;
    if (leftValue === rightValue || (!leftFinite && !rightFinite)) {
      return compareCodes(code(left), code(right));
    }
    return direction === 'ASC' ? leftValue - rightValue : rightValue - leftValue;
  });
  shuffleEqualRanges(
    sorted,
    (left, right) => {
      const leftValue = value(left);
      const rightValue = value(right);
      return leftValue === rightValue
        || (!Number.isFinite(leftValue) && !Number.isFinite(rightValue));
    },
    rng,
  );
  return new Map(sorted.map((row, index) => [row, index + 1]));
}

export function combineRanks<T>(
  rows: readonly T[],
  ranks: readonly ReadonlyMap<T, number>[],
  code: (row: T) => string,
  rng?: Rng,
): T[] {
  const scored = rows.map((row) => ({
    row,
    rankSum: ranks.reduce(
      (sum, rank) => sum + (rank.get(row) ?? Number.POSITIVE_INFINITY),
      0,
    ),
  })).sort((left, right) => (
    left.rankSum === right.rankSum
      ? compareCodes(code(left.row), code(right.row))
      : left.rankSum - right.rankSum
  ));
  shuffleEqualRanges(scored, (left, right) => left.rankSum === right.rankSum, rng);
  return scored.map(({ row }) => row);
}

export function scoreEarningsAcceleration(
  input: EarningsAccelerationInput,
): { ttmGrowth: number; priceMomentum: number } | null {
  const quarters = [input.q0, input.q1, input.q2, input.q3, input.q4, input.q5, input.q6, input.q7];
  if (quarters.some((value) => !Number.isFinite(value))) return null;
  if (!Number.isFinite(input.priceMomentum) || input.priceMomentum <= 0) return null;

  // 스펙 §8.2: 양수 조건은 두 TTM 합과 YoY 분모 q4·q5 에만 건다. 개별 분기 전부에
  // 걸면 한 분기 적자였지만 TTM 이 견조한 기업까지 잘못 제외한다. 음수→양수 전환
  // (작은 분모 폭발) 차단은 priorTtm·q4·q5 양수 조건이 담당한다.
  const currentTtm = input.q0 + input.q1 + input.q2 + input.q3;
  const priorTtm = input.q4 + input.q5 + input.q6 + input.q7;
  if (currentTtm <= 0 || priorTtm <= 0) return null;
  if (input.q4 <= 0 || input.q5 <= 0) return null;

  const ttmGrowth = currentTtm / priorTtm - 1;
  const latestQuarterYoy = input.q0 / input.q4 - 1;
  const previousQuarterYoy = input.q1 / input.q5 - 1;
  if (
    !Number.isFinite(ttmGrowth)
    || ttmGrowth <= 0
    || !Number.isFinite(latestQuarterYoy)
    || !Number.isFinite(previousQuarterYoy)
    || latestQuarterYoy <= previousQuarterYoy
  ) {
    return null;
  }
  return { ttmGrowth, priceMomentum: input.priceMomentum };
}

function safePositiveMarketCap(value: string): number | null {
  if (!/^\d+$/.test(value)) return null;
  try {
    const parsed = BigInt(value);
    if (parsed <= 0n || parsed > MAX_SAFE_BIGINT) return null;
    return Number(parsed);
  } catch {
    return null;
  }
}

export function scoreLowPerHighRoe(
  input: LowPerHighRoeInput,
): { per: number; roe: number } | null {
  const marketCap = safePositiveMarketCap(input.marketCapKrw);
  if (
    marketCap === null
    || !Number.isFinite(input.netIncomeTtm)
    || input.netIncomeTtm <= 0
    || !Number.isFinite(input.totalEquity)
    || input.totalEquity <= 0
  ) {
    return null;
  }
  const per = marketCap / input.netIncomeTtm;
  const roe = input.netIncomeTtm / input.totalEquity;
  if (!Number.isFinite(per) || per <= 0 || !Number.isFinite(roe) || roe <= 0) return null;
  return { per, roe };
}

export function rankLowPerHighRoe(
  rows: readonly LowPerHighRoeCandidate[],
  rng?: Rng,
): LowPerHighRoeCandidate[] {
  const scored = rows.flatMap((row) => {
    const metrics = scoreLowPerHighRoe(row);
    return metrics === null ? [] : [{ row, ...metrics }];
  });
  const perRanks = ordinalRank(
    scored,
    (entry) => entry.per,
    'ASC',
    (entry) => entry.row.symbol,
    rng,
  );
  const roeRanks = ordinalRank(
    scored,
    (entry) => entry.roe,
    'DESC',
    (entry) => entry.row.symbol,
    rng,
  );
  return combineRanks(scored, [perRanks, roeRanks], (entry) => entry.row.symbol, rng).map(
    (entry) => entry.row,
  );
}
