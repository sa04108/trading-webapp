# 지원 시장 범위 명시 설계

날짜: 2026-07-29
관련: 스펙 §11 §13, DECISIONS.md D-006, 2026-07-29-web-facts-sync-design.md

## 목적

**US 는 이 시스템에서 아예 동작하지 않는데 UI 는 고를 수 있게 제공한다.**

`getSessionForMarket('US')` 는 `UnsupportedMarketSessionError` 를 던지고
(exchange-session.ts:30-33), 데이터셋을 만드는 **두 경로가 모두** 그것을 호출한다 —
`createBrokerDataset`(dataset-service.ts:120)과 `importCsv`(dataset-service.ts:154).
1분봉이든 일봉이든, 증권사 수집이든 CSV 가져오기든 US 는 생성 시점에 거부된다.

의도된 거부다. D-006 추가 항목: "세션이 정의되지 않은 시장(US)의 import 는 명시적으로
거부한다. KR 세션으로 빈 1h 집계를 만들고 완료로 위장하던 문제의 수정 — US 지원 시
DST 를 포함한 세션 정의가 선행돼야 한다."

그런데 웹은 데이터셋 생성 폼과 CSV 가져오기 폼 **양쪽에서** US 를 선택지로 내놓는다
(datasets-page.tsx:487, :609). 지금 사용자가 받는 안내는 시장을 고르고 종목을 넣고
「만들기」를 누른 뒤에 오는 400 하나뿐이다. **거부를 코드가 알고 있는데 화면이 말하지
않는다.**

여기에 재무 수집 제약이 겹친다. DART 는 국내 공시 기관이므로 재무는 KR 전용이다 —
이건 US 세션이 정의된 뒤에도 남는 제약이라 별도로 말해야 한다.

## 명시할 제약

| 제약 | 근거 | 해소 조건 |
|---|---|---|
| 데이터셋 생성 불가 (증권사·CSV 모두) | 세션 미정의 → `UnsupportedMarketSessionError` | DST 포함 세션 정의 (D-006) |
| 시간봉 집계 불가 | 세션 경계가 없다 | 위와 같음 |
| DART 재무 수집 불가 | DART 는 국내 공시 기관 | 별도 소스(SEC EDGAR) 도입 |

**손익 통화 표시**(`formatKrw` 가 무조건 `원` 을 붙인다, format.ts:8-11)는 US 데이터셋이
존재할 수 없어 지금 화면에 드러나지 않는다. UI 문구로 쓰지 않고 D-027 에 한계로만
기록한다 — US 지원 작업이 반드시 함께 해결해야 하는 항목이다.

## 1. 지원 여부의 단일 출처

지금 "US 는 안 된다" 는 지식이 `getSessionForMarket` 이 **던진다는 사실** 안에 암묵적으로
들어 있다. 화면이 쓰려면 선언적으로 물어볼 수 있어야 한다. 웹에 `['US']` 를 상수로
박으면 US 세션이 추가되는 날 화면만 낡은 채로 남는다.

`exchange-session.ts` 를 맵 기반으로 바꿔 두 질문이 같은 출처에서 나오게 한다:

```ts
const SESSIONS: Partial<Record<Market, ExchangeSession>> = { KR: KR_SESSION };

export function getSessionForMarket(market: Market): ExchangeSession {
  const session = SESSIONS[market];
  if (!session) throw new UnsupportedMarketSessionError(market);
  return session;
}

/** 세션이 정의된 시장인지 — 데이터셋 생성·집계·coverage 가 가능한지와 같은 질문이다 */
export function hasMarketSession(market: Market): boolean {
  return SESSIONS[market] !== undefined;
}
```

`ALL_MARKETS: readonly Market[] = ['KR', 'US']` 를 `candle.ts` 의 `Market` 타입 옆에
둔다 — 타입과 그 값 목록이 떨어져 있으면 시장을 추가할 때 한쪽만 고쳐진다.

## 2. 시장 지원 정보

`market-data/domain/market-support.ts`:

```ts
export interface MarketSupport {
  readonly market: Market;
  /** 데이터셋 생성·수집 가능 여부 (거래소 세션 정의 여부와 같다) */
  readonly datasetsSupported: boolean;
  /** DART 재무 수집 대상 시장인지 — DART 는 국내 공시 기관이다 */
  readonly factsSupported: boolean;
  /** 지원되지 않는 이유 (한국어). 전부 지원되면 null */
  readonly reason: string | null;
}

export function listMarketSupport(): readonly MarketSupport[];
```

`factsSupported` 는 **시장 자격만** 본다 — `DART_API_KEY` 설정 여부는 배포 상태이지
시장 속성이 아니다. 그건 데이터셋별 `factsSyncEstimator`(재무 동기화 설계 §7)가 이미
`UNSUPPORTED` + 이유로 답한다. 둘을 한 필드에 섞으면 "KR 인데 재무 불가" 의 원인이
시장인지 키인지 구분되지 않는다.

## 3. API

`GET /markets` (인증 필요, `dataset-routes.ts` 에 등록 — `/symbols/info` 와 같은 자리):

```ts
{ markets: MarketSupport[] }
```

배포마다 고정인 값이라 클라이언트는 `staleTime: Infinity` 로 캐시한다.

`/system/info` 에 얹지 않는 이유: 그쪽은 uptime·여유 디스크처럼 계속 변하는 값을
담고 있어 긴 `staleTime` 을 걸 수 없다. 시장 지원 정보를 거기 두면 둘 중 하나가
잘못된 주기로 갱신된다.

## 4. UI

### 시장 Select 두 곳

데이터셋 생성 dialog(`datasets-page.tsx:481-488`)와 CSV 가져오기 dialog(`:603-610`)의
하드코딩된 `<SelectItem>` 두 쌍을 `useMarketSupport()` 결과로 렌더한다.

```
시장
┌────────────────────────────────┐
│ KR                          ▾ │
└────────────────────────────────┘
  ┌────────────────────────────┐
  │ KR                         │
  │ US  (지원 예정)         ⊘  │  ← disabled
  └────────────────────────────┘
```

`datasetsSupported === false` → `<SelectItem disabled>` + `(지원 예정)` 접미사.

**고를 수 없게 만드는 것이 핵심이다.** 고를 수 있게 두고 400 을 받게 하는 것은 명시가
아니다 — 사용자는 종목을 다 넣은 뒤에야 알게 된다.

미지원 시장의 `reason` 은 항상 보이는 자리에 둔다(선택 여부와 무관하게 폼 하단 한 줄):

> US 는 아직 지원하지 않습니다 — 거래소 세션 정의가 없어(DST 미지원) 데이터셋을 만들 수
> 없습니다. DART 재무 수집도 국내 종목 전용입니다.

접었다 펴는 자리에 숨기지 않는다. 선택지가 회색인 이유를 찾으러 다니게 하면 명시한
것이 아니다.

### 재무 체크박스 툴팁

재무 동기화 설계 §8 의 툴팁에 **한 줄을 상시 추가한다.** 현재 계획은 `UNSUPPORTED` 일
때만 이유를 띄우는데, 그러면 KR 데이터셋에서는 "재무가 국내 전용" 이라는 사실이 아예
보이지 않는다.

> 이 데이터셋 종목의 재무제표까지 함께 받습니다.
> **국내(KR) 종목만 가능합니다 — DART 는 국내 공시 기관입니다.**
> 봉만 받는 것보다 오래 걸립니다 — 아래 예상 시간을 확인하세요.

## 5. 서버 검증은 그대로 둔다

`createBrokerDataset`·`importCsv` 의 `getSessionForMarket` 호출을 없애지 않는다. UI 가
막는 것과 별개로 API 는 직접 호출될 수 있고, D-006 이 고친 문제("KR 세션으로 빈 1h
집계를 만들고 완료로 위장")가 그 검증에 걸려 있다. UI 는 **거부를 미리 알려주는 층** 이지
거부하는 층이 아니다.

`POST /datasets` 와 CSV import 의 `z.enum(['KR', 'US'])` 도 유지한다 — 스키마에서 US 를
빼면 400 의 메시지가 "필드가 올바르지 않습니다" 로 뭉개져, 시장이 원인이라는 정보가
사라진다.

## 6. 테스트

- `hasMarketSession` 단위 — KR true, US false
- `listMarketSupport` 단위 — KR 전부 true·reason null, US 전부 false·reason 이 세션과
  재무 두 이유를 모두 담는지
- `getSessionForMarket` 회귀 — 맵 기반으로 바꾼 뒤에도 KR 은 `KR_SESSION`, US 는
  `UnsupportedMarketSessionError`
- e2e — 데이터셋 생성 dialog 에서 US 항목이 disabled 이고 이유 문구가 보이는지;
  재무 툴팁에 "국내(KR) 종목만" 이 있는지

## 7. 결정 기록

`docs/DECISIONS.md` 에 **D-027** 을 추가한다: 미지원 시장을 UI 에서 고를 수 없게 하고
이유를 상시 노출한다. 함께 기록할 남은 한계 — `formatKrw` 가 통화를 원화로 고정하므로
US 지원 작업은 세션 정의와 통화 표시를 같이 해결해야 한다.

## 범위에서 뺀 것

- **US 세션 정의·DST 지원** — 이 설계는 제약을 말하는 것이고 없애는 것이 아니다.
- **통화 표시 일반화** — US 데이터셋이 존재할 수 없어 지금 드러나지 않는다. D-027 에
  한계로만 기록한다.
- **Market 타입에서 US 제거** — 스키마·저장된 데이터가 그 값을 참조한다. 타입을 줄이면
  기존 행이 타입과 어긋난다.
