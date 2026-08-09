# 종목 마스터(point-in-time security master) 설계

최초 작성: 2026-08-05
SCD Type 2 개정: 2026-08-09

## 배경

백테스트는 현재 종목 목록이 아니라 각 날짜에 실제로 존재했던 종목 상태가 필요하다.
날짜별 전체 스냅샷은 저장량이 크고, 체크포인트+가변 길이 이벤트 체인은 과거 시작점을
하루씩 당겨 수집할 때 전체 체크포인트가 반복 생성될 수 있었다. 체크포인트 검증 상태를
화면에 노출하는 방식도 사용자가 데이터 자체보다 내부 저장 구현을 해석하게 만들었다.

입력은 계속 KRX의 날짜별 전체 유니버스다. 저장만 종목별 SCD Type 2로 바꾼다. 즉,
“종목별 일별 행”을 만드는 것이 아니라 종목 상태가 실제로 달라진 관측일에만 새 버전을
한 행 남긴다.

## 결정 사항

| 항목 | 결정 |
|---|---|
| 식별자 | `standardCode` |
| 버전 구간 | 반개구간 `[validFromDate, validToDate)`, 현재 버전은 `validToDate=null` |
| 저장 단위 | 최초 baseline 종목 수 + `(종목, 상태 변경 관측일)` 수 |
| 상태 필드 | `shortCode`, `name`, `market`, `sharesOutstanding`, `instrumentType`, `listedDate` |
| 수집 입력 | 거래일별 KRX 전체 KOSPI·KOSDAQ 기본정보 |
| 수집 사실 | `symbol_master_coverage`와 `symbol_master_trading_days`가 별도 보존 |
| 변경 이력 | SCD 경계의 이전·이후 상태를 비교해 조회 시 파생 |
| 체크포인트 | 신규 저장·검증·조회·API·UI에서 제거 |
| UI | 수집 구간과 종목 상태만 표시하며 내부 저장 앵커를 노출하지 않음 |

## 데이터 모델

```text
symbol_master_versions
  id
  standard_code
  valid_from_date          # 포함
  valid_to_date            # 미포함, null이면 열린 버전
  short_code
  name
  market
  shares_outstanding
  instrument_type
  listed_date
  recorded_at_ms

symbol_master_coverage     # 실제 확인한 날짜 구간, 휴장일 포함
symbol_master_trading_days # 실제 거래가 있었던 관측일
symbol_master_market_caps  # 시총 랭킹 레이지 캐시
```

조회 조건은 다음과 같다.

```sql
valid_from_date <= :date
AND (valid_to_date IS NULL OR valid_to_date > :date)
```

`validFromDate`는 실제 상장일이 아니라 이 저장소가 그 상태를 처음 확인한 날이다.
실제 상장일은 `listedDate` 속성으로 따로 보존한다.

DB 제약:

- `UNIQUE (standard_code, valid_from_date)`
- `UNIQUE (standard_code) WHERE valid_to_date IS NULL`
- `CHECK (valid_to_date IS NULL OR valid_to_date > valid_from_date)`
- INSERT·UPDATE overlap 방지 trigger

서비스 불변식:

- 같은 종목의 구간은 겹치지 않는다.
- 인접한 동일 상태 버전은 하나로 합친다.
- 모든 수집 거래일 D에서 SCD 조회 결과는 그날 KRX full universe와 같다.
- 과거 D를 삽입해도 다음 기수집 관측일 N의 상태는 삽입 전과 같다.
- 버전·거래일·coverage는 한 트랜잭션에서 저장한다.
- coverage 밖이거나 같은 연속 coverage 안에 거래일 anchor가 없는 날짜는 조회하지 않는다.

## 상태 변경 표현

- 최초 관측: `[D, null)` baseline 버전 삽입. 신규상장 이벤트로 노출하지 않는다.
- 신규상장: D부터 새 버전 삽입.
- 상장폐지: 직전 버전의 `validToDate=D`; D부터 유니버스에 없다.
- 재상장: 부재 구간 뒤 D부터 새 버전 삽입.
- 시장·주식 수·이름·유형·단축코드·상장일 변경: 직전 버전을 D에 닫고 변경된 전체
  상태 한 행을 D부터 연다.
- 같은 날 여러 필드가 바뀌어도 SCD 버전은 한 행이다.

## 수집과 과거 구간 보정

`ingestDate(D)`는 KRX full universe를 받은 뒤 D 다음의 가장 가까운 기수집 거래일 또는
기존 버전 경계 N을 찾는다. 기존 타임라인에서 `[D,N)`만 실측 상태로 덮고 N 이후는
보존한다. 덮기 전후 N의 전체 상태도 비교해 미래 훼손을 즉시 실패시킨다.

```text
기존 A [01-01, 01-05), B [01-05, ∞)
01-03 실측 C를 뒤늦게 수집

결과 A [01-01, 01-03), C [01-03, 01-05), B [01-05, ∞)
```

동일 상태의 과거 날짜를 하루씩 추가하면 인접 구간이 합쳐진다.

```text
기존 A [01-04, ∞)
01-03 A 수집 → A [01-03, ∞)
01-02 A 수집 → A [01-02, ∞)
```

따라서 체크포인트 스냅샷이 날짜마다 쌓이지 않는다. 실제 백필은 호출 효율을 위해
오름차순으로 수행하지만, 역순·중간 갭 수집도 최종 저장 행 수를 부풀리지 않는다.

KRX 응답에 거래가 있는데 기본정보가 비거나 기존 시장 종목 수가 비정상적으로 급감하면
저장을 거부한다. 한 번의 불완전 응답이 시장 전체 상장폐지로 굳는 것을 막기 위해서다.

## 변경 이벤트

이벤트는 재구성 원천으로 저장하지 않는다. 조회 구간의 SCD 경계에서 이전·이후 버전을
비교해 다음 이벤트를 파생한다.

```text
LISTED
DELISTED
MARKET_MOVED
SHARES_CHANGED
NAME_CHANGED
TYPE_CHANGED
SHORT_CODE_CHANGED
LISTED_DATE_CHANGED
```

여러 필드가 같은 날 바뀌면 사용자 이력에는 필드별 이벤트가 보이지만 저장 버전은 한
행이다. 파생 ID는 `date:standardCode:eventType` 문자열이라 안정적이고 고유하다.
`observedSpanStart`는 해당 경계 전 가장 가까운 관측 거래일에서 계산한다.

## 기존 데이터 이행

마이그레이션 0012는 `symbol_master_versions`와 단일 상태 행
`symbol_master_storage_state(PENDING|ACTIVE)`를 추가한다. 서비스 첫 부팅에서 다음을 한
SQLite 트랜잭션으로 실행한다.

1. legacy 체크포인트·종목·이벤트와 거래일을 읽는다.
2. 기존의 nearest-checkpoint 조회 의미를 날짜순으로 재현한다.
3. 전체 6개 상태 필드를 비교해 SCD 버전으로 압축한다.
4. 각 legacy 경계일에서 이전 조회와 SCD 조회의 SHA-256 상태 지문을 비교한다.
5. 검증 성공 후 중복 checkpoint/event 행을 비우고 상태를 `ACTIVE`로 바꾼다.

중간 실패는 전체 롤백되어 `PENDING`에서 다시 시도된다. legacy 흔적은 있는데 기준
체크포인트가 없거나 체크포인트 종목이 비어 있으면 빈 SCD로 확정하지 않고 부팅을
실패시킨다. 빈 legacy 테이블 자체는 후속 contract migration까지 남겨 구버전 DB의
이행 코드를 안전하게 유지한다.

이 배포 이후 코드만 과거 버전으로 되돌리는 것은 지원하지 않는다. 롤백할 때는 배포 전
DB snapshot도 함께 복원해야 한다.

## UI

- 선택 날짜 기준 유니버스 표와 coverage 타임라인을 표시한다.
- 미수집 날짜는 빈 상태와 동기화 버튼을 표시한다.
- 체크포인트·검증됨·불일치·미검증 마커나 문구는 표시하지 않는다.
- 최근 변경 패널은 SCD에서 파생한 이벤트를 표시한다.

## 테스트 기준

- 반개구간 경계, overlap/열린 버전 제약
- 변경 없는 날짜를 반복 수집해도 버전 행이 늘지 않음
- 같은 날 여러 필드 변경은 버전 한 행, 이벤트 ID는 필드별로 고유
- 과거 날짜를 하루씩 prepend해도 동일 상태는 한 행으로 병합
- 중간 갭 overlay가 다음 미래 상태를 보존
- 신규상장·상장폐지·재상장
- 최초 baseline을 신규상장 이벤트로 오인하지 않음
- 고립 휴장일이 다른 coverage 구간 상태를 노출하지 않음
- legacy 이행의 상태 동등성·멱등성·중복 데이터 정리

## 범위 밖

- 시총 외 추가 랭킹 팩터
- legacy 빈 테이블을 실제 DROP하는 contract migration
