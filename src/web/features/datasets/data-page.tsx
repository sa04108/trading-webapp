import { useSearchParams } from 'react-router';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { DatasetsPanel } from './datasets-panel';
import { SymbolsPanel } from './symbols-panel';

/**
 * 데이터 화면 — 데이터셋과 종목을 나눈다 (설계 2026-07-31-symbol-as-first-class).
 *
 * 탭 상태를 쿼리스트링에 두는 이유: 종목을 제거하거나 데이터셋을 만든 뒤 새로고침해도
 * 방금 보던 구획으로 돌아온다. 두 구획을 왕복하는 작업(종목 추가 → 데이터셋 만들기)이
 * 흔해서 뒤로가기가 탭을 기억해야 한다.
 */
export function DataPage() {
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') === 'symbols' ? 'symbols' : 'datasets';

  return (
    <div className="space-y-4">
      <h2 className="text-lg font-semibold">데이터</h2>
      <Tabs
        value={tab}
        onValueChange={(value) => {
          const next = new URLSearchParams(params);
          next.set('tab', value);
          setParams(next, { replace: true });
        }}
      >
        <TabsList>
          <TabsTrigger value="datasets">데이터셋</TabsTrigger>
          <TabsTrigger value="symbols">종목</TabsTrigger>
        </TabsList>
        <TabsContent value="datasets" className="mt-4">
          <DatasetsPanel />
        </TabsContent>
        <TabsContent value="symbols" className="mt-4">
          <SymbolsPanel />
        </TabsContent>
      </Tabs>
    </div>
  );
}
