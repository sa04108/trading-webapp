# 단타·스윙 전략 2종 — `ema-trend-switch` · `rsi-reversion`

날짜: 2026-07-30

## 문제

등록된 전략 셋은 전부 특정 사용 방식에 묶여 있다: `hourly-breakout` 은 엔진
검증용 기준 전략이고, `cross-sectional-momentum`·`value-quality-rank` 는 월·분기
리밸런스의 장기 횡단면 전략이다. **소수 종목으로 분봉 데이트레이딩부터 일봉
스윙(보유 1~2달)까지 커버하는 단기 전략이 없다.**

동기가 된 사용 사례는 레버리지·2x인버스 상품 페어다: 엔진이 롱 온리이므로
(`engine.ts` 의 `validateOrder` 가 SELL 을 보유 수량으로 제한) 하락 방향은
인버스 상품 **매수**로만 표현된다. 다만 이것은 전략 속성이 아니라 종목 구성의
문제다 — 전략은 상품 유형을 몰라야 한다 (아래 "상관 그룹" 참고).

## 결정

전략 2개를 추가하고, 공용 부품은 `strategies/shared/` 로 뽑는다.

| 전략 | 성격 | 진입 | 청산 |
|---|---|---|---|
| `ema-trend-switch` | 추세 추종 | EMA 스프레드 ≥ 임계 | 트레일링 스톱 · 스프레드 반전 · maxHoldBars |
| `rsi-reversion` | 되돌림 | RSI ≤ 과매도 | RSI 회복 · ATR 스톱 · maxHoldBars |

### 확정된 선택

- **이름에 레버리지를 넣지 않는다.** 로직 어디에도 상품 유형 전제가 없다 —
  종목별 시그널, 상관 그룹핑, ATR 수량 산정 전부 임의 종목에서 동작한다.
  이름은 메커니즘을 따른다 (기존 관례: `hourly-breakout` 등). 레버리지·인버스는
  설명 문구의 예시로만 남긴다.
- **방향은 종목 선택으로 표현된다.** 시그널을 종목별로 계산하면 역상관 쌍에서는
  한쪽만 조건을 만족한다. 어느 쪽이 인버스인지 전략이 알 필요가 없다.
- **전략 2개 분리, 모드 파라미터 아님.** 위저드가 짧은 파라미터 목록만 보여주고,
  같은 기간·시드로 나란히 비교할 수 있으며, 한쪽 수정이 다른 쪽 재현성 해시를
  건드리지 않는다.
- **봉 주기 파라미터 없음.** 모든 창은 봉 수다. 1m·1h·1d 는 데이터셋/timeframe
  선택으로 정해진다 (위저드 기존 기능).
- **보유 상한은 `maxHoldBars`(선택).** 분봉이면 390 ≈ 하루, 일봉이면 20 ≈ 1달,
  40 ≈ 2달. 비우면 시그널로만 청산. 장 마감 강제 청산은 세션 지식이 필요해
  범위 밖.
- **기존 전략은 건드리지 않는다.** `hourly-breakout` 의 ATR 로직을 shared 로
  옮기지 않는다 — 파일이 바뀌면 strategySourceHash 가 바뀐다. 새 모듈에 새로
  작성한다.

### 이번 범위가 아닌 것

숏 포지션(엔진 확장), 장 마감 강제 청산, 상품 마스터(레버리지 배수 메타데이터),
그룹 롤링 재계산, 이벤트(어닝 서프라이즈) 전략.

---

## 1. 상관 그룹 — 동시 보유 방지

**목적**: 역상관 종목(예: 레버리지·곱버스)을 함께 들어 수수료만 내는 구간 제거.

- 워밍업: `correlationBars`(기본 60) 봉이 전 종목에 채워지는 첫 시점에 종목간
  로그수익률 피어슨 상관을 **1회** 계산하고 기간 끝까지 고정한다.
- 상관 ≤ `-correlationThreshold`(기본 0.5) 인 쌍을 같은 그룹으로 병합한다.
  병합은 전이적이다(A–B, B–C 면 A·B·C 한 그룹) — 1x·2x·인버스·곱버스가 한
  묶음이 된다.
- **그룹당 동시 보유 1종목.** 그룹 내 다른 종목이 보유 중이거나 진입 대기면
  신호를 무시한다.
- 짝이 없는 종목은 단독 그룹 — 평범한 롱 온리로 동작한다.
- 결정성: 상관 행렬 순회·병합 모두 심볼 코드 오름차순 (`shared/rank.ts` 와
  같은 원칙, 재현성 §9.5).
- 워밍업이 채워지기 전에는 진입하지 않는다 (지표 워밍업과 동일한 취급).

## 2. 공용 부품 — `strategies/shared/`

| 파일 | 내용 |
|---|---|
| `indicators.ts` | Wilder ATR · EMA · Wilder RSI. 증분 갱신 상태 + 순수 갱신 함수 |
| `pair-groups.ts` | 로그수익률 상관 계산 + 임계 기반 그룹 병합 (1회 계산용) |
| `position-sizing.ts` | `floor(equity × riskPct% ÷ (stopAtrMultiplier × ATR))` — 변동성 반비례라 2x 상품은 수량이 자동 절반 |
| `trailing-stop.ts` | 체결 확인 후 실제 진입가 기준 스톱 고정(갭 대응, `hourly-breakout` 관례), 트레일링 선택 시 고점 갱신마다 상향(고정 스톱은 trail 미지정), `maxHoldBars` 경과 판정 |

## 3. 전략 A — `ema-trend-switch` (EMA 추세 스위치)

- **진입**: 포지션·대기 없음, 그룹 비어 있음,
  `(EMA_fast − EMA_slow) ÷ EMA_slow × 100 ≥ entryThresholdPercent`.
- **수량**: `position-sizing` (리스크 기반).
- **청산** (먼저 걸리는 것):
  1. 종가 < 트레일링 스톱 (진입가 기준 고정 후 고점 따라 상향)
  2. EMA 스프레드 ≤ 0 (추세 반전)
  3. 보유 봉 수 ≥ `maxHoldBars` (지정 시)

```ts
fastEmaBars: int 2..100, 기본 12
slowEmaBars: int 5..400, 기본 26        // fast < slow 는 스키마 refine 으로 검증
entryThresholdPercent: 0.01..10, 기본 0.3
atrPeriod: int 2..100, 기본 14
stopAtrMultiplier: 0..20 양수, 기본 2
trailAtrMultiplier: 0..20 양수, 기본 2
maxHoldBars: int 1..10000, 선택
riskPerTradePercent: 0..5 양수, 기본 1
correlationBars: int 20..500, 기본 60
correlationThreshold: 0.1..0.95, 기본 0.5
```

## 4. 전략 B — `rsi-reversion` (RSI 되돌림)

- **진입**: 포지션·대기 없음, 그룹 비어 있음, `RSI ≤ entryRsi`.
- **수량**: 동일.
- **청산** (먼저 걸리는 것):
  1. `RSI ≥ exitRsi`
  2. 종가 < 고정 ATR 스톱 (트레일링 아님 — 되돌림 전략은 진입 후 하락을
     어느 정도 견뎌야 한다)
  3. 보유 봉 수 ≥ `maxHoldBars` (지정 시)

```ts
rsiPeriod: int 2..100, 기본 14
entryRsi: 5..45, 기본 30
exitRsi: 50..95, 기본 55               // entry < exit 는 스키마 refine 으로 검증
atrPeriod: int 2..100, 기본 14
stopAtrMultiplier: 0..20 양수, 기본 2
maxHoldBars: int 1..10000, 선택
riskPerTradePercent: 0..5 양수, 기본 1
correlationBars: int 20..500, 기본 60
correlationThreshold: 0.1..0.95, 기본 0.5
```

공통 관례 (둘 다):

- `requiresFundamentals` 없음 — 봉만 본다.
- `pendingEntry`/`exitPending` 로 미체결 중복 주문 금지 (`hourly-breakout` 관례).
- 파라미터 한국어 `title`/`description` 은 `.meta()` — 위저드가 그대로 읽는다.
- 스톱 레벨은 신호봉 종가가 아니라 **실제 체결가** 기준 (갭 대응).

## 5. 테스트

| 테스트 | 지키는 것 |
|---|---|
| 지표 손계산 대조 (EMA·RSI·ATR) | `indicators.ts` 정확성 |
| 4종목 합성 봉 → 그룹 2개, 심볼 순서 뒤집어도 동일 | 그룹핑 정확성 + 재현성 |
| 역상관 쌍 양쪽 신호 → 한쪽만 체결 | 그룹당 1종목 |
| `maxHoldBars` N봉 후 청산, 미지정 시 무제한 | 보유 상한 |
| 심볼 역할 교환(같은 봉, 이름만 교환) → 대칭 결과 | 방향 무지 = 상품 유형 무전제 |
| 같은 가격 경로를 1m·1h·1d 로 → 같은 주문 시퀀스 | 봉 주기 무관 |
| 트레일링 스톱: 고점 갱신 후 하락 시 상향된 레벨에서 청산 | `trailing-stop.ts` |
| 워밍업 미충족 구간 무진입 | 상관·지표 워밍업 |
