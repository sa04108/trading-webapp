import { useMutation, useQueryClient } from '@tanstack/react-query';
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
import { api, ApiError, postJson } from '@/lib/api-client';
import type { DataJob } from '@/features/datasets/symbol-types';
import { MAX_UNIVERSE_SYMBOLS } from '../../../shared/schemas/universe-limit.js';
import type { UniverseRule } from '../../../shared/schemas/universe-rule.js';

interface UniverseScheduleEntryDto {
  readonly rebalanceDate: string;
  /** 실제 유니버스·시총을 읽은 거래일 — 휴장일이면 소급된 직전 거래일이다 */
  readonly effectiveTradingDate: string;
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
  const queryClient = useQueryClient();
  // 동기화는 mutation 이 아니라 직접 만든 순차 루프다 — 미커버 날짜가 2년치면 24개라
  // 버튼을 24번 누르게 할 수 없고, 한 번에 다 태우되 어디까지 갔는지 보여야 한다.
  const [syncProgress, setSyncProgress] = useState<{ done: number; total: number } | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);
  // 봉 없는 종목 등록·동기화 — 아래 registerAndSyncMissingCandles 참고.
  const [candlePhase, setCandlePhase] = useState<'REGISTERING' | 'SYNCING' | null>(null);
  const [candleSyncError, setCandleSyncError] = useState<string | null>(null);
  // 등록·동기화가 성공적으로 끝났는데도 재미리보기에 missingCandleSymbols 가 남을 수
  // 있다(상장폐지 종목은 증권사가 이름·봉을 안 준다) — 그때는 오류가 아니라 이 사실을
  // 한 줄로 설명한다. 규칙을 다시 미리보기하면 지난 시도 결과이므로 지운다.
  const [candleSyncAttempted, setCandleSyncAttempted] = useState(false);
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

  /**
   * 미커버 날짜를 오래된 순서로 하나씩 동기화하고 마지막에 한 번만 다시 미리보기한다.
   *
   * 서버가 날짜마다 KRX 를 부르므로 병렬로 던지면 호출 한도를 몰아 쓰고 서로의 소급
   * 수집과 엉킨다 — 순차로 돈다. 중간에 실패해도 그때까지 수집한 날짜는 이미 커버로
   * 남으므로, 오류를 보여주고 남은 만큼 다시 누르면 이어진다.
   */
  const syncAllUncovered = async (dates: readonly string[]): Promise<void> => {
    setSyncError(null);
    setSyncProgress({ done: 0, total: dates.length });
    let failure: string | null = null;
    let done = 0;

    for (const date of dates) {
      try {
        await postJson<unknown>('/symbol-master/sync', { date });
        done += 1;
        setSyncProgress({ done, total: dates.length });
      } catch (error) {
        const reason = error instanceof ApiError ? error.message : '동기화 실패';
        failure = `${date} 동기화 실패 — ${reason} (${done}/${dates.length} 완료)`;
        break;
      }
    }

    setSyncProgress(null);
    setSyncError(failure);
    await queryClient.invalidateQueries({ queryKey: ['symbol-master'] });
    // 동기화가 끝나면 같은 질문(그때 previewMutation 이 실제로 받은 params)을 자동으로
    // 다시 던진다 — 사용자가 미리보기를 다시 누르지 않아도 된다. 일부만 성공했어도
    // 다시 물어야 남은 미커버 날짜가 정확히 추려진다.
    if (done > 0 && previewMutation.variables) runPreview(previewMutation.variables);
  };

  /**
   * 봉 없는 종목을 그 자리에서 등록하고 동기화한다 — 앞선 미커버 날짜 동기화(위
   * syncAllUncovered)와 같은 원칙이다. 탭을 옮겨 종목을 등록하고 다시 동기화를 거는
   * 왕복을 없앤다.
   *
   * POST /symbols 가 409(added=0)를 내도 실패로 다루지 않는다 — 이 라우트는 넘긴 코드가
   * 전부 이미 등록돼 있을 때만 409 를 낸다(symbol-routes.ts). 그 경우가 바로 "봉만
   * 없는" 상태이므로 등록을 건너뛰고 그대로 동기화로 넘어간다.
   *
   * 잡 폴링·완료 판정은 symbols-panel.tsx 와 같다: status 가 RUNNING/QUEUED 인 동안
   * 1초 간격으로 다시 읽고, 그 밖의 상태는 끝난 것으로 본다.
   */
  const registerAndSyncMissingCandles = async (codes: readonly string[]): Promise<void> => {
    setCandleSyncError(null);
    setCandleSyncAttempted(false);
    setCandlePhase('REGISTERING');

    let job: DataJob | null = null;
    try {
      try {
        await postJson<unknown>('/symbols', { codes, market: value.markets[0] });
      } catch (error) {
        if (!(error instanceof ApiError) || error.status !== 409) throw error;
      }

      setCandlePhase('SYNCING');
      const started = await postJson<{ job: DataJob }>('/symbols/sync', { codes, slice: '1d' });
      let current: DataJob = started.job;
      while (current.status === 'RUNNING' || current.status === 'QUEUED') {
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        const response = await api<{ job: DataJob }>(`/data-jobs/${current.id}`);
        current = response.job;
      }
      job = current;

      if (current.status === 'COMPLETED') setCandleSyncAttempted(true);
      else if (current.status === 'CANCELLED') setCandleSyncError('봉 수집이 취소되었습니다');
      else setCandleSyncError(current.error ?? '봉 수집이 실패했습니다');
    } catch (error) {
      const reason = error instanceof ApiError ? error.message : '등록·동기화에 실패했습니다';
      setCandleSyncError(reason);
    } finally {
      setCandlePhase(null);
    }

    // 등록·동기화 시도가 있었으면(잡을 실제로 받았으면) 결과와 무관하게 다시 미리보기해
    // 남은 목록을 정확히 추린다 — syncAllUncovered 와 같은 방식.
    if (job !== null) {
      await queryClient.invalidateQueries({ queryKey: ['symbol-master'] });
      if (previewMutation.variables) runPreview(previewMutation.variables);
    }
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
              onClick={() => {
                // 직접 다시 미리보기하면 지난 등록·동기화 시도의 설명은 더 이상 이
                // 결과에 대한 것이 아니다 — 지운다.
                setCandleSyncAttempted(false);
                runPreview(currentParams);
              }}
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
                      <TableCell className="tabular-nums">
                        {entry.rebalanceDate}
                        {/* 요청 날짜와 적용 거래일이 같으면 덧붙이지 않는다 — 휴장일 소급이
                            있을 때만 알려주면 된다(브리프 표기 규약) */}
                        {entry.effectiveTradingDate !== entry.rebalanceDate ? (
                          <span className="text-muted-foreground">
                            {' '}
                            (적용 {entry.effectiveTradingDate})
                          </span>
                        ) : null}
                      </TableCell>
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
              종목 마스터가 리밸런스 날짜 {preview.uncoveredDates.length}개를 아직 커버하지
              않습니다 — 동기화해야 미리보기를 완성할 수 있습니다.
            </p>
            <p className="text-xs tabular-nums opacity-80">
              {preview.uncoveredDates.join(', ')}
            </p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={syncProgress !== null || candlePhase !== null}
              onClick={() => void syncAllUncovered(preview.uncoveredDates)}
            >
              {syncProgress === null
                ? `${preview.uncoveredDates.length}개 날짜 모두 동기화`
                : `동기화 중 ${syncProgress.done}/${syncProgress.total}`}
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}

      {/* 429/503(쿼터·미설정) 같은 동기화 실패가 조용히 묻히지 않게 previewMutation 과
          같은 방식으로 보여준다 (리뷰 fix) */}
      {syncError !== null ? (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{syncError}</AlertDescription>
        </Alert>
      ) : null}

      {preview && preview.missingCandleSymbols.length > 0 ? (
        <Alert variant="destructive" role="alert">
          <AlertDescription className="space-y-2">
            <p>다음 종목은 아직 봉 데이터가 없어 백테스트를 실행할 수 없습니다.</p>
            <p className="text-xs text-muted-foreground wrap-anywhere">
              {preview.missingCandleSymbols.join(', ')}
            </p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={candlePhase !== null || syncProgress !== null}
              onClick={() => void registerAndSyncMissingCandles(preview.missingCandleSymbols)}
            >
              {candlePhase === 'REGISTERING'
                ? '등록 중…'
                : candlePhase === 'SYNCING'
                  ? '봉 수집 중…'
                  : `${preview.missingCandleSymbols.length}개 종목 등록·동기화`}
            </Button>
            {candleSyncAttempted ? (
              <p className="text-xs text-muted-foreground">
                일부 종목은 증권사에서 과거 봉을 받지 못했습니다 — 상장폐지 종목일 수 있습니다.
              </p>
            ) : null}
            <p className="text-xs text-muted-foreground">
              <Link to="/datasets?tab=prices" className="underline">
                가격 데이터 탭
              </Link>
              에서 직접 등록·동기화할 수도 있습니다.
            </p>
          </AlertDescription>
        </Alert>
      ) : null}

      {candleSyncError !== null ? (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{candleSyncError}</AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
}
