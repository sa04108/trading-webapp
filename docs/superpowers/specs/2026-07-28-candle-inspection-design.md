# 캔들 데이터 검증 차트 설계

날짜: 2026-07-28
관련: 스펙 §11 §14, D-020 (수집 파이프라인)

## 목적

수집·가져온 캔들이 정상인지 눈으로 확인한다 — "이 데이터 믿어도 되나"에 답하는
검증 화면. 탐색(줌·팬·지표)은 목적이 아니다. 필요해지면 lightweight-charts 로
확장하되 서버 API 는 그대로 재사용한다.

## 서버

`GET /datasets/:id/candles?symbol&timeframe&fromTsMs&toTsMs`
(`DatasetService.getCandlesForInspection`)

- timeframe 검증: 1h 데이터셋 → 1m(원본)·1h, 1d 데이터셋 → 1d 만.
- **상한 2,000봉 — 초과는 400.** 검증 화면은 봉을 다운샘플링으로 뭉개지 않고
  정직하게 거부한다 (백테스트 결과 차트의 LTTB 와 다른 선택인 이유).
- coverage `missingRanges`(요청 구간과 겹치는 것만) 동봉. coverage 는 데이터셋
  timeframe 기준이므로 다른 timeframe 뷰에는 빈 배열 — 근사 음영을 그리지 않는다.

## 웹

데이터셋 카드의 심볼 클릭 → 드로어 (`candle-inspect-drawer.tsx`).

- recharts 커스텀 shape 캔들(심지 1px + 몸통, dataKey=[low,high] 범위 바) +
  거래량 바(하단, 단일 muted 색). 새 의존성 없음.
- **X축은 시간 수치축** — 카테고리축과 달리 봉이 없는 구간이 실제 빈 공간으로
  보인다. 갭 가시화가 검증의 핵심이라 의도된 선택.
- 기간 프리셋은 2,000봉 상한 안에 들어오는 구성만: 1m(1일·1주), 1h(1달·1년),
  1d(1년·5년). 자유 기간 입력 없음(YAGNI). 구간 끝점은 coverage 의 마지막 봉
  (없으면 현재 시각) — 오래된 데이터도 프리셋이 바로 보인다.
- 색: 기존 `--gain`(상승 빨강)·`--loss`(하락 파랑) — KR 관례. dataviz 검증기로
  라이트·다크 표면 모두 전 검사 통과 확인(CVD ΔE 26.7+).
- 누락 음영: ReferenceArea, 데이터셋 timeframe 뷰에서만.
- 빈 구간·상한 초과는 안내 문구로.

## 테스트

- 통합: 1m/1h 조회 왕복, timeframe·심볼 검증 400, 상한 400, missingRanges 규칙.
- E2E: full MVP flow 에 심볼 클릭 → 드로어·차트 렌더 확인 + 스크린샷.

## 범위 밖

줌·팬·크로스헤어, 지표 오버레이, 다심볼 비교, 표 보기(원자료는 API 로 조회 가능).
