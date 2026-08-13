import { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { PageSizeInput, Pagination } from '@/components/pagination';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { pageWindow } from '@/lib/pagination';
import { parsePageSize } from '@/lib/page-size';
import type { UniverseRebalancingEntryDto } from '../../../shared/schemas/universe-rebalancing.js';

export function UniverseRebalancingSection({
  entries,
}: {
  entries: readonly UniverseRebalancingEntryDto[];
}) {
  const [page, setPage] = useState(0);
  const [pageSizeText, setPageSizeText] = useState('20');
  const pageSize = parsePageSize(pageSizeText, 20);
  const { pageCount, currentPage, from, to } = pageWindow(entries.length, pageSize, page);
  const visible = entries.slice(from, to);

  if (entries.length === 0) return null;

  return (
    <Card className="lg:col-span-2">
      <CardHeader className="flex flex-row items-center justify-between gap-2">
        <CardTitle className="text-base">종목 리밸런싱</CardTitle>
        <PageSizeInput
          value={pageSizeText}
          label="종목 리밸런싱 페이지당 표시 수"
          unit="건"
          onChange={(nextValue) => {
            setPageSizeText(nextValue);
            setPage(0);
          }}
        />
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>리밸런스일</TableHead>
                <TableHead>기준일</TableHead>
                <TableHead>변동 종목 수</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visible.map((entry) => (
                <TableRow key={entry.rebalanceDate}>
                  <TableCell className="whitespace-nowrap text-xs">
                    {entry.rebalanceDate}
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-xs">
                    {entry.effectiveDate}
                    {entry.effectiveDate !== entry.rebalanceDate ? (
                      <span className="text-muted-foreground"> (휴장 조정)</span>
                    ) : null}
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-xs">
                    {entry.kind === 'INITIAL' ? (
                      <>최초 구성 {entry.memberCount}종목</>
                    ) : (
                      <>
                        합계 {entry.changedCount}종목 (편입{' '}
                        <span className="text-gain tabular-nums">{entry.addedCount}</span> · 편출{' '}
                        <span className="text-loss tabular-nums">{entry.removedCount}</span>)
                      </>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
        <Pagination
          className="mt-3"
          ariaLabel="종목 리밸런싱 페이지 이동"
          currentPage={currentPage}
          pageCount={pageCount}
          onPageChange={setPage}
        />
      </CardContent>
    </Card>
  );
}
