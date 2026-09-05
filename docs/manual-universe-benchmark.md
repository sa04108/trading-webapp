# 유니버스 프리뷰 수동 벤치마크

이 도구는 `2016-09-01..2026-09-02`, 월 1회, KOSDAQ, `MARKET_CAP HIGH 200 → DECLINE HIGH 50 (20일)`, `rsi-reversion` 기본 파라미터 요청을 실제 서버 factory와 HTTP/SSE 라우트로 측정한다. 일반 테스트와 배포 산출물에는 포함되지 않으며 `pnpm cli`에서 명시적으로만 로드된다.

## 안전 조건

- `--database`는 필수다. `/var/lib/quant-platform` 운영 경로는 거부한다.
- controller, 테스트 서버, 준비 child를 추가로 띄우므로 실제 운영 앱이 실행 중인 1GB 호스트에서는 병행하지 않는다. 별도 로컬 검증 머신에서만 실행한다.
- 입력은 `users`, `sessions`, 감사 로그, 알림, 준비/백테스트 job 및 결과 테이블이 모두 빈 market/facts/coverage 전용 sanitized SQLite여야 한다. 한 행이라도 있으면 복사 전에 중단한다.
- 입력 DB는 real path까지 운영 경로가 아닌지 확인하고 `readonly + query_only`로 연다. SQLite online backup으로 `/tmp/qp-universe-benchmark-*`에 WAL까지 반영된 일관된 disposable copy를 만들고, 복제본도 sanitized 조건을 다시 검사한다. 서버와 fixture는 그 복제본만 수정한다.
- KRX/FRED/Toss와 실제 snapshot의 DART URL은 loopback discard port로 고정하고 서버 process의 `fetch`도 deny한다. synthetic fixture에서만 독립 controller의 결정적 DART `013` 응답을 허용한다. 실제 snapshot의 데이터 부족은 외부 요청 금지 실패로 명시되며 성능 성공으로 해석하지 않는다.
- 서버 부팅 복구 루틴은 호출하지 않는다. production `createContainer(..., { preparationExecution: 'forked' })`와 `buildServer`만 사용한다.
- 기본 process-tree RSS 진단 guard는 운영 hard limit와 같은 640MiB, 준비 child 자체 guard는 320MiB, V8 old-space는 exact 2,000종목 검증을 통과한 128MiB, 전체 상한은 15분이다. 두 child 한계는 수동 비교를 위해 명시 옵션으로만 바꿀 수 있고 보고서에 남는다. RSS 합계는 공유 페이지를 중복 계산하므로 systemd cgroup `MemoryCurrent`와 같은 지표가 아니며, `MemoryHigh=512MiB` 통과를 주장하는 수치로 쓰지 않는다. 초과하면 전용 process group과 PID 시작 시각을 확인해 서버와 모든 준비 child를 종료하고 non-zero로 끝낸다.
- readiness 성공 기준은 표본 1개 이상, 실패 0, p95 500ms 이하, max 2,000ms 이하다. 옵션으로 더 엄격하게 조정할 수 있다.

## 실행

실데이터 근거는 승인된 sanitized export로만 만든다.

```bash
pnpm cli universe:benchmark \
  --database /absolute/path/market-facts-snapshot.sqlite \
  --execution forked \
  --server-runtime built \
  --memory-limit-mib 640 \
  --timeout-ms 900000 \
  --output /tmp/universe-proposed.json
```

먼저 `pnpm build:server`를 실행한다. 기본값인 `--server-runtime built`는 부모 앱과 준비 worker를 모두 `dist` JavaScript에서 로드한다. 얇은 manual wrapper만 Node 24 native type stripping으로 실행하며 `tsx` loader를 상속하지 않는다. `source`는 개발 진단 전용이다.

8ba3cff에는 이 CLI dispatch가 없으므로 baseline worktree에 manual scripts뿐 아니라 `src/server/cli.ts`의 `universe:benchmark` dispatch도 임시 이식한 뒤 `--execution inline`으로 실행해야 한다. `--execution inline` 옵션만으로 현재 코드를 과거 구현으로 되돌리는 것은 아니다. `--compare`는 이렇게 같은 도구와 입력으로 별도 생성한 유효 baseline 보고서를 받아 source SHA-256, fixture version, 요청, schedule, diagnostics, warnings까지 fail-closed로 비교한다.

```bash
pnpm cli universe:benchmark \
  --database /absolute/path/market-facts-snapshot.sqlite \
  --execution forked \
  --compare /tmp/universe-baseline.json \
  --output /tmp/universe-proposed.json
```

로컬에 실제 데이터가 없을 때는 새 임시 디렉터리에 migrated 빈 DB를 만든 뒤 scalable smoke fixture를 만들 수 있다. 기존 파일을 지우거나 덮어쓰지 않는 self-contained 예시는 다음과 같다. 이것은 실제 운영 성능 근거가 아니다.

```bash
BENCHMARK_DIR="$(mktemp -d /tmp/qp-universe-benchmark-input.XXXXXX)"
DATABASE_PATH="$BENCHMARK_DIR/empty.sqlite" \
DATA_ROOT="$BENCHMARK_DIR/data" \
IMPORT_ROOT="$BENCHMARK_DIR/imports" \
EXPORT_ROOT="$BENCHMARK_DIR/exports" \
TEMP_ROOT="$BENCHMARK_DIR/temp" \
pnpm cli db:prepare

pnpm build:server
pnpm cli universe:benchmark \
  --database "$BENCHMARK_DIR/empty.sqlite" \
  --synthetic-symbols 2000 \
  --execution forked \
  --server-runtime built \
  --output /tmp/universe-synthetic.json
```

`--synthetic-symbols` 입력이 이미 같은 deterministic fixture라면 symbols/bars/SCD/metrics/action 행 수를 정확히 검증한 뒤 재사용한다. 다른 데이터가 섞여 있으면 중단한다.

보고서는 다음을 담는다.

- 관련 테이블의 행 수와 날짜 범위(원문 행은 출력하지 않음)
- 202 응답 시간, `RUNNING` 관찰 여부, cancel 응답/terminal 시간
- 실제 preparation SSE open 지연과 이벤트 수, 관찰 가능한 phase별 시간
- 별도 controller가 반복 호출한 `/api/v1/health/ready` 지연 p95/max와 최대 heartbeat gap
- 서버와 모든 descendant preparation child를 합한 peak RSS
- 부모의 단계별 `process.memoryUsage`와 `smaps_rollup` PSS/Pss_Anon/Pss_File, 1초 간격 process-tree PSS
- READY 재조회 지연, schedule hash, schedule/union/diagnostic/warning 개수, semantic hash
- git SHA와 tracked/untracked 내용을 합친 dirty diff fingerprint, seed 전 일관된 SQLite backup bytes의 streaming SHA-256, fixture/request fingerprint

timeout, RSS, cancellation, readiness 또는 데이터 준비 실패도 가능한 측정치·마지막 preparation phase·원인을 JSON에 먼저 기록하고 non-zero로 종료한다. `externalDataRequired=true`인 실제 snapshot 실패는 오프라인 준비 상태이며 성능 회귀 판정이 아니다.

`--keep-temp`는 디버깅에만 사용한다. 기본값은 종료 시 disposable 디렉터리를 삭제한다.

WAL snapshot hash와 입력/출력 안전 guard만 빠르게 확인할 때는 빈 migrated DB로 다음 manual smoke를 실행한다. 일반 Vitest에는 포함되지 않는다.

```bash
pnpm exec tsx scripts/manual/universe-benchmark-safety-smoke.ts \
  "$BENCHMARK_DIR/empty.sqlite"
```
