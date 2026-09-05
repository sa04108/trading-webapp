import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader,
  DialogTitle, DialogTrigger,
} from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { cn } from '@/lib/utils';
import {
  groupPreparationIssues, PREPARATION_SOURCE_LABELS, splitPreparationWarnings,
  type PreparationIssueGroup,
} from './preparation-issues';

type DetailMode = 'reason' | 'symbol';
interface DetailRow {
  readonly group: PreparationIssueGroup;
  readonly entry: PreparationIssueGroup['symbols'][number];
}

function dispositionLabel(disposition: PreparationIssueGroup['disposition']): string {
  return disposition === 'EXCLUDED' ? '대상에서 제외' : '참고 안내';
}

/** 앞쪽 공통 셀은 연속된 같은 값의 행 수만큼 합친다. */
function rowSpan<T>(rows: readonly T[], index: number, key: (row: T) => string): number {
  const value = key(rows[index]!);
  if (index > 0 && key(rows[index - 1]!) === value) return 0;
  let end = index + 1;
  while (end < rows.length && key(rows[end]!) === value) end += 1;
  return end - index;
}

export function PreparationIssueDetails({ groups, mode }: {
  readonly groups: readonly PreparationIssueGroup[];
  readonly mode: DetailMode;
}) {
  const rows: DetailRow[] = groups.flatMap((group) => group.symbols.map((entry) => ({ group, entry })));
  if (mode === 'symbol') rows.sort((a, b) => a.entry.symbol.localeCompare(b.entry.symbol));
  return (
    <Table aria-label={mode === 'reason' ? '확인사항 기본보기' : '확인사항 종목별보기'} className="min-w-[720px]">
      <TableHeader><TableRow>
        {mode === 'symbol' ? <TableHead scope="col">종목코드</TableHead> : null}
        <TableHead scope="col">API / 데이터</TableHead>
        <TableHead scope="col">사유</TableHead>
        {mode === 'reason' ? <TableHead scope="col">종목코드</TableHead> : null}
        <TableHead scope="col">날짜·기간</TableHead>
        <TableHead scope="col">상세 내용</TableHead>
      </TableRow></TableHeader>
      <TableBody>
        {rows.map(({ group, entry }, index) => {
          const symbolSpan = rowSpan(rows, index, (row) => row.entry.symbol);
          const sourceSpan = rowSpan(rows, index, (row) => mode === 'symbol'
            ? `${row.entry.symbol}:${row.group.source}` : row.group.source);
          const reasonSpan = mode === 'reason' ? rowSpan(rows, index, (row) => row.group.key) : 1;
          return (
            <TableRow key={`${group.key}:${entry.symbol}`}>
              {mode === 'symbol' && symbolSpan > 0 ? (
                <TableCell rowSpan={symbolSpan} className="align-top font-mono">{entry.symbol}</TableCell>
              ) : null}
              {sourceSpan > 0 ? (
                <TableCell rowSpan={sourceSpan} className="align-top whitespace-normal">
                  {PREPARATION_SOURCE_LABELS[group.source]}
                </TableCell>
              ) : null}
              {reasonSpan > 0 ? (
                <TableCell rowSpan={reasonSpan} className="min-w-36 align-top whitespace-normal">
                  {group.reason}
                  <span className="mt-1 block text-xs text-muted-foreground">{dispositionLabel(group.disposition)}</span>
                </TableCell>
              ) : null}
              {mode === 'reason' ? <TableCell className="align-top font-mono">{entry.symbol}</TableCell> : null}
              <TableCell className="min-w-32 align-top whitespace-pre-line">
                {[...new Set(entry.details.map((detail) => detail.period))].join('\n')}
              </TableCell>
              <TableCell className="min-w-60 align-top whitespace-normal wrap-anywhere">
                <ul className="space-y-2">
                  {entry.details.map(({ period, detail }) => (
                    <li key={JSON.stringify([period, detail])}>
                      {entry.details.length > 1 ? <span className="text-xs text-muted-foreground">{period}: </span> : null}
                      {detail}
                    </li>
                  ))}
                </ul>
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

export function PreparationIssuesCard({ warnings, className, result = false }: {
  readonly warnings: readonly string[];
  readonly className?: string;
  readonly result?: boolean;
}) {
  const parsed = useMemo(() => splitPreparationWarnings(warnings), [warnings]);
  const groups = useMemo(() => groupPreparationIssues(parsed.issues), [parsed]);
  const [mode, setMode] = useState<DetailMode>('reason');
  const uniqueSymbols = new Set(parsed.issues.map((issue) => issue.symbol)).size;
  if (warnings.length === 0) return null;
  return (
    <Card className={cn('min-w-0', className)}>
      <Dialog onOpenChange={(open) => { if (open) setMode('reason'); }}>
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
          <CardTitle className="text-base">유니버스 준비 확인사항</CardTitle>
          <DialogTrigger asChild>
            <Button type="button" variant="outline" size="sm">자세히 보기</Button>
          </DialogTrigger>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          {groups.length > 0 ? (
            <Table aria-label="유니버스 준비 확인사항 요약">
              <TableHeader><TableRow>
                <TableHead scope="col">API / 데이터</TableHead>
                <TableHead scope="col">사유</TableHead>
                <TableHead scope="col">처리</TableHead>
                <TableHead scope="col" className="text-right">종목 수</TableHead>
              </TableRow></TableHeader>
              <TableBody>
                {groups.map((group) => (
                  <TableRow key={group.key}>
                    <TableCell className="whitespace-normal">{PREPARATION_SOURCE_LABELS[group.source]}</TableCell>
                    <TableCell className="min-w-36 whitespace-normal wrap-anywhere">{group.reason}</TableCell>
                    <TableCell>{dispositionLabel(group.disposition)}</TableCell>
                    <TableCell className="text-right tabular-nums">{group.symbols.length.toLocaleString('ko-KR')}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : null}
          <p className="text-xs text-muted-foreground">
            중복 제외 {uniqueSymbols.toLocaleString('ko-KR')}종목 · 같은 종목이 서로 다른 사유에 포함될 수 있습니다.
          </p>
          {parsed.otherWarnings.length > 0 ? (
            <p className="text-xs text-muted-foreground">기타 확인사항 {parsed.otherWarnings.length}건은 자세히 보기에서 확인할 수 있습니다.</p>
          ) : null}
          <p className="text-xs text-muted-foreground">
            {result ? '이 백테스트를 준비할 당시 확인된 내용입니다.' : '확인사항을 검토한 뒤 그대로 진행할 수 있습니다.'}
          </p>
        </CardContent>
        <DialogContent className="flex max-h-[90dvh] min-w-0 flex-col sm:max-w-5xl">
          <DialogHeader className="pr-8">
            <DialogTitle>유니버스 준비 확인사항 상세</DialogTitle>
            <DialogDescription>
              해당 미리보기에서 확인된 사유와 모든 종목코드입니다. 중복 제외 {uniqueSymbols.toLocaleString('ko-KR')}종목.
            </DialogDescription>
          </DialogHeader>
          <Tabs value={mode} onValueChange={(value) => setMode(value as DetailMode)} className="min-h-0 gap-3">
            <TabsList aria-label="확인사항 보기 방식" className="shrink-0">
              <TabsTrigger value="reason">기본보기</TabsTrigger>
              <TabsTrigger value="symbol">종목별보기</TabsTrigger>
            </TabsList>
            {(['reason', 'symbol'] as const).map((value) => (
              <TabsContent key={value} value={value} className="min-h-0 overflow-auto rounded-md border">
                <PreparationIssueDetails groups={groups} mode={value} />
                {parsed.otherWarnings.length > 0 ? (
                  <div className="space-y-2 border-t p-3">
                    <p className="font-medium">기타 확인사항 · 종목 정보 없음</p>
                    <ul className="list-disc space-y-2 pl-4 wrap-anywhere">
                      {parsed.otherWarnings.map((warning, index) => <li key={index}>{warning}</li>)}
                    </ul>
                  </div>
                ) : null}
              </TabsContent>
            ))}
          </Tabs>
          <DialogFooter>
            <DialogClose asChild><Button type="button" variant="outline">닫기</Button></DialogClose>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
