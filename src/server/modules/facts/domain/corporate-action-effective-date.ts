import { CORPORATE_ACTION_FIELD, type Fact } from './fact.js';

/**
 * KRX 기초정보에서 관측한 상장주식수 변경 하나.
 *
 * market-data 모듈의 타입을 그대로 가져오지 않고 여기서 다시 좁혀 정의한다 —
 * facts → market-data 의존을 만들지 않으려는 것이다 (스펙 §7).
 */
export interface SharesChange {
  readonly shortCode: string;
  /** KRX 가 바뀐 주식수를 처음 내보낸 날 ('YYYY-MM-DD') */
  readonly effectiveDate: string;
  /** 변경 후 주식수 / 변경 전 주식수 */
  readonly ratio: number;
}

/** KRX 짝을 찾지 못했거나 상충 공시 때문에 안전하게 정렬할 수 없는 자본변동 */
export interface UnalignedAction {
  readonly symbol: string;
  readonly periodKey: string;
  readonly ratio: number;
}

/**
 * 짝을 찾는 날짜 창. DART 기준일 기준으로 [-30일, +90일].
 *
 * 액면분할은 기준일 뒤 1~2주에 변경상장이 오는 것이 표준이라 뒤쪽이 넓어야 한다.
 * 앞쪽도 열어 두는 이유는 KRX 기초정보 관측일이 기준일보다 하루이틀 빠른 경우가
 * 있어서다. 창을 넓히기보다 비율 일치를 좁게 잡아 오짝을 막는다.
 */
export const CORPORATE_ACTION_ALIGNMENT_WINDOW = {
  beforeDays: 30,
  afterDays: 90,
} as const;

/** 전체 매칭 그래프에 포함할 raw DART 기준일의 최소·최대. */
export function corporateActionRawDateRange(
  facts: readonly Fact[],
): { readonly from: string; readonly to: string } | null {
  const dates = facts
    .filter((fact) => fact.field === CORPORATE_ACTION_FIELD)
    .map((fact) => fact.periodKey)
    .sort();
  const from = dates[0];
  const to = dates[dates.length - 1];
  return from === undefined || to === undefined ? null : { from, to };
}

/**
 * 비율 일치 허용 오차(상대). DART 비율은 분기 공시 발행주식수로 나눈 근사값이라
 * (dart-report-parser.ts `parseIssuanceRows`) KRX 주식수 비율과 소수점이 어긋난다.
 * 5% 는 1:2 분할(2.0)과 1:5 분할(5.0), 소규모 무상증자(1.02)를 서로 구분할 만큼 좁다.
 */
const RATIO_TOLERANCE = 0.05;
const RATIO_ERROR_SCALE = 1_000_000;

const MS_PER_DAY = 86_400_000;

function dayDistance(a: string, b: string): number {
  return Math.round(Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / MS_PER_DAY);
}

function signedDayOffset(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / MS_PER_DAY);
}

function ratioMatchError(factRatio: number, sharesRatio: number): number | null {
  if (
    !Number.isFinite(factRatio)
    || !Number.isFinite(sharesRatio)
    || factRatio <= 0
    || sharesRatio <= 0
  ) return null;
  const factChange = factRatio - 1;
  const sharesChange = sharesRatio - 1;
  // 증가와 감소는 같은 사건일 수 없다. total ratio끼리 비교하면 1.02와 0.98도
  // 불과 3.9% 차이로 보여 무상증자와 감자를 잘못 짝지을 수 있다.
  if (factChange === 0 || sharesChange === 0 || Math.sign(factChange) !== Math.sign(sharesChange)) {
    return null;
  }
  // 작은 자본변동에서는 총 비율보다 변화분을 비교해야 한다. 1.02와 1.07은
  // 총 비율로 4.9% 차이지만 실제 증감률은 2% 대 7%로 전혀 다른 사건이다.
  const tolerance = RATIO_TOLERANCE + Number.EPSILON;
  // 심한 병합에서는 0.05(1-for-20)와 0.01(1-for-100)의 변화분이 각각 -95%,
  // -99%라 서로 가까워 보인다. 총 비율도 함께 비교해야 다섯 배 차이를 거른다.
  const totalRatioError = Math.abs(sharesRatio / factRatio - 1);
  const changeMagnitudeError = Math.abs(sharesChange / factChange - 1);
  if (totalRatioError > tolerance || changeMagnitudeError > tolerance) return null;
  return totalRatioError + changeMagnitudeError;
}

interface FlowEdge {
  readonly to: number;
  readonly reverse: number;
  capacity: number;
  readonly cost: number;
}

function addFlowEdge(graph: FlowEdge[][], from: number, to: number, cost: number): FlowEdge {
  const forward: FlowEdge = { to, reverse: graph[to]!.length, capacity: 1, cost };
  const reverse: FlowEdge = { to: from, reverse: graph[from]!.length, capacity: 0, cost: -cost };
  graph[from]!.push(forward);
  graph[to]!.push(reverse);
  return forward;
}

function sendMinimumCostFlow(graph: FlowEdge[][], source: number, sink: number, count: number): void {
  for (let sent = 0; sent < count; sent += 1) {
    const distances = Array<number>(graph.length).fill(Number.POSITIVE_INFINITY);
    const previousNodes = Array<number>(graph.length).fill(-1);
    const previousEdges = Array<number>(graph.length).fill(-1);
    distances[source] = 0;

    // 역방향 간선의 비용은 음수가 될 수 있어 Bellman-Ford로 최단 augmenting path를
    // 찾는다. 노드와 간선은 날짜순으로 만들어지고 동률에서는 먼저 찾은 경로를
    // 유지하므로 입력 배열 순서와 무관하게 같은 최적해를 고른다.
    for (let pass = 0; pass < graph.length - 1; pass += 1) {
      let changed = false;
      for (let from = 0; from < graph.length; from += 1) {
        if (!Number.isFinite(distances[from])) continue;
        for (let edgeIndex = 0; edgeIndex < graph[from]!.length; edgeIndex += 1) {
          const edge = graph[from]![edgeIndex]!;
          if (edge.capacity === 0) continue;
          const candidate = distances[from]! + edge.cost;
          if (candidate >= distances[edge.to]!) continue;
          distances[edge.to] = candidate;
          previousNodes[edge.to] = from;
          previousEdges[edge.to] = edgeIndex;
          changed = true;
        }
      }
      if (!changed) break;
    }

    if (previousNodes[sink] === -1) {
      throw new Error('자본변동 날짜 배정 그래프에 완전 매칭이 없습니다.');
    }
    for (let node = sink; node !== source;) {
      const previousNode = previousNodes[node]!;
      const edge = graph[previousNode]![previousEdges[node]!]!;
      edge.capacity -= 1;
      graph[node]![edge.reverse]!.capacity += 1;
      node = previousNode;
    }
  }
}

function compareFacts(left: Fact, right: Fact): number {
  return left.periodKey.localeCompare(right.periodKey)
    || left.value - right.value
    || left.asOfTsMs - right.asOfTsMs
    || left.scope.localeCompare(right.scope);
}

/**
 * 한 종목의 사건을 최종 효력일에 배정한다.
 *
 * 모든 fact에는 자기 원래 날짜로 남는 fallback 간선이 있어 완전 배정이 가능하다.
 * fallback 비용을 전체 날짜 거리의 가능한 합보다 크게 두면 목적함수가 자연스럽게
 * (1) 정렬 건수 최대, (2) 총 날짜 거리 최소가 된다. 날짜 노드 용량이 1이므로 다른
 * 사건의 원래 날짜를 쓰려면 그 사건도 함께 이동해야 하고, 동일 변경일 충돌도 막힌다.
 */
function matchSymbolActions(
  symbolActions: readonly Fact[],
  symbolChanges: readonly SharesChange[],
  unmatchableActions: ReadonlySet<Fact>,
): Map<Fact, string> {
  const orderedActions = [...symbolActions].sort(compareFacts);
  const changesByDate = new Map<string, SharesChange[]>();
  for (const change of symbolChanges) {
    const changes = changesByDate.get(change.effectiveDate) ?? [];
    changes.push(change);
    changesByDate.set(change.effectiveDate, changes);
  }
  // 같은 종목·날짜에 서로 다른 KRX 주식수 비율이 있으면 어느 행이 실제 SCD인지
  // 판정할 근거가 없다. fact와 맞는 행 하나만 골라 쓰면 다른 행이 진짜일 때 수량이
  // 크게 어긋나므로, 완전히 같은 비율의 중복만 허용하고 상충 날짜는 후보에서 뺀다.
  const orderedChangeDates = [...changesByDate]
    .filter(([, changes]) => new Set(changes.map((change) => change.ratio)).size === 1)
    .map(([date]) => date)
    .sort();
  const candidatesByFact = new Map<Fact, Map<string, { distance: number; ratioError: number }>>();
  const allDates = new Set(orderedActions.map((fact) => fact.periodKey));
  for (const fact of orderedActions) {
    const candidates = new Map<string, { distance: number; ratioError: number }>();
    if (unmatchableActions.has(fact)) {
      candidatesByFact.set(fact, candidates);
      continue;
    }
    for (const date of orderedChangeDates) {
      const offset = signedDayOffset(fact.periodKey, date);
      if (
        offset < -CORPORATE_ACTION_ALIGNMENT_WINDOW.beforeDays
        || offset > CORPORATE_ACTION_ALIGNMENT_WINDOW.afterDays
      ) continue;
      const ratioErrors = (changesByDate.get(date) ?? []).flatMap((change) => {
        const error = ratioMatchError(fact.value, change.ratio);
        return error === null ? [] : [error];
      });
      if (ratioErrors.length === 0) continue;
      candidates.set(date, {
        distance: dayDistance(fact.periodKey, date),
        ratioError: Math.round(Math.min(...ratioErrors) * RATIO_ERROR_SCALE),
      });
      allDates.add(date);
    }
    candidatesByFact.set(fact, candidates);
  }

  const orderedDates = [...allDates].sort();
  const source = 0;
  const firstFactNode = 1;
  const firstDateNode = firstFactNode + orderedActions.length;
  const sink = firstDateNode + orderedDates.length;
  const graph = Array.from({ length: sink + 1 }, () => [] as FlowEdge[]);
  const dateIndexes = new Map(orderedDates.map((date, index) => [date, index]));
  const maximumDistance = Math.max(
    CORPORATE_ACTION_ALIGNMENT_WINDOW.beforeDays,
    CORPORATE_ACTION_ALIGNMENT_WINDOW.afterDays,
  );
  const maximumRatioError = Math.ceil(2 * RATIO_TOLERANCE * RATIO_ERROR_SCALE);
  const distancePriority = orderedActions.length * maximumRatioError + 1;
  const maximumAlignedCost = maximumDistance * distancePriority + maximumRatioError;
  const unalignedPenalty = orderedActions.length * maximumAlignedCost + 1;
  const assignmentEdges: {
    readonly fact: Fact;
    readonly date: string;
    readonly aligned: boolean;
    readonly edge: FlowEdge;
  }[] = [];

  orderedActions.forEach((fact, factIndex) => {
    const factNode = firstFactNode + factIndex;
    addFlowEdge(graph, source, factNode, 0);
    const candidates = candidatesByFact.get(fact)!;
    const assignments = [...candidates].map(([date, candidate]) => ({
      date,
      cost: candidate.distance * distancePriority + candidate.ratioError,
      aligned: true,
    }));
    if (!candidates.has(fact.periodKey)) {
      assignments.push({ date: fact.periodKey, cost: unalignedPenalty, aligned: false });
    }
    for (const { date, cost, aligned } of assignments.sort((left, right) => (
      left.date.localeCompare(right.date)
    ))) {
      const edge = addFlowEdge(graph, factNode, firstDateNode + dateIndexes.get(date)!, cost);
      assignmentEdges.push({ fact, date, aligned, edge });
    }
  });
  orderedDates.forEach((_date, dateIndex) => {
    addFlowEdge(graph, firstDateNode + dateIndex, sink, 0);
  });

  sendMinimumCostFlow(graph, source, sink, orderedActions.length);

  const movedTo = new Map<Fact, string>();
  for (const assignment of assignmentEdges) {
    if (assignment.aligned && assignment.edge.capacity === 0) {
      movedTo.set(assignment.fact, assignment.date);
    }
  }
  return movedTo;
}

/**
 * 자본변동 팩트의 효력발생일을 KRX 가 주가를 조정한 날로 옮긴다.
 *
 * **왜 필요한가.** 팩트의 효력발생일은 DART 증자·감자 현황의 `isu_dcrs_de` 로,
 * 액면분할에서는 **분할 기준일**이다. 그런데 KRX 일봉 주가가 분할 후 값으로 바뀌는
 * 날은 **변경상장일**이고 그 사이 1~2주는 주권교체로 매매거래가 정지된다. 엔진은
 * 효력발생일 봉에서 보유 수량에 비율을 곱하므로(engine.ts), 두 날짜가 어긋나면
 * 그 구간 동안 수량만 ×비율 이고 단가는 분할 전 값이라 평가금액이 비율 배로 뛴다.
 * 재개 봉에서 단가가 ÷비율 되며 원래대로 돌아온다 — 자산곡선에 없던 봉우리가 선다.
 *
 * **무엇을 기준으로 옮기는가.** KRX 기초정보의 상장주식수가 바뀐 날이다. 액면분할·
 * 병합에서 그 날이 곧 변경상장일이고, 주가가 조정되는 날과 같다.
 *
 * **비율은 DART 값을 그대로 쓴다.** KRX 주식수 비율로 갈아끼우지 않는다 — 같은 날
 * 유상증자가 겹치면 KRX 비율에는 그 몫까지 섞여 있어 가격 보정 비율이 아니게 된다.
 * KRX 쪽은 "언제" 만 결정하고 "얼마" 는 DART 가 결정한다.
 *
 * **한계.** 무상증자·주식배당은 주가가 신주배정기준일 직전(권리락일)에 조정되고
 * 주식수는 신주상장일에 늘어난다. 이 함수는 후자로 옮기므로 그 둘이 어긋나는 만큼은
 * 여전히 남는다. 권리락일은 지금 수집하는 데이터 어디에도 없다.
 */
export function alignCorporateActionEffectiveDates(
  facts: readonly Fact[],
  sharesChanges: readonly SharesChange[],
): { facts: Fact[]; unaligned: UnalignedAction[] } {
  // 같은 이벤트의 동일 비율 재공시를 정렬 전에 접는다. 비율이 다르면 어느 공시가
  // 실제 수량 배수인지 이 데이터만으로 판정할 수 없으므로 대표 하나를 보존하되
  // conflict로 표시해 아래 매칭에서 제외한다. 임의의 한 비율을 KRX 날짜에 붙이면
  // 다른 비율이 정정공시였을 때 보유 수량과 가격 단위가 크게 어긋날 수 있다.
  const actionsByPeriod = new Map<string, Fact>();
  const conflictingPeriodKeys = new Set<string>();
  for (const fact of facts) {
    if (fact.field !== CORPORATE_ACTION_FIELD) continue;
    const key = `${fact.scope}|${fact.key}|${fact.periodKey}`;
    const existing = actionsByPeriod.get(key);
    if (existing !== undefined && existing.value !== fact.value) conflictingPeriodKeys.add(key);
    if (
      existing === undefined
      || fact.asOfTsMs < existing.asOfTsMs
      || (fact.asOfTsMs === existing.asOfTsMs && fact.value < existing.value)
    ) {
      actionsByPeriod.set(key, fact);
    }
  }
  const actions = [...actionsByPeriod.values()];
  if (actions.length === 0) return { facts: [...facts], unaligned: [] };
  const retainedActions = new Set(actions);
  const conflictedActions = new Set(
    actions.filter((fact) => conflictingPeriodKeys.has(`${fact.scope}|${fact.key}|${fact.periodKey}`)),
  );

  const changesBySymbol = new Map<string, SharesChange[]>();
  for (const change of sharesChanges) {
    const list = changesBySymbol.get(change.shortCode) ?? [];
    list.push(change);
    changesBySymbol.set(change.shortCode, list);
  }

  const movedTo = new Map<Fact, string>();
  const actionsBySymbol = new Map<string, Fact[]>();
  for (const fact of actions) {
    const list = actionsBySymbol.get(fact.key) ?? [];
    list.push(fact);
    actionsBySymbol.set(fact.key, list);
  }
  for (const symbol of [...actionsBySymbol.keys()].sort()) {
    const matched = matchSymbolActions(
      actionsBySymbol.get(symbol)!,
      changesBySymbol.get(symbol) ?? [],
      conflictedActions,
    );
    for (const [fact, date] of matched) movedTo.set(fact, date);
  }

  const unaligned: UnalignedAction[] = actions
    .filter((fact) => !movedTo.has(fact))
    .map((fact) => ({ symbol: fact.key, periodKey: fact.periodKey, ratio: fact.value }));

  return {
    facts: facts.flatMap((fact) => {
      if (fact.field === CORPORATE_ACTION_FIELD && !retainedActions.has(fact)) return [];
      const moved = movedTo.get(fact);
      return [moved === undefined ? fact : { ...fact, periodKey: moved }];
    }),
    unaligned,
  };
}
