# 백테스트 소비 timeframe 명시화 — 1분봉 소비 허용

날짜: 2026-07-29

## 문제

백테스트 요청에 timeframe 이라는 개념이 없다. 실행부가 `dataset.timeframe`
(1h | 1d) 을 암묵적으로 소비하고, "무슨 봉으로 돌렸는지" 는 요청·결과·UI 어디에도
기록되지 않는다. 1m 원본이 물리적으로 존재하는데도 (1h 데이터셋은 1m + 1h 를
함께 보관) 백테스트는 접근할 수 없다 — 스펙 §11 "사전 집계 1시간봉 우선" 은
성능·메모리 관례이지 구조적 제약이 아니다.

- 엔진(`engine.ts`)은 timeframe 무지 — 정렬된 봉 배열을 시간 순으로 돌 뿐이다.
- 전략 파라미터도 봉 개수 기준(`lookbackBars`)이라 어떤 봉이든 동작한다.
- 진짜 제약은 실행부가 기간 내 전체 봉을 메모리 배열로 올린다는 것. KR 1m 은
  종목·연당 약 9.5만 봉 — 상한 없이 열면 OOM 이 가능하다.

## 결정 (사용자 선택: A안)

**요청이 timeframe 을 명시적으로 들고 다닌다.** 데이터셋 모델은 그대로 둔다.

### 계약 (`backtest-request.ts`)

- `timeframe: z.enum(['1m','1h','1d']).optional()` — optional 인 이유는 저장된
  과거 요청(복제·재실행)이 새 스키마로도 파싱돼야 하기 때문. 미지정 = 데이터셋
  기본(`dataset.timeframe`), 기존 동작과 동일.

### 제공 가능 timeframe 규칙 (공유 헬퍼)

"1h 데이터셋은 1m 원본도 보관한다" 는 관례가 검증 차트(`dataset-service`),
드로어 UI, 이제 백테스트 검증까지 세 곳에서 필요하다 —
`availableTimeframes(datasetTimeframe)` 를 market-data domain 에 두고 공유한다.

### 제출 검증 (`backtest-routes.ts`)

1. `timeframe` 이 데이터셋 제공 범위 밖이면 거부 (1d 데이터셋에 1m 등).
2. **메모리 가드레일**: coverage 메타데이터로 예상 봉 수를 추정해
   `MAX_BACKTEST_BARS`(2,000,000) 초과 시 명시적으로 거부하고 기간·종목 축소
   또는 1h 사용을 안내한다. Parquet 은 읽지 않는다 (D-025 와 같은 원칙).
   추정: 심볼별 `barCount × (기간∩커버리지 비율) × 배율` (1h coverage 로 1m 을
   추정할 때 배율 60 — 상한이므로 과대추정은 안전한 방향).
   순수 함수 `estimateBars`(backtest domain)로 두고 단위 테스트한다.
3. 실행부에도 같은 상한의 백스톱을 둔다 (로드 중 초과 시 실패) — 제출 후
   데이터가 늘어난 경우의 뒤늦은 방어선.

### 실행부 (`backtest-child.ts`)

`request.timeframe ?? dataset.timeframe` 으로 로드. 나머지는 그대로 —
엔진·전략·메트릭은 timeframe 무지라 변경 없음.

### 웹

- 위저드 데이터 단계: 데이터셋이 1h 면 봉 선택 노출 (1시간봉 기본 / 1분봉).
  1d 데이터셋은 선택지가 없으므로 숨긴다. 검토 단계에 봉 행 추가.
- `prefill.ts`: `timeframe` 왕복 (복제 시 원본의 봉 선택이 따라온다).
- 위저드 데이터셋 목록의 timeframe 표기도 데이터 페이지와 같은 `1m→1h` 로 통일.

### 문서

- SPEC §11 원칙 한 줄 수정: "백테스트는 사전 집계 1시간봉 우선" → 기본값은
  1h, 요청이 명시하면 1m 소비 가능 + 봉 수 상한.
- SPEC §15 요청 예시에 `timeframe` 추가, DECISIONS 에 D-026 기록.

## 하지 않는 것 (YAGNI)

- 데이터셋 모델 재설계(보유 timeframe 목록) — B안, 지금 불필요.
- 1m coverage 별도 계산 — 기간 검증은 기존 dataset-timeframe coverage 로 충분
  (1m 과 1h 의 시간 범위는 동일하다).
- 스트리밍 엔진 — 상한으로 충분할 때 하는 최적화가 아니다.

## 테스트

- 단위: `estimateBars` (커버리지 부분 겹침, 1m 배율, 커버리지 없는 심볼).
- 통합: 1m CSV import 후 timeframe='1m' 백테스트 완주 (totalBars 로 1m 소비
  증명), 1d 데이터셋에 1m 요청 → 400, 상한 초과 추정 → 400, timeframe 미지정
  기존 동작 유지.
- 단위: prefill timeframe 왕복.
