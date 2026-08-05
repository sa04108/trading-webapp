import { useMutation } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ApiError, postJson } from '@/lib/api-client';
import { useSymbolMasterSync } from '@/features/symbol-master/use-symbol-master';
import { MAX_UNIVERSE_SYMBOLS } from '../../../shared/schemas/universe-limit.js';
import type { UniverseRule } from '../../../shared/schemas/universe-rule.js';

interface UniverseScheduleEntryDto {
  readonly rebalanceDate: string;
  readonly symbols: readonly string[];
}

/** `POST /backtests/universe-preview` 응답 (스펙 2026-08-05, backtest-routes.ts 와 같은 모양) */
interface UniversePreviewResponseDto {
  readonly schedule: readonly UniverseScheduleEntryDto[];
  readonly unionSymbols: readonly string[];
  readonly scheduleHash: string;
  readonly uncoveredDates: readonly string[];
  readonly missingCandleSymbols: readonly string[];
}

interface PreviewParams {
  readonly universeRule: UniverseRule;
  readonly period: { readonly from: string; readonly to: string };
  readonly rebalanceMonths: number;
}

function sameParams(a: PreviewParams, b: PreviewParams): boolean {
  return (
    a.universeRule.markets[0] === b.universeRule.markets[0] &&
    a.universeRule.topN === b.universeRule.topN &&
    a.universeRule.sortKey === b.universeRule.sortKey &&
    a.period.from === b.period.from &&
    a.period.to === b.period.to &&
    a.rebalanceMonths === b.rebalanceMonths
  );
}

export interface UniverseRuleStepProps {
  value: UniverseRule;
  onChange: (rule: UniverseRule) => void;
  period: { from: string; to: string };
  onPeriodChange: (period: { from: string; to: string }) => void;
  /** 전략 파라미터의 rebalanceMonths(없으면 1) — 위저드가 같은 소스로 도출해 넘긴다 */
  rebalanceMonths: number;
  onValidityChange: (valid: boolean) => void;
  onUnionSymbolsChange: (symbols: readonly string[]) => void;
}

/**
 * 위저드 1단계(유니버스) — 데이터셋·KRX 스냅샷 선택을 유니버스 규칙 정의로 교체한다
 * (스펙 2026-08-05).
 *
 * 기간(시작일·종료일)을 이 화면에서 함께 받는 이유: `POST /backtests/universe-preview`
 * 는 리밸런스 날짜를 계산하려고 기간이 필요한데, 위저드의 '기간' 단계는 이 단계보다
 * 뒤에 있다(WIZARD_STEPS 순서 — 브리프 외 결정). 기간을 이 단계에서만 받게 하면 뒷단계
 * 진입 자체가 막혀 버리므로, 위저드가 들고 있는 같은 from/to 상태를 여기서도 편집한다.
 * '기간' 단계는 그 값을 다시 보여주고 조정할 수 있는 자리로 남는다 — 편집이 겹치더라도
 * 최종 방어선은 언제나 서버 제출 검증(422)이다.
 *
 * 미리보기 성공 여부는 `useMutation` 이 마지막으로 받은 `variables` 와 지금 값을 비교해
 * 판정한다 — 규칙이나 기간이 그 뒤 바뀌면 그 비교가 어긋나 `stale` 이 되고, 부모는
 * '다음' 단계로 갈 수 없다(규칙 변경 시 미리보기 무효화).
 */
export function UniverseRuleStep({
  value,
  onChange,
  period,
  onPeriodChange,
  rebalanceMonths,
  onValidityChange,
  onUnionSymbolsChange,
}: UniverseRuleStepProps) {
  const syncMutation = useSymbolMasterSync();
  const previewMutation = useMutation({
    mutationFn: (params: PreviewParams) =>
      postJson<UniversePreviewResponseDto>('/backtests/universe-preview', params),
  });

  // topN 은 유효한 정수일 때만 부모에 커밋한다 — 입력 중 빈 문자열·범위 밖 값은
  // 로컬 텍스트로만 남기고 `value`(항상 유효한 UniverseRule)는 건드리지 않는다.
  const [topNText, setTopNText] = useState(String(value.topN));
  useEffect(() => {
    setTopNText(String(value.topN));
  }, [value.topN]);

  const currentParams: PreviewParams = { universeRule: value, period, rebalanceMonths };
  const preview = previewMutation.data ?? null;
  const stale =
    preview !== null &&
    (previewMutation.variables === undefined || !sameParams(previewMutation.variables, currentParams));
  const valid =
    preview !== null &&
    !stale &&
    preview.uncoveredDates.length === 0 &&
    preview.missingCandleSymbols.length === 0;

  useEffect(() => {
    onValidityChange(valid);
    onUnionSymbolsChange(valid ? (preview?.unionSymbols ?? []) : []);
    // onValidityChange·onUnionSymbolsChange 는 매 렌더 새 함수일 수 있어 일부러 의존성
    // 배열에 넣지 않는다 — 이 프로젝트는 react-hooks lint 플러그인을 쓰지 않는다.
  }, [valid, preview]);

  const periodValid = period.from !== '' && period.to !== '' && period.from <= period.to;
  const canPreview = periodValid && !previewMutation.isPending;

  const runPreview = (params: PreviewParams): void => {
    previewMutation.mutate(params);
  };

  return (
    <div className="space-y-3">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">유니버스 규칙</CardTitle>
          <CardDescription>
            리밸런스 날짜마다 시가총액 상위 N종목으로 유니버스를 다시 구성합니다.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-end gap-2">
            <div className="space-y-1">
              <Label htmlFor="universe-market">시장</Label>
              <Select
                value={value.markets[0]}
                onValueChange={(next) =>
                  onChange({ ...value, markets: [next as 'KOSPI' | 'KOSDAQ'] })
                }
              >
                <SelectTrigger id="universe-market" className="h-11 w-32">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="KOSPI">KOSPI</SelectItem>
                  <SelectItem value="KOSDAQ">KOSDAQ</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="universe-topn">상위 N (시가총액)</Label>
              <Input
                id="universe-topn"
                type="number"
                inputMode="numeric"
                className="h-11 w-28"
                min={1}
                max={MAX_UNIVERSE_SYMBOLS}
                value={topNText}
                onChange={(e) => {
                  const text = e.target.value;
                  setTopNText(text);
                  const n = Number(text);
                  if (Number.isInteger(n) && n >= 1 && n <= MAX_UNIVERSE_SYMBOLS) {
                    onChange({ ...value, topN: n });
                  }
                }}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="universe-from">시작일</Label>
              <Input
                id="universe-from"
                type="date"
                className="h-11"
                value={period.from}
                onChange={(e) => onPeriodChange({ ...period, from: e.target.value })}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="universe-to">종료일</Label>
              <Input
                id="universe-to"
                type="date"
                className="h-11"
                value={period.to}
                onChange={(e) => onPeriodChange({ ...period, to: e.target.value })}
              />
            </div>
            <Button
              className="h-11"
              disabled={!canPreview}
              onClick={() => runPreview(currentParams)}
            >
              {previewMutation.isPending ? '조회 중…' : '미리보기'}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            리밸런스 주기 {rebalanceMonths}개월마다 — 전략 파라미터 기본값입니다.
          </p>
          {period.from !== '' && period.to !== '' && period.from > period.to ? (
            <Alert variant="destructive" role="alert">
              <AlertDescription>시작일이 종료일보다 늦습니다</AlertDescription>
            </Alert>
          ) : null}
          {previewMutation.isError ? (
            <Alert variant="destructive" role="alert">
              <AlertDescription>
                {previewMutation.error instanceof ApiError
                  ? previewMutation.error.message
                  : '미리보기에 실패했습니다'}
              </AlertDescription>
            </Alert>
          ) : null}
        </CardContent>
      </Card>

      {preview ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">리밸런스 일정</CardTitle>
            <CardDescription>
              {stale
                ? '규칙이나 기간이 바뀌었습니다 — 다시 미리보기하세요.'
                : `종목 ${preview.unionSymbols.length}개 · 리밸런스 ${preview.schedule.length}회`}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="max-h-64 overflow-y-auto rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>리밸런스 날짜</TableHead>
                    <TableHead className="text-right">종목 수</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {preview.schedule.map((entry) => (
                    <TableRow key={entry.rebalanceDate}>
                      <TableCell className="tabular-nums">{entry.rebalanceDate}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {entry.symbols.length}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {preview && preview.uncoveredDates.length > 0 ? (
        <Alert variant="destructive" role="alert">
          <AlertDescription className="space-y-2">
            <p>
              종목 마스터가 다음 리밸런스 날짜를 아직 커버하지 않습니다 — 동기화해야
              미리보기를 완성할 수 있습니다.
            </p>
            <ul className="space-y-1">
              {preview.uncoveredDates.map((date) => (
                <li key={date} className="flex items-center gap-2">
                  <span className="tabular-nums">{date}</span>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={syncMutation.isPending}
                    onClick={() =>
                      syncMutation.mutate(
                        { date },
                        {
                          // 동기화가 끝나면 같은 질문(그때 previewMutation 이 실제로 받은
                          // params)을 자동으로 다시 던진다 — 사용자가 미리보기를 다시
                          // 누르지 않아도 된다(브리프 규약).
                          onSuccess: () => {
                            if (previewMutation.variables) runPreview(previewMutation.variables);
                          },
                        },
                      )
                    }
                  >
                    동기화
                  </Button>
                </li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      ) : null}

      {preview && preview.missingCandleSymbols.length > 0 ? (
        <Alert variant="destructive" role="alert">
          <AlertDescription className="space-y-1">
            <p>
              다음 종목은 아직 봉 데이터가 없어 백테스트를 실행할 수 없습니다 —{' '}
              <Link to="/datasets?tab=prices" className="underline">
                가격 데이터 탭
              </Link>
              에서 동기화하세요.
            </p>
            <p className="text-xs text-muted-foreground wrap-anywhere">
              {preview.missingCandleSymbols.join(', ')}
            </p>
          </AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
}
