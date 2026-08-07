import { Link, Navigate, Outlet, useLocation, useSearchParams } from 'react-router';
import { cn } from '@/lib/utils';

/**
 * 데이터 화면 — 종목 마스터와 가격 데이터를 나눈다 (설계 2026-08-05-symbol-master-design).
 *
 * 두 구획은 화면 전체가 바뀌는 나란한 페이지라서 각자 경로를 갖는다(설계
 * 2026-08-07-step-urls-design). 왕복이 이력에 쌓여 뒤로가기가 직전 구획으로 돌아간다.
 */
const SECTIONS = [
  { slug: 'master', label: '종목 마스터' },
  { slug: 'prices', label: '가격 데이터' },
] as const;

export function DataPage() {
  const { pathname } = useLocation();

  return (
    <div className="space-y-4">
      <h2 className="text-lg font-semibold">데이터</h2>
      {/*
        Tabs 를 쓰지 않는 이유: 자식 라우트는 활성 패널 하나만 마운트하므로 짝이 없는
        TabsTrigger 의 aria-controls 가 허공을 가리킨다. 위저드 단계 nav 와 같은
        nav + aria-current 패턴으로 맞춘다.

        클래스는 tabs.tsx 의 default variant 모양을 다시 만든 것이다. 그 파일의 클래스
        문자열을 그대로 옮겨오지는 않는다 — group-data-[variant=…]/tabs-list 선택자들이
        Tabs.Root·TabsList 가 붙이는 data 속성에 매달려 있어 nav 안에서는 죽는다.
      */}
      <nav aria-label="데이터 구획">
        <ul className="inline-flex h-8 w-fit items-center justify-center rounded-lg bg-muted p-[3px]">
          {SECTIONS.map((section) => {
            const active = pathname === `/datasets/${section.slug}`;
            return (
              <li key={section.slug} className="h-full">
                <Link
                  to={`/datasets/${section.slug}`}
                  aria-current={active ? 'page' : undefined}
                  className={cn(
                    'relative inline-flex h-full items-center justify-center rounded-md border border-transparent px-2.5 text-sm font-medium whitespace-nowrap transition-colors',
                    'focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-1 focus-visible:outline-ring',
                    active
                      ? 'bg-background text-foreground shadow-sm dark:border-input dark:bg-input/30'
                      : 'text-foreground/60 hover:text-foreground dark:text-muted-foreground dark:hover:text-foreground',
                  )}
                >
                  {section.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
      <div className="mt-4">
        <Outlet />
      </div>
    </div>
  );
}

/**
 * `/datasets` 와 옛 `?tab=` 링크를 구획 경로로 잇는다.
 *
 * `tab` 만 소비하고 나머지 쿼리는 그대로 넘긴다 — 종목 마스터의 `?date=` 링크가
 * 끊기면 안 된다. `symbols` 는 데이터 탭이 데이터셋·종목이던 시절의 값이다.
 *
 * `replace` 인 이유: push 로 하면 뒤로가기가 이 리다이렉트 원점으로 돌아와 곧바로 다시
 * 튕기는 루프가 된다.
 */
export function DatasetsIndexRedirect() {
  const [params] = useSearchParams();
  const tab = params.get('tab');
  const slug = tab === 'prices' || tab === 'symbols' ? 'prices' : 'master';

  const rest = new URLSearchParams(params);
  rest.delete('tab');
  const search = rest.toString();

  return (
    <Navigate
      to={{ pathname: `/datasets/${slug}`, search: search === '' ? '' : `?${search}` }}
      replace
    />
  );
}
