import { Navigate, NavLink, Outlet, useSearchParams } from 'react-router';
import { cn } from '@/lib/utils';

/**
 * 데이터 화면 — 종목 마스터와 벤치마크를 경로로 나눈다.
 *
 * `/datasets/master` 경로는 남긴다: `?date=` 를 쓰는 종목 마스터 화면과 주소가 갈라져
 * 있어야 그 화면만의 뒤로가기 동작(설계 2026-08-07-step-urls-design)이 흔들리지 않는다.
 */
export function DataPage() {
  return (
    <div className="space-y-4">
      <h2 className="text-lg font-semibold">데이터</h2>
      <nav aria-label="데이터 구획" className="flex gap-2">
        {([
          ['/datasets/master', '종목 마스터'],
          ['/datasets/benchmarks', '벤치마크'],
        ] as const).map(([to, label]) => (
          <NavLink
            key={to}
            to={to}
            className={({ isActive }) => cn(
              'rounded-md px-3 py-2 text-sm font-medium',
              isActive ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground',
            )}
          >
            {label}
          </NavLink>
        ))}
      </nav>
      <div className="mt-4">
        <Outlet />
      </div>
    </div>
  );
}

/**
 * `/datasets` 와 옛 `?tab=` 링크를 종목 마스터 경로로 잇는다.
 *
 * `tab` 만 소비하고 나머지 쿼리는 그대로 넘긴다 — 종목 마스터의 `?date=` 링크가
 * 끊기면 안 된다. 옛 링크의 기본 구획은 계속 `master` 다.
 *
 * `replace` 인 이유: push 로 하면 뒤로가기가 이 리다이렉트 원점으로 돌아와 곧바로 다시
 * 튕기는 루프가 된다.
 */
export function DatasetsIndexRedirect() {
  const [params] = useSearchParams();

  const rest = new URLSearchParams(params);
  rest.delete('tab');
  const search = rest.toString();

  return (
    <Navigate
      to={{ pathname: '/datasets/master', search: search === '' ? '' : `?${search}` }}
      replace
    />
  );
}
