# 백테스트 화면에 종목명 표시 설계

날짜: 2026-07-29
관련: 스펙 §12, 2026-07-28-broker-sync-design.md (SymbolInfoService)

## 목적

백테스트 화면이 종목을 코드로만 보여준다. `005930` 이 삼성전자인지 알아야 결과를
읽을 수 있는데, 코드를 외우고 있는 사람만 읽을 수 있는 화면이다.

**종목명을 주로, 코드를 괄호에** 표시한다: `삼성전자 (005930)`. 이름이 길어도
**코드는 절대 잘리지 않는다** — 코드가 잘리면 종목을 식별할 유일한 수단이 사라진다.

조회 경로는 이미 있다. `GET /symbols/info` + `SymbolInfoService` 가 코드 → 이름을
주고, 소스 미설정은 에러가 아니라 빈 결과다(symbol-info-service.ts:19-20). 데이터셋
화면이 이미 이걸 쓴다(datasets-page.tsx:127). 백테스트 화면에 없을 뿐이다.

## 적용 범위 (대화에서 확정)

| 자리 | 현재 |
|---|---|
| 결과 상단 Description | `backtest-detail-page.tsx:466` |
| 거래 내역 — 종목 열 (미청산) | `backtest-detail-page.tsx:158` |
| 거래 내역 — 종목 열 (체결) | `backtest-detail-page.tsx:188` |
| 거래 내역 — 종목 필터 | `backtest-detail-page.tsx:127-131` |
| 종목별 성과 표 | `backtest-detail-page.tsx:539` |
| 백테스트 목록 카드 | `backtests-page.tsx:31` |

네 곳만 바꾸고 두 곳을 남기면 같은 화면 안에서 표기가 갈린다 — 전부 바꾼다.

## 1. 표기 규칙

**`이름 (코드)`** — 한 가지 형식을 모든 자리에 쓴다. 표에서는 공백을 넣고 목록에서는
빼는 식으로 갈라 두면 규칙이 둘이 되고 테스트도 둘이 된다.

이름을 모르면(소스 미설정, 신규·폐지 종목) **코드만** 쓴다. 빈 괄호(`(005930)`,
` (005930)`)를 만들지 않는다. `SymbolInfoService` 는 모르는 심볼을 negative cache 로
두고 응답에서 빼므로(symbol-info-service.ts:13) 이 분기는 실제로 일어난다.

## 2. 공유 훅으로 승격

`useStockNames` 와 `StockInfo` 가 `datasets-page.tsx:64-86` 안에 갇혀 있다.
`src/web/lib/use-stock-names.ts` 로 옮긴다 — `api-client.ts` 를 쓰는 훅이라 `lib/` 이
맞는 자리다.

```ts
export interface StockInfo {
  symbol: string;
  name: string;
  englishName: string | null;
  market: string;
  status: string;
}

/** 코드 → 종목정보. 소스 미설정이면 빈 Map 이라 코드만 표시된다. */
export function useStockNames(symbols: readonly string[]): ReadonlyMap<string, StockInfo>;
```

동작은 그대로 옮긴다(queryKey = 정렬 없는 join, `staleTime` 1시간). `datasets-page.tsx`
는 import 로 바꾸고, 같은 파일의 `useSymbolPreview` 는 남긴 채 `StockInfo` 만 새 모듈에서
가져온다 — 데이터셋 입력 확인 전용 훅이라 옮길 이유가 없다.

## 3. 표시 컴포넌트

판단은 순수 함수에, 렌더링은 컴포넌트에 둔다 (§7 테스트 제약).

```ts
// src/web/features/backtests/symbol-summary.ts — 표기 규칙의 단일 출처
export function formatSymbolLabel(symbol: string, name: string | null): string;
//   ('005930', '삼성전자') → '삼성전자 (005930)'
//   ('005930', null)       → '005930'
```

```tsx
// src/web/components/symbol-label.tsx
export function SymbolLabel({ symbol, name, className }: {
  symbol: string;
  name: string | null;
  className?: string;
}): React.JSX.Element;
```

```tsx
// name 이 있을 때
<span className={cn('flex items-baseline gap-1', className)}>
  <span className="max-w-40 truncate" title={name}>{name}</span>
  <span className="shrink-0 text-muted-foreground">({symbol})</span>
</span>
// name 이 null 이면 <span>{symbol}</span>
```

**코드가 잘리지 않는 근거는 `shrink-0` 이다.** 이름 쪽만 `truncate` + `max-w-40`(160px)
으로 줄어들고, 코드 쪽은 flex 축소 대상에서 빠진다. 문자 수로 자르는 방식은 한글·영문
혼용 종목명(`HD현대일렉트릭`)에서 실제 픽셀 폭과 어긋나므로 쓰지 않는다.

`title={name}` 으로 잘린 전체 이름을 hover 에서 볼 수 있게 한다.

## 4. Description — 앞 5개 + "외 N종목"

지금은 `symbols.join(', ')` 로 **전부** 나열한다. 200종목 백테스트면 코드만으로도 긴
줄인데 이름까지 붙으면 화면 여러 줄을 잡아먹는다. 앞 5개만 쓴다.

```ts
// src/web/features/backtests/symbol-summary.ts
export const SYMBOL_SUMMARY_LIMIT = 5;

export function formatSymbolSummary(
  symbols: readonly string[],
  nameOf: (symbol: string) => string | null,
  limit = SYMBOL_SUMMARY_LIMIT,
): string;
```

앞 `limit` 개를 `, ` 로 잇고, 남은 개수를 접미사로 붙인다.

- 2종목 → `삼성전자 (005930), SK하이닉스 (000660)` (접미사 없음)
- 정확히 5종목 → 5개 전부, 접미사 없음
- 200종목 → `삼성전자 (005930), SK하이닉스 (000660), 카카오 (035720), NAVER (035420), LG에너지솔루션 (373220) 외 195종목`
- 이름을 모르는 항목은 코드만 (§1)
- 빈 배열이면 빈 문자열

전체 목록을 잃지 않는다 — 거래 내역의 종목 필터와 종목별 성과 표에 전부 있다.

`SymbolLabel`(JSX, 표 안 잘림용)과 `formatSymbolSummary`(문자열, 줄바꿈되는 문단용)를
나누는 이유: 문단은 wrap 되므로 잘릴 일이 없고, CSS truncate 를 걸면 오히려 한 줄로
강제된다.

## 5. 조회 범위 — 화면마다 다르게

`GET /symbols/info` 는 심볼을 콤마로 이어 쿼리에 싣고 최대 1,000개를 받는다
(dataset-routes.ts:63). 화면마다 필요한 만큼만 조회한다.

- **상세 화면** — `useStockNames(job.request.universe.symbols)` 한 번. 거래 내역·종목별
  성과·Description 이 같은 Map 을 쓴다. 데이터셋 심볼 상한이 1,000이라 초과하지 않는다.
- **목록 화면** — 카드마다 훅을 부르면 카드 수만큼 요청이 난다. 페이지의 모든 잡에서
  **표시할 앞 5개씩만** 모아 합집합으로 한 번 조회한다. 상한이 `5 × 페이지당 잡 수`로
  묶여 심볼 수와 무관하게 안전하다.

`job` 이 로딩 중이면 빈 배열로 부른다 — 훅이 `enabled: symbols.length > 0` 로 이미
처리한다.

## 6. 종목 필터 Select

트리거가 `w-36`(144px)이라 `삼성전자 (005930)` 이 안 들어간다. **`w-56`(224px)으로
넓히고** 트리거·항목 모두 `SymbolLabel` 을 쓴다. `전체 종목` 항목은 그대로 둔다.

필터의 `value` 는 **코드를 유지한다** — 표시만 바뀌고 쿼리 파라미터(`?symbol=`)는
그대로다. 서버 API 는 손대지 않는다.

## 7. 테스트

이 저장소에는 React 컴포넌트 단위 테스트 환경이 없다 — `vitest.config.ts` 가
`tests/{unit,integration,architecture}` 만 돌리고 jsdom·testing-library 가 없다. 이
설계를 위해 그 인프라를 새로 들이지 않는다. 대신 **판단이 있는 부분을 순수 함수로
빼내 단위 테스트하고, 렌더링은 Playwright 로 확인한다.**

- `formatSymbolSummary` 단위 — 5개 이하/초과, 이름 없는 항목 혼재, 전부 이름 없음,
  빈 배열, `limit` 경계(정확히 5개, 6개)
- `formatSymbolLabel` 단위 — `name === null` → 코드만, 이름 있으면 `이름 (코드)`.
  `SymbolLabel` 은 이 함수의 결과를 span 두 개로 나눠 그리는 것 외에 판단이 없다
- e2e — 거래 내역에 `이름 (코드)` 가 뜨고, 종목 필터로 걸러도 결과가 유지되며(value 가
  코드임을 확인), 데이터셋 카드의 종목명이 훅 이동 후에도 그대로 나오는지

## 범위에서 뺀 것

- **CSV Export** — 기계가 읽는 출력이므로 코드만 유지한다. 이름을 넣으면 파싱하는
  쪽이 컬럼을 늘려야 한다.
- **새 백테스트 위저드**(`new-backtest-wizard.tsx:476`, `:611`) — 결과 화면이 아니고,
  종목 선택 목록은 이미 데이터셋 화면 관례를 따른다. 별건으로 둔다.
- **이름으로 검색·정렬** — `SymbolInfoService` 는 코드 → 이름 단방향만 제공한다
  (symbol-info-service.ts:19).
- **영문명 표시** — `englishName` 이 응답에 있지만 KR 화면에서 쓸 자리가 없다.
