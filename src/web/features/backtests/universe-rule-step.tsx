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
export interface UniversePreviewResponseDto {
  readonly schedule: readonly UniverseScheduleEntryDto[];
  readonly unionSymbols: readonly string[];
  readonly scheduleHash: string;
  readonly uncoveredDates: readonly string[];
  readonly missingCandleSymbols: readonly string[];
}

export interface PreviewParams {
  readonly universeRule: UniverseRule;
  readonly period: { readonly from: string; readonly to: string };
  readonly rebalanceMonths: number;
}

/**
 * 파라미터 동등성 — 부모(new-backtest-wizard.tsx)와 이 컴포넌트가 같은 정의를 써야
 * "이 미리보기가 지금 값과 여전히 일치하는가" 판정이 두 곳에서 어긋나지 않는다.
 */
export function sameUniverseParams(a: PreviewParams, b: PreviewParams): boolean {
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
  /** 위저드 '기간' 단계가 정한 값 — 이 화면에서는 읽기 전용이다(리뷰 fix, 아래 참고) */
  period: { from: string; to: string };
  /** 전략 파라미터의 rebalanceMonths(없으면 1) — 위저드가 같은 소스로 도출해 넘긴다 */
  rebalanceMonths: number;
  /**
   * 미리보기가 성공할 때마다(재동기화 뒤 재시도 포함) 그때 실제로 쓴 params 와 결과를
   * 그대로 올려 보낸다. **유효성 판정 자체는 하지 않는다** — 부모가 지금 값과 비교해
   * 판정한다(아래 컴포넌트 주석 참고). 이 컴포넌트는 그 판정에 필요한 원재료만 전달한다.
   */
  onPreviewResolved: (params: PreviewParams, result: UniversePreviewResponseDto) => void;
}

/**
 * 위저드 유니버스 단계 — 데이터셋·KRX 스냅샷 선택을 유니버스 규칙 정의로 교체한다
 * (스펙 2026-08-05).
 *
 * **기간은 이 화면에서 편집하지 않는다.** 위저드 '기간' 단계가 이 단계보다 앞에 있어
 * (WIZARD_STEPS 순서 — 리뷰 fix, 이전에는 뒤에 있었다) 이 화면에 들어올 때는 이미
 * from/to 가 정해져 있다. 여기서 다시 편집할 수 있게 하면 입력처가 두 곳이 되고,
 * 어느 한쪽에서 바꾼 값이 다른 쪽 화면에 열려 있는 이 컴포넌트를 갱신하지 못하는
 * 경합(리뷰에서 지적된 마운트 생명주기 버그)이 생긴다.
 *
 * **미리보기 유효성도 이 컴포넌트가 판정하지 않는다.** 전에는 `useMutation` 의
 * `variables` 와 지금 값을 비교해 `valid`/`stale` 을 계산하고 그 결과만 부모에
 * 올려보냈는데, 이 컴포넌트가 언마운트되면(다른 단계로 이동하면) 그 계산 자체가
 * 멈춘다 — 그 상태에서 '기간' 단계로 돌아가 날짜를 바꾸면 부모가 들고 있는 마지막
 * 값(성공)이 그대로 남아, 이미 무효해진 미리보기를 유효하다고 계속 보여주는 버그가
 * 있었다. 지금은 성공한 원재료(params·result)만 올려보내고, 부모가 매 렌더 지금
 * 값과 비교해 유효성을 다시 계산한다 — 이 컴포넌트가 화면에 있든 없든 항상 맞다.
 */
export function UniverseRuleStep({
  value,
  onChange,
  period,
  rebalanceMonths,
  onPreviewResolved,
}: UniverseRuleStepProps) {
  const syncMutation = useSymbolMasterSync();
  const previewMutation = useMutation({
    mutationFn: (params: PreviewParams) =>
      postJson<UniversePreviewResponseDto>('/backtests/universe-preview', params),
    onSuccess: (data, params) => onPreviewResolved(params, data),
  });

  // topN 은 유효한 정수일 때만 부모에 커밋한다 — 입력 중 빈 문자열·범위 밖 값은
  // 로컬 텍스트로만 남기고 `value`(항상 유효한 UniverseRule)는 건드리지 않는다.
  const [topNText, setTopNText] = useState(String(value.topN));
  useEffect(() => {
    setTopNText(String(value.topN));
  }, [value.topN]);

  const currentParams: PreviewParams = { universeRule: value, period, rebalanceMonths };
  const preview = previewMutation.data ?? null;
  // 이 컴포넌트가 화면에 떠 있는 동안 "다시 미리보기하세요" 안내를 보여줄 뿐이다 —
  // 실제 다음 단계 게이트는 부모가 판정한다(위 컴포넌트 주석 참고).
  const stale =
    preview !== null &&
    (previewMutation.variables === undefined ||
      !sameUniverseParams(previewMutation.variables, currentParams));

  const canPreview = period.from !== '' && period.to !== '' && period.from <= period.to;

  const runPreview = (params: PreviewParams): void => {
    previewMutation.mutate(params);
  };

  return (
    <div className="space-y-3">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">유니버스 규칙</CardTitle>
          <CardDescription>
            리밸런스 날짜마다 시가총액 상위 N종목으로 유니버스를 다시 구성
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
            <Button
              className="h-11"
              disabled={!canPreview || previewMutation.isPending}
              onClick={() => runPreview(currentParams)}
            >
              {previewMutation.isPending ? '조회 중…' : '미리보기'}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            기간 {period.from || '?'} ~ {period.to || '?'} · 리밸런스 주기 {rebalanceMonths}
            개월마다 — 전략 파라미터 기본값
          </p>
          {!canPreview ? (
            <Alert variant="destructive" role="alert">
              <AlertDescription>먼저 '기간' 단계에서 기간을 입력하세요</AlertDescription>
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

      {/* 429/503(쿼터·미설정) 같은 동기화 실패가 조용히 묻히지 않게 previewMutation 과
          같은 방식으로 보여준다 (리뷰 fix) */}
      {syncMutation.isError ? (
        <Alert variant="destructive" role="alert">
          <AlertDescription>
            {syncMutation.error instanceof ApiError
              ? syncMutation.error.message
              : '동기화에 실패했습니다'}
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
