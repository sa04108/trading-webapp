# 한국 증시 현재 3개월 목표 연구

2026-09-08 종가 기준의 탐색 기록이다. 운영 전략 등록·실계좌 연결·주문 발송 기능은 없다. 연구 모듈에서 기존 운영 엔진과 전략을 직접 실행한다. 목표 달성 여부는 보고서의 재무 성과로 판단하며 테스트 통과로 대체하지 않는다.

실험 전 규칙과 결과는 `docs/research/kr-current-quarter-*.md`, 고정된 모든 조합은 `configs/`, 원문·개별 계좌 결과는 Git에서 제외된 `data/kr-quarter-research/`에 있다. `configs/experiments.json`이 집계 대상 전체 실행 목록이다. 같은 파라미터도 주식과 ETF의 실험을 구분한다.

## 자료와 준비

Node·pnpm은 저장소 버전을 사용한다. Python 3.12 환경에 `requirements.txt`를 설치한다. 아래의 `python`은 해당 가상환경의 실행 파일을 뜻한다.

보존된 기초 입력이 필요하다.

- 주식 가격·과거 월별 시가총액 상위 50종목: `data/kr-regime-research/input-50.json.gz`. 이전 연구 커밋 `ebc7936`의 `scripts/research/prepare_kr_regimes.py`가 생성한 자료다. 현재 종목군을 과거 전체에 적용하지 않았다.
- 원천 KRX 패널 및 연간 공시: `data/reliable-strategy-reproduction/2026-09-06-8791951/research-data/panel/`, 같은 위치의 `annual.json`. KRX 원문·DART 원문과 정규화 이력은 기존 수집 기록에 보존되어 있다. 새 공개 가격을 받는 것만으로 이 비공개 로컬 자료가 복원되지는 않는다.
- 추가 원문: Npay 지수·종목·일별 시세표, Yahoo ETF 실제 OHLC와 분배금·분할 이벤트, FRED·Cboe·한국은행·정부 발표.

```bash
python scripts/quarter-research/fetch_sources.py data/kr-quarter-research/sources-20260908
python scripts/quarter-research/fetch_etf_raw.py data/kr-quarter-research/etf-raw-20260908
python scripts/quarter-research/reconcile_etf_prices.py data/kr-quarter-research
python scripts/quarter-research/prepare_inputs.py data/kr-quarter-research
python scripts/quarter-research/prepare_stock_inputs.py data/kr-regime-research/input-50.json.gz data/kr-quarter-research/etf-input.json.gz data/kr-quarter-research/stock-50-input.json.gz
python scripts/quarter-research/add_annual_inputs.py data/kr-quarter-research/stock-50-input.json.gz data/reliable-strategy-reproduction/2026-09-06-8791951/research-data/annual.json data/kr-quarter-research/quality-stock-input.json.gz
```

수집기는 이미 저장된 원문을 다시 받지 않는다. 최초 FRED 장기간 요청의 시간 초과와 기간을 줄인 재시도는 원문 manifest에 따로 남아 있다. 원문 API의 미래 개정 때문에 새 다운로드가 과거 해시와 같다는 보장은 없다. 정확한 재현에는 보존된 해시 일치 입력을 사용한다.

## 계좌 실행

```bash
node --import tsx scripts/quarter-research/quarter-engine.ts data/kr-quarter-research/stock-50-input.json.gz data/kr-quarter-research/reproduction-stock-confirmation confirmation scripts/quarter-research/configs/stock-frozen-diagnostics.json
```

인수는 `입력.gz 출력폴더 단계 [후보.json] [슬리피지bp] [시드] [앞에서 실행할 창 수 또는 0] [초기현금] [옵션.json]` 순서다. 단계는 `earlier`, `development`, `validation`, `confirmation`이다. 출력 폴더는 새 경로를 권장한다. 같은 경로를 재사용하면 같은 이름 결과를 덮어쓰므로 실패 원본은 먼저 보존해야 한다.

월 첫 실제 거래일부터 달력 3개월 계좌를 시작하며 전체 창이 단계와 자료 기간 안에 있어야 한다. 기존 전략의 종가 신호·다음 시가 체결·두 단계 회전을 그대로 따른다. 주식 세금은 날짜별 프로필, ETF 세금은 0, 수수료는 편도 1.5bp, 기본 슬리피지는 5bp, 직전 거래량의 1% 체결 한도를 사용한다. ETF 가격 2천원 미만도 5원 호가를 적용하는 보수적 단순화가 있다.

평가액 +10.5%에서 청산 신호를 내도 실제 비용 후 수익이 10% 미만이면 실패다. 미청산·확인되지 않은 기업행위 보유도 목표 달성으로 세지 않는다. 계좌 고점 대비 10% 낙폭 중단은 갭 이후의 실제 손실 상한을 보장하지 않는다. 3개월 만기 전 마지막 신호 뒤에도 거래량 한도로 남은 포지션은 임의로 체결시키지 않는다.

## 현재 신호와 집계

아래는 초기 실행 경로다. 초기 현재 입력에는 네 거래일 결손이 있었으므로 최신 신호 재현에는 아래의 가격 정정 절차를 사용한다. 원래 증거 입력을 덮어쓰지 않는다.

```bash
python scripts/quarter-research/fetch_current_stocks.py data/kr-quarter-research/current-stocks-20260908 data/reliable-strategy-reproduction/2026-09-06-8791951/research-data/panel
python scripts/quarter-research/prepare_current_inputs.py data/kr-quarter-research/quality-stock-input.json.gz data/kr-quarter-research/etf-input.json.gz data/kr-quarter-research/current-stocks-20260908/manifest.json data/kr-quarter-research/current-stock-input.json.gz
node --import tsx scripts/quarter-research/current-signals.ts data/kr-quarter-research/current-stock-input.json.gz scripts/quarter-research/configs/current-candidates.json data/kr-quarter-research/current-signals.json
python scripts/quarter-research/build_evidence.py data/kr-quarter-research data/kr-quarter-research/evidence
```

현재 신호 입력으로 과거 분기 성과를 실행하면 거부한다. 초기 현재 가격은 겹친 150일봉의 OHLCV가 일치했지만 워밍업 중 빠진 네 거래일을 놓쳤다. 아래 정정 절차로 200개 결손 일봉을 보강하고 현재 신호를 다시 계산했다. 최신 기업행위의 공식 수집 범위는 기존 팩트까지만이며 이후의 일별 31% 초과 단위 변화는 중단·확인하도록 했다. 이 가격 변화 검사만으로 모든 기업행위가 검증되는 것은 아니다.

연간 실적은 접수일 다음 날 이후에만 사용한다. 최신 정정값을 최초 공시일로 소급하지 않지만 과거 최초 공시 빈티지가 완전하지 않다. 2014년 연간 자료가 없어 두 해 실적이 필요한 전략은 2016년 상당 부분에서 진입 자격이 없다. FRED 일별 자료는 관측일 +7일, 수출은 월초 관측일 +90일의 공개 지연 가정이며 개정 이력을 갖춘 인증된 시점 자료가 아니다. 월별 물가와 국제 정세는 현재 환경 해석에 사용한다.

## 확인

```bash
python -m unittest discover -s scripts/quarter-research -p 'test_*.py' -v
pnpm exec vitest run tests/unit/quarter-research.test.ts tests/unit/annual-quality-quarter.test.ts tests/unit/recovery-quarter.test.ts
pnpm exec eslint scripts/quarter-research/*.ts tests/unit/quarter-research.test.ts tests/unit/annual-quality-quarter.test.ts tests/unit/recovery-quarter.test.ts
pnpm exec tsc -p tsconfig.server.json --noEmit
```

RSI 개발 실행 중 평가 종료 뒤 상장폐지 일정이 엔진 시간축으로 넘어가던 연구 입력 문제가 발견됐다. 실패 응답은 `rsi-input-boundary-failure.json`에 보존하고 종료일 이후 일정을 제외해 다시 실행했다. 운영 엔진은 바꾸지 않았다. 기존 완료된 대표 후보의 재실행과 원본 계좌 결과 비교를 별도로 기록한다.

## EMA·분기 실적 후속 탐색

`configs/followup-experiments.json`은 `b3e80bf` 뒤 추가한 31개 실험 목록이다. 이전 `experiments.json` 집계와 구분한다. 원문은 `data/kr-quarter-research/followup/`에 보존했다.

`fetch_quarterly.py`는 기존 앱 인증 환경 안에서 DART 다중회사 주요계정을 조회한다. `--codes-json`에는 중복 없는 8자리 DART 회사코드 JSON 배열을, `--env-file`에는 기존 앱 환경 파일을 지정한다. API 인증키는 파일에서 읽고 원응답만 표준 출력에 gzip으로 보낸다. `--usage-database`를 생략하면 같은 환경의 `DATABASE_PATH`를 읽기 전용으로 열어 일별 사용량을 확인한다. 호출 수는 자체 기록에만 남으며 앱 사용 원장에 쓰지 않는다. 다른 동시 수집기의 모든 호출까지 추적하는 전역 예약 장치는 아니다. 실제 수집은 123개 회사·92회, 사전 의미 확인은 4회였다.

```bash
python scripts/quarter-research/prepare_quarterly.py data/kr-quarter-research/followup/dart-quarterly.jsonl.gz data/kr-quarter-research/followup/dart-request-codes.json data/kr-quarter-research/followup/quarterly-observations.json
node --import tsx scripts/quarter-research/quarterly-coverage.ts data/kr-quarter-research/stock-50-input.json.gz data/kr-quarter-research/followup/quarterly-observations.json data/kr-quarter-research/followup/quarterly-coverage.json
python scripts/quarter-research/add_quarterly_inputs.py data/kr-quarter-research/stock-50-input.json.gz data/kr-quarter-research/followup/quarterly-observations.json data/kr-quarter-research/followup/quarterly-stock-input.json.gz
node --import tsx scripts/quarter-research/quarter-engine.ts data/kr-quarter-research/followup/quarterly-stock-input.json.gz data/kr-quarter-research/followup/reproduction-earnings-confirmation confirmation scripts/quarter-research/configs/earnings-frozen.json
python scripts/quarter-research/add_quarterly_inputs.py data/kr-quarter-research/current-stock-input.json.gz data/kr-quarter-research/followup/quarterly-observations.json data/kr-quarter-research/followup/quarterly-current-input.json.gz
node --import tsx scripts/quarter-research/current-signals.ts data/kr-quarter-research/followup/quarterly-current-input.json.gz scripts/quarter-research/configs/earnings-frozen.json data/kr-quarter-research/followup/earnings-current-signals.json
python scripts/quarter-research/build_followup_evidence.py data/kr-quarter-research data/kr-quarter-research/followup/evidence
pnpm exec vitest run tests/unit/quarterly-earnings-research.test.ts tests/unit/earnings-acceleration-rank.test.ts
```

전체 집계를 재현하려면 `followup-experiments.json`의 단계·선택 파일 조합을 모두 완료해야 한다. EMA는 기존 주식 입력을 쓴다. 분기 실적은 당기·누적 차분 대조, 같은 회계기준, 두 보고서의 접수일 다음 날 적용을 검사한다. 2015년 분기 자료가 반환되지 않아 연속 8분기 조건을 충족한 첫 월간 시작점은 2018년 4월이다. 자료 충족 구간의 별도 요약도 보존한다. 상세 결과와 한계는 `docs/research/kr-current-quarter-followup-findings.md`에 있다.


## 저PER·고ROE, 종목군 확대, 현재 가격 정정

`configs/value-experiments.json`은 이 회차의 입력·후보·단계·슬리피지·시드 목록이다. 15개 개발 설정과 후속 진단을 합해 34개 실험이다. 새 DART 조회 없이 이전 원문을 재사용한다.

```bash
python scripts/quarter-research/prepare_valuation.py data/kr-quarter-research/followup/dart-quarterly.jsonl.gz data/kr-quarter-research/followup/dart-request-codes.json data/kr-quarter-research/value/valuation-observations.json
python scripts/quarter-research/add_valuation_inputs.py data/kr-quarter-research/stock-50-input.json.gz data/kr-quarter-research/value/valuation-observations.json data/reliable-strategy-reproduction/2026-09-06-8791951/research-data/panel data/kr-quarter-research/value/valuation-stock-input.json.gz
node --import tsx scripts/quarter-research/valuation-coverage.ts data/kr-quarter-research/value/valuation-stock-input.json.gz data/kr-quarter-research/value/valuation-coverage.json
python scripts/quarter-research/repair_current_history.py data/kr-quarter-research/current-stocks-20260908/manifest.json data/kr-quarter-research/value/current-history-repair
python scripts/quarter-research/prepare_current_inputs.py data/kr-quarter-research/quality-stock-input.json.gz data/kr-quarter-research/etf-input.json.gz data/kr-quarter-research/value/current-history-repair/manifest.json data/kr-quarter-research/value/repaired-current-stock-input.json.gz
python scripts/quarter-research/add_quarterly_inputs.py data/kr-quarter-research/value/repaired-current-stock-input.json.gz data/kr-quarter-research/followup/quarterly-observations.json data/kr-quarter-research/value/repaired-quarterly-current-input.json.gz
python scripts/quarter-research/add_current_valuation.py data/kr-quarter-research/value/repaired-quarterly-current-input.json.gz data/kr-quarter-research/value/valuation-observations.json data/kr-quarter-research/value/current-history-repair/manifest.json data/kr-quarter-research/value/complete-current-input.json.gz
node --import tsx scripts/quarter-research/current-signals.ts data/kr-quarter-research/value/complete-current-input.json.gz scripts/quarter-research/configs/value-current-candidates.json data/kr-quarter-research/value/current-signals.json
```

200종목 원천은 이전 커밋 `ebc7936`의 `scripts/research/prepare_kr_regimes.py`를 보존된 연구 원자료에 `--universe-size 200 --ranking cap`으로 실행해 `expanded/source/input-200.json.gz`를 만들었다. 외부 원문의 해시가 같은 파일을 사용해야 정확히 재현된다. 한국항공우주 정지일은 설정에 기록한 DART 원문이 필요하다.

```bash
python scripts/quarter-research/prepare_stock_inputs.py data/kr-quarter-research/expanded/source/input-200.json.gz data/kr-quarter-research/etf-input.json.gz data/kr-quarter-research/expanded/stock-200-input.json.gz --end 2026-08-14
python scripts/quarter-research/apply_verified_halt.py data/kr-quarter-research/expanded/stock-200-input.json.gz scripts/quarter-research/configs/kai-verified-halt.json data/kr-quarter-research/expanded/stock-200-verified-input.json.gz
node --import tsx scripts/quarter-research/quarter-engine.ts data/kr-quarter-research/expanded/stock-200-verified-input.json.gz data/kr-quarter-research/expanded/reproduction-development development scripts/quarter-research/configs/expanded-candidates.json
```

현재 200종목은 Npay 3페이지씩의 두 시장 카탈로그와 종목당 시세표 2페이지를 받는다. 9월 7일까지의 완전한 실제 KRX 20거래일 거래대금으로 선정한다. `fetch_current_krx.py --env-file ...`는 기존 앱 인증 환경에서 실행하고 stdout을 로컬 원문 gzip 파일로 보존한다. 운영 사용량 원장은 읽기 전용이며 인증키는 밖으로 복사하지 않는다. 최초 두 시장·9월 8일까지 요청은 KOSPI 당일 빈 응답에서 멈췄다. 이 부분 원문도 보존하고 `--markets KOSDAQ --through 20260907`로 나머지 6일만 조회했다. 총 13회 요청·12회 자료 응답이며 동시 수집기의 모든 사용량을 예약하는 도구는 아니다.

```bash
python scripts/quarter-research/fetch_current_stocks.py data/kr-quarter-research/expanded/current-provisional data/reliable-strategy-reproduction/2026-09-06-8791951/research-data/panel --universe-size 250 --catalog-pages 3 --table-pages 2
python scripts/quarter-research/select_current_krx.py data/kr-quarter-research/expanded/current-provisional/manifest.json data/reliable-strategy-reproduction/2026-09-06-8791951/research-data/panel data/kr-quarter-research/etf-input.json.gz data/kr-quarter-research/expanded/current-liquid-manifest.json --recent data/kr-quarter-research/expanded/current-krx.jsonl.gz data/kr-quarter-research/expanded/current-krx-kosdaq.jsonl.gz
python scripts/quarter-research/prepare_current_inputs.py data/kr-quarter-research/expanded/stock-200-verified-input.json.gz data/kr-quarter-research/etf-input.json.gz data/kr-quarter-research/expanded/current-liquid-manifest.json data/kr-quarter-research/expanded/current-stock-input.json.gz --quarantine-unresolved
node --import tsx scripts/quarter-research/current-signals.ts data/kr-quarter-research/expanded/current-stock-input.json.gz scripts/quarter-research/configs/expanded-frozen.json data/kr-quarter-research/expanded/current-signals.json
python scripts/quarter-research/build_value_evidence.py data/kr-quarter-research data/kr-quarter-research/value/evidence
```

현재 관찰의 `--quarantine-unresolved`는 모든 해당 종목에 미확인 기업행위 이후 실제 일봉만 제공한다. 과거 성과에 같은 처리를 소급 적용한 것은 아니다. 가격 결손 정정용 50종목 비교에는 이전 정책을 유지해 결손 보강의 영향만 측정했다. 이 두 현재 입력의 종목군·자료 적격성 정책을 구분한다.

전체 집계에는 `value-experiments.json`의 모든 실행이 필요하다. 고정 비용·시드·입력 해시·개별 결과를 확인하고 초기 실패 파일은 성공 계좌 집계에 넣지 않는다. 관련 TypeScript 확인에는 `tests/unit/quarterly-value-research.test.ts`와 기존 `tests/unit/low-per-high-roe-rank.test.ts`를 포함한다. 최신 결과와 남은 과제는 `docs/research/kr-current-quarter-value-findings.md`에 있다.


## 미확인 이력·모든 조건 발생일·확인 대기

`configs/entry-experiments.json`의 19개 실행 조합은 후보별 25개 요약·1,091개 완료 계좌를 만든다. 앞선 결과를 덮어쓰지 않는 별도 후속 조사다. 실행기의 마지막 인수 `options.json`은 `starts`(중복 없는 오름차순 실제 거래일), `resetUncertainHistory`, `activationConfirmationBars`를 받는다. 고정 시작점 오류나 미완성 만기를 조용히 제외하지 않으며 옵션 원문 바이트의 해시를 모든 결과에 남긴다.

```bash
python scripts/quarter-research/prepare_entry_dates.py data/kr-quarter-research/expanded/stock-200-verified-input.json.gz scripts/quarter-research/configs data/kr-quarter-research/entry/date-audit.json
node --import tsx scripts/quarter-research/quarter-engine.ts data/kr-quarter-research/expanded/stock-200-verified-input.json.gz data/kr-quarter-research/entry/reproduction-daily-confirmation confirmation scripts/quarter-research/configs/entry-candidates.json 5 204 0 100000000 scripts/quarter-research/configs/entry-confirmation-options.json
node --import tsx scripts/quarter-research/quarter-engine.ts data/kr-quarter-research/expanded/stock-200-verified-input.json.gz data/kr-quarter-research/entry/reproduction-confirm5-confirmation confirmation scripts/quarter-research/configs/expanded-recovery.json 5 204 0 100000000 scripts/quarter-research/configs/entry-confirm5-confirmation-options.json
python scripts/quarter-research/build_entry_evidence.py data/kr-quarter-research data/kr-quarter-research/entry/evidence
pnpm exec vitest run tests/unit/quarter-research.test.ts tests/unit/recovery-quarter.test.ts tests/unit/uncertain-history-quarter.test.ts tests/unit/confirmed-entry-quarter.test.ts
```

날짜 생성기는 성과를 읽지 않고 25% 이상 변동성·20일 양수·20일 이동평균 위인 완성된 창을 고른다. `entry-30-*.json`은 같은 목록의 30% 부분집합이고 `entry-confirm{3,5,10}-*.json`은 그 시작점과 원래 만기를 유지한 최초 확인 대기다. 모든 실행을 재현하려면 실험 목록의 입력·선택·비용·시드·옵션 조합을 지정한 경로에서 완료한 뒤 집계기를 실행한다. 위 `reproduction-*` 예시는 별도 경로이므로 전체 집계 목록을 대체하지 않는다.

가격 이력 옵션은 현재까지 발생한 미확인 사건 이후의 실제 일봉만 신호에 공급한다. 새 순위 결정과 다음 단계 매수 자격에 적용하되 보유 포지션의 실제 가격과 청산은 유지한다. 확인 대기는 처음 조건을 연속 충족한 날에 최초 순위를 정하고, 이후 원래 회전 일정으로 진행한다. `activation`은 조건 확인 완료 기록이며 실제 체결은 `fills`로 판단한다. 만기 청산 신호와 같은 날 확인돼도 주문은 위험 규칙에서 취소될 수 있다. 옵션이 없으면 기존 동작·결과 형식을 유지한다.

집계기는 1,091개 원본 계좌·25개 요약의 해시와 실행 설정을 대조하고 전체 및 비중첩 통계를 다시 계산한다. 공개용 요약은 `docs/research/kr-current-quarter-entry-results/`, 해시 일치 원본은 로컬 `data/kr-quarter-research/entry/`에 있다. [진입일 후속 결과](../../docs/research/kr-current-quarter-entry-findings.md)에 가격 처리 전후, 모든 조건 문턱, 확인 대기와 현재 대기 상태를 함께 기록했다.


## 종목 손절 단일 변수 진단

`configs/position-stop-experiments.json`은 손절 6·12·16%의 개발 월간·조건부 검증·조건부 최근 9개 실험 목록이다. 나머지 매매 코드·위험 규칙은 진입일 연구 커밋 `04eed6d` 그대로다. 연속 확인 대기는 적용하지 않는다. 모든 조합을 완료한 뒤 아래 집계기로 369개 새 계좌와 123개 기본 계좌를 대조한다. 기본 8% 계좌는 `entry/monthly-development` 및 `entry/daily-{validation,confirmation}`에서 같은 시작점만 재사용한다.

```bash
node --import tsx scripts/quarter-research/quarter-engine.ts data/kr-quarter-research/expanded/stock-200-verified-input.json.gz data/kr-quarter-research/position-stop/reproduction-stop12-confirmation confirmation scripts/quarter-research/configs/position-stop-12.json 5 204 0 100000000 scripts/quarter-research/configs/entry-30-confirmation-options.json
node --import tsx scripts/quarter-research/current-signals.ts data/kr-quarter-research/expanded/current-stock-input.json.gz scripts/quarter-research/configs/position-stop-12.json data/kr-quarter-research/position-stop/current-stop12-signals.json
python scripts/quarter-research/build_position_stop_evidence.py data/kr-quarter-research data/kr-quarter-research/position-stop/evidence
```

[종목 손절 결과](../../docs/research/kr-current-quarter-position-stop-findings.md)에 모든 손절값과 비중첩 실패를 함께 기록했다. 추가 월간·비용 평가의 진행 기준을 충족하지 못했으므로 그 후속 평가는 실행하지 않았다. 현재 12% 손절 후보의 첫 목표는 기본 후보와 같지만 보유 후 경로가 달라질 수 있다.


## 회복 종목 선정 기간 단축

`configs/faster-recovery-experiments.json`의 9개 실행은 회복 20일·3종목, 30일·3종목, 20일·5종목의 개발 월간·조건부 검증·조건부 최근 계좌를 만든다. 매매 코드와 기본 8% 손절을 유지하며 직전 12% 손절 결과와 결합하지 않는다. 새 369개 계좌와 이전 40·60일 설정의 동일 시작점 200개를 대조한다.

```bash
node --import tsx scripts/quarter-research/quarter-engine.ts data/kr-quarter-research/expanded/stock-200-verified-input.json.gz data/kr-quarter-research/faster-recovery/reproduction-20-3-confirmation confirmation scripts/quarter-research/configs/faster-recovery-20-3.json 5 204 0 100000000 scripts/quarter-research/configs/entry-30-confirmation-options.json
python scripts/quarter-research/build_faster_evidence.py data/kr-quarter-research data/kr-quarter-research/faster-recovery/evidence
```

집계 전에는 실험 목록의 모든 조합을 지정 경로에서 완료해야 한다. 40일 개발은 이전 가격 이력 정책이 달라 직접 비교하지 않는다. [기간 단축 결과](../../docs/research/kr-current-quarter-faster-recovery-findings.md)에 채택 실패와 미청산을 포함한 모든 결과를 기록했다.


## 2011년 추가 역사 국면

`configs/earlier-experiments.json`의 두 실행은 고정 후보 세 개로 72개 계좌를 만든다. 별도 `earlier` 단계는 2011~2014년이며 현재 확보 입력은 2011-01-03~2012-03-22다. 30% 조건의 18개 시작점과 25%에만 추가되는 6개를 실행하고 35% 부분집합은 재실행하지 않는다. [추가 국면 결과](../../docs/research/kr-current-quarter-earlier-findings.md)에 모두 실패한 결과와 자료 처리의 비교 한계를 기록했다.

`fetch_earlier_krx.py --env-file ... --days-json 'YYYYMMDD 배열' --kinds daily basic`은 기존 앱 인증 환경 안에서 실행하고 stdout gzip을 로컬로 보존한다. 고정 수집 날짜는 `earlier-krx-dates.json`이다. 원본 `krx-sample.jsonl.gz`의 20110103·20110907 두 날짜는 두 종류를 함께 조회한 8개 응답이며, 나머지 302일은 종류별 `krx-daily.jsonl.gz`·`krx-basic.jsonl.gz`다. 이미 받은 날짜는 요청 목록에서 빼고 새 파일에 저장한다. 이 CLI는 원격 환경을 자동으로 찾거나 원문을 자동으로 합치지 않는다. 사용량 원장은 읽기 전용이며 다른 동시 수집기의 호출을 전역 예약하지 않는다.

`fetch_earlier_sources.py --env-file ...`도 같은 인증 환경에서 FRED 관측 API를 호출하고 stdout gzip을 `fred-api.jsonl.gz`로 보존한다. 최초 공개 CSV 경로의 시간 초과 원문 기록은 `fetch-failures.json`에 별도로 남겼다. 인증키가 없는 공개 URL과 허용한 관측 필드만 결과에 남는다. 이전 Npay 지수·VIX·한국은행 저장 원문도 준비해야 한다.

```bash
python scripts/quarter-research/prepare_earlier_input.py data/kr-quarter-research/earlier data/kr-quarter-research/earlier/stock-200-input.json.gz scripts/quarter-research/configs
node --import tsx scripts/quarter-research/quarter-engine.ts data/kr-quarter-research/earlier/stock-200-input.json.gz data/kr-quarter-research/earlier/reproduction-primary earlier scripts/quarter-research/configs/earlier-candidates.json 5 204 0 100000000 scripts/quarter-research/configs/earlier-30-options.json
python scripts/quarter-research/build_earlier_evidence.py data/kr-quarter-research data/kr-quarter-research/earlier/evidence
```

집계 전에는 실험 목록의 `primary`·`extra25` 두 출력 경로를 모두 완료해야 한다. 위 `reproduction-primary` 예시는 별도 계좌 재현용이다. 입력 생성기는 25·30·35% 전체 옵션을 다시 만들며, 25% 전용 추가 옵션은 25% 시작일에서 30% 시작일을 뺀 고정 파일이다. 바이트 재현에는 보존 원문, 같은 출력 파일명과 동일한 의존성 버전을 쓴다. 원자료는 Git에서 제외하며 공개 요약만 저장한다.


## 계좌 낙폭 중단 가정 비교

`configs/account-stop-experiments.json`은 기존 20일·5종목·20봉 회전 모멘텀에 계좌 중단 15·20%를 적용한 4개 실행·154개 계좌다. `accountStopPct` 옵션을 생략하면 기존 10%와 원래 출력 형식을 유지한다. 0 이하·100 이상·유한하지 않은 값·숫자가 아닌 값은 실행 전에 거부한다. 기존 10% 조건부 계좌 77개는 재사용한다.

```bash
node --import tsx scripts/quarter-research/quarter-engine.ts data/kr-quarter-research/expanded/stock-200-verified-input.json.gz data/kr-quarter-research/account-stop/reproduction-stop15-confirmation confirmation scripts/quarter-research/configs/account-stop-candidate.json 5 204 0 100000000 scripts/quarter-research/configs/account-stop-15-confirmation-options.json
python scripts/quarter-research/build_account_stop_evidence.py data/kr-quarter-research data/kr-quarter-research/account-stop/evidence
```

두 값이 고정 진행 기준을 통과해 `account-stop-diagnostics-experiments.json`의 추가 18개 실행·580개 계좌를 진행했다. 개발 월간·2011년에는 기존 이력 처리와 같은 기준의 10% 대조군도 새로 실행한다. 25% 추가 날짜는 30% 계좌와 겹치지 않는 날짜만 실행하고, 35%는 부분집합을 다시 집계한다. `account-stop-condition-dates.json`에 문턱별 전체 날짜를 고정했다. 비용 평가는 원래 30% 날짜에서 슬리피지 10·20bp를 각각 적용한다.

```bash
python scripts/quarter-research/build_account_stop_diagnostics.py data/kr-quarter-research data/kr-quarter-research/account-stop/diagnostics
node --import tsx scripts/quarter-research/current-signals.ts data/kr-quarter-research/expanded/current-stock-input.json.gz scripts/quarter-research/configs/account-stop-candidate.json data/kr-quarter-research/account-stop/current-signals.json
```

집계 전 두 실험 목록의 모든 입력·출력·단계·비용·시드·옵션 조합을 지정 경로에서 완료해야 한다. 기본 집계 후 후속 집계를 실행한다. 위 `reproduction-*`는 전체 집계와 다른 별도 재현 경로다. 현재 신호는 두 중단 설정에서 최초 선정 종목이 같으며 계좌 중단 옵션은 이후 보유 경로에 작용한다. 조건별 성과·과거 실패·실제 낙폭·현재 선정과 검증 기록은 [계좌 중단 비교](../../docs/research/kr-current-quarter-account-stop-findings.md)에 있다.


## 체결 시드·순위 선정 일정 민감도

`configs/execution-stability-experiments.json`은 시드 205·206과 선정일 이동 1·2·3·4의 12개 실행·462개 계좌 목록이다. 원래 시드 204·이동 0 계좌 77개는 재사용한다. 후보와 원래 계좌 시작일·만기·위험 규칙은 계좌 중단 15% 비교 그대로다.

```bash
node --import tsx scripts/quarter-research/quarter-engine.ts data/kr-quarter-research/expanded/stock-200-verified-input.json.gz data/kr-quarter-research/execution-stability/reproduction-offset2-validation validation scripts/quarter-research/configs/account-stop-candidate.json 5 204 0 100000000 scripts/quarter-research/configs/execution-offset2-validation-options.json
python scripts/quarter-research/build_execution_evidence.py data/kr-quarter-research data/kr-quarter-research/execution-stability/evidence
```

집계 전 실험 목록의 모든 조합을 지정 출력 경로에서 완료해야 한다. `rebalanceOffsetBars`는 최초 순위 선정과 뒤따르는 회전 신호를 실제 거래일만큼 늦추며 원래 만기를 늘리지 않는다. 생략은 0이며 0 이상 회전 주기 미만 정수만 허용한다. 이동 뒤 신호일이 없는 창은 거부한다. 위 `reproduction-*`는 별도 재현 경로다. [실행 민감도 결과](../../docs/research/kr-current-quarter-execution-stability-findings.md)에 기준 미달과 실제 목표에 미달한 청산 경로를 함께 기록했다.


## 실제 목표 미달 청산 뒤 매매 재개

`configs/target-retry-experiments.json`은 별도 재개 정책의 초기 6개·조건부 후속 8개 실행 목록이다. `primary`는 시드 204·일정 이동 0·2·4의 231개 계좌이며, 모두 진행 기준을 통과한 뒤 `conditional`의 시드 204·이동 1·3과 시드 205·206·이동 0의 308개 계좌를 실행한다. 전체 실행은 새 539개와 같은 날짜의 기존 539개 계좌를 대조한다.

```bash
node --import tsx scripts/quarter-research/quarter-engine.ts data/kr-quarter-research/expanded/stock-200-verified-input.json.gz data/kr-quarter-research/target-retry/reproduction-offset2-validation validation scripts/quarter-research/configs/account-stop-candidate.json 5 204 0 100000000 scripts/quarter-research/configs/target-retry-seed204-offset2-validation-options.json
python scripts/quarter-research/build_target_retry_evidence.py data/kr-quarter-research data/kr-quarter-research/target-retry/evidence
python scripts/quarter-research/build_target_retry_evidence.py data/kr-quarter-research data/kr-quarter-research/target-retry/evidence --include-conditional
python scripts/quarter-research/analyze_context.py data/kr-quarter-research data/kr-quarter-research/target-retry/context.json target-retry/seed204-offset0-validation target-retry/seed204-offset0-confirmation
pnpm exec vitest run tests/unit/target-retry-quarter.test.ts tests/unit/quarter-research.test.ts tests/unit/uncertain-history-quarter.test.ts tests/unit/confirmed-entry-quarter.test.ts tests/unit/recovery-quarter.test.ts
```

첫 집계는 모든 `primary` 출력이 필요하고 `--include-conditional`은 후속 출력까지 요구한다. 위 `reproduction-*`는 별도 예시 경로다. `resumeAfterMissedTarget`의 기본값은 기존 영구 중단이다. `true`이면 목표 청산 뒤 전량 매도가 끝나 실제 비용 후 수익이 10% 미만일 때 정상 전략 판단을 재개한다. 원래 최고점·낙폭 기준·계좌 자금·만기는 유지하며 부분 청산, 실제 목표 확보, 낙폭 중단, 만기에서는 매수를 허용하지 않는다. 버전은 `+target-retry.1`로 구분하고 재개 현금을 위험 사건에 남긴다. 재개 직후 즉시 임의로 매수하지 않으며 원래 순위 선정·다음 봉 매수 단계를 따른다.

집계기는 재개 시점의 현금과 수량을 체결 내역으로 다시 계산하고, 최초 재개 판단 이전 경로·재개하지 않은 계좌의 기존 결과·원래 만기·최고점 기준 낙폭·개별 비용을 대조한다. 추가 비용은 수수료·매도세·모형 슬리피지 합계이며 슬리피지를 현금에서 이중 차감하지 않는다. [재개 정책 결과](../../docs/research/kr-current-quarter-target-retry-findings.md)에 수익 감소 사례와 현재 조건의 부족한 표본도 함께 기록한다.


## 재개 정책의 비용·조건·과거 구간 진단

`configs/target-retry-diagnostics-experiments.json`은 재개 정책을 유지한 8개 실행·255개 추가 계좌 목록이다. 편도 슬리피지 10·20bp의 154개, 변동성 25%에만 추가되는 31개, 개발 월간 46개, 2011년 24개를 실행한다. 모든 실행이 완료된 뒤 같은 비용·시드·날짜의 기존 영구 중단 계좌와 대조한다. 직전 재개 비교의 기본 77개 계좌도 조건 집계에 재사용한다.

```bash
node --import tsx scripts/quarter-research/quarter-engine.ts data/kr-quarter-research/expanded/stock-200-verified-input.json.gz data/kr-quarter-research/target-retry-diagnostics/reproduction-cost20-confirmation confirmation scripts/quarter-research/configs/account-stop-candidate.json 20 204 0 100000000 scripts/quarter-research/configs/target-retry-diagnostic-stop15-cost20-confirmation-options.json
python scripts/quarter-research/build_target_retry_diagnostics.py data/kr-quarter-research data/kr-quarter-research/target-retry-diagnostics/evidence
```

위 `reproduction-*`는 별도 예시 경로다. 집계기는 원래 고정 실험과 재개 옵션의 차이, 개별 원본 성과와 현금·비용·낙폭을 대조한다. 기존 25·30·35% 조건 날짜를 그대로 사용하며 35%와 2011년의 30·35%는 부분집합 집계다. 전체 비용·조건 결과와 과거 부진을 [후속 진단 결과](../../docs/research/kr-current-quarter-target-retry-diagnostics-findings.md)에 함께 보존한다.
