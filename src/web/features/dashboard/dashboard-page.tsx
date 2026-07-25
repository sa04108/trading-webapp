import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

export function DashboardPage() {
  return (
    <div className="space-y-4">
      <h2 className="text-lg font-semibold">대시보드</h2>
      <div className="grid gap-4 sm:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">실행 중 작업</CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            백테스트 기능은 이후 단계에서 제공됩니다.
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">최근 결과</CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">아직 결과가 없습니다.</CardContent>
        </Card>
      </div>
    </div>
  );
}
