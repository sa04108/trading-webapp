# Universe preview execution findings

## 결론

10년 월별 universe preview의 CPU 병목은 계산 규칙 자체가 아니라, 각 리밸런싱 날짜마다 전체 symbol-master 이벤트를 재구성하고 그 결과를 다시 탐색하던 경로였다. `sharesChangesBetween`을 인접 SCD 행의 SQL projection으로 바꾸고, resolver가 종목별 전체 corporate-action graph를 한 번만 준비하도록 한 뒤 합성 2,000종목 입력에서 동일 결과를 유지하면서 직접 resolver 실행 시간이 573.3초에서 35.2초로 줄었다. `delistedEventsBetween`의 별도 projection도 동일 빈 결과를 유지하면서 1.57초에서 0.18초로 줄었다.

full preparation의 결정적 메모리 병목은 별도로 `candleDataExclusions`가 union 전체의 10년 유효 날짜를 한 번에 `.all()`로 읽고 배열과 `Set`으로 복제하던 경로였다. 합성 입력에서는 약 500만 날짜 행이 동시에 물질화됐다. 따라서 child heap/RSS 상한 조정보다 검증 실행 단위를 실제 active members와 짧은 날짜 창으로 줄이는 것이 필요한 수정이다.

직접 비교 수치는 운영 데이터가 아닌 결정적 합성 SQLite와 `tsx` source runtime에서 얻었다. 별도로 bounded candle 검증까지 적용한 실제 `dist` 서버의 HTTP/cgroup exact 2,000종목 시나리오는 최종 기본값인 128 MiB old-space와 320 MiB child RSS guard에서 완료됐다. 다만 production snapshot export 승인이 없어 운영 데이터 전후 profiling은 하지 못했다.

## 직접 비교 방법

- 기준 코드는 `8ba3cff` detached worktree, 변경 코드는 `fix/universe-preview-execution` worktree를 사용했다.
- 두 실행 모두 같은 SQLite 파일, universe 규칙, 기간, 외부 fetch 0회 조건에서 `resolveOrDescribeNeeds`를 호출했다.
- 결과 종류, schedule/diagnostics 수, union 크기와 정규화된 전체 결과 SHA-256을 비교했고 실행 전후 관련 테이블 행수도 확인했다.
- 200종목 입력 결과는 `/tmp/universe-direct-baseline-200.json`, `/tmp/universe-direct-current-200.json`에, 2,000종목 입력 결과는 `/tmp/universe-direct-baseline-2000.json`, `/tmp/universe-direct-current-2000.json`에 보존했다.
- 합성 2,000종목 DB는 SCD 38,000행, 일봉 5,568,000행, metrics 242,000행, action facts 3,600행이다.

## 합성 입력 결과

| 규모 | 구현 | wall | user CPU | max RSS | shares 누적 | listEvents 누적 |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| 200 | 기준 | 26.680초 | - | 411.3 MiB | 242회 / 15.137초 / 43,920행 | 242회 / 13.042초 / 458,520행 |
| 200 | 변경 | 11.049초 | - | 312.6 MiB | 122회 / 0.694초 / 720행 | 0회 |
| 2,000 | 기준 | 573.347초 | 536.754초 | 558.8 MiB | 242회 / 534.903초 / 439,200행 | 242회 / 155.029초 / 4,585,200행 |
| 2,000 | 변경 | 35.150초 | 31.576초 | 433.7 MiB | 171회 / 1.495초 / 3,960행 | 0회 |

2,000종목 직접 실행은 wall 기준 약 16.3배, user CPU 기준 약 17.0배 단축됐다. 두 구현의 결과 해시는 모두 `74b9e5559c6fe2b8eec057631266b43248072b3dd2109127ba8d3ebabf594b0b`였고, `READY`, schedule 121개, diagnostics 121개, union 1,907개 및 관련 테이블 행수가 일치했다. 200종목 결과 해시도 양쪽 모두 `7939ee91faf3d459dbb51a3c6258eacae77bf457a7ebabc3176895949fee5bc0`로 일치했다.

초기 SQL은 `standard_code + valid_to_date` self join을 사용해 2,000종목에서 140.4초가 걸렸다. 기존 `(standard_code, valid_from_date)` 인덱스를 사용하는 correlated predecessor lookup으로 고친 뒤 위의 35.2초가 나왔다. 140.4초 수치는 최종 구현 성능이 아니라 쿼리 형태의 병목을 확인한 중간 진단 결과다.

측정은 source runtime이었고, 일부 실행 구간에 다른 테스트 또는 HTTP benchmark와 CPU 경합 가능성이 있었다. 따라서 wall 시간은 참고값이며 통제된 운영 benchmark로 해석하면 안 된다. 동일 입력의 결과 해시와 user CPU 차이는 알고리즘 변화의 직접 근거로 사용했다.

## SQL query plan

`/tmp/explain-shares-projection.ts`로 같은 합성 DB에서 확인했다.

- shares의 `after` 행은 `idx_smv_short_code (short_code=?)`를 사용한다.
- 인접 `before` 행은 `idx_smv_code_from (standard_code=? AND valid_from_date=?)`를 사용한다.
- correlated predecessor 후보도 covering `idx_smv_code_from (standard_code=? AND valid_from_date<?)`를 사용한다.
- delisted closing 행은 `idx_smv_valid_to (valid_to_date>? AND valid_to_date<?)`를 사용한다.
- delisted exact successor는 covering `idx_smv_code_from (standard_code=? AND valid_from_date=?)` LEFT JOIN을 사용한다.
- 두 projection 모두 최종 결정적 정렬에 임시 B-tree를 사용한다. 새 migration이나 index는 추가하지 않았다.

## Delisted projection

같은 2,000종목 DB에서 `delistedEventsBetween`만 따로 측정한 결과는 다음과 같다. 원본은 `/tmp/universe-direct-delisted-before-2000.json`, 변경 결과는 `/tmp/universe-direct-delisted-after-2000.json`에 있다.

| 구현 | wall | listEvents | 호출 전후 RSS | max RSS |
| --- | ---: | ---: | ---: | ---: |
| 전체 이벤트 재구성 | 1.568초 | 1회 / 1.560초 / 37,600행 | 244.2 → 305.3 MiB | 305.3 MiB |
| SQL projection | 0.177초 | 0회 | 228.9 → 235.4 MiB | 275.8 MiB |

두 결과는 모두 빈 배열이며 해시 `4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945`로 일치했다. exact successor, gap 이후 재개, 실제 재상장, 첫 관측일 baseline, 범위 경계, 빈 short code 경고 동작은 focused test로 고정했다.

## 의미 보존과 검증

- resolver cache는 resolve 호출 안에서만 존재하고 종목별 전체 action graph를 보존한다. 좁은 가격 창 밖의 경쟁 action이 창 안의 assignment를 바꾸는 기존 의미를 유지한다.
- share 변화는 날짜/short code pushdown, 관측일 baseline, 같은 standard code의 연속 SCD predecessor, gap 제외, 양의 유한 주식수 입력 및 문자열 값 변화(`100` 대 `100.0`) 의미를 유지한다.
- 최종 full suite는 161개 파일의 1,848개 테스트가 모두 통과했고 failed/pending은 0개였다. job-queue 61개와 orchestrator 42개 focused test, typecheck, lint, build도 통과했다. 전체 Vitest 보고서는 `/tmp/universe-preview-final-vitest.json`에 있다.
- 그 전에 수행한 알고리즘 focused 3개 파일 83개 테스트, scoped non-trading-day focused 12개 테스트와 관련 광역 회귀 8개 파일 127개 테스트도 통과했다.
- 첫 full suite에서 job-queue 35개가 실패한 원인은 worker 전용 test fixture가 폐기된 "전체기간 단일 valid-date 호출" 형태에 결합돼 있었기 때문이다. helper만 요청 기간의 실제 봉 eligibility와 batch 날짜를 반환하도록 보완했고 제품 검증이나 assertion은 완화하지 않았다.
- cache는 호출 간 공유되지 않는다. 호출 중 동시 SCD 갱신까지 단일 snapshot으로 보장하려면 DB transaction 또는 epoch가 필요하므로, 실행 격리와 최종 fresh identity/stabilization 검증이 여전히 필요하다.

## 결정적 메모리 병목

기존 `candleDataExclusions`는 schedule union 1,907개 종목에 대해 전체 10년 구간의 유효 일봉 날짜를 `getValidDatesByCodeBetween(...).all()`로 읽었다. 서비스가 종목별 날짜 배열을 만든 뒤 orchestrator가 다시 종목별 `Set`을 만들어, 원본 query rows와 배열·Set 표현이 한 실행 안에서 겹쳤다.

이 검증과 전체기간 적재 구현은 `ef91fb4`(`fix(backtest): exclude symbols with incomplete source data`)에서 함께 도입됐다. 이는 최근 안전성 검사 추가 뒤 메모리가 증가했다는 관찰과 일치한다. 누락 source data를 제외하는 검증 목적이나 결과를 되돌리지 않고, 전체기간을 한 번에 적재하던 조회 범위와 실행 단위만 바꾼다.

원본 날짜 행을 읽지 않고 `/tmp/universe-direct-2000.sqlite`에 worker와 동일한 valid-date predicate의 집계 SQL만 실행했다. 2016-09-01부터 2026-09-02까지 종목마다 2,610개 유효 날짜가 있었으므로, 이 fixture의 실제 union 1,907개에 대한 기존 query 결과는 정확히 4,977,270행이었다.

변경 경로는 동일 schedule을 순회하되 실제 active 50개 종목만, 최대 31 calendar-day 단위로 같은 valid-date predicate와 scoped non-trading-day query를 실행한다. 전체 기간에는 active 50개×2,610일인 130,500쌍을 빠짐없이 검사하지만, 한 번의 query가 물질화하는 최대치는 50개×31일인 1,550행이고 실제 유효 거래일만 보면 더 작다. 즉 검증량이나 의미를 줄이는 것이 아니라 약 498만행과 그 복제본이 동시에 살아 있던 cardinality를 작은 실행 단위로 낮춘다. 전체 누락일 수와 첫 누락일, 거래정지 및 상장폐지 제외 의미는 유지한다. 이는 결과 수집 전에 임의로 차단하는 방식이 아니라 동일 검증의 실행 단위를 재설계하는 것이다. child RSS cap은 320 MiB를 유지하고, bounded 경로 검증 결과에 따라 기본 old-space는 128 MiB로 정했다.

## 운영 및 최종 검증

### 최종 기본값 actual cgroup

최신 `dist/server/bootstrap/main.js`를 최종 기본값인 old-space 128 MiB, child RSS guard 320 MiB와 `MemoryHigh=512 MiB`, `MemoryMax=640 MiB`에서 실행한 exact 2,000종목 준비는 163.044초에 `COMPLETED`로 끝났다. READY replay POST도 83.560초에 HTTP 200을 반환했고 schedule 121개, diagnostics 121개, union 1,907개, warnings 0개였다. schedule hash는 `9bea1202071c9be63730ca43a99d49ff1f88d7d7f95e777397cac1224ebdfe9f`, harness semantic hash는 `22bc0fbd62230eb6d4e08a4d1e8ec4c71f7e93cccb1392e0b9625913e6bf7d90`이다.

completion 중 readiness 1,541회와 replay 중 771회는 모두 실패가 없었고 최대 응답은 각각 177.4 ms와 209.5 ms였다. 최대 관측 간격은 278.5 ms였고 취소 검증도 3.830초에 통과했다. cgroup peak는 537,387,008 B(512.5 MiB), `memory.high` event는 12,156회였으며 max, OOM, OOM-kill event는 모두 0회였다. 서비스도 inactive 상태로 정상 종료했다. 상세 결과는 `/tmp/qp-cgroup-universe-final128.ArMwzl/cgroup-final-result.json`에 있다. 이로써 최종 기본값의 exact 2,000종목 end-to-end 완료와 HTTP 격리·취소 복구를 확인했다.

### 운영 데이터 한계

변경 전 운영 요청에서는 취소 전 CPU 약 84%, RSS 약 260 MiB와 readiness timeout이 관찰됐고, 취소 후 readiness가 회복됐다. 다만 production snapshot export 승인이 없어 운영 데이터로 직접 전후 profiling하지 못했다.

### 진단 이력

bounded candle 변경 전에 최종 shares query와 delisted projection만 적용한 full HTTP/cgroup 재검증에서는 당시 192 MiB old-space 설정의 2,000종목 준비가 158.4초 후 `RESOLVING_STAGES` child RSS 326 MiB가 320 MiB guard를 넘어 중단됐다. 이전 측정의 331 MiB보다 5 MiB 낮아졌지만 완료 조건은 충족하지 못했다. `memory.high=512 MiB`, `memory.max=640 MiB`에서 cgroup peak는 512.5 MiB, `memory.high` event는 7,340회, max/OOM event는 0회였다. readiness 1,498회는 실패가 없었고 최대 응답 182 ms, 최대 관측 간격 272.6 ms였으며, 취소는 3.9초에 완료됐다.

bounded candle 변경 전의 이전 구현에서 GC를 더 일찍 유도한 128 MiB old-space 재검증은 156.5초 후 같은 phase에서 V8 live heap 부족으로 SIGABRT했다. cgroup peak는 512.5 MiB, `memory.high` event는 7,172회, max/OOM event는 0회였고 readiness 1,483회는 실패가 없었다. 이 결과는 대량 행 적재가 남은 구현에 heap tuning만 적용할 수 없다는 근거이며, 아래 bounded 128 MiB 성공 결과와 모순되지 않는다.

약 500만 날짜 행 동시 적재를 제거한 bounded candle 코드는 별도의 RSS 640 MiB CLI 진단 환경에서 36.2초 후 child RSS 322.4 MiB가 320 MiB guard를 넘어 중단됐다. 이 실행은 위의 실제 cgroup 실행과 조건이 다르고 SSE 진행 이벤트도 65개뿐이어서 첫 121개월 resolver pass를 마치기 전에 종료했을 가능성이 높다. 따라서 158.4초와 36.2초를 비교해 시간 단축 근거로 사용할 수 없으며, 두 값은 서로 다른 환경의 실패 시점일 뿐이다. raw tree RSS diagnostic은 595.3 MiB로 640 MiB 미만이었고 PSS는 509.5 MiB였다. readiness 359회는 실패가 없었으며 p95 18.6 ms, 최대 171.1 ms, 최대 관측 간격 192.6 ms였고 취소는 3.8초에 완료됐다. 상세 결과는 `/tmp/universe-http-final-2000.json`에 있다.

bounded 경로의 192 MiB old-space 교차 검증도 실제 `dist/server/bootstrap/main.js`, `MemoryHigh=512 MiB`, `MemoryMax=640 MiB`, child RSS guard 320 MiB 조건에서 같은 exact 2,000종목 준비를 163.637초에 `COMPLETED`로 마쳤다. READY replay POST도 83.256초에 HTTP 200을 반환했고 schedule 121개, diagnostics 121개, union 1,907개, warnings 0개였다. schedule hash와 harness semantic hash는 최종 128 MiB 결과와 같았다.

completion 중 readiness 1,554회와 replay 중 768회는 모두 실패가 없었고 최대 응답은 각각 224.2 ms와 219.6 ms였다. 취소 검증도 3.900초에 통과했다. cgroup peak는 537,391,104 B(512.5 MiB), `memory.high` event는 12,057회였으며 max, OOM, OOM-kill event는 모두 0회였다. 서비스 stop까지 완료했고 상세 결과는 `/tmp/qp-cgroup-universe-bounded.pN5jLR/cgroup-final-result.json`에 보존했다. 이로써 192 MiB old-space 조건의 exact 2,000종목 end-to-end 완료와 HTTP 격리·취소 복구를 확인했다.

최종 기본값으로 선택한 128 MiB old-space의 표준 CLI exact 2,000종목 검증도 116.768초에 `COMPLETED`로 끝났고 READY replay는 56.882초에 HTTP 200을 반환했다. schedule 및 semantic hash는 최종 cgroup 결과와 정확히 같았다. child peak는 304.3 MiB로 320 MiB guard 아래였고 raw process-tree RSS는 585.7 MiB, PSS는 493.2 MiB였다. readiness 2,137회는 실패가 없었으며 p95 14.3 ms, 최대 179.2 ms였고 취소는 3.682초에 완료됐다. 상세 결과는 `/tmp/universe-http-final-2000-oldspace128.json`에 있다.
