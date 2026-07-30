# 분봉 백필 2년 상한 + 사전 안내 — 구현 보고

## 요약

TDD로 3개 요구사항을 순차 구현했다. 각 단위마다 실패하는 테스트를 먼저 작성해
실패를 확인한 뒤 구현했다. 전체 `pnpm test`(666개), `pnpm typecheck`,
`pnpm lint`, `pnpm test:e2e`(7 passed, 1 skipped)가 모두 통과한다.

## Requirement 1 — 순수 헬퍼 `minute-backfill.ts`

새 파일 `src/server/modules/market-data/domain/minute-backfill.ts`:

- `MINUTE_BACKFILL_MAX_MONTHS = 24` — 하드 상한.
- `MINUTE_BACKFILL_SYMBOL_YEARS = 20` — 권장치 계산용 예산(스펙에 명시된 계산 근거를
  주석에 그대로 남김).
- `recommendedMinuteMonths(symbolCount)` — `clamp(floor(20*12/n), 1, 24)`.
  0종목은 1종목으로 취급(0으로 나누기 방지, 상한 24 반환).
- `minuteBackfillFloorTsMs(nowMs)` — `Date.setUTCMonth` 기반 달력 월 산술(30일
  근사 아님). symbolCount 인자를 받지 않는다 — 수집 상한은 종목 수와 무관하게 고정.
- `estimateMinuteBackfillBars(symbolCount, sessionMinutesPerDay, months)` —
  `symbolCount × sessionMinutesPerDay × round(months × 21)`.

테스트: `tests/unit/minute-backfill.test.ts` (13개, 스펙에 명시된 모든 경계값
1/10/20/40/1000/0 종목 포함). 구현 전 "Cannot find module" 로 실패 확인 후 구현,
전부 통과.

## Requirement 1 (계속) — `broker-sync-service.ts`

백필 분기(`if (state?.backfillDoneAtMs == null)`)에서 slice별로 `fromTsMs`를
분기:
- `1m` → `minuteBackfillFloorTsMs(now)`
- `1d` → `0` (변경 없음)

`markBackfillDone`·`brokerSyncState.backfillDoneAtMs`(schema.ts) 두 곳의 문서
주석을 "API 바닥"에서 "현재 상한 기준으로 더 당길 백필 작업이 없음"으로 갱신.
창이 항상 앞으로만 밀리므로(과거로 후퇴하지 않으므로) 넓히기/gap-fill 분기는
추가하지 않았다 — 요구사항에 명시된 제약대로.

테스트: `tests/unit/broker-sync-service.test.ts`에 새 describe
`분봉 백필 상한 (2년)` 추가 — (a) 분봉 동기화가 `fromTsMs = minuteBackfillFloorTsMs(clock.now())`
를 요청, (b) 일봉 동기화는 여전히 `fromTsMs: 0`. 구현 전 (a)가 `0 !== 예상값`으로
실패하는 것을 확인한 뒤 구현, 통과.

## Requirement 2 — coverage 응답에 `minutePlan` 추가

`DatasetService`에 새 메서드 `getMinutePlan(market, symbolCount): MinutePlan | null`
(dataset-service.ts):
- `hasMarketSession(market)`이 false면 `null`.
- `sessionMinutesPerDay`는 `getSessionForMarket(market)`의
  `closeMinutes - openMinutes`에서 유도 — 390을 하드코딩하지 않음.
- `expectedBars = estimateMinuteBackfillBars(symbolCount, sessionMinutesPerDay, MINUTE_BACKFILL_MAX_MONTHS)`.
- `exceedsBacktestLimit = expectedBars > MAX_BACKTEST_BARS`
  (`../../backtest/domain/bar-estimate.js`에서 import — 의존성 규칙
  `.dependency-cruiser.cjs`에 market-data→backtest 금지 항목이 없어 허용됨,
  `tests/architecture/module-boundaries.test.ts` 통과로 확인).

`dataset-routes.ts`의 `GET /datasets/:datasetId/coverage` 응답에
`minutePlan: datasetService.getMinutePlan(dataset.market, dataset.symbols.length)`
추가.

테스트: `tests/integration/market-data.test.ts`의 기존 coverage 테스트
("imports CSV via API, aggregates to hourly, and reports coverage")에
`minutePlan` 어서션 추가. 실제 시스템 클록을 쓰는 테스트 컨테이너라 `fromTsMs`는
요청 전후 `Date.now()`로 감싼 범위로 검증(정확한 단일 값 대신 상하한 비교) —
매 ms 경계를 넘는 극히 드문 flake만 있고 하드코딩된 상수는 없음. 구현 전
"Cannot read properties of undefined (reading 'capMonths')"로 실패 확인 후 구현,
통과.

## Requirement 3 — 웹 사전 확인 Dialog

`src/web/features/datasets/datasets-page.tsx`의 `DatasetCard`:
- `needsMinuteSyncConfirm = slice === '1m' && !hasSliceData` (기존
  `sliceHasData` 재사용).
- "동기화" 버튼 클릭 시 `needsMinuteSyncConfirm`이면 `syncMutation.mutate()`
  대신 `Dialog`(shadcn, 기존 `confirmDelete` 패턴과 동일)를 연다.
- Dialog 내용: 수집 기간(`capMonths`개월), 예상 봉 수(`.toLocaleString()`으로
  천 단위 구분), 권장 기간(`recommendedMonths`개월 — 안내 문구 포함),
  `exceedsBacktestLimit`이면 경고 문구
  "예상 봉 수가 백테스트 상한(200만 봉)을 넘어 한 번의 실행으로는 약
  {recommendedMonths}개월치까지만 사용할 수 있습니다.". 소요 시간은 기존 카드와
  동일한 조건문(`syncEstimate.candles.basis === 'LAST_RUN'` → 실측치,
  아니면 "첫 수집은 소요 시간을 예측할 수 없습니다")을 그대로 재사용.
- 버튼: 취소(닫기만) / 동기화 시작(닫고 `syncMutation.mutate()`).
- 증분 분봉 동기화(이미 데이터 있음)와 모든 일봉 동기화는 조건이 거짓이라 Dialog를
  거치지 않고 곧바로 시작 — 코드 경로상 다른 분기를 타지 않는다.

이 저장소는 `.tsx` 컴포넌트에 대한 단위 테스트 인프라(jsdom/testing-library)가
없다(`vitest.config.ts`의 `include`가 `*.test.ts`만 포함) — 그래서 이
Requirement는 TDD 유닛 테스트 대신 `pnpm typecheck`/`pnpm lint`/`pnpm test:e2e`로
검증했다.

### e2e 관련 확인

작업 지시에는 "e2e 스위트가 동기화를 클릭하므로 다이얼로그 경로를 타면 스펙을
갱신하라"는 전제가 있었으나, 실제로 `tests/e2e/mvp-flow.spec.ts`를 확인한 결과
"동기화" 버튼을 클릭하는 e2e 테스트는 존재하지 않는다(CSV import로 데이터를
채우는 경로만 사용). 따라서 e2e 스펙 수정은 필요하지 않았고, `pnpm test:e2e`
전체(7 passed, 1 skipped(모바일 전용 스킵))가 기존 상태 그대로 통과함을 확인했다.

## 검증 결과

- `pnpm vitest run tests/unit/minute-backfill.test.ts` — 13 passed
- `pnpm vitest run tests/unit/broker-sync-service.test.ts` — 37 passed
- `pnpm vitest run tests/integration/market-data.test.ts` — 20 passed
- `pnpm test` (전체) — 666 passed
- `pnpm typecheck` — clean
- `pnpm lint` — clean
- `pnpm test:e2e` — 7 passed, 1 skipped

## 변경 파일

- `src/server/modules/market-data/domain/minute-backfill.ts` (신규)
- `src/server/modules/market-data/application/broker-sync-service.ts`
- `src/server/modules/market-data/application/dataset-service.ts`
- `src/server/modules/market-data/presentation/dataset-routes.ts`
- `src/server/shared/db/schema.ts`
- `src/web/features/datasets/datasets-page.tsx`
- `tests/unit/minute-backfill.test.ts` (신규)
- `tests/unit/broker-sync-service.test.ts`
- `tests/integration/market-data.test.ts`

## 우려 사항 / 후속 고려

- `DatasetService.getCandleSyncEstimate`(기존 코드, 이번 작업 범위 밖)는
  `brokerSyncState`를 slice로 필터링하지 않고 심볼별 최신 backfillDoneAtMs만
  본다 — 한 데이터셋에 1d·1m 슬라이스가 모두 있으면 소요시간 추정(`syncEstimate.candles`)이
  슬라이스를 구분하지 않는다. Dialog의 "소요 시간" 문구는 기존 관례를 그대로
  재사용했으므로 이 사전부터 있던 특성을 그대로 물려받는다. 이번 요구사항
  범위(분봉 백필 상한) 밖이라 손대지 않았다.
- (아래 리뷰 수정에서 해소됨) market-data → backtest 모듈 간 새 의존성
  (`MAX_BACKTEST_BARS` import)이 있었으나, 상수를 `src/server/shared/`로
  옮겨 양쪽 모두 shared 를 참조하도록 고쳤다 — 자세한 내용은 아래 "리뷰 수정"
  절 참고.

## 리뷰 수정 (2건 Important, 2건 Minor)

리뷰어가 지적한 4건을 모두 수정했다. 커밋:
`fix(market-data): 분봉 경고 대화상자와 상한 경계를 다듬는다`

### 1. (Important) 확인 다이얼로그가 아무것도 보여주지 않은 채 확인 가능했던 문제

`datasets-page.tsx` 의 분봉 확인 Dialog는 `minutePlan`(coverage 쿼리 응답)만
보고 있었는데, coverage 쿼리에 `enabled` 게이트가 없어 쿼리가 아직 응답하지
않은 순간에는 `data`가 `undefined` → `minutePlan`이 `null` → 본문이 통째로
숨겨지면서도 "동기화 시작" 버튼은 그대로 활성 상태였다. 즉 사용자가 아무 것도
보지 못한 채 확인을 눌러 버릴 수 있었다 — 이 다이얼로그를 만든 이유 자체가
무너지는 경로였다.

고침: `useQuery`에서 `isLoading`을 함께 꺼내(`coverageLoading`) 세 가지
상태를 구분한다.
- 로딩 중(`coverageLoading === true`): "예상 규모를 계산하는 중입니다…"를
  보여주고 "동기화 시작" 버튼을 `disabled`로 잠근다.
- 로딩이 끝났고 `minutePlan`이 있음: 기존 계획 정보(수집 기간·예상 봉 수·권장
  기간·상한 초과 경고·소요 시간)를 보여준다.
- 로딩이 끝났는데도 `minutePlan`이 `null`(시장에 거래 세션 정의가 없어 계산
  자체가 불가능한, 로딩과는 다른 정상 상태): "이 시장은 예상 규모를 계산할 수
  없습니다."라고 알리고 — 계산 불가 자체가 막을 이유는 아니므로 — 진행은
  막지 않는다(버튼은 활성).

파일: `src/web/features/datasets/datasets-page.tsx`. 이 저장소에 `.tsx`
컴포넌트 단위 테스트 인프라가 없어(기존 상태) `pnpm typecheck`/`pnpm lint`/
`pnpm test:e2e`로 검증했다 — 전과 동일하게 7 passed, 1 skipped.

### 2. (Important) market-data → backtest 의존 방향 역전

`dataset-service.ts`가 `MAX_BACKTEST_BARS`를
`backtest/domain/bar-estimate.js`에서 직접 import해, 이 저장소 전반의 방향
(backtest 가 market-data 에 의존)과 반대로 흘렀다. dependency-cruiser 에 이
쌍을 막는 규칙이 없었던 것은 예상 못 한 사각지대였을 뿐, 의도된 허용이
아니었다.

고침:
- `src/server/shared/backtest-limits.ts` 신설 — `MAX_BACKTEST_BARS = 2_000_000`
  정의와 "왜 shared 에 있는지"(두 모듈 중 어느 쪽 domain 에도 두면 반대쪽이
  그 모듈에 의존하게 된다)를 문서화.
- `backtest/domain/bar-estimate.ts`는 이제 이 값을 정의하지 않고
  `export { MAX_BACKTEST_BARS } from '../../../shared/backtest-limits.js';`로
  재노출 — `backtest-routes.ts`·`backtest-child.ts`·기존
  `tests/unit/bar-estimate.test.ts` 등 기존 import 경로는 그대로 둔다.
- `dataset-service.ts`는 `../../../shared/backtest-limits.js`에서 직접
  import 하도록 변경 — 더는 backtest 모듈을 참조하지 않는다.

검증: `pnpm exec vitest run tests/architecture` 통과(market-data → backtest
의존이 완전히 사라졌으므로 이 규칙이 새로 필요하지도 않다),
`tests/unit/bar-estimate.test.ts` 그대로 통과(재노출 확인).

### 3. (Minor) `minuteBackfillFloorTsMs` 의 윤년 오버플로

`setUTCMonth`만으로 24개월을 당기면, 오늘이 2/29(윤년)이고 24개월 전 해가
평년이면 Date 객체가 "2월 29일"을 존재하지 않는 날로 보고 자동으로
3월 1일로 넘겨버렸다 — 상한이 조용히 하루 좁아지는 문제였다.

고침: 일자를 먼저 1일로 고정한 채 월만 옮기고(오버플로 없음), 도착한 달의
실제 마지막 날짜를 구해 원래 일자를 그 값으로 클램프하도록 재작성.

테스트 추가: `tests/unit/minute-backfill.test.ts`에
`Date.UTC(2028, 1, 29)`(2028-02-29, 윤년) → `Date.UTC(2026, 1, 28)`(2026년은
평년이라 2/28)로 클램프되는지 확인하는 케이스. 구현 전 실패
(`1772323200000`(3/1) ≠ `1772236800000`(2/28))를 확인한 뒤 고쳤고, 기존
회귀 테스트(2026-07-30, 2026-01-31 케이스)도 그대로 통과함을 재확인했다.

### 4. (Minor) 거래일 상수 주석 불일치 + 변수명 캐멀케이스

- `minute-backfill.ts`의 `MINUTE_BACKFILL_SYMBOL_YEARS` 주석이 "약
  245거래일/년"이라고 적어 뒀는데, 실제 계산에 쓰는
  `AVERAGE_TRADING_DAYS_PER_MONTH = 21`을 연 환산하면 252일이라 서로 어긋났다.
  주석을 "약 252거래일(월평균 21거래일 × 12개월, estimateMinuteBackfillBars
  의 가정과 동일)"로 고치고, 그에 맞춰 "95,500봉/종목·년 → 191만봉"이던 예시
  숫자도 "98,280봉/종목·년 → 196만봉"으로 재계산해 일치시켰다.
- `tests/integration/market-data.test.ts:250`의 지역 변수
  `kRSessionMinutesPerDay` → `krSessionMinutesPerDay`로 표준 캐멀케이스로
  변경.

## 리뷰 수정 후 최종 검증

- `pnpm exec vitest run tests/unit/minute-backfill.test.ts tests/architecture` — 15 passed
- `pnpm test` (전체) — 667 passed (리뷰 전 666 + 윤년 테스트 1건 추가)
- `pnpm typecheck` — clean
- `pnpm lint` — clean
- `pnpm test:e2e` — 7 passed, 1 skipped (변동 없음)

## 리뷰 수정 변경 파일

- `src/server/shared/backtest-limits.ts` (신규)
- `src/server/modules/backtest/domain/bar-estimate.ts`
- `src/server/modules/market-data/application/dataset-service.ts`
- `src/server/modules/market-data/domain/minute-backfill.ts`
- `src/web/features/datasets/datasets-page.tsx`
- `tests/unit/minute-backfill.test.ts`
- `tests/integration/market-data.test.ts` (변수명만)
