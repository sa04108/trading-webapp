# 웹 동기화에 재무 수집 옵션 붙이기 설계

날짜: 2026-07-29
관련: 스펙 §11 §13, 2026-07-28-broker-sync-design.md, 2026-07-29-quant-strategies-and-fact-store-design.md

## 목적

DART 재무 수집이 CLI 전용이다. `factSyncService` 를 부르는 곳은 `cli.ts` 하나뿐이고
HTTP 라우트가 없다 — 재무 전략을 제출하면 422 와 함께 "SSH 에서 `pnpm cli facts:sync`
를 실행하세요" 라는 안내가 나온다. 웹에서 데이터셋을 만든 사람이 백테스트를 돌리려면
서버에 접속해야 한다.

이 설계는 데이터셋 카드의 「동기화」 옆에 **「재무」 체크박스**를 두어 봉과 재무를 한
번에 받게 하고, 체크 여부에 따라 **예상 소요시간**을 미리 보여준다.

수집 정책(대화에서 확정):

- **연도 범위는 봉 커버리지에서 자동으로 뽑는다.** 백테스트는 봉이 있는 구간만 도니까
  재무도 그 구간만 있으면 충분하다. UI 에 연도 입력을 두지 않는다.
- **웹은 증분, CLI 는 임의 범위.** 웹 실행은 미수집 연도 + 현재 연도만 호출한다.
  과거 연도 정정공시 전체 재수집은 기존 `facts:sync --from --to` 가 담당한다.
- **재무 예상시간은 계산으로 정확히 나온다.** 봉은 페이지 수를 미리 알 수 없어
  직전 실행의 실측치를 참고치로 쓴다.

## 사용자 전제 정정

대화에서 "커버리지에 상장일이 나온다"는 전제가 있었으나, `data_coverage.firstTsMs`
(schema.ts:95)는 상장일이 아니라 **이미 수집된 첫 봉의 시각**이다. 상장일은 이
코드베이스 어디에도 없다 — 증권사 어댑터도 `symbol-info-service` 도 주지 않는다.

실용적으로는 이게 더 맞는 기준이다(백테스트가 도는 구간 = 봉이 있는 구간). 대신
**봉이 하나도 없는 새 데이터셋에서는 근거가 없다** — 그 경우를 아래 §2 가 다룬다.

## 1. 조립 — 모듈 경계를 지키면서 한 잡으로 묶기

`POST /datasets/sync` 에 `includeFacts?: boolean` 을 추가하고 **봉 → 재무 순서로 같은
잡 안에서** 돌린다. 잡 id 하나, 취소 하나, 폴링 하나 — "버튼 하나" 라는 요구에 맞고
기존 UI 의 잡 복구·다른 탭 재부착 경로를 그대로 쓴다.

`BrokerSyncService`(market-data)가 `FactSyncService`(facts)를 직접 import 하면 모듈이
엉킨다. **함수를 주입한다** — 이미 있는 관례다(`dataset-routes.ts:52-53` 의
`hasActiveBacktests` 가 같은 방식으로 backtest 모듈을 컨테이너에서 연결한다).

```ts
// BrokerSyncDeps 에 추가 — market-data 는 facts 를 import 하지 않는다
readonly factsPhase?: (args: {
  datasetId: string;
  fromYear: number;
  toYear: number;
  onProgress: (progress: FactPhaseProgress) => void;
  shouldStop: () => boolean;
}) => Promise<FactPhaseResult>;
```

연도 범위는 **BrokerSyncService 가 계산해서 넘긴다** — 봉 단계 직후 `refreshCoverage()`
를 부른 당사자이고, 커버리지·거래소 세션은 market-data 의 지식이다(§2). `symbols`·
연결/별도 기준·DART 호출은 factsPhase 클로저(컨테이너가 조립)가 결정한다. 결과적으로
market-data 는 DART 를, facts 는 커버리지를 서로 모른다.

라우트는 `includeFacts` 를 **선검증**한다. 재무 단계는 봉 뒤에 오므로, 40분 봉 수집을
끝낸 뒤 "DART 키가 없습니다" 로 실패하면 안 된다. `market !== 'KR'` 이거나
`DART_API_KEY` 미설정이면 즉시 400 + 이유.

`dependency-cruiser` 에 `market-data-no-facts` 규칙을 추가해 이 경계를 구조적으로
강제한다(기존 `market-data-no-broker` 와 같은 이유).

## 2. 연도 범위 — 봉 수집이 끝난 뒤 커버리지에서

봉 단계 직후 `refreshCoverage()` 가 갱신한 커버리지에서 범위를 뽑는다. market-data
도메인의 순수 함수로 둔다:

```ts
// market-data/domain 에 추가
export function deriveFactYearRange(
  coverage: readonly { firstTsMs: number | null; lastTsMs: number | null; barCount: number }[],
  market: Market,
): { fromYear: number; toYear: number } | null;
```

- 대상 = `barCount > 0` 인 커버리지 행
- `fromYear` = `min(firstTsMs)` 의 거래소 현지 연도, `toYear` = `max(lastTsMs)` 의 연도
- 현지 변환은 `getSessionForMarket(market).utcOffsetMinutes`(KR = +540,
  exchange-session.ts:17)를 쓴다 — `dart-report-parser.ts:112` 가 이미 같은 상수로
  접수일을 변환한다. 새 시간대 유틸을 만들지 않는다.
- 대상 행이 없으면 `null`

**호출자는 둘이고 같은 함수를 쓴다**: 실행 경로의 `BrokerSyncService`(§1), 추정 경로의
`factsSyncEstimator` 클로저(§7). 갈라지면 화면의 연도와 실제 수집 연도가 달라진다.

**비KR 은 `null` 이 아니라 던진다.** `deriveFactYearRange` 가 `getSessionForMarket` 을
부르므로 세션 미정의 시장에서는 `UnsupportedMarketSessionError` 가 올라온다. §1 의 라우트
선검증이 그 앞을 막지만, 잡 단계 안에서는 이 호출이 `factsPhase` 를 감싼 try 밖에 있어
예외가 `run` 의 catch 로 올라가 **봉 결과까지 실패로 덮는다** — 재무 단계가 throw 하지
않게 만든 이유(§5)가 여기서 무너진다. 지금은 US 데이터셋을 만들 수 없어(D-006) 도달하지
않지만, `runFactsPhase` 가 `market !== 'KR'` 을 `skipReason` 으로 먼저 거른다 — 그 가드로
방어선을 닫았다 (2026-07-30 리뷰, 같은 날 반영). DART 는 국내 공시 기관이므로 이 가드는
예외 방어만이 아니다: 세션이 정의되는 날 봉 단계가 통과하면서 국내 공시를 외국 종목에
붙이는 경로가 살아난다.

**`null` 이면**(봉이 하나도 없으면) 재무 단계를 건너뛰고 `facts_json.skipReason` 에
`'봉이 수집되지 않아 재무 연도 범위를 정할 수 없습니다'` 를 기록한다. 잡은 봉 단계
결과에 따라 COMPLETED 로 끝나되 UI 가 이 사유를 경고로 띄운다 — 조용히 0건으로 끝나면
사용자는 재무를 받았다고 믿는다.

## 3. 증분 추적

`FactSyncService` 는 멱등하지만 **매번 전 연도를 다시 호출한다.** 증분이 없으면
체크박스를 켠 채로 두는 사용자는 매주 45분을 쓴다.

### 저장

`broker_sync_state` 와 같은 모양의 새 테이블:

```sql
CREATE TABLE dataset_facts_state (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  dataset_id         TEXT NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
  symbol             TEXT NOT NULL,
  covered_years_json TEXT NOT NULL,   -- number[] 오름차순
  updated_at_ms      INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_dataset_facts_state_dataset_symbol
  ON dataset_facts_state (dataset_id, symbol);
```

**연도 목록**이지 범위가 아니다. CLI 로 2010–2012 를 받고 웹으로 2019–2026 을 받으면
커버리지는 불연속이 된다 — 범위 두 개로 접으면 2013–2018 을 수집했다고 거짓말한다.

`FactSyncService` 가 **종목을 저장한 직후** 그 종목의 완료 연도를 기록한다. 저장과
같은 지점이라 180/200 에서 중단된 실행도 정확히 이어받는다.

### 수집 계획 — 순수 함수 하나로

추정치와 실제 실행이 같은 규칙을 써야 한다. 둘이 갈라지면 화면의 숫자가 조용히
틀려진다. 계획을 순수 함수로 뽑는다:

```ts
// src/server/modules/facts/domain/sync-plan.ts
export type FactSyncMode = 'FULL' | 'INCREMENTAL';

export interface FactSyncPlan {
  /** 종목 → 재무·자본변동을 수집할 연도 (오름차순) */
  readonly yearsBySymbol: ReadonlyMap<string, readonly number[]>;
  /** 종목 → 주식총수를 읽을 연도 (= 위 + **각 연도의** 직전 1년) */
  readonly shareYearsBySymbol: ReadonlyMap<string, readonly number[]>;
  readonly calls: number;
  readonly estimatedMs: number;
  readonly overDailyLimit: boolean;
}

export function planFactSync(args: {
  symbols: readonly string[];
  fromYear: number;
  toYear: number;
  currentYear: number;
  coveredBySymbol: ReadonlyMap<string, readonly number[]>;
  mode: FactSyncMode;
}): FactSyncPlan;
```

규칙:

- `FULL` — `Y_s = [fromYear..toYear]` (수집 이력 무시). CLI 가 쓴다.
- `INCREMENTAL` — `Y_s = ([fromYear..toYear] \ covered_s) ∪ ({currentYear} ∩ [fromYear..toYear])`.
  현재 연도는 항상 다시 읽는다 — 분기 보고서가 그 안에서 갱신된다.
- **주식총수 연도 = `Y_s ∪ { y − 1 : y ∈ Y_s }`.** 아래 근거 참고.
- **중복 심볼은 한 번만 계획한다** — 호출 수가 부풀면 예상 시간도 부푼다.

> **해결 (2026-07-30 리뷰 → 같은 날 반영):** 중복이 섞이면 어댑터가
> `fnlttSinglAcntAll`·`irdsSttus` 를 다시 쏘고(`stockTotqySttus` 만 `shareRowsCache` 로
> 걸린다) 실제 호출이 `plan.calls` 를 넘어 이 절의 전제("추정치와 실제 실행이 같은 규칙")가
> 깨졌다. **두 곳에서 접는다:**
>
> - `FactSyncService.sync` 가 `[...new Set(request.symbols)]` 을 순회한다. 진행 콜백의
>   `total`, 중단 로그의 `symbolTotal`, 중단 메시지의 분모도 고유 종목 수다 — 중복을 세면
>   진행률이 100% 에 닿지 않고 끝난다. CLI 가 인자로 중복을 넘겨도 여기서 닫힌다.
> - `createBrokerDataset` 이 `symbols_json` 을 저장할 때 접는다 —
>   `updateSymbols`·`importCsv` 가 이미 쓰는 관례다.
>
> `POST /datasets` 의 `z.array` 에 uniqueness refine 은 **두지 않는다.** 중복은 무해한
> 입력이고 접은 결과가 모호하지 않다 — 400 은 알려줄 것 없는 거부다.

### 주식총수를 한 해 더 읽는 이유

`fetchCorporateActions` 는 `sharesBefore(dateKey)`
(dart-fact-source.ts:298-305)로 **이벤트 직전 발행주식수**를 찾아 분할 비율을 만든다.
그 시계열은 `stockTotqySttus` 응답의 접수일로 채워진다. 증분 실행이 올해만 긁으면
연초 이벤트의 앵커가 사라져 비율이 조용히 gap 이 된다.

`bsns_year = Y−1` 를 읽으면 접수일이 Y−1 년 5·8·11월과 **Y 년 3월**(사업보고서)에
찍힌 항목 4개가 들어온다 — 연초 이벤트까지 앵커가 확보된다.

**앵커는 모든 연도에 붙인다 — 첫 연도만으로는 부족하다.** (2026-07-29 리뷰에서 정정.
초안은 `min(Y_s) − 1` 하나만 읽게 했다.) `Y_s` 가 연속이라는 보장이 없고, INCREMENTAL
이 바로 불연속을 만드는 경로다:

> 이력이 `{2021..2025}` 인 데이터셋에 웹이 2019–2026 을 증분 요청하면 `Y_s =
> [2019, 2020, 2026]` 이다. 첫 연도만 앵커하면 주식총수를 `[2018, 2019, 2020, 2026]`
> 에서만 읽어 2021–2025 가 통째로 빈다. 2026-02-10 에 공시된 분할은 `sharesBefore` 가
> 2020 년 사업보고서(접수 ~2021-03) 값을 집어 **5년 지난 주식수**로 비율을 계산한다.
> `parseIssuanceRows` 는 직전값이 `null` 일 때만 gap 을 남기므로, 값이 있으면서 틀린
> 이 경우는 **조용히 잘못된 비율**이 되고 adjusted-price 가 그것을 전 구간에 곱한다.

`Y_s` 가 연속이면 이 규칙은 `min(Y_s) − 1` 과 같은 결과이고 추가 호출이 0이다 — 첫
실행과 단일 연도 증분은 영향을 받지 않는다. 비용은 **불연속 구간 수 × 4호출**이다.

이 규칙은 `FULL` 에도 똑같이 적용한다. 규칙이 하나여야 테스트가 하나이고, 첫 실행에서도
`fromYear` 연초 이벤트의 앵커가 생겨 정합성이 나아진다(현재는 그 이벤트가 gap 이 된다).

### 포트 변경

`FetchFinancialsRequest` 의 `fromYear`/`toYear` 를 **연도 목록**으로 바꾼다:

```ts
export interface FetchFinancialsRequest {
  readonly symbols: readonly string[];
  /** 재무·자본변동을 읽을 연도 */
  readonly years: readonly number[];
  /** 주식총수를 읽을 연도 (years + 직전 1년) */
  readonly shareYears: readonly number[];
  readonly consolidated: boolean;
}
```

불연속 연도를 범위 두 값으로 표현하는 허구를 없앤다. `dart-fact-source` 의
`for (let year = from; year <= to; ...)` 세 곳이 `for (const year of ...)` 로 바뀐다.

`FactSyncRequest`(애플리케이션 입력)는 `fromYear`/`toYear` + `mode` 를 유지한다 —
CLI 인자 모양이 그대로 남고, 연도 목록 전개는 `planFactSync` 가 맡는다.

## 4. 예상 시간

```ts
// src/server/modules/facts/domain/sync-plan.ts
/** 종목·연도당 DART 호출: fnlttSinglAcntAll 4 + stockTotqySttus 4 + irdsSttus 1 */
export const DART_CALLS_PER_SYMBOL_YEAR = 9;
/** 주식총수 앵커 1년치 (§3) */
export const DART_SHARE_ANCHOR_CALLS = 4;
/** RestClient 그룹 최소 간격 — dart-fact-source 가 이 상수를 쓴다 */
export const DART_MIN_INTERVAL_MS = 120;
/** DART OpenAPI 일일 호출 한도 */
export const DART_DAILY_CALL_LIMIT = 40_000;
```

`calls = Σ_s (|Y_s| × 9 + (|S_s| − |Y_s|) × 4)`, `estimatedMs = calls × 120`.

`S_s` 는 §3 의 주식총수 연도(`Y_s ∪ { y − 1 : y ∈ Y_s }`)이고, `|S_s| − |Y_s|` 가 곧
**연속 구간 수** — 즉 앵커 수다. `Y_s` 가 연속이면 구간이 하나라 `|Y_s| × 9 + 4` 로
접히고, 아래 표가 모두 그 경우다. (2026-07-30 리뷰에서 정정. 초안의
`(|Y_s| > 0 ? 4 : 0)` 는 §3 이 앵커를 구간마다로 바꾸기 전의 식이라 불연속 구간에서
실제 호출 수보다 작게 나왔다.)

**`dart-fact-source.ts` 의 `groupMinIntervalMs` 를 `DART_MIN_INTERVAL_MS` 에서 가져오게
바꾼다.** 그러지 않으면 rate limit 을 조정했을 때 화면의 추정치만 조용히 틀려진다.
infra → domain 방향이므로 §7 의존 규칙에 맞다.

규모 감각(200종목):

| 실행 | 연도 | 호출 | 예상 |
|---|---|---|---|
| 첫 실행 | 12년 | 22,400 | 약 45분 |
| 첫 실행 | 8년 | 15,200 | 약 30분 |
| 증분 | 현재 연도만 | 2,600 | 약 5분 |

`overDailyLimit = calls > DART_DAILY_CALL_LIMIT`. 한도 40,000 은 사용자가 확정한 값이다.
`fact-sync-service.ts:53` 의 "일 한도 20,000" 주석은 40,000 으로 고친다 —
`dart-fact-source.ts:86` 의 "4만" 과 어긋나 있어 어느 쪽을 믿을지 알 수 없다.

## 5. 잡 진행 상태

`data_import_jobs` 에 컬럼 3개를 추가한다.

| 컬럼 | 용도 |
|---|---|
| `phase TEXT` | `CANDLES` \| `FACTS` — 45분 잡의 현재 단계 |
| `candles_ms INTEGER` | 봉 단계만의 소요시간. §6 참고치의 근거 |
| `facts_json TEXT` | 재무 단계 진행·결과 |

`*Json` 컬럼은 이미 이 스키마의 관례다(`symbolsJson`·`missingRangesJson`·`requestJson`).

```ts
interface FactsJobState {
  fromYear: number | null;
  toYear: number | null;
  symbolsDone: number;
  symbolTotal: number;
  savedFacts: number;
  gapCount: number;
  /** 중단 사유 (FactSyncReport.failureMessage) */
  failureMessage: string | null;
  /**
   * 재무 단계를 **시작조차 하지 않은** 사유. 두 갈래다 — 봉이 없어 연도 범위를 못 정한
   * 경우(§2)와 `factsPhase` 가 주입되지 않은 경우(DART 키 미설정). 후자는 §7 의 라우트
   * 선검증이 400 으로 막으므로 정상 경로에서는 나오지 않는 방어선이다.
   */
  skipReason: string | null;
}
```

`facts_json` 이 null 이면 재무를 요청하지 않은 잡이다 — 별도 플래그 컬럼을 두지 않는다.
`symbolsDone`·`savedFacts`·`gapCount` 는 **종목마다 갱신**한다(이미 있는
`FactSyncHooks.onSymbolDone` 훅). 조용한 45분은 멈춘 것과 구분되지 않는다.

### 취소

`FactSyncHooks` 에 `shouldStop?(): boolean` 을 추가해 **종목 경계**에서 확인한다 —
봉 쪽이 페이지 경계에서 확인하는 것과 같은 입자다. 저장은 종목 단위이므로 취소
지점까지의 팩트와 `covered_years_json` 이 남아 재실행이 이어받는다.

`FactSyncReport` 에 `stopReason: 'ERROR' | 'CANCELLED' | null` 을 추가한다. 잡 상태를
`FAILED` / `CANCELLED` 로 갈라야 하고, 지금은 `stoppedAtSymbol` 만으로 둘을 구분할 수
없다. CLI 는 `shouldStop` 을 넘기지 않으므로 동작이 그대로다.

## 6. 봉 참고치

계산으로는 안 나온다 — 키움 차트 API 는 호출당 350ms 최소 간격이지만
(`kiwoom-market-data-source.ts:65`) 페이지당 봉 수와 보관 깊이를 미리 알 수 없다.
대신 **직전 실행의 실측치**를 쓴다.

```sql
SELECT candles_ms FROM data_import_jobs
WHERE dataset_id = ? AND source_type = 'BROKER'
  AND candles_ms IS NOT NULL
  AND created_at_ms > (SELECT MAX(backfill_done_at_ms) FROM broker_sync_state
                       WHERE dataset_id = ?)
ORDER BY created_at_ms DESC LIMIT 1;
```

정렬 기준은 `created_at_ms` 다. 같은 데이터셋의 BROKER 잡은 겹칠 수 없으므로
(`startSync` 가 `SyncAlreadyRunningError` 로 막는다) 시작 순서가 곧 종료 순서이고,
`completed_at_ms` 는 nullable 이라 정렬 기준으로 쓰면 값이 없는 행에서 순서가 흔들린다.
(초안은 `completed_at_ms` 였다 — 구현이 이 근거로 바꿨다.)

**`status = 'COMPLETED'` 조건은 두지 않는다** (2026-07-30 리뷰에서 정정. 초안에는 있었다.)
재무 단계가 멈추면 잡은 `FAILED`/`CANCELLED` 로 적히는데 그때도 봉 단계는 이미 끝나
`candles_ms` 가 측정돼 있다(`broker-sync-service.ts` 의 `run`). 상태로 거르면 DART 오류
하나가 멀쩡한 봉 실측치를 버리고 예상치가 `UNKNOWN` 으로 남는다 — `candles_ms` 를 잡
전체 소요시간과 분리한 이유가 상태 필터를 통해 그대로 되돌아온다.

`candles_ms IS NOT NULL` 자체가 이미 "봉 단계가 끝까지 갔다" 를 함의한다. 봉 도중에
죽은 잡은 이 값을 남기지 않는다(`candlesMs` 는 `refreshCoverage` 직후에만 채워진다).

> **코드가 이 정정을 따른다 (2026-07-30).** `getCandleSyncEstimate` 에서
> `eq(dataImportJobs.status, 'COMPLETED')` 를 걷고, 그 동작을 고정하던
> `candle-sync-estimate.test.ts` 의 `'실패한 잡은 쓰지 않는다'` 는 FAILED·CANCELLED
> 실측치를 쓰는 테스트 둘로 바꿨다. 봉 도중에 죽어 `candles_ms` 가 없는 잡을 여전히
> 건너뛴다는 테스트가 아래 함의를 지킨다.

두 개의 문턱이 있다:

1. **전 종목이 백필 완료 상태여야 한다** (`broker_sync_state.backfill_done_at_ms` 가
   데이터셋의 모든 심볼에 대해 non-null). 첫 백필과 증분은 소요시간이 자릿수로 다르다.
2. **백필 완료 이후에 시작된 잡이어야 한다** (`created_at_ms >` 조건). 백필을 포함한
   실행의 소요시간을 증분 예상치로 쓰면 과대 추정이 된다.

`candles_ms` 를 따로 두는 이유: 잡 전체 소요시간에는 재무 단계가 섞여 있어 봉
참고치로 쓸 수 없다.

조건을 만족하는 잡이 없으면 참고치를 표시하지 않는다. 종목 수가 달라졌어도 보정하지
않는다 — 참고치라고 이름 붙이고 그대로 보여준다.

## 7. API

### `GET /datasets/:datasetId/coverage` — 응답에 추가

```ts
export interface SyncEstimate {
  readonly candles: { basis: 'LAST_RUN'; ms: number } | { basis: 'UNKNOWN' };
  readonly facts: FactsSyncEstimate;
}

export type FactsSyncEstimate =
  | { basis: 'UNSUPPORTED'; reason: string }
  | { basis: 'AFTER_CANDLES' }
  | { basis: 'PLANNED'; fromYear: number; toYear: number;
      calls: number; estimatedMs: number; overDailyLimit: boolean };
```

응답 필드 이름은 `syncEstimate: SyncEstimate` 다.

- `UNSUPPORTED` — 비KR 데이터셋 또는 DART 키 미설정. `reason` 이 그대로 UI 에 뜨고,
  체크박스가 disabled 된다.
- `AFTER_CANDLES` — 봉 커버리지가 비어 있어 연도 범위를 아직 모른다.
- `PLANNED` — `planFactSync(mode: 'INCREMENTAL')` 결과.

카드가 이미 이 쿼리를 돌리므로 요청이 늘지 않는다. `DatasetSummary` 는 건드리지
않는다 — 체크박스 활성 여부는 `facts.basis` 로 판단한다.

market-data 라우트가 facts 를 계산할 수는 없으므로, 컨테이너가 함수를 주입한다
(`hasActiveBacktests` 와 같은 방식). 이 함수가 돌려주는 것이 위 `syncEstimate.facts`
그 자체다 — `syncEstimate.candles` 는 market-data 가 §6 쿼리로 채운다.

```ts
factsSyncEstimator: (datasetId: string) => FactsSyncEstimate
```

클로저는 `deriveFactYearRange`(§2) → `planFactSync(mode: 'INCREMENTAL')`(§3) 순으로
부른다. 실행 경로와 같은 두 함수다.

### `POST /datasets/sync` — 바디에 추가

```ts
{ datasetId: string; includeFacts?: boolean }
```

`includeFacts === true` 이고 `factsSyncEstimator(datasetId).basis === 'UNSUPPORTED'`
이면 400 + 그 `reason`. 같은 주입 함수를 재사용하므로 판정 로직이 한 곳에 있다.

## 8. UI

```
┌─ 코스피 대형주   KR  1m→1h  v3 ─────────────────────┐
│                     ☑ 재무 ⓘ    [⟳ 동기화] [🗑 삭제] │
│  봉 약 6분 (직전 실행 기준) + 재무 2019~2026년 · 약 30분 │
└──────────────────────────────────────────────────────┘
```

### 체크박스

라벨은 **「재무」** 한 단어. 설명은 툴팁으로 옮긴다.

> 이 데이터셋 종목의 재무제표까지 함께 받습니다.
> 국내(KR) 종목만 가능합니다 — DART 는 국내 공시 기관입니다.
> 봉만 받는 것보다 오래 걸립니다 — 아래 예상 시간을 확인하세요.

가운데 줄은 **`UNSUPPORTED` 여부와 무관하게 항상** 보인다. 미지원일 때만 띄우면 KR
데이터셋에서는 "재무가 국내 전용" 이라는 사실이 아예 드러나지 않는다
(2026-07-29-market-support-disclosure-design.md §4).

`TooltipProvider` 는 `app.tsx:13` 에 이미 있다. 트리거 아이콘·문구 배치는
`param-hint.tsx` 를 따른다(같은 "설명은 툴팁으로" 패턴).

`src/web/components/ui/checkbox.tsx` 가 없으므로 추가한다 — `radix-ui` 통합
패키지에서 `Checkbox` 를 가져오는 기존 shadcn 관례(`tooltip.tsx:2` 와 동일)를 따른다.

**기본값은 해제이고 기억하지 않는다.** 체크 상태를 저장하면 데이터셋을 갱신할 때마다
의도 없이 45분 작업이 걸린다.

### 예상 시간 줄

`syncEstimate` 와 체크 상태의 조합으로 한 줄을 만든다.

| 상태 | 문구 |
|---|---|
| 체크 해제 + `candles.LAST_RUN` | `봉 약 6분 (직전 실행 기준)` |
| 체크 해제 + `candles.UNKNOWN` | `첫 수집은 소요 시간을 예측할 수 없습니다` |
| 체크 + `facts.PLANNED` | `… + 재무 2019~2026년 · 약 30분` |
| 체크 + `facts.PLANNED` (증분) | `… + 재무 2026년 갱신 · 약 5분` |
| 체크 + `facts.AFTER_CANDLES` | `… + 재무 범위는 봉 수집 후 결정됩니다` |
| `facts.UNSUPPORTED` | 체크박스 disabled + `reason` |
| `overDailyLimit` | 경고색 + `DART 일일 한도(40,000회)를 넘습니다 — 남은 구간은 다음 날 이어받으세요` |

`overDailyLimit` 은 **경고일 뿐 실행을 막지 않는다.** 한도에 실제로 걸리면 DART 가
오류 status 를 돌려주고 `FactSyncService` 가 중단 지점을 리포트한다 — 저장분은 남고
`covered_years_json` 이 이어받게 한다. 미리 차단하면 한도가 남았는데도 못 돌리는 경우가
생긴다(추정치는 이 데이터셋의 호출 수만 알고 그날 다른 실행이 쓴 양은 모른다).

`fromYear === toYear` 면 `2026년 갱신`, 아니면 `2019~2026년` 으로 쓴다.

### 진행 중 · 완료

- `phase === 'CANDLES'`: `봉 수집 중…`
- `phase === 'FACTS'`: `재무 수집 중 · 12/200종목 · 1,234건`
- 완료 토스트: `동기화 완료: 코스피 대형주 · 1,234봉 · 재무 5,678건 (누락 90건)`
- `facts_json.skipReason` 이 있으면 완료 토스트 대신 경고 토스트로 그 사유를 띄운다.
- `facts_json.failureMessage` 가 있으면 잡이 FAILED 이고 그 메시지가 그대로 뜬다
  (이어받는 방법이 이미 문구에 들어 있다).

누락(gap) 목록 자체는 UI 에 싣지 않는다 — 첫 실행에서 수천 건이 나오고, 대부분은
"매핑되지 않은 계정"(전략이 쓰지 않는 계정)이다. 건수만 보여주고 상세는 CLI 가 이미
사유별로 묶어 출력한다.

## 9. 테스트

- `planFactSync` 단위 — FULL/INCREMENTAL, 불연속 covered years, 현재 연도 항상 포함,
  주식총수 앵커 연도(**연속 구간마다** 직전 1년), 불연속이면 앵커 호출이 구간 수만큼
  늘어나는지, 중복 심볼을 한 번만 계획하는지, 호출 수·예상 시간, 한도 초과 경계
- `deriveFactYearRange` 단위 — KST 연말/연초 경계, `barCount === 0` 만 있는 경우,
  커버리지 없음 → `null`
- `dart-fact-source` 단위 — `years`/`shareYears` 포트 변경 후 불연속 연도 요청,
  `shareRowsCache` 가 두 단계에 걸쳐 여전히 공유되는지
- `FactSyncService` 단위 — 종목 저장 직후 `covered_years_json` 기록, `shouldStop` 에서
  중단 시 `stopReason === 'CANCELLED'` + 앞선 종목 기록 유지
- `BrokerSyncService` 단위 — 재무 단계 호출, `phase`·`candles_ms`·`facts_json` 전이,
  재무 단계 실패가 봉 결과를 지우지 않음, 봉 0건일 때 `skipReason`
- 라우트 단위 — `includeFacts` + 비KR → 400, DART 키 없음 → 400,
  `syncEstimate` 세 가지 basis 직렬화
- 봉 참고치 쿼리 단위 — 백필 미완료면 `UNKNOWN`, 백필 완료 이전 잡은 제외,
  `candles_ms` 없는 옛 잡은 제외
- 기존 `fact-sync-service.test.ts`·`dart-fact-source.test.ts` 회귀 — CLI 경로 무변경
- e2e — 체크박스 토글 시 예상 시간 문구가 바뀌고, 툴팁이 뜨고, 비KR 데이터셋에서
  disabled 인지

## 10. 마이그레이션

`pnpm db:generate` 로 두 변경을 만든다 (drizzle-kit 이 한 파일에 담는다 — 실제 산출물은
`migrations/0003_ancient_tyrannus.sql` 하나다):

1. `data_import_jobs` + `phase`, `candles_ms`, `facts_json` (전부 nullable — 기존 행은
   그대로 남고 UI 는 null 을 "재무 미요청" 으로 읽는다)
2. `dataset_facts_state` 테이블

기존 데이터에 대한 백필은 없다. 이미 CLI 로 재무를 받은 데이터셋은
`dataset_facts_state` 가 비어 있어 첫 웹 실행이 전 구간을 다시 받는다 — 멱등하므로
결과는 같고, 그 이후부터 증분이 걸린다. 잘못된 커버리지를 추측해 심는 것보다 낫다.

## 범위에서 뺀 것

- **연결/별도(CFS/OFS) 선택** — 웹은 CFS 고정. CLI `--fs-div` 가 남아 있다.
- **재무 전용 실행** — 봉 없이 재무만 받는 경로. 연도 범위가 봉 커버리지에서 나오므로
  의미가 없다.
- **gap 상세 UI** — 건수만. 상세는 CLI.
- **거시 지표(`FactScope.MACRO`)·US 재무(SEC EDGAR)** — 기존 범위 밖 그대로.
- **계정 매핑 확장** — `dart-account-map.ts` 는 손대지 않는다. PER/PBR/ROE 같은 지표는
  별도 작업이다.
