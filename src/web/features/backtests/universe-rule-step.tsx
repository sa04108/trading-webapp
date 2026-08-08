import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
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
import { MAX_UNIVERSE_SYMBOLS } from '../../../shared/schemas/universe-limit.js';
import type { UniverseRule } from '../../../shared/schemas/universe-rule.js';
import type { SymbolMasterCoverageDto } from '../../../shared/schemas/symbol-master.js';

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
  /**
   * period.from~to 전체가 종목 마스터 coverage 로 빈틈없이 덮였는지 — uncoveredDates
   * 는 리밸런스 날짜만 보므로, 리밸런스 날짜 사이 평일이 비어 있는 부분 커버리지는
   * 이 값으로만 드러난다(운영 버그 fix — 아래 fullSyncNeeded 참고).
   */
  readonly periodCovered: boolean;
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
  // 백테스트는 기간 안 모든 거래일의 봉을 쓴다 — 리밸런스 날짜만 동기화해서는
  // 부족하다(Task 4, 스펙 2026-08-06). 그래서 이 화면은 날짜별 순차 동기화 대신
  // 백그라운드 백필(SymbolMasterBackfill)을 기간 전체(period.from~to)로 시작시키고
  // coverage 의 backfill 상태를 폴링해 진행을 보여준다 — 2년이면 캘린더 730일이라
  // 포그라운드 루프로 돌리면 몇 분 걸린다.
  const [backfillRunning, setBackfillRunning] = useState(false);
  const [backfillCursor, setBackfillCursor] = useState<string | null>(null);
  const [backfillError, setBackfillError] = useState<string | null>(null);
  const previewMutation = useMutation({
    mutationFn: (params: PreviewParams) =>
      postJson<UniversePreviewResponseDto>('/backtests/universe-preview', params),
    onSuccess: (data, params) => {
      onPreviewResolved(params, data);
      // 이 응답 자체가 unionSymbols 를 등록한다(backtest-routes.ts
      // registerUniverseSymbols, 스펙 2026-08-06 리뷰 발견).
      // 재무 게이트가 보는 hasFacts 는 `['symbols']` 조회로만 온다
      // (new-backtest-wizard.tsx symbolsWithFacts).
      // 무효화하지 않으면 방금 새로 등록된 종목이 마운트 시점의 낡은 스냅샷에는 없다.
      // hasFacts 를 "모른다"로 보고 게이트가 근거 없이 다음 단계를 막는다.
      void queryClient.invalidateQueries({ queryKey: ['symbols'] });
    },
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

  /**
   * "기간 전체 동기화" 버튼의 주 해결책 조건 — uncoveredDates(리밸런스 날짜만) 뿐
   * 아니라 periodCovered(기간 전체)·missingCandleSymbols(봉 없는 종목)도 본다.
   * 리밸런스 날짜는 다 커버됐는데 그 사이 평일의 KRX 일봉이 비어 있으면
   * uncoveredDates 는 빈 배열이라 이 버튼이 사라지고, 봉 없는 종목에 남는 유일한
   * 선택지가 증권사 동기화뿐이 된다 — 상장폐지 종목은 증권사가 모르므로 반드시
   * 404 로 실패한다(운영 버그). 조건을 넓혀 이 버튼이 항상 먼저 뜨게 한다.
   */
  // 기간을 이미 다 채웠으면 이 버튼을 내리다 — 다시 눌러도 수집할 날짜가 없어
  // 아무 일도 일어나지 않는다. 그 상태로 남은 종목은 KRX 에도 데이터가 없다는 뜻이라
  // 아래 별도 안내가 맡는다.
  const fullSyncNeeded =
    preview !== null && (preview.uncoveredDates.length > 0 || !preview.periodCovered);

  /** 위 fullSyncNeeded 가 뜬 이유를 우선순위대로 설명한다 — 리밸런스 날짜 > 기간 전체 */
  const fullSyncReason = (result: UniversePreviewResponseDto): string => {
    if (result.uncoveredDates.length > 0) {
      return `종목 마스터가 리밸런스 날짜 ${result.uncoveredDates.length}개를 아직 커버하지 않습니다.`;
    }
    return '기간 중 일부 날짜의 KRX 데이터가 아직 없습니다.';
  };

  // 기간을 이미 다 커버했는데도(periodCovered) 여전히 봉이 없는 종목이
  // 남아 있는지 본다. 그렇다면 KRX 에도 그 종목의 일봉이 없다는 뜻이다
  // (증권사 동기화는 D-041 로 제거됐다) — 안내 알림만 보여준다.
  // 기간이 아직 미커버인 동안은 이 알림을 띄우지 않는다.
  // "기간 전체 동기화"부터 먼저 시도해야 하기 때문이다.
  const missingCandlesAfterFullSync =
    preview !== null && preview.periodCovered && preview.missingCandleSymbols.length > 0;

  const runPreview = (params: PreviewParams): void => {
    previewMutation.mutate(params);
  };

  /**
   * 지금 도는(또는 방금 끝난) 백필의 대상 구간이 이 화면이 요청한 period.from~to 를
   * 전부 덮는지 본다. `targetStartDate` 가 null 이면 그 백필 자체가 없던 것이므로
   * false 다. `targetEndDate` 가 null 이면 toDate 없이(오늘까지) 시작한 백필이라는
   * 뜻이라 위쪽은 항상 덮인 것으로 본다.
   */
  const backfillCoversRequestedPeriod = (
    targetStartDate: string | null,
    targetEndDate: string | null,
  ): boolean =>
    targetStartDate !== null &&
    targetStartDate <= period.from &&
    (targetEndDate === null || targetEndDate >= period.to);

  /**
   * `POST /symbol-master/backfill` 로 기간 전체(period.from~to) 백필을 시작시키고,
   * `GET /symbol-master/coverage` 의 backfill 상태가 RUNNING 이 아닐 때까지 폴링한다.
   *
   * 백필은 서버 쪽 단일 백그라운드 러너다 — 이미 다른 백필이 RUNNING 이면 이 호출은
   * 새로 시작하지 않고 그 진행 상황에 편승한다(symbol-master-backfill.ts start() 참고).
   * coverage 가 대상 구간(targetStartDate/targetEndDate)을 함께 주므로, 편승 중인
   * 진행이 이 화면이 요청한 기간을 덮지 못하면(다른 화면·스케줄러가 다른 범위를
   * 돌리는 중이면) 그 사실을 바로 알린다 — 그러지 않으면 사용자는 이유를 모른 채
   * "버튼이 다시 나타남"만 보게 된다(리뷰 finding). 편승 자체를 큐잉으로 막지는
   * 않는다 — 그 백필이 끝나면 버튼을 다시 눌러 이어가면 된다.
   *
   * BUDGET_EXHAUSTED 로 멈추면 오류로 안내한다 — 버튼을 다시 누르면(보통 다음날 예산이
   * 리셋된 뒤) 이어서 시도할 수 있다.
   *
   * 백필이 온전히 끝났어도(IDLE) 리밸런스 날짜가 하나 이상 여전히 uncoveredDates 로
   * 남을 수 있다 — `period.from` 자체가 휴장일이면 그 직전 거래일(재구성 앵커)이
   * 백필 요청 구간(`period.from`~`period.to`) 밖이라 이번 백필이 닿지 않기 때문이다
   * (symbol-master-service.ts `effectiveTradingDateWithinCoverage` 는 "같은 커버
   * 구간 안"에서만 앵커를 찾는다). 그 소급은 원래 `ensureTradingDay`(`POST
   * /symbol-master/sync`)의 책임이므로, 남은 날짜만 그 경로로 개별 보정한 뒤 다시
   * 미리보기한다 — 리밸런스 날짜 수만큼만 추가로 들어 대량 백필과 비용이 겹치지 않는다.
   */
  const syncFullPeriod = async (): Promise<void> => {
    setBackfillError(null);
    setBackfillRunning(true);
    setBackfillCursor(null);
    let backfillCompleted = false;

    try {
      await postJson<unknown>('/symbol-master/backfill', {
        fromDate: period.from,
        toDate: period.to,
      });

      let status = (await api<SymbolMasterCoverageDto>('/symbol-master/coverage')).backfill;
      while (status.state === 'RUNNING') {
        if (!backfillCoversRequestedPeriod(status.targetStartDate, status.targetEndDate)) {
          setBackfillError(
            '다른 구간 수집이 진행 중입니다 — 끝나면 다시 눌러 주세요.',
          );
          return; // finally 에서 backfillRunning 을 내린다 — 이 진행은 우리 요청이 아니므로 재미리보기도 하지 않는다.
        }
        setBackfillCursor(status.cursorDate);
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        status = (await api<SymbolMasterCoverageDto>('/symbol-master/coverage')).backfill;
      }

      if (status.state === 'BUDGET_EXHAUSTED') {
        setBackfillError(
          `오늘 수집 한도에 도달했습니다 (진행: ${status.cursorDate ?? '?'}) — 잠시 후 다시 시도하세요`,
        );
      } else if (status.state === 'FAILED') {
        setBackfillError(status.error ?? '기간 동기화에 실패했습니다');
      } else {
        backfillCompleted = true;
      }
    } catch (error) {
      setBackfillError(error instanceof ApiError ? error.message : '기간 동기화에 실패했습니다');
    } finally {
      setBackfillRunning(false);
    }

    await queryClient.invalidateQueries({ queryKey: ['symbol-master'] });
    if (!previewMutation.variables) return;

    // 부분 진행(BUDGET_EXHAUSTED·FAILED)이었어도 다시 물어야 남은 미커버 날짜가
    // 정확히 추려진다 — 다만 그 경우 아래 소급 보정은 시도하지 않는다: 방금 KRX
    // 예산이 바닥났거나 실패한 상태에서 날짜마다 추가 소급 호출을 걸면 같은 이유로
    // 다시 실패할 뿐이고, 이미 뜬 backfillError 로 원인은 충분히 안내된다.
    if (!backfillCompleted) {
      runPreview(previewMutation.variables);
      return;
    }

    let refreshed: UniversePreviewResponseDto;
    try {
      refreshed = await previewMutation.mutateAsync(previewMutation.variables);
    } catch {
      return; // previewMutation.isError 알림이 이미 안내한다
    }
    if (refreshed.uncoveredDates.length === 0) return;

    try {
      for (const date of refreshed.uncoveredDates) {
        await postJson('/symbol-master/sync', { date });
      }
    } catch (error) {
      setBackfillError(
        error instanceof ApiError ? error.message : '남은 리밸런스 날짜를 소급하지 못했습니다',
      );
      return;
    }
    await queryClient.invalidateQueries({ queryKey: ['symbol-master'] });
    runPreview(previewMutation.variables);
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

      {preview && fullSyncNeeded ? (
        <Alert variant="destructive" role="alert">
          <AlertDescription className="space-y-2">
            <p>
              {fullSyncReason(preview)} 기간 전체를 동기화해야 미리보기를 완성할 수 있습니다 —
              봉이 없는 종목이 있을 때 먼저 시도할 방법입니다.
            </p>
            {preview.uncoveredDates.length > 0 ? (
              <p className="text-xs tabular-nums opacity-80">
                {preview.uncoveredDates.join(', ')}
              </p>
            ) : null}
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={backfillRunning}
              onClick={() => void syncFullPeriod()}
            >
              {backfillRunning
                ? backfillCursor
                  ? `동기화 중… ${backfillCursor}`
                  : '동기화 중…'
                : '기간 전체 동기화'}
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}

      {/* 429/503(쿼터·미설정)·예산 소진 같은 백필 실패가 조용히 묻히지 않게 previewMutation 과
          같은 방식으로 보여준다 (리뷰 fix) */}
      {backfillError !== null ? (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{backfillError}</AlertDescription>
        </Alert>
      ) : null}

      {preview && missingCandlesAfterFullSync ? (
        <Alert variant="destructive" role="alert">
          <AlertDescription className="space-y-2">
            <p>다음 종목은 아직 봉 데이터가 없어 백테스트를 실행할 수 없습니다.</p>
            <p className="text-xs text-muted-foreground wrap-anywhere">
              {preview.missingCandleSymbols.join(', ')}
            </p>
            {/* 기간을 이미 다 채운 상태에서만 이 블록이 뜬다. 그런데도 봉이
                없다면 KRX 에도 이 종목의 일봉이 없다는 뜻이다. 봉 수집 경로가
                종목 마스터 동기화 하나뿐이라(가격 데이터 화면·증권사 동기화는
                D-041 로 제거됨) 이 화면에서 더 시도할 방법이 없다. */}
            <p className="text-xs text-muted-foreground">
              기간은 이미 다 수집했습니다 — KRX 에도 이 종목의 일봉이 없습니다.
              그 기간에 거래가 없었거나(거래정지·정리매매 종료) KRX 가 제공하지
              않는 종목입니다.
            </p>
            <p className="text-xs text-muted-foreground">
              상위 N 이나 기간을 조정해 이 종목을 유니버스에서 빼는 것 외에는
              방법이 없습니다.
            </p>
          </AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
}
