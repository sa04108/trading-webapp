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
- market-data → backtest 모듈 간 새 의존성(`MAX_BACKTEST_BARS` import)이
  생겼다. 아키텍처 테스트는 통과하지만, 두 모듈이 향후 계층 규칙을 더 엄격히
  가져갈 경우 이 참조를 포트로 역전할지 검토가 필요할 수 있다.
