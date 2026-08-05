# 종목 마스터 (point-in-time security master) 설계

날짜: 2026-08-05
브랜치: feat/symbol-master

## 배경

데이터셋("현재 종목 리스트")과 시점 고정 스냅샷은 백테스트에 맞지 않는 개념이다.
백테스트는 거래 기간 내내 변하는 유니버스를 시점별로 재구성해야 한다.
모든 날짜의 전체 스냅샷을 저장하면 용량을 낭비하므로,
기준 스냅샷(체크포인트)과 변경 이벤트(delta)만 저장한다.

이 구조의 업계 표준 명칭은 point-in-time security master다.
화면·문서에서는 **종목 마스터**, 코드에서는 `symbolMaster` 접두어를 쓴다.

## 결정 사항

| 항목 | 결정 |
|---|---|
| 명칭 | 종목 마스터 (`symbolMaster*`) |
| delta 기록 단위 | 영업일 |
| 체크포인트 간격 | 분기 말 (검증 앵커 겸용) |
| 백필 범위 | 10년 |
| 소유 구조 | 전역 단일 코퍼스. 사용자가 만들지 않는다 |
| 저장 대상 | 구성원부(상장·폐지·시장·유형·이름) + 상장주식수 |
| 저장 제외 | 시가총액·순위(가격×주식수로 계산), 재무 수치(추후 별도 분기 테이블) |
| UI | 타임머신 중심 뷰, 미수집 날짜는 빈 상태(근사값 미표시) |
| 동기화 의미 | KRX 온디맨드 수집. 표 재구성은 로컬 연산이라 항상 자동 |

## 데이터 모델

새 테이블 4개.

```
symbolMasterCheckpoints        — 분기 말 전체 스냅샷 (검증 앵커 + 재구성 시작점)
  id, checkpointDate, source, verifiedAt, createdAt

symbolMasterCheckpointSymbols  — 체크포인트 시점 종목 전량
  checkpointId, standardCode, shortCode, name, market,
  sharesOutstanding, instrumentType, listedDate

symbolMasterEvents             — 변경 이벤트 (delta)
  id, effectiveDate, standardCode, eventType, oldValue, newValue, observedSpan
  eventType: LISTED | DELISTED | MARKET_MOVED | SHARES_CHANGED
           | NAME_CHANGED | TYPE_CHANGED

symbolMasterCoverage           — 수집 완료 날짜 구간
  startDate, endDate, syncedAt

symbolMasterMarketCaps         — 시총 랭킹 레이지 캐시
  date, standardCode, marketCapKrw
  백테스트가 리밸런스 날짜 랭킹을 요청할 때만 KRX에서 받아 저장한다.
  재실행 시 오프라인 재현을 보장한다. 요청된 날짜만 저장하므로 희소하다.
```

종목 마스터는 전 종목을 저장한다. `instrumentType`에는 `classifyKrxIssue` 결과
(`COMMON_STOCK` 또는 제외 사유)를 그대로 넣고, 필터 정책은 읽기 시점에 적용한다.

`observedSpan`은 diff 기준 구간(직전 수집일~당일)이다.
갭을 건너뛴 온디맨드 수집이면 구간이 넓어지고,
이벤트 날짜가 근사값임을 데이터 자체가 드러낸다.
갭 구간 안에서 상장 후 폐지된 종목은 이벤트에 남지 않는다.
정밀한 이력은 백필이 연속 수집으로 채울 때 완성된다.

제거 대상: `datasets`, `datasetSymbols`, `universeSnapshots`, `universeSnapshotSymbols`
테이블과 `DatasetService`, `UniverseSnapshotService`, `DatasetsPanel`, `KrxSnapshotStep`.

### 재구성

`getUniverseAsOf(date)`:
date 이하 가장 가까운 체크포인트를 로드한 뒤 이벤트를 순차 적용한다.
체크포인트 이전 날짜면 역방향으로 적용한다(oldValue 사용).

## 수집 파이프라인

경로 3개가 같은 코어를 공유한다.

```
ingestDate(date):
  1. KRX에서 date 전체 유니버스 조회 (krx-historical-universe-source 재사용)
  2. getUniverseAsOf(직전 수집일) 결과와 diff
  3. 변경분만 symbolMasterEvents에 기록 (effectiveDate=date, observedSpan=직전 수집일~date)
  4. coverage 구간 갱신
```

1. **일일 동기화** — 매 영업일 장 마감 후 스케줄 실행.
   마지막 수집일 다음날부터 오늘까지 순차 ingest해 갭을 자동 보정한다.
2. **백필 잡** — 10년치를 과거에서 현재로 진행한다.
   분기 말 도달 시 체크포인트를 저장한다.
   중단하면 coverage를 보고 이어서 재개한다. 진행률을 UI에 노출한다.
3. **온디맨드** — 타임머신에서 미수집 날짜 요청 시 단일 날짜만 ingest한다.
   자동 동기화 체크박스가 켜져 있거나 수동 버튼을 눌렀을 때만 동작한다.

### KRX 호출량

엔드포인트(시장별 기본정보·일별매매)는 날짜당 벌크 응답이다.
날짜 1개 ingest = 총 4호출 = 엔드포인트당 2호출.

- 일일 동기화: 엔드포인트당 2호출/일 (한도 10,000의 0.02%)
- 10년 백필 전체: 엔드포인트당 4,920호출 — 하루 한도 안

백필 잡에 일일 호출 예산(기본 8,000/엔드포인트, 설정 가능)을 두고,
예산 소진 시 중단 후 다음날 재개한다.
기존 `todayCallCount()`와 `KrxQuotaError`(429)를 재사용한다.

일별매매 응답에 OHLCV가 포함된다.
같은 호출로 가격 데이터를 저장해 캔들 수집과 일원화할 여지가 있다(이번 범위 밖).

### 검증 (분기 체크포인트)

백필·일일 동기화가 분기 말을 지날 때:

1. 이벤트 재구성 결과와 KRX 실조회를 diff한다.
2. 일치하면 `verifiedAt`을 찍고 체크포인트를 저장한다.
3. 불일치하면 KRX 실측값으로 체크포인트를 저장하고 불일치 내역을 로그와 UI에 남긴다.
   이후 재구성은 이 체크포인트에서 시작하므로 오류가 전파되지 않는다.

KRX 조회 결과가 빈 날짜는 휴장으로 처리한다. coverage에 포함하되 이벤트는 없다.

## UI

### 종목 마스터 화면 (타임머신 뷰)

- 상단 컨트롤 바: 날짜 이동(◀ ▶), 자동 동기화(KRX) 체크박스, [지금 동기화] 버튼
- 타임라인 슬라이더: 수집 완료 구간 진하게, 미수집 구간 빗금, 분기 체크포인트 마커
- 메인: 선택 날짜 기준 유니버스 표
  (코드·이름·시장·상장주식수·상장일, 검색·시장 필터·정렬)
  + 마지막 수집·체크포인트 검증 상태 표시
- 사이드 패널: 선택 날짜 근처 변경 이벤트 (클릭 시 상세)
- 미수집 날짜(자동 동기화 꺼짐): 표 대신 빈 상태
  [이 날짜 동기화] / [가장 가까운 수집일로 이동] 버튼. 근사값을 보여주지 않는다.
- 슬라이더 이동에 따른 표 갱신은 로컬 재구성이라 항상 자동이다.
  체크박스는 KRX 수집 여부만 제어한다.

### 네비게이션

데이터 버튼과 `DataPage`는 유지하고 탭을 재구성한다.

```
데이터
 ├─ 종목 마스터   ← 데이터셋 탭 자리. 기본 탭
 └─ 가격 데이터   ← 기존 종목 탭 개명 (등록 종목·캔들 동기화)
```

쿼리스트링 탭 상태(`?tab=`) 구조는 유지한다.

## 백테스트 통합

- 위저드 2단계를 스냅샷 선택에서 **유니버스 규칙 정의**로 교체한다.
  시장, 종목유형, 리밸런스 시점 상위 N(정렬 기준: 시총 등)을 입력한다.
- 기간 입력 시 coverage를 검사한다.
  미수집 구간이 있으면 경고와 [동기화] 버튼을 보여준다.
- 제출 시점에 서버가 리밸런스 날짜별 멤버십 일정을 확정한다.
  날짜마다 `getUniverseAsOf(date)`로 구성원을 얻고,
  시총 상위 N 랭킹은 KRX 일별매매 MKTCAP으로 계산한다(레이지 캐시 경유).
  로컬 캔들이 없는 선정 종목은 경고로 노출한다.
- 엔진은 확정된 멤버십 일정을 받아 리밸런스 시점마다 거래 대상을 제한한다.
- 재현성: `backtestRuns`에 규칙, `KRX_FILTER_POLICY_VERSION`, 멤버십 일정 해시를 저장한다.
  종목 리스트 복사본은 저장하지 않는다 — 일정은 마스터+캐시에서 재도출 가능하다.

## 마이그레이션

- 테이블 4개 drop, 관련 서비스·컴포넌트 삭제.
- 기존 `backtestRuns`가 snapshot을 참조하면 해당 이력도 정리한다(개발 단계 데이터).

## 에러 처리

- KRX 쿼터 초과·승인 만료: 기존 오류 타입 재사용, 타임라인 UI에 배너.
- 재구성 불가(coverage 없음): 빈 상태.
- 체크포인트 검증 불일치: 자동 교정 + 경고 표시.

## 테스트

- 단위: diff 엔진, 재구성(순방향·역방향·체크포인트 경계), observedSpan 기록.
- 통합: fake KRX 소스로 ingest→재구성 왕복, 쿼터 예산 중단·재개.
- e2e: 기존 KRX 유니버스 시나리오를 폐기하고
  타임머신 뷰 + 새 위저드 시나리오로 재작성한다.

## 범위 밖

- 재무 수치(PER용 순이익 등) 분기 테이블
- 일별매매 OHLCV를 캔들 수집과 일원화
- PER/PBR/EV-EBITDA 정렬 기준 (krx-universe-sort-followups 참고)
