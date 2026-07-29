# 정량 전략 2종 추가 + PIT 팩트 스토어

날짜: 2026-07-29

## 문제

등록된 전략은 `hourly-breakout` 하나다. 이 전략은 봉만 본다 —
`StrategyBarContext` 가 제공하는 것은 `bars` · `getHistory(symbol)` ·
`portfolio` · `rng` 뿐이고, 재무제표·거시 지표에 접근할 채널이 없다. 데이터
계층도 `CandleRepository`(Parquet, 데이터셋 격리) 와 `StockInfoSource`(코드 → 이름)
두 개가 전부다.

정량 전략은 차트만으로 성립하지 않는다. PER·PBR·ROE·EBITDA 같은 재무 지표,
그리고 금리·환율 같은 외적 요인이 필요하다. 다만 그 데이터 파이프라인을 먼저
설계하면 "무엇을 위한 데이터인가" 가 비어 있다. 그래서 순서를 뒤집는다 —
**대표 전략 2개를 먼저 확정하고, 그 전략이 실제로 요구하는 데이터만 설계한다.**

## 결정

두 전략은 **서로 다른 축을 하나씩** 확장한다.

| 전략 | 확장하는 축 | 새 데이터 |
|---|---|---|
| `cross-sectional-momentum` | 횡단면 랭킹 + 캘린더 리밸런스 | 분할 이력만 |
| `value-quality-rank` | 상장시점(PIT) 재무제표 | 재무 계정 전체 |

중복이 없고, 각각이 엔진의 다른 한계를 드러낸다. 모멘텀은 엔진의
멀티심볼·리밸런스 경로를, 밸류는 재무 데이터 채널을 요구한다.

### 확정된 선택

- **PIT 엄격도**: 상장시점 정확 — 공시 접수일을 기록한다. 근사(분기말 + 45일)
  아님. DART 가 접수일을 주므로 KR 은 구현 가능하다.
- **유니버스**: 요청의 `symbols` 목록 그대로. 상한만 50 → 200 확대. 시점별
  지수 구성 스냅샷은 범위 밖.
- **데이터 추상화**: 범용 PIT 장(long) 포맷 저장 + 도메인별 타입 있는 접근자.
- **시장 범위**: KR 만. DART OpenAPI. US 재무는 범위 밖.
- **분할 보정**: DART 증자·감자 현황으로 분할 이력을 수집해 신호 계산에만
  적용한다. 배당은 미보정.

### 이번 범위가 아닌 것

거시 지표 수집(스키마는 수용하되 수집 안 함 — 이 전략 2개가 쓰지 않는다),
시점별 지수 구성 종목, 생존편향 제거, 배당 보정, US 재무제표, 업종 분류.

---

## 1. 전략 A — `cross-sectional-momentum` (횡단면 모멘텀)

매월 첫 거래일, 유니버스 전 종목의 12-1개월 수익률을 랭킹해 상위 N 을
동일가중 보유한다. 나머지는 전량 청산한다. 학계·업계 표준 팩터이고 재현
가능하다.

소비 timeframe 은 `1d`.

### 파라미터

```ts
export const crossSectionalMomentumParameters = z.object({
  formationDays: z.number().int().min(20).max(756).default(252),
  skipDays:      z.number().int().min(0).max(63).default(21),
  topN:          z.number().int().min(1).max(50).default(10),
  rebalanceMonths: z.number().int().min(1).max(12).default(1),
  absoluteMomentumFilter: z.boolean().default(true),
});
```

한국어 라벨·설명은 `hourly-breakout` 과 같이 `.meta({ title, description })`
에 둔다. 위저드가 JSON 스키마의 `title`/`description`/`default` 를 그대로 읽고,
`strategySourceHash` 는 이 두 필드를 제외한다.

### 신호

```
score(symbol) = adjClose[t - skipDays] / adjClose[t - skipDays - formationDays] - 1
```

`adjClose` 는 분할 보정 종가(§3.4). `getHistory(symbol)` 을 뒤에서 인덱싱하고,
이력이 `formationDays + skipDays` 미만인 종목은 후보에서 제외한다.
`absoluteMomentumFilter` 가 참이면 `score ≤ 0` 인 종목은 상위 N 안에 들어도
제외한다 — 그만큼 현금으로 남는다.

수량은 `floor(equity / topN / price)`.

### 2단계 리밸런스 (엔진 마찰 회피)

리밸런스 봉에서 매도와 매수를 동시에 내면 엔진의 리스크 체크
(`engine.ts:265` — `positions.size + pendingNewBuySymbols.size >= maxPositions`)
에 걸린다. 청산 주문을 낸 포지션도 체결 전까지는 `positions` 에 남아 카운트되기
때문에, `topN` 과 `maxPositions` 가 같으면 전량 회전이 막힌다.

**엔진을 고치지 않는다.** 대신 리밸런스를 두 봉에 나눈다:

1. 리밸런스 봉 — 탈락 종목 전량 매도만 낸다. 유지 종목은 건드리지 않는다.
2. 다음 봉 — 신규 편입 종목을 매수한다.

실제 대금 결제에도 부합하고, 엔진 변경이 0이다.

### 상태

```ts
interface CrossSectionalMomentumState {
  /** 'YYYY-MM' (KST). exchange-session 의 시간대 헬퍼 재사용 */
  lastRebalanceMonthKey: string | null;
  /** 매도 봉의 다음 봉에서 실행할 편입 목록 */
  pendingBuys: readonly string[] | null;
  /** 미체결 진입 — 중복 주문 방지 */
  entryPending: Set<string>;
}
```

리밸런스 트리거는 `lastRebalanceMonthKey` 가 `null`(최초 실행) 이거나,
`monthKey(tsMs, KST)` 가 그것과 다르면서 경과 개월 수가 `rebalanceMonths` 이상일
때다. 즉 "새 달의 첫 거래일" 이며, 휴장일 캘린더를 따로 알 필요가 없다. 최초
실행은 이력이 충분해진 첫 봉에서 일어난다 — 그 전에는 후보가 비어 아무것도 하지
않는다.

---

## 2. 전략 B — `value-quality-rank` (밸류·퀄리티 랭킹)

분기 첫 거래일, 두 지표를 각각 순위 매겨 합산하고 합이 작은 상위 N 을
동일가중 보유한다 (Greenblatt Magic Formula 계열).

- **이익수익률** = TTM EBIT ÷ EV
  - EV = 시가총액 + 총차입금 − (현금및현금성자산 + 단기금융상품)
  - 총차입금 = 단기차입금 + 유동성장기부채 + 사채 + 장기차입금
  - 시가총액 = **봉 종가 × PIT 발행주식수** — 매 봉 재계산
- **자본수익률(ROC)** = TTM EBIT ÷ (순운전자본 + 유형자산)
  - 순운전자본 = `max(유동자산 − 유동부채, 0)`

순위는 두 지표 모두 **큰 값이 1위**다. 두 순위를 더해 합이 작은 상위 N 을
고른다. 동점은 심볼 코드 오름차순으로 깬다 — 재현성 요구다.

TTM EBIT ≤ 0 인 종목은 제외한다 (원 규칙, 파라미터가 아니다). EV ≤ 0 인 종목,
TTM 4개 분기가 채워지지 않은 종목도 후보에서 빠진다.

### 비율을 저장하지 않는 이유

PER·PBR·이익수익률은 가격의 함수다. 가격은 매일 변한다. 비율을 팩트로 저장하면
어느 시점 가격으로 계산된 값인지 알 수 없고 봉 가격과 어긋난다. 따라서
**원자료(영업이익·자본총계·EBIT·순부채·발행주식수)만 저장하고 비율은 봉 시점에
계산한다.**

### 파라미터

```ts
export const valueQualityRankParameters = z.object({
  topN:            z.number().int().min(1).max(50).default(20),
  rebalanceMonths: z.number().int().min(1).max(12).default(3),
  staleQuarters:   z.number().int().min(1).max(8).default(2),
});
```

`staleQuarters` — 최신 공시의 기준분기가 현재로부터 N분기 넘게 낡으면 제외한다.
관리종목·상장폐지 직전 종목이 랭킹 상위에 오르는 것을 막는다.

연결(CFS)/별도(OFS)는 전략 파라미터가 아니라 **수집 시점 선택**이다
(`facts:sync --fs-div`). `Fact` 의 키는 `(scope, key, field, periodKey, asOfTsMs)`
이므로 같은 계정의 두 기준을 함께 담으면 서로를 덮어쓴다. 필드 이름에 접미사를 붙여
유니온을 두 배로 늘리는 대안은 모든 조회 지점을 분기시키므로 택하지 않았다.
데이터셋 하나는 한 기준만 담는다.

리밸런스는 전략 A 와 같은 2단계 방식을 쓴다. 두 전략이 공유하는 로직이므로
순수 헬퍼로 뽑는다 (§5).

### 금융업 제외는 유니버스 책임

은행·보험은 EV 개념이 성립하지 않아 원 규칙이 금융업을 제외한다. 업종 분류
데이터가 없고 (`StockInfo` 는 `market` 만 가진다) 이를 위해 팩트 스키마에 업종을
넣는 것은 YAGNI 다. **유니버스 구성 시 제외하는 것을 문서화한다.**

### 필요한 계정

영업이익 · 유동자산 · 유동부채 · 유형자산 · 현금및현금성자산 · 단기금융상품 ·
단기차입금 · 유동성장기부채 · 사채 · 장기차입금 · 발행주식수.

---

## 3. PIT 팩트 스토어 — 신규 모듈 `src/server/modules/facts/`

### 3.1 도메인

```ts
// domain/fact.ts
export type FactScope = 'SYMBOL' | 'MACRO';

export interface Fact {
  readonly scope: FactScope;
  /** SYMBOL 이면 종목코드, MACRO 이면 지표 키 (예: 'KR_BASE_RATE') */
  readonly key: string;
  readonly field: string;
  /** 기준 기간. '2025Q1' | '2025FY' | '2025-03-14'(시점성 이벤트) */
  readonly periodKey: string;
  /** 이 값이 세상에 알려진 시각 — PIT 컷오프 기준 */
  readonly asOfTsMs: number;
  readonly value: number;
  readonly unit: string; // 'KRW' | 'SHARES' | 'RATIO'
}

export type FundamentalField =
  | 'OPERATING_INCOME'
  | 'CURRENT_ASSETS' | 'CURRENT_LIABILITIES' | 'TANGIBLE_ASSETS'
  | 'CASH_AND_EQUIVALENTS' | 'SHORT_TERM_INVESTMENTS'
  | 'SHORT_TERM_BORROWINGS' | 'CURRENT_LONG_TERM_DEBT'
  | 'BONDS' | 'LONG_TERM_BORROWINGS'
  | 'SHARES_OUTSTANDING';
```

장(long) 포맷 하나로 재무·금리·환율·CPI 를 모두 담는다. 새 지표를 추가할 때
스키마 마이그레이션이 없다. 전략은 raw bag 이 아니라 타입 있는 접근자를 쓴다
(§3.2) — 저장 유연성과 호출 안전성을 둘 다 가진다.

### 3.2 저장 — 데이터셋 귀속

캔들과 같은 관례를 따른다:

```
dataset=<id>/facts/scope=SYMBOL/data.parquet
```

이유:

1. **재현성이 공짜다.** 과거 공시를 나중에 backfill 해도 다른 데이터셋의 과거
   백테스트 결과가 변하지 않는다. 전역 저장소로 두면 backfill 이 과거를
   바꾸므로 수집 배치 버전을 요청에 스탬프해야 한다 — 불필요한 복잡성.
2. **정리 코드가 필요 없다.** `deleteDataset` 이 이미 `dataset=<id>` 를 재귀
   삭제한다 (`parquet-candle-repository.ts:109`).
3. **작다.** 200종목 × 20분기 × 12필드 ≈ 5만 행. 단일 Parquet 파일로 충분하고
   데이터셋별 중복 저장이 무의미한 규모다.

DuckDB 로 읽는다 (`duckdb-service` 재사용). 쓰기는 캔들과 같은 임시파일 →
원자적 교체 패턴을 따른다.

```ts
// application/ports.ts
export interface FactQuery {
  readonly datasetId: string;
  readonly scope: FactScope;
  readonly keys?: readonly string[];
  readonly fields?: readonly string[];
  readonly asOfMaxTsMs?: number;
}

export interface FactRepository {
  getFacts(query: FactQuery): Promise<Fact[]>;
  saveFacts(datasetId: string, facts: readonly Fact[]): Promise<void>;
}

export interface FetchFinancialsRequest {
  readonly symbols: readonly string[];
  readonly fromYear: number;
  readonly toYear: number;
  readonly consolidated: boolean;
}

export interface FactSource {
  /** 재무제표 계정 + 발행주식수 */
  fetchFinancials(request: FetchFinancialsRequest): Promise<FactIngestionResult>;
  /** 분할·무상증자 등 자본변동 이벤트 */
  fetchCorporateActions(request: FetchFinancialsRequest): Promise<FactIngestionResult>;
}

export class FactSourceNotConfiguredError extends Error {}
```

`FactIngestionResult` 는 팩트 목록과 함께 **누락 리포트**(매핑 실패한 종목·계정)
를 담는다. 조용히 빠뜨리면 랭킹이 소리 없이 왜곡된다.

### 3.3 전략 컨텍스트 확장

룩어헤드 차단을 규약이 아니라 구조로 만든다 — 전략이 미래 팩트에 접근할 자리가
없어야 한다.

```ts
export interface FundamentalSnapshot {
  /** 이 시점까지 공시된 것 중 최신 분기값 */
  get(field: FundamentalField): number | null;
  /** 직전 4개 분기 합 (손익 계정용). 4개 미달이면 null */
  ttm(field: FundamentalField): number | null;
  readonly latestPeriodKey: string | null;
  readonly latestAsOfTsMs: number | null;
}

export interface CorporateAction {
  /** 효력 발생일 (기준일) */
  readonly effectiveTsMs: number;
  /** 주식수 증가 배수. 2:1 분할 = 2 */
  readonly ratio: number;
}

export interface StrategyBarContext {
  // 기존: tsMs / bars / getHistory / portfolio / rng
  /** 현재 tsMs 이전에 공시된 재무만. 데이터 없으면 null */
  fundamentals(symbol: string): FundamentalSnapshot | null;
  /** 효력발생일 ≤ tsMs 인 자본변동 이벤트만 */
  corporateActions(symbol: string): readonly CorporateAction[];
}
```

엔진은 시작 시 facts 를 `asOfTsMs` 순으로 정렬해 로드하고, 봉 타임라인을
진행하며 커서를 전진시킨다 — 봉을 다루는 방식과 동일하다. 팩트는 작으므로
전량 메모리 로드가 안전하다.

`hourly-breakout` 은 두 필드를 무시하면 된다. 다만 컨텍스트 생성부와 모든 전략
테스트 헬퍼가 새 필드를 채워야 한다 — 넓지만 얕은 변경이다.

### 3.4 분할 보정은 신호 전용

**캔들을 수정주가로 바꾸지 않는다.** 체결가·호가 단위·수수료 계산은 실제
거래된 가격이어야 한다. 수정주가로 체결하면 비용 모델이 전부 틀어진다.

대신 공용 순수 함수를 둔다:

```ts
// strategies/shared/adjusted-price.ts
export function adjustedCloseAt(
  history: readonly Candle[],
  actions: readonly CorporateAction[],
  index: number,
): number;
```

`close[index] ÷ (index 이후 발생한 모든 ratio 의 곱)`. 모멘텀 전략만 사용한다.

PIT 관점: 분할은 공시일에 알려지고 기준일에 발생한다. `periodKey` = 기준일,
`asOfTsMs` = 공시 접수일로 저장하고, `corporateActions` 는 **기준일 ≤ tsMs** 인
이벤트만 노출한다. 이미 발생한 분할로 과거 가격을 보정하는 것은 룩어헤드가
아니다.

배당은 보정하지 않는다 — price momentum 은 학계에서도 흔한 관행이다. 이 한계는
결과 화면 경고에 추가한다.

---

## 4. DART 수집 파이프라인

`src/server/modules/facts/infrastructure/dart/dart-fact-source.ts`

| 용도 | 엔드포인트 |
|---|---|
| 종목코드 → corp_code | `corpCode.xml` (zip, 1회 다운로드 후 캐시) |
| 재무제표 전 계정 | `fnlttSinglAcntAll.json` |
| 발행주식수 | `stockTotqySttus.json` |
| 분할·무상증자 이력 | `irdsSttus.json` (증자·감자 현황) |

`fnlttSinglAcntAll` 파라미터: `corp_code`, `bsns_year`,
`reprt_code`(11013=1Q / 11012=반기 / 11014=3Q / 11011=사업보고서),
`fs_div`(CFS/OFS).

엔드포인트 경로와 응답 필드는 **API 키 발급 후 실제 응답으로 검증해 조정한다** —
`kiwoom-market-data-source.ts:21` 이 이미 쓰는 관례다.

### 4.1 정확성 함정 3개

1. **누적값 차분.** 반기·3분기 보고서의 손익 계정은 누적값이다. 분기 단독
   영업이익 = 당기 누적 − 전기 누적. 재무상태표 계정(자산·부채)은 시점값이라
   그대로 쓴다. 계정 종류에 따라 처리가 갈리므로 계정 매핑표가 이 구분을
   들고 있어야 한다.
2. **계정 식별.** `account_id`(IFRS 표준 태그) 를 우선 쓰고, 비표준 태그면
   `account_nm` 폴백 매핑표를 쓴다. 매핑 실패는 수집 리포트에 누락으로 남긴다.
3. **asOfTsMs.** `rcept_no` 앞 8자리(접수일)의 **18:00 KST**. 1d 봉 마감이
   15:30 KST 이므로 공시일 당일 봉에는 반영되지 않고 다음 봉부터 쓰인다.
   보수적이고 룩어헤드를 완전히 차단한다.

### 4.2 운영

- Env: `DART_API_KEY` optional. 미설정이면 어댑터 비활성 —
  `FactSourceNotConfiguredError` 를 던진다 (토스 어댑터와 같은 패턴).
- HTTP 재시도·rate limit: `broker/infrastructure/rest-client.ts` 를
  `src/server/shared/` 로 승격해 공유한다. DART 는 증권사가 아니므로 broker
  모듈에 두면 §7 계층 방향을 위반한다.
- 호출량: 종목·연도당 9건이다 — 재무제표 4(정기보고서 4종) + 발행주식수 4(같은 4종) +
  증자·감자 1. 200종목 10년치면 약 18,000건.
  **DART 일일 한도는 40,000건**이라 한도는 여유가 있다 (200종목 12년치 21,600건도
  하루에 들어간다). 실제 제약은 벽시계 시간이다 — rate limiter 가 120ms 간격이라
  초당 8.3건, 18,000건에 최소 36분이 걸린다. 그래서 백필은 `tmux`/`screen` 안에서
  돌린다. 연도를 쪼개는 이유도 한도가 아니라 "중단 시 재수집 범위를 줄이려면" 이다.
- 수집은 **CLI**: `facts:sync --dataset <id> --from 2015 --to 2026`.
  §2.6 은 "백테스트용 데이터 관리(증권사 데이터 동기화)" 를 웹에 허용하므로 라우트로
  만들어도 위반은 아니다. CLI 로 시작하는 이유는 진행률 표시·잡 큐·취소 UI 를 새로
  만들지 않아도 되기 때문이다. 필요해지면 `broker-sync-service` 와 같은 방식으로
  라우트를 추가한다.

---

## 5. 변경 범위

1. `src/shared/schemas/backtest-request.ts` — `symbols` max 50 → 200.
   하위호환 확대이므로 기존 저장 요청은 그대로 유효하다.
2. `strategy/domain/strategy.ts` — `StrategyBarContext` 에 `fundamentals` ·
   `corporateActions` 추가.
3. `backtest/domain/engine.ts` — facts 로드 + PIT 커서 전진, 경고 문구에 배당
   미보정 추가.
4. 신규 `facts` 모듈 — domain / application(ports) / infrastructure(Parquet
   저장소 + DART 어댑터).
5. `server/cli.ts` — `facts:sync` 명령.
6. `strategy/strategies/` — 전략 2개 + 공용 헬퍼
   (`shared/adjusted-price.ts`, `shared/rebalance-schedule.ts`,
   `shared/rank.ts`). 레지스트리 등록.
7. 재무가 수집되지 않은 데이터셋에 `value-quality-rank` 를 제출하면 제출 단계에서
   명확한 메시지로 거부한다 (실행 후 빈 결과가 아니라).
8. UI 변경 없음 — 위저드가 JSON 스키마의 `title`/`description`/`default` 를 이미
   읽는다. 전략의 `.meta()` 한국어 라벨만 채운다.

`shared/rebalance-schedule.ts` 는 두 전략이 공유하는 순수 로직이다: KST 월 키
계산, 경과 개월 판정, 2단계 리밸런스 상태 전이. 전략 파일에 중복 구현하면 두
곳에서 따로 틀린다.

---

## 6. 테스트

핵심 4개:

- **PIT 회귀** — 공시 접수일 하루 전 봉에서 `fundamentals()` 가 *이전* 분기를
  반환하고, 접수일 다음 봉에서 새 분기를 반환한다. 룩어헤드 방어선이다.
- **누적값 차분** — 실제 DART 응답 픽스처로 3분기 단독 영업이익을 검증한다.
- **12-1 창 오프바이원** — 합성 봉으로 `formationDays`/`skipDays` 인덱싱을
  검증한다. 분할 이벤트가 있는 종목의 보정 수익률도 함께 본다.
- **2단계 리밸런스** — `topN == maxPositions` 에서 전량 회전이 막히지 않고 다음
  봉에 매수가 체결된다.

그 밖에:

- 랭킹 동점 처리 — 결정적이어야 한다 (심볼 코드 순 tiebreak). 재현성 요구.
- `absoluteMomentumFilter` 가 참일 때 후보 부족 시 현금 비중이 남는다.
- `staleQuarters` 로 낡은 공시 종목이 제외된다.
- EV ≤ 0 · TTM 4분기 미달 종목이 후보에서 빠진다.
- 재현성 — 같은 요청 2회 제출 시 동일한 재현성 메타데이터 (§9.5) 와 결과.
- Parquet 저장소 왕복 — `saveFacts` → `getFacts` 로 `asOfMaxTsMs` 필터 동작.

## 7. 남은 한계 (결과 화면에 명시)

생존편향, 시점별 지수 구성 미반영, 배당·권리락 미보정, 거래정지·유동성 부족,
공휴일 캘린더. §9.4 의 기존 경고에 "배당 미보정" 을 추가한다 — 분할은 이제
보정되므로 경고 문구가 정확해져야 한다.
