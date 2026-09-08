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

인수는 `입력.gz 출력폴더 단계 [후보.json] [슬리피지bp] [시드] [앞에서 실행할 창 수 또는 0] [초기현금]` 순서다. 단계는 `development`, `validation`, `confirmation`이다. 출력 폴더는 새 경로를 권장한다. 같은 경로를 재사용하면 같은 이름 결과를 덮어쓰므로 실패 원본은 먼저 보존해야 한다.

월 첫 실제 거래일부터 달력 3개월 계좌를 시작하며 전체 창이 단계와 자료 기간 안에 있어야 한다. 기존 전략의 종가 신호·다음 시가 체결·두 단계 회전을 그대로 따른다. 주식 세금은 날짜별 프로필, ETF 세금은 0, 수수료는 편도 1.5bp, 기본 슬리피지는 5bp, 직전 거래량의 1% 체결 한도를 사용한다. ETF 가격 2천원 미만도 5원 호가를 적용하는 보수적 단순화가 있다.

평가액 +10.5%에서 청산 신호를 내도 실제 비용 후 수익이 10% 미만이면 실패다. 미청산·확인되지 않은 기업행위 보유도 목표 달성으로 세지 않는다. 계좌 고점 대비 10% 낙폭 중단은 갭 이후의 실제 손실 상한을 보장하지 않는다. 3개월 만기 전 마지막 신호 뒤에도 거래량 한도로 남은 포지션은 임의로 체결시키지 않는다.

## 현재 신호와 집계

```bash
python scripts/quarter-research/fetch_current_stocks.py data/kr-quarter-research/current-stocks-20260908 data/reliable-strategy-reproduction/2026-09-06-8791951/research-data/panel
python scripts/quarter-research/prepare_current_inputs.py data/kr-quarter-research/quality-stock-input.json.gz data/kr-quarter-research/etf-input.json.gz data/kr-quarter-research/current-stocks-20260908/manifest.json data/kr-quarter-research/current-stock-input.json.gz
node --import tsx scripts/quarter-research/current-signals.ts data/kr-quarter-research/current-stock-input.json.gz scripts/quarter-research/configs/current-candidates.json data/kr-quarter-research/current-signals.json
python scripts/quarter-research/build_evidence.py data/kr-quarter-research data/kr-quarter-research/evidence
```

현재 신호 입력으로 과거 분기 성과를 실행하면 거부한다. 현재 가격 50종목은 원래 자료와 겹친 150일봉의 OHLCV 전부가 일치한다. 최신 기업행위의 공식 수집 범위는 기존 팩트까지만이며 이후의 일별 31% 초과 단위 변화는 중단·확인하도록 했다. 이 가격 변화 검사만으로 모든 기업행위가 검증되는 것은 아니다.

연간 실적은 접수일 다음 날 이후에만 사용한다. 최신 정정값을 최초 공시일로 소급하지 않지만 과거 최초 공시 빈티지가 완전하지 않다. 2014년 연간 자료가 없어 두 해 실적이 필요한 전략은 2016년 상당 부분에서 진입 자격이 없다. FRED 일별 자료는 관측일 +7일, 수출은 월초 관측일 +90일의 공개 지연 가정이며 개정 이력을 갖춘 인증된 시점 자료가 아니다. 월별 물가와 국제 정세는 현재 환경 해석에 사용한다.

## 확인

```bash
python -m unittest discover -s scripts/quarter-research -p 'test_*.py' -v
pnpm exec vitest run tests/unit/quarter-research.test.ts tests/unit/annual-quality-quarter.test.ts tests/unit/recovery-quarter.test.ts
pnpm exec eslint scripts/quarter-research/*.ts tests/unit/quarter-research.test.ts tests/unit/annual-quality-quarter.test.ts tests/unit/recovery-quarter.test.ts
pnpm exec tsc -p tsconfig.server.json --noEmit
```

RSI 개발 실행 중 평가 종료 뒤 상장폐지 일정이 엔진 시간축으로 넘어가던 연구 입력 문제가 발견됐다. 실패 응답은 `rsi-input-boundary-failure.json`에 보존하고 종료일 이후 일정을 제외해 다시 실행했다. 운영 엔진은 바꾸지 않았다. 기존 완료된 대표 후보의 재실행과 원본 계좌 결과 비교를 별도로 기록한다.
