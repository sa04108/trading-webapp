import {
  LEGACY_STAGE_DIRECTION,
} from '../../../shared/schemas/universe-rule.js';
import type {
  RebalanceInterval,
  UniverseCriterion,
  UniverseDirection,
  UniverseRule,
  UniverseStage,
} from '../../../shared/schemas/universe-rule.js';

/**
 * 화면에 쓰는 한글 라벨 — PER 은 원어를 그대로 쓴다(용어 규칙).
 * `universe-stage-editor.tsx` 의 `CRITERION_LABEL` 과 같은 값을 쓴다 — 편집기와 결과
 * 화면이 같은 기준을 다른 말로 부르면 사용자가 자기가 고른 조건을 못 알아본다.
 */
export const CRITERION_LABEL: Record<UniverseCriterion, string> = {
  MARKET_CAP: '시가총액',
  VOLUME: '거래량',
  TRADING_VALUE: '거래대금',
  PER: 'PER',
  ROE: 'ROE',
  DECLINE: '가격 변동',
};

const DIRECTION_LABEL: Record<
  UniverseCriterion,
  Record<UniverseDirection, string>
> = {
  MARKET_CAP: { HIGH: '상위', LOW: '하위' },
  VOLUME: { HIGH: '상위', LOW: '하위' },
  TRADING_VALUE: { HIGH: '상위', LOW: '하위' },
  PER: { HIGH: '높음', LOW: '낮음' },
  ROE: { HIGH: '높음', LOW: '낮음' },
  DECLINE: { HIGH: '급상승', LOW: '급하락' },
};

function stageLabel(stage: UniverseStage): string {
  const direction = stage.direction ?? LEGACY_STAGE_DIRECTION[stage.criterion];
  const criterion =
    stage.criterion === 'DECLINE'
      ? `${CRITERION_LABEL.DECLINE} ${DIRECTION_LABEL.DECLINE[direction]}(${stage.lookbackTradingDays}일)`
      : `${CRITERION_LABEL[stage.criterion]} ${DIRECTION_LABEL[stage.criterion][direction]}`;
  return `${criterion} ${stage.limit}`;
}

const UNIT_SUFFIX: Record<RebalanceInterval['unit'], string> = {
  DAY: '일',
  WEEK: '주',
  MONTH: '개월',
  YEAR: '년',
};

const EVERY_LABEL: Record<RebalanceInterval['unit'], string> = {
  DAY: '매일',
  WEEK: '매주',
  MONTH: '매월',
  YEAR: '매년',
};

/** value 1 은 매일/매주/매월/매년, 그 외는 'N일마다'/'N주마다'/'N개월마다'. */
function intervalLabel(interval: RebalanceInterval): string {
  if (interval.value === 1) return EVERY_LABEL[interval.unit];
  return `${interval.value}${UNIT_SUFFIX[interval.unit]}마다`;
}

/**
 * 유니버스 규칙 한 줄 요약: 시장 · 단계(→로 연결) · 리밸런스 주기.
 *
 * 실제 리밸런스 결과 종목 수는 적지 않는다 — 종목 구성은 더 이상 저장된 값이 아니라
 * 제출 시점에 서버가 규칙으로 재구성한 멤버십 일정이라, 그 수를 알려면 다시 미리보기를
 * 조회해야 한다. 목록·상세 화면의 요약 한 줄을 위해 그 비용을 치르지 않는다.
 */
export function formatUniverseRuleSummary(rule: UniverseRule): string {
  const stagesText = rule.stages.map(stageLabel).join(' → ');
  return `${rule.markets.join('·')} · ${stagesText} · ${intervalLabel(rule.rebalanceInterval)}`;
}
