import { useSearchParams } from 'react-router';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { SymbolMasterPanel } from '@/features/symbol-master/symbol-master-panel';
import { SymbolsPanel } from './symbols-panel';

/**
 * 데이터 화면 — 종목 마스터와 가격 데이터를 나눈다 (설계 2026-08-05-symbol-master-design).
 *
 * 탭 상태를 쿼리스트링에 두는 이유: 종목 마스터에서 날짜를 선택하거나 가격 데이터를
 * 조회한 뒤 새로고침해도 방금 보던 구획으로 돌아온다. 두 구획을 왕복하는 작업이
 * 흔해서 뒤로가기가 탭을 기억해야 한다.
 */
export function DataPage() {
  const [params, setParams] = useSearchParams();
  const raw = params.get('tab');
  const tab = raw === 'prices' || raw === 'symbols' ? 'prices' : 'master';

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
          <TabsTrigger value="master">종목 마스터</TabsTrigger>
          <TabsTrigger value="prices">가격 데이터</TabsTrigger>
        </TabsList>
        <TabsContent value="master" className="mt-4">
          <SymbolMasterPanel />
        </TabsContent>
        <TabsContent value="prices" className="mt-4">
          <SymbolsPanel />
        </TabsContent>
      </Tabs>
    </div>
  );
}
