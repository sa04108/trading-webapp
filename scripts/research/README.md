# 신뢰도 우선 전략 연구 재현

[결과 보고서](../../docs/research/reliable-ten-year-strategy-report.md)의 후보는 **목표 미달**이다.
이 디렉터리는 별도 연구 계산기이며 운영 전략 등록·주문·배포를 수행하지 않는다.

Python 3.12와 `requirements.txt`의 고정 버전을 사용했다. 원문 시세·공시·시장 DB는
Git에 넣지 않는다. 완료된 연구의 비공개 자료 경로는 이 작업 환경의
`/tmp/strategy-research-private`이며 임시 디렉터리이므로 영구 보관을 보장하지 않는다.
접속 호스트·개인키·API 키는 코드와 산출물에 포함되지 않는다.

## 기존 스냅샷에서 재실행

저장소 루트에서 실행한다. 기존 결과 파일은 덮어쓰지 않으므로 새 출력 경로를 사용한다.

```bash
TASK_RESEARCH_DIR=/tmp/strategy-research-private
TASK_PYTHON="$TASK_RESEARCH_DIR/venv/bin/python"

"$TASK_PYTHON" -m unittest discover -s scripts/research -p 'test_*.py'

"$TASK_PYTHON" scripts/research/etf_backtest.py \
  --prices "$TASK_RESEARCH_DIR/us-etf" \
  --fred "$TASK_RESEARCH_DIR/fred_us.jsonl" \
  --output "$TASK_RESEARCH_DIR/replay/qqq-trend-ten-year.json" \
  --start 2016-08-28 --end 2026-08-28 --family qqq_trend

"$TASK_PYTHON" scripts/research/research_backtest.py \
  --data "$TASK_RESEARCH_DIR" \
  --output "$TASK_RESEARCH_DIR/replay/korea-validation.json" \
  --start 2021-08-28 --end 2024-08-27 \
  --family quality --holdings 40 --market-filter

"$TASK_PYTHON" scripts/research/etf_robustness.py \
  --prices "$TASK_RESEARCH_DIR/us-etf" \
  --fred "$TASK_RESEARCH_DIR/fred_us.jsonl" \
  --base "$TASK_RESEARCH_DIR/us-final/full-ten.json" \
  --output "$TASK_RESEARCH_DIR/replay/robustness.json"

"$TASK_PYTHON" scripts/research/etf_index_stress.py \
  --prices "$TASK_RESEARCH_DIR/us-etf" \
  --fred "$TASK_RESEARCH_DIR/fred_us.jsonl" \
  --output "$TASK_RESEARCH_DIR/replay/index-proxy-stress.json"
```

개발 실행 조합과 기간은 [사전 기록](../../docs/research/reliable-ten-year-strategy-protocol.md)에
있다. 모든 완료 실험 요약은 `docs/research/reliable-strategy-results.json`의 `registry`에
보존했다. 국내 결과는 `result`, 미국 결과는 `summary` 필드를 사용한다.
분석기의 상태 필드를 제거하여 인증된 총수익으로 표시하지 않는다.

## 새 자료 수집과 패널 준비

새 조회는 공급자의 과거 정정 때문에 보존 원문과 달라질 수 있다. 원문 SHA-256과
정규화된 가격을 함께 비교한다. 기존 스냅샷의 정확한 재현에는 보존 원문을 사용한다.

```bash
python3 -m venv /tmp/strategy-research-new-venv
/tmp/strategy-research-new-venv/bin/pip install -r scripts/research/requirements.txt
```

운영 DB가 있는 승인된 환경에서 `market_snapshot.py export DATABASE`의 표준 출력을
별도 저장소의 `market.jsonl.gz`로 보낸다. `mode=ro`, `query_only`, 한 읽기 트랜잭션,
허용 시장 테이블만 사용한다. 운영 SQLite 파일을 단순 복사해 WAL과 어긋나게 만들지 않는다.
인증 테이블을 포함한 전체 DB를 내려받을 필요가 없다.

다음은 이미 확보한 로컬 파일을 준비하는 순서다.

```bash
"$TASK_PYTHON" scripts/research/market_snapshot.py import \
  "$TASK_RESEARCH_DIR/market.jsonl.gz" "$TASK_RESEARCH_DIR/market.sqlite"
"$TASK_PYTHON" scripts/research/prepare_panel.py \
  "$TASK_RESEARCH_DIR/market.sqlite" "$TASK_RESEARCH_DIR/panel"
pnpm exec tsx scripts/research/align_snapshot_actions.ts \
  "$TASK_RESEARCH_DIR/market.sqlite" "$TASK_RESEARCH_DIR/aligned_actions.json"
"$TASK_PYTHON" scripts/research/audit_actions.py \
  "$TASK_RESEARCH_DIR/panel" "$TASK_RESEARCH_DIR/aligned_actions.json"
"$TASK_PYTHON" scripts/research/audit_candidates.py "$TASK_RESEARCH_DIR/panel"
"$TASK_PYTHON" scripts/research/fetch_reference_prices.py \
  "$TASK_RESEARCH_DIR/panel" "$TASK_RESEARCH_DIR/reference-prices"
"$TASK_PYTHON" scripts/research/prepare_reference.py \
  "$TASK_RESEARCH_DIR/panel" "$TASK_RESEARCH_DIR/reference-prices"
"$TASK_PYTHON" scripts/research/prepare_annual.py \
  "$TASK_RESEARCH_DIR/dart_annual.jsonl.gz" "$TASK_RESEARCH_DIR/annual.json"
```

DART 원문은 `fetch_dart_annual.py`의 `fetch()`로 조회했다. 입력은 과거 보통주를 공식 `corpCode.xml`의
`short_code -> corp_code`로 연결한 뒤 얻은 회사코드 문자열 목록이다.
일일 사용량 DB를 전달하면 운영 카운터와 이번 호출 수를 합산하여 상한 전에 중단한다.
2015~2025년, 100개 회사씩 330개 배치와 사전 조회 3회를 사용했다. 현재 시점 재조회가
당시 최초 공시 버전을 복원하지는 않는다. 완료 표식이 없는 수집 결과를 재무 입력으로
사용할 수 없다. API 키는 해당 승인 환경의 `DART_API_KEY`에서 읽는다.

KOSPI·KOSDAQ 추세용 입력은 각 `KOSPI-reference.json`, `KOSDAQ-reference.json`이다.
국내 차트와 같은 공개 `fchart.stock.naver.com/sise.nhn`의 일봉 요청에 `symbol=KOSPI`
또는 `KOSDAQ`, `timeframe=day`, `count=3000`, `requestType=0`을 사용했고, EUC-KR XML
`item`의 `data` 문자열 목록을 JSON으로 저장했다. 이 값은 시가 체결가로 쓰지 않는다.

미국 ETF는 `fetch_etf_prices.py DESTINATION`으로 4개 요청을 저장한다. 지정한 시작일보다
응답 이력이 짧을 수 있으므로 실제 날짜를 검사한다. FRED 키가 이미 환경에 설정된 경우:

```bash
"$TASK_PYTHON" scripts/research/fetch_fred.py \
  --series NASDAQ100 DTB3 --start 1999-01-01 --end 2026-09-04 \
  --output "$TASK_RESEARCH_DIR/fred-us-new.jsonl"
"$TASK_PYTHON" scripts/research/fetch_fred.py \
  --series NASDAQ100 DEXKOUS IR3TIB01KRM156N --start 2015-01-01 --end 2026-09-04 \
  --output "$TASK_RESEARCH_DIR/fred-kr-new.jsonl"
```

## 보고서 갱신

`export_research_report.py`는 보존한 실험 디렉터리와 감사 파일을 읽고, 수치 요약·원문 해시·
비교 PNG만 지정 출력 디렉터리에 생성한다. 결과 JSON의 코드 해시는 실행 시점 파일의
해시다. 이 명령은 기존 보고서 산출물을 갱신한다.

```bash
"$TASK_PYTHON" scripts/research/export_research_report.py \
  --data "$TASK_RESEARCH_DIR" --output docs/research
```

원문 가격에 접근할 수 없는 환경에서는 데이터 추출을 검증하는 합성 테스트와 코드
검사까지만 재현할 수 있다. 실제 성과가 재현된 것으로 표시하지 않는다.

## 2차 연구: QLD·GLD 고정 배분

[추가 보고서](../../docs/research/diversified-strategy-report.md)의 남길 후보는 QLD 40%·GLD 60%
월간 재조정이다. 수익 목표와 민감도는 통과했지만 **달러의 사전 샤프·낙폭 관문은 미달**이다.
새 독립 홀드아웃으로 표시하지 않는다. 첫 연구의 실패 기록도 유지한다.

보존 원문이 있는 환경에서는 다음 순서로 실행한다. 아래 `replay-*` 출력은 새 경로여야 한다.

```bash
"$TASK_PYTHON" scripts/research/diversified_data.py \
  --data "$TASK_RESEARCH_DIR" --output "$TASK_RESEARCH_DIR/replay-diversified-panel"

"$TASK_PYTHON" scripts/research/diversified_validation.py \
  --panel "$TASK_RESEARCH_DIR/replay-diversified-panel" \
  --fred "$TASK_RESEARCH_DIR/fred_diversified.jsonl" \
  --issuer "$TASK_RESEARCH_DIR/us-diversification/QQQ-invesco-performance.json" \
  --output "$TASK_RESEARCH_DIR/replay-diversified-validation.json"

"$TASK_PYTHON" scripts/research/export_diversified_report.py \
  --source "$TASK_RESEARCH_DIR/replay-diversified-validation.json" \
  --panel "$TASK_RESEARCH_DIR/replay-diversified-panel" \
  --development "$TASK_RESEARCH_DIR/diversified-development" \
  --output "$TASK_RESEARCH_DIR/replay-diversified-report"
```

기본 계산기 단독 CLI는 기본 원금 10만 달러를 사용한다. 최종 보고서와 같은 1억원·
초기 환전 조건은 `diversified_validation.py`가 적용하므로 단독 CLI 숫자를 원화 보고서와
혼동하지 않는다. 전체 검증은 수분이 걸릴 수 있다.

새 공개 원문은 `fetch_diversified.py NEW_ROOT/us-diversification`으로 수집한다.
GLD의 2010년 이후 차트 두 조각은 기존 `fetch_etf_prices.py NEW_ROOT/us-etf`로 준비한다.
FRED는 다음 네 시리즈를 한 파일로 수집할 수 있다.

```bash
"$TASK_PYTHON" scripts/research/fetch_fred.py \
  --series NASDAQ100 DTB3 DEXKOUS IR3TIB01KRM156N \
  --start 1999-01-01 --end 2026-09-04 \
  --output NEW_ROOT/fred_diversified.jsonl
```

공식 NAV·분할·성과 API는 현재 자료를 제공하므로 나중에 조회하면 기준일과 원문 해시가
바뀔 수 있다. 특히 Invesco 비교는 응답 `effectiveDate=2026-08-31`인 보존 원문을 사용해야
이 보고서와 같은 날짜가 된다. 향후 분할을 포함하는 새 차트와 오래된 분할 CSV를 섞지 않는다.
코드의 2025년 분할 일자 예외는 공식 적용일 근거와 함께 보존되어 있다.

추가 개발 재현에는 `diversified_backtest.py`로 규약의 9개+3개 조합을 실행하고,
`trend_diversified.py --panel PANEL --fred FRED --output NEW_FILE`로 추세 방어 개발 관문을
실행한다. 과거 개발 조합은 당시의 단순 비용 모델을 썼다. Python의 `DiversifiedParameters`에
`minimum_commission_usd=0, commission_per_share=0, sell_fee_rate=0`을 지정하고 원금
10만 달러로 실행하면 초기 비용 모델을 복원한다. 보존된 +651.397483414% 결과의
2,514일 평가액이 이 방식으로 정확히 재현되는 것을 확인했다. 현재 비용 모델의
대조 계산으로 과거 원문 결과를 덮어쓰지 않는다. 추세 방어는 개발에서 실패했으므로 이후
10년을 실행하는 명령을 제공하지 않는다.

## 분배금·오류 시가 추가 감사

[추가 감사](../../docs/research/distribution-data-audit.md)는 20건·21건 분배금 가설을
공식 QLD NAV 총수익과 대조한 뒤 같은 고정 전략의 현금 장부를 비교한다. 두 가설은
인증된 이력이 아니며, 원문 전체의 누락 여부를 통과시킨 것으로 표시하지 않는다.
가격수익 기본 모드는 이전 2,514일·238건 결과와 정확히 같다.

실행 시점 입력 가설은 파생 JSON에 모두 보존돼 있다. 다음 명령으로 새 디렉터리에
복원한다. 기존 경로를 덮어쓰지 않는다.

```bash
"$TASK_PYTHON" - "$TASK_RESEARCH_DIR/replay-distribution-inputs" <<'PY'
import json
from pathlib import Path
import sys

snapshot = json.loads(Path('docs/research/distribution-data-audit.json').read_text())
destination = Path(sys.argv[1])
destination.mkdir(parents=True, exist_ok=False)
for scenario in snapshot['scenarios']:
    with (destination / (scenario['name'] + '.json')).open('x') as stream:
        json.dump(scenario['input'], stream, ensure_ascii=False, indent=2)
PY

"$TASK_PYTHON" scripts/research/distribution_reconciliation.py \
  --panel "$TASK_RESEARCH_DIR/diversified-panel-v2" \
  --fred "$TASK_RESEARCH_DIR/fred_diversified.jsonl" \
  --scenarios "$TASK_RESEARCH_DIR/replay-distribution-inputs" \
  --performance "$TASK_RESEARCH_DIR/data-completion/etf_performance.csv" \
  --prior-validation "$TASK_RESEARCH_DIR/diversified-validation/full-validation-v3.json" \
  --output "$TASK_RESEARCH_DIR/replay-distribution-audit.json"
```

`--prior-validation`에는 기존 v3 원문 또는 같은 파라미터로 재현한 전체 검증 결과를
전달한다. `--performance`에는 2026-08-31 기준 행이 있는 보존 공식 CSV가 필요하다.
공개 주소는 `https://accounts.profunds.com/etfdata/etf_performance.csv`이며, 현재 월로
갱신되는 파일이므로 나중의 다른 기준일을 조용히 대입하지 않는다. 원문 해시는 결과
JSON에 있다. 원문 NAV·시장 패널·환율·CSV가 없으면 당시 실제 성과의 전체 재현을
주장할 수 없다. `/tmp` 원문은 영구 보관소가 아니라는 기존 제한도 유지된다.

계산기 Python 호출의 `distribution_scenario=`에 해당 JSON 객체를 전달하면 미검증
가설임을 명시한 결과만 생성한다. 분배금 권리는 배당락일 시가 주문 전, 현금화는
지급일 시가 주문 후다. `quote_worst`는 오류 봉의 공급된 시가·고가·저가·종가 전체에서
불리한 값을 쓰는 진단이다. 기존 `range_worst`와 엄격 기본값 `fail`은 유지했다.

```bash
"$TASK_PYTHON" -m unittest discover -s scripts/research -p 'test_*.py'
```
