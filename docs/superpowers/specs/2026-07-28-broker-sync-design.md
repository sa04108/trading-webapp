# 증권사 캔들 동기화 (broker sync) 설계

날짜: 2026-07-28
관련: 스펙 §11 §13 §22, D-002, D-018, D-019

## 목적

어댑터(토스·키움)와 Parquet 저장소 사이의 비어 있는 유스케이스를 채운다.
지금은 백테스트 데이터를 사람이 CSV 로 날라야 한다 — 이 구현이 끝나면 자격 증명만
설정하면 시스템이 스스로 데이터셋을 채우고(백필) 유지한다(증분).

수집 정책(대화에서 확정):

- **일봉**: 원하는 종목을 수십 년 백필. 용량 무시 가능 (전 종목 30년 ≈ 0.3GB).
- **1분봉**: 매매·백테스트 유니버스로 한정해 API 최대 깊이까지 백필 + 상시 증분.
- **시간봉**: 수집하지 않는다 — 1분봉 세션 경계 집계로 생성 (스펙 §13, 토스는 1h 미제공).
- 유니버스 = 데이터셋의 심볼 목록. 새 도메인 개념을 만들지 않는다 (§11 데이터셋
  물리 격리와 일치). 수집 중단 밸브 = 심볼 목록에서 제거.

## 추상화 검토 (사용자 요청)

**충분한 것** — `MarketDataSource.fetchCandles(request) → {candles, hasMore}` 는
sync 가 필요로 하는 전부다. 페이지 크기·커서·인증·rate limit·증권사별 응답 형식이
전부 어댑터 뒤에 숨고, 이어받기는 "호출자가 toTsMs 를 좁힌다"는 증권사 중립
계약이다. `CandleRepository`·`aggregateToHourly`·`dataCoverage`·`dataImportJobs`
(sourceType BROKER 예약됨)·`POST /datasets/sync` 501 스텁까지 자리가 파여 있다.

**갭 3개와 보수:**

1. **포트 계약의 에러가 인프라에 정의돼 있다.** `BrokerNotConfiguredError` 가
   broker/infrastructure 에 살아서, sync(애플리케이션)가 이를 잡으려면 §7 위반
   (app→infra import)이 필요하다. → 에러를 포트 옆(`market-data/application/ports.ts`)
   으로 역전한다: `MarketDataSourceNotConfiguredError`, `UnsupportedTimeframeError`.
   어댑터(infra→app, 허용 방향)가 이를 던지고, 기존 broker 쪽 이름은 재export 로 유지.
2. **market-data→broker 금지가 규칙이 아니라 관례다.** dependency-cruiser 에
   strategy·backtest→broker 금지만 있다. → `market-data-no-broker` 규칙 추가로
   포트 역전을 구조적으로 강제한다.
3. **"백필이 바닥에 닿았다"는 상태를 저장할 곳이 없다.** 수집 범위 자체는
   `dataCoverage.firstTsMs/lastTsMs` 가 진실(저장소에서 재계산)이지만, 완료 플래그가
   없으면 매 sync 마다 API 바닥까지 재확인하게 된다. → `broker_sync_state`
   (datasetId, symbol, backfillDoneAtMs) 테이블 신설. 최소 상태만 DB 에 두고
   워터마크는 coverage 를 읽는다.

## BrokerSyncService (market-data/application)

의존: `MarketDataSource`(포트), `CandleRepository`, `DatasetService`(coverage 갱신·
버전 bump 재사용), db(drizzle), clock, logger, 디스크 여유 조회 함수(주입).

`syncDataset(datasetId)` — 심볼별로:

1. **증분**: coverage.lastTsMs 있으면 `[lastTsMs+1, now]` 를 페이지 루프로 수집.
2. **백필**: backfillDoneAtMs 없으면 `[0, (coverage.firstTsMs ?? now)-1]` 을 과거
   방향으로 수집, `hasMore=false` 에서 완료 마킹. 페이지마다 즉시 저장 → 중단돼도
   진행이 저장소에 남고, 다음 실행이 coverage 에서 이어받는다 (스펙 §13).
3. **1h 재집계**: 페이지 단위 집계는 세션 경계에 걸친 반쪽 시간봉을 만들 수 있다
   (뒤가 이기는 idempotent 저장과 결합하면 조용한 오데이터). 그래서 sync 중에는
   1m 만 저장하고, 심볼 수집이 끝난 뒤 이번에 새로 커버된 구간을 저장소에서
   날짜 단위로 스트리밍하며 `aggregateToHourly` 로 집계·저장한다.
4. **기록**: dataImportJobs 에 BROKER 잡 1행(RUNNING→COMPLETED/FAILED, rowsImported),
   coverage 갱신, 버전 bump(백테스트 pinning 용), 감사 로그.

가드:

- **미설정**: 포트 에러를 잡아 잡을 FAILED 로 기록하고 CSV 안내 메시지 — 501 스텁과
  같은 사용자 경험을 잡 결과로 옮긴다.
- **1h 데이터셋**: sync 거부 (시간봉은 집계 산출물 — 소스에 요청하지 않는다).
- **중복 실행**: 같은 데이터셋에 RUNNING BROKER 잡이 있으면 409.
- **고아 잡**: 프로세스 재시작 시 RUNNING 으로 남은 BROKER 잡을 부팅 시
  INTERRUPTED 로 마킹 (`recoverInterrupted()`, container 부팅 경로에서 호출).
- **디스크**: 심볼 시작 전 + 50페이지마다 여유 공간 확인, 임계(기본 2GB) 미만이면
  중단하고 잡에 사유 기록 (§22 "임계치 미달 시 거부"와 같은 원칙).
- **무한 루프**: 빈 페이지 + hasMore=true 조합은 진행이 없으므로 중단.

## 실행 모델

라우트는 잡 행을 만들고 즉시 202 로 jobId 를 반환, 수집은 fire-and-forget 비동기로
진행한다 (진행 조회는 기존 `GET /data-jobs/:jobId`). 백테스트 JobQueue 를 일반화하지
않는다 — 그건 원자적 claim 이 필요한 다중 워커용이고, sync 는 프로세스당 1개
fire-and-forget 이면 충분하다 (YAGNI). 서버가 죽으면 위의 이어받기가 복구 경로다.

## 조립 (bootstrap)

- config: `TOSS_BASE_URL`(기본 https://openapi.tossinvest.com)·`TOSS_CLIENT_ID`·
  `TOSS_CLIENT_SECRET`, `SYNC_MIN_FREE_DISK_MB`(기본 2048).
- container: 자격 증명이 있으면 토스 어댑터, 없으면 null-config 어댑터(포트 에러를
  던지는 기존 동작)를 `MarketDataSource` 로 주입. 증권사 선택은 조립부 전용 지식 —
  애플리케이션은 어느 증권사인지 모른다 (§2.4). 키움 env 는 실 스펙 검증 전이므로
  아직 노출하지 않는다 (D-002 의 비활성 상태 유지).
- routes: `POST /datasets/sync` 501 스텁 교체. body: `{ datasetId }`.

## 범위 밖

- 스케줄러(매일 증분 자동 실행) — 백업 자동화와 함께 나중에 (사용자 결정).
- 1m S3 아카이브 — 보관 깊이 실측 후 (D-019).
- 종목 마스터(전 종목 목록) API — 심볼은 데이터셋 생성 시 사용자가 준다.
- 헬스 대시보드의 디스크 지표 노출 — sync 가드와 별개 작업으로 분리.

## 테스트

단위(BrokerSyncService): fake MarketDataSource·인메모리 저장소로 백필 완료/이어받기/
증분/1h 재집계 경계/미설정/중복 실행/디스크 가드/빈 페이지 중단. 어댑터·저장소는
기존 테스트가 있다. 아키텍처: market-data-no-broker 규칙은 기존 경계 테스트가 잡는다.
