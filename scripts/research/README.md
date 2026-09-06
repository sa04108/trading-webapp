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
