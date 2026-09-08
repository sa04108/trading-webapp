# 국내 단기 국면 연구 재현

실제 등록 전략과 같은 `runBacktest` 엔진을 사용한다. 운영 DB에 쓰거나 주문을 내는 경로는 없다. 새 `trend-pullback`은 이 디렉터리의 연구 후보이며 운영 레지스트리에 등록하지 않았다. 국면 매수 제한·청산은 연구용 `withRegime`이 적용하므로, 웹에서 같은 전략 파라미터만 입력한 결과와 같다고 가정하면 안 된다.

## 입력과 환경

- Node.js 24, 저장소의 pnpm 의존성.
- Python 3.12와 `requirements.txt`. 별도 가상환경을 권장한다.
- 기존에 보존된 `data/reliable-strategy-reproduction/2026-09-06-8791951/research-data/`의 `market.jsonl.gz`, `panel/*.npy`, `fred.jsonl`.
- 추가 공개 자료: Cboe VIX 일별 API, 한국은행 기준금리 변경 이력, Npay KOSPI 일별 차트 API. `--fetch`는 파일이 없는 경우에만 이 세 원문을 받아 로컬에 저장한다. 인증 키는 필요 없다.
- 모든 시장 원문, 개별 거래내역, 입력 번들은 Git에서 제외된 `data/kr-regime-research/`에 보존한다. 공개 집계는 `docs/research/`에 있다.

```bash
python3 -m venv /tmp/kr-regime-venv
/tmp/kr-regime-venv/bin/pip install -r scripts/research/requirements.txt
/tmp/kr-regime-venv/bin/python scripts/research/prepare_kr_regimes.py \
  data/reliable-strategy-reproduction/2026-09-06-8791951/research-data \
  data/kr-regime-research --fetch
node_modules/.bin/tsx scripts/research/kr-regime-engine.ts \
  data/kr-regime-research/input-50.json.gz data/kr-regime-research/replay-development development
/tmp/kr-regime-venv/bin/python scripts/research/analyze_kr_regimes.py \
  data/kr-regime-research/input-50.json.gz data/kr-regime-research/replay-development \
  data/kr-regime-research/replay-development-summary.json --select
```

실행 인자를 생략한 개발 탐색은 기존 7개 전략 × 3개 파라미터 × 4개 국면, 총 84개다. 명시적인 후보 배열 JSON을 네 번째 인자로 주면 그 후보만 실행한다. 다음 선택 인자는 비용 배수, 시드, 거래불가일 보강 JSON 경로다. 보강 파일은 실행 결과에 SHA-256을 별도로 남긴다. 비용 배수는 수수료·슬리피지만 바꾸며 법정 매도세는 그대로 둔다.

```bash
node_modules/.bin/tsx scripts/research/kr-regime-engine.ts \
  data/kr-regime-research/input-50.json.gz data/kr-regime-research/replay-existing-validation \
  validation docs/research/kr-existing-development.diagnostic.json
```

`development`는 2016–2019, `validation`은 2020–2022, `confirmation`은 2023–2026-08-28이다. 워밍업은 평가 기간 밖에서 공급하고 초기 현금은 매번 1억원이다. 기간 마지막 전 거래일에 청산 신호를 내며, 마지막 날까지 청산되지 않은 보유분은 결과에 남는다.

새 전략 조합은 `pullbackCandidates()`가 반환하며 `config/pullback-trials.json`에 고정했다. 확장 36개는 `config/liquid-trials.json`, 추가 관심 후보는 `config/liquid-momentum-20-frozen.json`에 있다. 진입 RSI 5·10·15만 바꾸며 10이 기본값이다. 새 전략의 자체 5봉 상한은 유지된다. 모든 전략에 적용하는 공통 보유 상한은 20거래일이며 정지·부분체결 때문에 실제 청산은 더 늦을 수 있다.

## 거래대금 100종목 확장

```bash
/tmp/kr-regime-venv/bin/python scripts/research/prepare_kr_regimes.py \
  data/reliable-strategy-reproduction/2026-09-06-8791951/research-data \
  data/kr-regime-research --universe-size 100 --ranking liquidity
```

확장 실행에서는 `scripts/research/config/execution-overrides.json`을 마지막 인자로 지정한다. 한국항공우주 2017-10-11 거래정지일에 정규장 OHLC가 없는 것을 추가 API 원문과 당시 보도로 확인한 보강이다. 원가격을 채우지 않고 그 날짜의 체결만 금지한다. 파일에는 출처와 원문 해시가 있다.

```bash
node --max-old-space-size=4096 --import tsx scripts/research/kr-regime-engine.ts \
  data/kr-regime-research/input-100.json.gz data/kr-regime-research/replay-liquid-confirmation \
  confirmation scripts/research/config/liquid-momentum-followup.json 1 204 \
  scripts/research/config/execution-overrides.json
```

현재 상장 종목을 소급하지 않고 월별 과거 종목군을 복원한다. 여러 해 동안 선정됐던 종목의 합집합은 매월 보유 후보 수보다 크다. 큰 번들은 로컬에서 직렬로 실행하고 필요하면 `node --max-old-space-size=4096 --import tsx`를 사용한다. 운영의 소형 서버에서 대규모 탐색을 실행하지 않는다.

## 감사와 해석

- `input-*-audit.json`에 시장 snapshot·패널·FRED·추가 원문의 SHA-256, 종목 수, 가격 공백, 가격단위 보정 사건이 있다.
- 가격은 KRX 실제 OHLC다. 분할 형태의 큰 단위 변경은 독립 차트의 수정계수로 보정했다. 이는 현금배당·합병·신주 권리 및 신주 매도 가능일을 모두 인증한 처리가 아니다. 미해결 단위 변경을 보유 중 통과한 거래는 후보 기준에서 탈락한다. 작은 미확인 권리나 공급자 정정은 추가 위험으로 남는다.
- 한국 장 마감 전의 미국 데이터만 쓰도록 미국 지수·VIX·환율은 엄격하게 이전 날짜를 선택한다. 금리 변경도 다음 날짜부터 적용한다. 국내 KOSPI 종가는 당일 확정치를 사용한다.
- 벤치마크는 NDX 가격지수다. 원화 NDX는 달러 지수 × 원/달러 환율이다. 한국의 첫 평가 관측부터 마지막 관측까지의 전체 성과와 국면 비교 성과를 따로 기록한다.
- 국면 비교는 진입 가능한 날부터 청산일까지다. 정지로 청산이 늦어지면 양쪽 구간을 함께 연장한다. 국면 밖 손익이 하나라도 남으면 집계가 실패한다. 좋은 거래만 남기는 비교가 아니다.
- 현금 이자는 0, 국내 현금배당 제외, 투자자별 소득과세 전이다. 거래비용은 날짜별 매도세·편도 수수료 1.5bp·슬리피지 5bp·KRX 호가와 직전 거래량의 1% 체결 한도다. 실제 시가 갭으로 진입 후 비중이 신호 기준 목표 20%를 넘을 수 있다.
- 재무 전략은 원문에 있는 공시 시각만 사용한다. 부족한 TTM 이력을 최신 연간 재무로 대체하지 않는다. 재무 전략의 무거래나 적은 거래는 전략 자체의 무효를 입증하지 않는다.
- 이전 연구에서 다른 전략으로 같은 시장 기간을 보았다. 이 연구의 마지막 기간도 완전히 새로운 블라인드 표본은 아니다. 블록 재표본 구간은 선택된 과거 경로에 조건부인 진단이며 미래 승률이나 선택 편향 보정 인증이 아니다.

## 검증

```bash
/tmp/kr-regime-venv/bin/python -m unittest discover -s scripts/research -p 'test_kr_regimes.py'
node_modules/.bin/vitest run tests/unit/kr-regime-research.test.ts tests/unit/trend-pullback-research.test.ts
pnpm lint && pnpm typecheck && pnpm test && pnpm build
```

집계 도구는 매 실행의 자산·체결·거래 증거에서 비교 구간을 다시 계산한다. 최초 개발 실행에서 발견한 리밸런싱 간격 오류의 결과는 `data/kr-regime-research/development/`에 보존하고, 수정 후 유효한 결과는 `development-v2/`를 사용한다. 새 입력을 준비할 때 생성 시각 메타데이터는 달라질 수 있으므로, 보존된 입력 번들의 해시로 완전히 같은 입력인지 확인하고 결과 재실행에서는 계산 시간 필드를 제외해 비교한다.
