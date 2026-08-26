import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';
import {
  type UniverseCriterion,
  type UniverseDirection,
  type UniverseStage,
} from '../../../shared/schemas/universe-rule.js';
import {
  addStage,
  changeStageCriterion,
  changeStageDirection,
  changeStageLimit,
  FIRST_STAGE_LIMIT_MAX,
  moveStage,
  normalizePriceChangeLookbackInput,
  normalizeStageLimitInput,
  parseStageLimitInput,
  removeStage,
  type PipelineUpdate,
} from './universe-pipeline';

const ALL_CRITERIA: readonly UniverseCriterion[] = [
  'MARKET_CAP',
  'VOLUME',
  'TRADING_VALUE',
  'PER',
  'ROE',
  'DECLINE',
];

/** 화면에 보여줄 한글 라벨 — PER 은 원어를 그대로 쓴다(용어 규칙) */
const CRITERION_LABEL: Record<UniverseCriterion, string> = {
  MARKET_CAP: '시가총액',
  VOLUME: '거래량',
  TRADING_VALUE: '거래대금',
  PER: 'PER',
  ROE: 'ROE',
  DECLINE: '가격 변동',
};

const DIRECTION_OPTIONS: Record<UniverseCriterion, readonly [
  { value: UniverseDirection; label: string },
  { value: UniverseDirection; label: string },
]> = {
  MARKET_CAP: [{ value: 'HIGH', label: '상위' }, { value: 'LOW', label: '하위' }],
  VOLUME: [{ value: 'HIGH', label: '상위' }, { value: 'LOW', label: '하위' }],
  TRADING_VALUE: [{ value: 'HIGH', label: '상위' }, { value: 'LOW', label: '하위' }],
  PER: [{ value: 'LOW', label: '낮음' }, { value: 'HIGH', label: '높음' }],
  ROE: [{ value: 'HIGH', label: '높음' }, { value: 'LOW', label: '낮음' }],
  DECLINE: [{ value: 'HIGH', label: '급상승' }, { value: 'LOW', label: '급하락' }],
};

const DECLINE_LOOKBACK_MIN = 1;
const DECLINE_LOOKBACK_MAX = 252;
const MAX_STAGE_COUNT = 6;

/** cascade 강조를 지우는 시간 — 브리프가 지정한 2초 */
const HIGHLIGHT_DURATION_MS = 2000;

export interface UniverseStageEditorProps {
  stages: readonly UniverseStage[];
  onChange: (stages: UniverseStage[]) => void;
}

function StageLimitInput({
  index,
  value,
  max,
  highlighted,
  onValueChange,
}: {
  index: number;
  value: number;
  max: number;
  highlighted: boolean;
  onValueChange: (value: number) => void;
}) {
  const [text, setText] = useState(String(value));

  useEffect(() => {
    setText(String(value));
  }, [value]);

  return (
    <Input
      id={`stage-limit-${index}`}
      name="limit"
      type="number"
      inputMode="numeric"
      className={cn('h-8 w-24', highlighted && 'ring-2 ring-amber-400')}
      min={1}
      max={max}
      value={text}
      onChange={(event) => {
        const nextText = event.target.value;
        setText(nextText);
        const parsed = parseStageLimitInput(nextText, max);
        if (parsed !== null) onValueChange(parsed);
      }}
      onBlur={() => {
        const normalized = normalizeStageLimitInput(text, value, max);
        setText(String(normalized));
        if (normalized !== value) onValueChange(normalized);
      }}
    />
  );
}

function PriceChangeLookbackInput({
  index,
  value,
  onValueCommit,
}: {
  index: number;
  value: number;
  onValueCommit: (value: number) => void;
}) {
  const [text, setText] = useState(String(value));

  useEffect(() => {
    setText(String(value));
  }, [value]);

  return (
    <Input
      id={`stage-lookback-${index}`}
      name="lookbackTradingDays"
      type="number"
      inputMode="numeric"
      className="h-8 w-24"
      min={DECLINE_LOOKBACK_MIN}
      max={DECLINE_LOOKBACK_MAX}
      value={text}
      onChange={(event) => setText(event.target.value)}
      onBlur={() => {
        const normalized = normalizePriceChangeLookbackInput(text, value);
        setText(String(normalized));
        if (normalized !== value) onValueCommit(normalized);
      }}
    />
  );
}

/**
 * 유니버스 단계(최대 6단계) 편집기 — 시가총액·거래량·거래대금·PER·ROE·가격 변동 순서를
 * 사용자가 직접 쌓고 재배열한다.
 *
 * 상태 전이(add·remove·move·changeLimit) 자체는 `universe-pipeline.ts` 의 순수
 * 함수가 맡는다. 이 컴포넌트는 그 결과(`PipelineUpdate`)를 받아 두 가지만 더 한다:
 * 1) 최종 `stages` 를 부모에 올려보낸다.
 * 2) cascade 로 값이 바뀐 입력만 잠깐(2초) 강조해 "왜 값이 바뀌었는지" 를 알려준다.
 *
 * 이동은 위/아래 버튼과 native drag-and-drop 두 경로를 두지만, 둘 다 반드시
 * `moveStage()` 를 거친다 — 버튼과 드래그가 서로 다른 결과를 내면 사용자가 예측할
 * 수 없는 화면이 된다.
 */
export function UniverseStageEditor({ stages, onChange }: UniverseStageEditorProps) {
  const [highlighted, setHighlighted] = useState<ReadonlySet<number>>(new Set());
  const clearTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dragFromIndex = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (clearTimer.current) clearTimeout(clearTimer.current);
    },
    [],
  );

  const applyUpdate = (update: PipelineUpdate): void => {
    onChange(update.stages);
    if (clearTimer.current) clearTimeout(clearTimer.current);
    if (update.changedIndices.length === 0) {
      setHighlighted(new Set());
      return;
    }
    setHighlighted(new Set(update.changedIndices));
    clearTimer.current = setTimeout(() => setHighlighted(new Set()), HIGHLIGHT_DURATION_MS);
  };

  const usedCriteria = new Set(stages.map((stage) => stage.criterion));
  const availableCriteria = ALL_CRITERIA.filter((criterion) => !usedCriteria.has(criterion));

  return (
    <div className="space-y-2">
      {stages.map((stage, index) => {
        const maxLimit = index === 0 ? FIRST_STAGE_LIMIT_MAX : stages[index - 1]!.limit;
        const isHighlighted = highlighted.has(index);
        return (
          <div
            key={`${stage.criterion}-${index}`}
            className="flex flex-wrap items-end gap-2 rounded-lg border p-2"
            draggable
            onDragStart={() => {
              dragFromIndex.current = index;
            }}
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => {
              event.preventDefault();
              const from = dragFromIndex.current;
              dragFromIndex.current = null;
              if (from !== null && from !== index) applyUpdate(moveStage(stages, from, index));
            }}
          >
            <span
              role="button"
              tabIndex={-1}
              aria-label={`${index + 1}단계 드래그하여 순서 변경`}
              className="cursor-grab px-1 text-muted-foreground select-none"
            >
              ⠿
            </span>
            <span className="text-sm font-medium">{index + 1}단계</span>

            <div className="space-y-1">
              <Label htmlFor={`stage-criterion-${index}`}>기준</Label>
              {/* shadcn Select 는 popup 을 portal 로 그려 SSR·정적 markup 검사와 맞지
                  않는다 — 여기서는 네이티브 select 로 옵션 disable 을 직접 검증한다. */}
              <select
                id={`stage-criterion-${index}`}
                name="criterion"
                className="h-8 rounded-lg border border-input bg-transparent px-2 text-sm"
                value={stage.criterion}
                onChange={(event) =>
                  applyUpdate(changeStageCriterion(
                    stages,
                    index,
                    event.target.value as UniverseCriterion,
                  ))
                }
              >
                {ALL_CRITERIA.map((criterion) => (
                  <option
                    key={criterion}
                    value={criterion}
                    disabled={criterion !== stage.criterion && usedCriteria.has(criterion)}
                  >
                    {CRITERION_LABEL[criterion]}
                  </option>
                ))}
              </select>
            </div>

            <div className="space-y-1">
              <Label htmlFor={`stage-direction-${index}`}>방향</Label>
              <select
                id={`stage-direction-${index}`}
                name="direction"
                className="h-8 rounded-lg border border-input bg-transparent px-2 text-sm"
                value={stage.direction}
                onChange={(event) => applyUpdate(changeStageDirection(
                  stages,
                  index,
                  event.target.value as UniverseDirection,
                ))}
              >
                {DIRECTION_OPTIONS[stage.criterion].map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            </div>

            <div className="space-y-1">
              <Label htmlFor={`stage-limit-${index}`}>N</Label>
              <StageLimitInput
                value={stage.limit}
                index={index}
                max={maxLimit}
                highlighted={isHighlighted}
                onValueChange={(nextLimit) =>
                  applyUpdate(changeStageLimit(stages, index, nextLimit))
                }
              />
            </div>

            {stage.criterion === 'DECLINE' ? (
              <div className="space-y-1">
                <Label htmlFor={`stage-lookback-${index}`}>가격 변동 산정기간(거래일)</Label>
                <PriceChangeLookbackInput
                  index={index}
                  value={stage.lookbackTradingDays}
                  onValueCommit={(lookbackTradingDays) => {
                    onChange(
                      stages.map((s, i) =>
                        i === index && s.criterion === 'DECLINE'
                          ? { ...s, lookbackTradingDays }
                          : s,
                      ),
                    );
                  }}
                />
              </div>
            ) : null}

            <div className="ml-auto flex gap-1">
              <Button
                type="button"
                variant="outline"
                size="icon-sm"
                aria-label={`${index + 1}단계 위로 이동`}
                disabled={index === 0}
                onClick={() => applyUpdate(moveStage(stages, index, index - 1))}
              >
                ↑
              </Button>
              <Button
                type="button"
                variant="outline"
                size="icon-sm"
                aria-label={`${index + 1}단계 아래로 이동`}
                disabled={index === stages.length - 1}
                onClick={() => applyUpdate(moveStage(stages, index, index + 1))}
              >
                ↓
              </Button>
              <Button
                type="button"
                variant="outline"
                size="icon-sm"
                aria-label={`${index + 1}단계 삭제`}
                disabled={stages.length <= 1}
                onClick={() => applyUpdate(removeStage(stages, index))}
              >
                ✕
              </Button>
            </div>
          </div>
        );
      })}

      {highlighted.size > 0 ? (
        <p role="status" className="text-xs text-muted-foreground">
          앞 단계 N을 넘지 않도록 뒤 단계 값을 함께 조정했습니다.
        </p>
      ) : null}

      {availableCriteria.length > 0 && stages.length < MAX_STAGE_COUNT ? (
        <div className="flex flex-wrap gap-2">
          {availableCriteria.map((criterion) => (
            <Button
              key={criterion}
              type="button"
              variant="outline"
              size="sm"
              onClick={() => applyUpdate(addStage(stages, criterion))}
            >
              {CRITERION_LABEL[criterion]} 단계 추가
            </Button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
