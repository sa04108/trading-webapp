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

/** 짝을 찾지 못해 DART 기준일을 그대로 둔 자본변동 */
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
const WINDOW_BEFORE_DAYS = 30;
const WINDOW_AFTER_DAYS = 90;

/**
 * 비율 일치 허용 오차(상대). DART 비율은 분기 공시 발행주식수로 나눈 근사값이라
 * (dart-report-parser.ts `parseIssuanceRows`) KRX 주식수 비율과 소수점이 어긋난다.
 * 5% 는 1:2 분할(2.0)과 1:5 분할(5.0), 소규모 무상증자(1.02)를 서로 구분할 만큼 좁다.
 */
const RATIO_TOLERANCE = 0.05;

const MS_PER_DAY = 86_400_000;

function dayDistance(a: string, b: string): number {
  return Math.round(Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / MS_PER_DAY);
}

function signedDayOffset(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / MS_PER_DAY);
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
  const actions = facts.filter((fact) => fact.field === CORPORATE_ACTION_FIELD);
  if (actions.length === 0) return { facts: [...facts], unaligned: [] };

  const changesBySymbol = new Map<string, SharesChange[]>();
  for (const change of sharesChanges) {
    const list = changesBySymbol.get(change.shortCode) ?? [];
    list.push(change);
    changesBySymbol.set(change.shortCode, list);
  }

  // 후보 짝 전체를 만들어 거리 순으로 확정한다. 팩트 순서대로 처리하면 뒤에 오는
  // 팩트가 더 가까운 짝을 먼저 온 팩트에게 빼앗긴다.
  const pairs: { fact: Fact; change: SharesChange; distance: number }[] = [];
  for (const fact of actions) {
    for (const change of changesBySymbol.get(fact.key) ?? []) {
      const offset = signedDayOffset(fact.periodKey, change.effectiveDate);
      if (offset < -WINDOW_BEFORE_DAYS || offset > WINDOW_AFTER_DAYS) continue;
      if (Math.abs(change.ratio / fact.value - 1) > RATIO_TOLERANCE) continue;
      pairs.push({ fact, change, distance: dayDistance(fact.periodKey, change.effectiveDate) });
    }
  }
  // 거리가 같으면 날짜·비율로 갈라 입력 순서에 결과를 맡기지 않는다 (재현성 §9.5)
  pairs.sort(
    (a, b) =>
      a.distance - b.distance
      || a.fact.periodKey.localeCompare(b.fact.periodKey)
      || a.change.effectiveDate.localeCompare(b.change.effectiveDate)
      || a.fact.value - b.fact.value,
  );

  // 한 종목이 이미 자본변동을 가진 날짜로는 옮기지 않는다. PitFactView 가 (종목,
  // 효력발생일) 한 칸으로 접으므로 겹치면 둘 중 하나가 조용히 사라진다.
  const takenDates = new Set(actions.map((fact) => `${fact.key}|${fact.periodKey}`));
  const usedChanges = new Set<SharesChange>();
  const movedTo = new Map<Fact, string>();

  for (const pair of pairs) {
    if (movedTo.has(pair.fact) || usedChanges.has(pair.change)) continue;
    const target = `${pair.fact.key}|${pair.change.effectiveDate}`;
    if (takenDates.has(target)) continue;
    usedChanges.add(pair.change);
    movedTo.set(pair.fact, pair.change.effectiveDate);
    takenDates.delete(`${pair.fact.key}|${pair.fact.periodKey}`);
    takenDates.add(target);
  }

  const unaligned: UnalignedAction[] = actions
    .filter((fact) => !movedTo.has(fact))
    .map((fact) => ({ symbol: fact.key, periodKey: fact.periodKey, ratio: fact.value }));

  return {
    facts: facts.map((fact) => {
      const moved = movedTo.get(fact);
      return moved === undefined ? fact : { ...fact, periodKey: moved };
    }),
    unaligned,
  };
}
