# KRX·DART 데이터 재사용과 외부 API 호출 정책 구현 인계

작성일: 2026-09-16 (KST)

후속 변경(2026-09-20): 아래의 서버 일일 공시 조회·미리보기 직접 조회 금지 정책은
사용자 결정 D-097로 대체됐다. 현재는 미리보기 시작마다 당일까지 확인하며 자동 조회하지
않는다. 실행·재시작·동시 요청 경계는 `docs/DECISIONS.md`의 D-097을 따른다.

조사 기준: `origin/main` = `de9eea1`

범위: 원인 조사, 사용자 정책 결정, 구현 항목·검증·이행 계획. 이 문서 작성 중 제품 코드와 운영 DB는 변경하지 않았다.

## 1. 목표와 사용자 결정

이미 정상적으로 받은 데이터는 코드 배포, DB 구조·파일 위치 변경, 에이전트 업데이트,
진행률 표시 변경만으로 다시 받지 않는다. API 응답 전체를 보존하고, 파서·필드·계산 변경은
저장된 응답의 로컬 재처리로 해결한다. 외부 HTTP 요청은 사유와 최소 대상 범위를 설명할 수
있어야 하며, 구현 편의를 위한 `coverage 없음 → 무조건 fetch`를 허용하지 않는다.

이 문서에서 **최초 수집**, **원문 재수집**, **로컬 재처리**, **최신성 확인**을 구분한다.
처음 요청하는 날짜·보고서의 수집은 기존 데이터의 신뢰 상실이 아니다. 이미 확인한 무자료
응답도 수집 이력이다. 신규 컬럼이 생긴 것은 원문이 없다는 뜻이 아니다.

| 항목 | 상태 | 정책 |
| --- | --- | --- |
| 코드·저장 구조 변경만으로 재수집 | 사용자 원칙 확정 | 금지. 실행/스키마 호환성, 파생값 검증, 원문 신뢰를 분리한다. |
| DART 새·정정공시 목록 확인 | 사용자 선택 확정 | 서버가 하루 1회 확인·저장하고 미리보기는 저장 결과를 재사용한다. |
| 정상인 기존 데이터에 새 기능의 필수 원문·필드가 없음 | 사용자 선택 확정 | 기존 데이터 보존, 해당 작업 차단, 필요한 범위 표시 후 재수집 승인. |
| 원문 손상·공급자 정정 확인 후 로컬 복구가 불가능함 | 사용자 선택 확정 | 대상·근거를 표시하고 사용자 승인 후 해당 범위만 재수집한다. |
| 일일 공시 목록 확인 미완료 시 기존 검증 데이터 사용 | 사용자 선택 확정 | 마지막 확인 시각과 최신성 미확인을 표시하고 기존 검증 데이터 사용을 허용한다. 손상·정정 확인 범위는 별도 차단한다. |

하루 1회는 공시 확인 **작업**의 주기다. 페이지 순회·누락된 기간 이어받기 때문에 HTTP
호출 수가 1회라는 뜻은 아니다. 미리보기마다 목록을 조회하거나 프로세스 재시작마다 같은
완료 작업을 반복하지 않는다.

위 정책 선택은 모두 확정됐다. 자동 재수집 권한을 임의로 확대하지 않는다. 새로운
날짜·보고서의 최초 수집과 기존 원문을 교체하는 정정 재수집은 별도다. 이 문서는 제품
수정의 실행 결과가 아니라 다음 구현자의 계약이다.

## 2. 조사 결과와 기존 설명 정정

### 2.1 직접 원인

- `scripts/build-runtime-versions.mjs::generateRuntimeVersions`의 `collectionVersion`은
  `agent-collection-runtime.ts`부터의 실행 import 그래프와 data migration을 해시한다.
  Node·TypeScript·관련 의존성·코드 생성 옵션·해시 생성기 자체의 소스도 입력이다.
  데이터의 내용 해시나 공급자의 변경 통지가 아니다.
- `SymbolMasterService::isCovered`, `isCoveredIn`, `effectiveTradingDateWithinCoverage`,
  `coverageRanges`, `isNonTradingRangeCovered` 등이 이 실행 해시와 동일한 coverage만 읽는다.
  `SelectionMetricRepository`도 같다. 이미 저장된 날짜·값이 있어도 이전 해시 또는 NULL이면
  미수집으로 보이고 `ingestDateUnguarded` 등이 실제 KRX HTTP 호출을 한다.
- `migrations/data/0002_collection_coverage_version.sql`은 세 coverage 테이블에 nullable
  컬럼만 추가한다. 기존 행은 NULL이 된다. 이것은 단순히 backfill이 빠진 문제가 아니라,
  NULL·다른 실행 해시를 재수집 사유로 취급한 계약 자체의 문제다. 현재 해시로 모든 행을
  덮는 임시 SQL은 다음 배포 때 재발하고 실제 결손까지 숨길 수 있으므로 해결책이 아니다.
- DART 재무·자본변동 coverage protocol에도 `collectionVersion` 동등성 검사가 들어 있다.
  실제 재무 행의 count/content hash 검증은 필요한 기능이지만, 실행 해시 불일치와는
  별개다. 둘을 함께 무효화하지 않아야 한다.

`krx-historical-universe-source.ts::fetchRows`의 `krx fetch ok`는 HTTP 응답을 파싱한
다음 남기는 로그다. 데이터셋 SQLite 파일 다운로드 로그로 해석한 이전 설명은 틀렸다.
또 KRX coverage 자체는 수집 완료 구간을 기록한다. 원격 데이터가 현재도 동일한지 검출하는
수단은 아니다. 기존 답변의 “collectionProtocolVersion만 보면 된다”도 충분하지 않다.
**파서 의미 버전이 바뀌어도 원문이 온전하면 우선 로컬에서 다시 해석해야 한다.**

### 2.2 관련 변경 이력

| 커밋 | 변경 | 재수집과의 관계 |
| --- | --- | --- |
| `ebfb19e` (9/14) | native agent 및 data DB 분리 | 물리 저장/전달 구조 변경. 그 자체가 공급자 재수집 근거가 되지 않는다. |
| `055f3e4` (9/15) | runtime domain version 도입 | KRX/DART coverage를 실행 내용 해시에 연결하고 coverage 컬럼을 추가했다. |
| `14873da` (9/15) | 코드 포맷 변경 | 해시 생성기 소스도 바뀌었다. 생성기 원문 자체를 해시에 넣으므로 포맷 변경도 영향을 준다. |
| `c36e570` (9/16, main) | agent/preparation 진행률 | 수집 런타임, 데이터 큐, 공통 agent protocol, runtime operations schema가 수집 그래프 안에서 바뀐다. |
| `de9eea1` (9/16, main merge) | 테스트 fixture 및 종료 처리 | 직전 main 대비 현재 수집 그래프 파일 변경은 없었다. |

위 내용은 Git diff와 현재 `runtimeGraph` 교집합으로 확인했다. 운영 서버의 배포 산출물,
저장 해시 분포, 실제 전체 호출 수는 조회하지 않았다. 이번 운영 증상을 단일 배포 해시로
확정하거나 모든 날짜를 이미 재수집했다고 단정하지 않는다. 로컬에서 계산한 실행 해시는
빌드 환경에도 의존하므로 운영 해시로 인용하지 않는다.

### 2.3 원문 보관의 현 상태

| 데이터 | 현재 보관 및 재사용 | 문제 |
| --- | --- | --- |
| DART 재무제표·주식총수·증자감자 | operations DB `dart_raw_api_snapshots.payload_json`에 성공/013 봉투 전체, 미사용 필드, 배열 순서, 해시, 수집 시각 보존 | `PREFER_CACHE`일 때만 재사용. 없거나 손상되면 단일 cache miss로 취급한다. |
| DART 공시 목록 `list.json` | 그때그때 live 조회 | 공용 영속 일일 조회 기록이 없다. |
| DART 고유번호 `corpCode.xml` | 프로세스 메모리 Promise/Map | 원문을 재생하면 호출하지 않지만, 재시작 후 매핑이 필요하면 전체 파일을 다시 받는다. |
| KRX 기본정보·일별매매·지수 | 파싱/정규화된 DB 값·coverage | DART와 같은 영속 응답 봉투 저장소가 없다. 미사용 원천 필드는 복구할 수 없다. |

DART의 기존 키는 `(symbol, endpoint, businessYear, reportCode, fsDiv)`이고 동일 키의
갱신은 upsert다. 원문과 정규화 데이터의 종목 정체성, 갱신 전후 이력 연결까지 모두 보장하는
구조는 아니다. `payload_json`은 HTTP 응답의 JSON 의미와 배열 순서를 보존하지만 수신 바이트
전체를 그대로 저장하는 형식은 아니다.

정책 적용 대상 endpoint는 다음과 같다. 목록/매핑도 실제 요청에 포함한다.

| 종류 | endpoint |
| --- | --- |
| KRX 기본정보 | `/svc/apis/sto/stk_isu_base_info`, `/svc/apis/sto/ksq_isu_base_info` |
| KRX 일별매매 | `/svc/apis/sto/stk_bydd_trd`, `/svc/apis/sto/ksq_bydd_trd` |
| KRX 지수 | `/svc/apis/idx/kospi_dd_trd`, `/svc/apis/idx/kosdaq_dd_trd` |
| DART 본문 | `/api/fnlttSinglAcntAll.json`, `/api/stockTotqySttus.json`, `/api/irdsSttus.json` |
| DART 발견/정체성 | `/api/list.json`, `/api/corpCode.xml` |

### 2.4 외부 요청으로 이어지는 경로 목록

| 경로/심볼 | 현행 요청 조건 | 필요한 변경 |
| --- | --- | --- |
| `SymbolMasterService::ingestDateUnguarded` | 현재 해시 coverage 없음 | 수집 이력과 로컬 복구 가능성을 먼저 판정. 거래일은 2시장 일별매매+기본정보, 휴장은 일별매매 2회 경로. |
| `ensureSelectionMetrics` | 거래대금 coverage 누락/다른 해시 | 로컬 일봉·지표·원문 재생. 미저장 필드 보충은 승인 대상. |
| `getMarketCapsAtUnguarded` | 시총 캐시 행 없음 | 기존 지표 또는 원문 재생. 정상 0건도 기록해 반복 HTTP 방지. |
| `backfillNonTradingDays` 및 CLI | 요청한 전 구간을 순회하여 일별매매 조회 | 기존 원문·완료 coverage 재사용. 명령 실행 자체를 모든 날짜 강제 재수집 권한으로 보지 않는다. |
| `SymbolMasterScheduler`, backfill, sync route | 완료 coverage 밖 날짜 | 같은 정책 적용. 새 날짜 최초 수집과 과거 완료일 재수집 분리. |
| `BenchmarkService::syncDate`, `runBackfill` | syncDate는 직접 조회, backfill은 값이 있는 날짜/주말만 skip | 정상 빈 응답 coverage도 skip. KRX 지수 원문 재생. FRED 동작 변경은 이번 범위 밖. |
| `FactSyncService::runSync` | FULL, 새·정정공시, 오래되거나 없는 watermark 등 | 파서 재처리와 최신성 확인을 분리. 광범위 REFRESH 제거. |
| `detectRedisclosedYears` | 90일 이전이면 수집연도 전체 forced, 공시 일부 필드 누락도 전체/연도 forced | 영속 공시 목록/미완료 확인 상태 사용. 불확실함을 데이터 전체 재수집으로 변환하지 않는다. |
| `dart-fact-source::rawRows` | 기본 정책 REFRESH; PREFER_CACHE의 miss/손상 시 fetch | 명시된 호출 사유가 없으면 외부 요청 금지. 없음/손상/파서 비호환을 구분. |
| `listRecentPeriodicFilings`, `createDartCorpCodeCache` | live 목록 조회, 메모리 매핑 miss | 일일 목록과 고유번호 원문/매핑 영속화. |
| `AgentDataQueue::request/runNext` | collectionVersion+요청 JSON으로 큐 ID 생성, 완료/재시도 | 코드 해시와 공급자 호출 권한 분리. 실행 시마다 현재 원문·coverage 상태 재판정. |
| `RestClient::request`, DART corpCode 직접 fetch | HTTP 429/5xx 재시도, 매핑 다운로드 | 최초 허용 사유·범위를 유지하며 attempt마다 quota/취소/허용 여부 검증. |
| `scripts/krx-smoke.ts` | 직접 공급자 호출 | 명시적인 실 API 검증 도구로 취급. 이 수정의 테스트·배포 검증에서 자동 실행 금지. |

원격/로컬 agent는 공급자 키 없이 읽기 전용 snapshot을 사용하고, 데이터 필요를 서버에
돌려준다. 현재 `preparation-runtime.ts::requireFacts`는 coverage 결손이 없으면 서버 수집을
요청하지 않는다. 따라서 단순히 기존 `FactSyncService` 안에 일일 목록 조회를 넣는 것으로는
새 공시가 이미 완성된 preview에 반영되지 않는다. 서버의 일일 확인과 결과 소비를 별도로
연결해야 한다.

## 3. 신뢰·최신성에 대한 판단

사용자 원칙은 타당하다. 배포·DB 위치·스키마가 바뀌었다는 사실은 공급자가 보낸 데이터가
틀렸다는 증거가 아니다. 다만 “재무 갱신 외에는 재호출할 경우가 전혀 없다”까지는 보장할 수 없다.

- 새 날짜·새 보고서·처음 필요한 endpoint는 최초 수집 대상이다.
- DART 정정·추가·철회 또는 새 보고서가 확인되면 재무뿐 아니라 주식총수·자본변동 정보도
  영향을 받을 수 있다. 실제 영향받는 원문 요청 키를 식별해야 한다.
- 원문 해시 불일치, 파일 유실, 잘못된 종목/시장/연도로 저장한 이력은 로컬 신뢰 문제다.
  먼저 정상 백업·다른 검증된 로컬 사본으로 복구하고, 불가능할 때만 필요한 범위를 재수집한다.
  로컬 해시가 맞는다는 것은 저장 후 훼손되지 않았다는 뜻이며 공급자 내용의 사실성 증명은 아니다.
- 정규화 결과의 값·행·coverage만 손상되고 원문이 온전하면 외부 호출 없이 재구성한다.
  파서가 같은 원문에서 실패하는 경우도 원문 손상으로 자동 분류하지 않는다.
- 무자료·빈 응답은 그 시점의 관측이다. 아직 제출되지 않은 보고서, KRX 게시 전 응답을
  영구 확정 데이터로 취급하면 나중에 생긴 자료를 놓친다. `NOT_YET_AVAILABLE`과
  정상적으로 확인된 무자료/휴장, 일시적 오류를 구분한다.
- KRX 과거 일별 데이터가 영구 불변이라는 보장은 이번에 확인하지 못했다. 공급자의
  구체적인 정정 안내나 검증된 오류가 있는 경우만 별도 복구 근거로 삼는다. 막연한 정정
  가능성은 정기 전체 재다운로드나 임의 TTL의 근거가 아니다.
- 상장폐지·코드 재사용·신규 상장은 새 날짜의 정체성/이력 수집 사유다. 그 사실만으로
  과거 정상 데이터를 전부 무효화하지 않는다.

공식 문서 확인(공개 개발가이드 조회만 수행, 인증된 데이터 API 호출 없음):

- [DART 공시검색](https://opendart.fss.or.kr/guide/detail.do?apiGrpCd=DS001&apiId=2019001):
  정정보고서를 포함하는 검색, 접수번호, 철회 표식, corp_code 없는 검색의 3개월 제한을
  제공한다. 이 제한은 한 요청의 검색 구간이며, 90일이 지난 원문을 모두 다시 받으라는
  요구가 아니다. 긴 공백은 날짜 구간·페이지를 나눠 확인할 수 있다는 설계 판단이다.
- [DART 전체 재무제표](https://opendart.fss.or.kr/guide/detail.do?apiGrpCd=DS003&apiId=2019020):
  요청 단위가 회사·사업연도·보고서·CFS/OFS이고 응답에 접수번호를 포함한다. 변경 범위와
  갱신 응답을 대조하는 근거다.
- [KRX Open API](https://openapi.krx.co.kr/contents/OPP/MAIN/main/index.cmd): 과거 일봉의
  영구 불변성이나 사용하는 endpoint의 확정 게시 시각은 이 조사로 입증하지 못했다.
  다른 KRX 상품의 배포 시각을 이 API의 보장으로 옮겨 쓰지 않는다.

## 4. 목표 계약: 어떤 경우 HTTP를 허용하는가

### 4.1 서로 다른 상태를 분리한다

| 상태/버전 | 판단하는 것 | 변화 시 조치 |
| --- | --- | --- |
| 수집 이력 | 어느 원천 요청을 성공적으로 확인했는가 | 최초 결손을 식별. 코드 변경으로 삭제/초기화 금지. |
| 원문 내용 해시·정체성 | 저장 원문이 온전하고 요청 대상과 일치하는가 | 손상 시 로컬 복구, 불가능하면 확정 정책에 따른 제한 재수집. |
| 파생 데이터 protocol/manifest | 현재 파서가 해당 원문을 올바르게 처리했고 결과가 보존됐는가 | 필요한 범위 로컬 재처리·검증. 불일치만으로 HTTP 금지. |
| 최신성 확인 checkpoint | 어느 공시/확인 구간까지 관측·반영했는가 | 일일 목록을 소비하고 실제 변경 키만 갱신. |
| 데이터 revision·snapshot 해시 | 계산 입력이 바뀌었는가/전달 파일이 동일한가 | preview 재검증·snapshot 게시/전달. 공급자 호출 근거 아님. |
| DB schema·agent·preview·execution version | 코드/저장/실행 호환성 | migration·업데이트·재계산. 공급자 호출 근거 아님. |

`collectionVersion`을 모든 행의 새 고정 값으로 바꾸는 패치는 금지한다. 유지한다면 수집
구현의 출처/진단 메타데이터로만 사용하고, coverage 재사용·원문 신뢰·HTTP 허용 조건에서
제거한다. parser protocol도 값이 달라졌다는 이유만으로 fetch를 허용하지 않는다.

### 4.2 호출 판단표

아래 사유명은 구현용 제안이며 명칭 변경은 가능하다. 의미·권한·범위는 유지한다.

| 상황 | 기본 동작 | 외부 요청 조건 |
| --- | --- | --- |
| 처음 필요한 확정 날짜/보고서/endpoint, 수집 이력 없음 | `FIRST_ACQUISITION` | 정상 준비/일일 수집 범위 안의 누락 요청만 허용. 기존 완료 이력을 코드 변경으로 없애 만든 miss는 해당하지 않음. |
| 정상 수집 이력/정규화 데이터 존재, 원문 저장 기능 도입 전 데이터 | `REUSE_LEGACY` | 원문 캐시 채우기 목적 재호출 금지. |
| 파서·신규 컬럼·계산식 변경, 필요한 원문 존재 | `REPLAY_LOCAL` | HTTP 0회. |
| 정규화 manifest 불일치/행 유실, 필요한 원문 존재 | `REPAIR_LOCAL` | HTTP 0회. 원문과 기존 검증 증거로 복구. |
| 새 필수 원문/필드가 기존 저장에 없음 | `BLOCKED_SOURCE_REQUIREMENT` | 범위별 사용자 승인 이후만 보충. 기존 데이터는 보존. |
| 정상 원문인데 필수 필드가 원천에도 없음/파서 실패 | `BLOCKED_INTERPRETATION` | 같은 응답을 반복 요청하지 않음. gap/원인 보존. |
| 일일 공시 확인 | `FILING_DISCOVERY` | 서버 일일 작업에만 허용. 페이지별 기록·재개. preview에서 직접 조회 금지. |
| 새 공시로 처음 제공된 보고서/원천 항목 | `PUBLICATION_CONFIRMED` | 미수집/게시 대기 항목에 한해 최초 수집. 새 사건·요청 키 근거를 보존. |
| 기존 원문의 정정공시/공급자 정정 | `SOURCE_CHANGE_CONFIRMED` | 확인 근거·대상 요청 키 표시 후 사용자 승인. 같은 키의 기존 정상 응답을 자동 교체하지 않음. |
| 원문 손상/유실·정체성 오염, 로컬 복구 불가능 | `SOURCE_RECOVERY` | 손상 근거·최소 요청 범위 표시 후 사용자 승인. |
| 90일 경과, 서버 재시작, 빌드/스키마 해시 차이 | 재사용 또는 로컬 확인 | 그 사유로 원문 요청 0회. 최신성 미확인은 별도 상태. |
| 일일 공시 확인 장애/미완료, 알려진 손상·정정 없음 | `REUSE_WITH_FRESHNESS_WARNING` | 검증 데이터 사용 허용, 마지막 확인시각/최신성 미확인 고지. preview의 보충 목록 요청 0회. |
| quota·네트워크/5xx·서버 재시작 후 재개 | 미완료 요청만 재개 | 이미 받은 원문은 재생. retry는 원래 허용한 요청 범위·사유에 묶음. |

승인 없는 기존 데이터 교체를 `FULL`, `force`, `cache miss`, 작업 재시도 또는 자정 quota
리셋으로 우회하지 않는다. 명시적으로 원문 새 필드 보충을 승인받아도, 이미 있는 필드를
무관한 날짜까지 다시 받거나 다른 종목의 손상을 자동 복구할 권한이 생기는 것은 아니다.

### 4.3 최소 호출 경계

서버의 정책 판정 결과는 최소한 공급자, endpoint, 정규화된 요청 키, 동작, 사유,
근거(새 접수번호/손상 snapshot/사용자 승인), 필요한 물리 호출 범위를 포함한다.
`CHECK/REUSE/REPLAY/BLOCK/REQUEST` 결과를 `needsDart`·진행률·실행이 공유한다.
계획 단계는 순수 로컬 판정이고 실제 API 호출로 계획을 만들지 않는다.

agent가 `NEEDS_DATA`를 보냈다는 사실만으로 HTTP를 허용하지 않는다. 서버가 현재 상태를
다시 확인하고 로컬 재생만으로 해결할 수 있다. 런타임 hash가 다른 새 queue 항목도 동일하다.
중복 제거는 코드 해시가 아닌 원천 요청 키와 갱신 근거에 맞춘다. 반대로 영구 COMPLETED
표식이 훗날 실제 원문 손상/새 공시 처리를 막지 않게 실행 시 상태를 재판정한다.

HTTP 어댑터에서 사유 없는 호출을 막고 실제 attempt마다 기존 quota 원장을 유지한다.
승인 범위에 없는 키, 취소된 요청, 이미 성공한 요청의 재시도는 보내지 않는다. 고유번호
파일·공시 목록·본문·KRX 지수도 예외가 아니다. 키/토큰은 계획·로그에 넣지 않는다.

## 5. 원문·coverage 보존과 이행

### 5.1 기존 DB를 버리지 않는 이행

1. 구현 테스트는 구버전 fixture와 임시 DB에서 수행한다. 운영 확인이 필요하면 먼저
   읽기 전용으로 DB 연결, 두 DB의 연결 identity, coverage/원문/작업 상태를 조사한다.
2. KRX의 NULL·여러 이전 `collection_version`별 완료 구간을 수집 이력으로 보존한다.
   버전별로 겹쳐 쌓인 날짜는 합집합을 만들되 **실제 빠진 날짜는 메우지 않는다**.
   `isNonTradingRangeCovered`가 단일 구간을 기대하는 점까지 이행한다.
3. 일봉·마스터 SCD·거래일·선정 지표·거래불가일 간의 기존 검증 규칙을 적용한다.
   날짜 범위만 있다고 모든 종목의 모든 필드를 보유했다고 인증하지 않는다. 정상 무자료와
   미수집, 의도적 gap/제외를 보존한다. manifest 불일치를 새 값으로 덮어 신뢰를 만들어내지 않는다.
4. DART 재무 manifest의 count/hash와 기존 gap·접수번호·watermark를 보존한다.
   실행 해시만 다른 동일 의미 protocol은 재사용한다. 의미 protocol이 다른 경우에만
   범위별 로컬 재생/호환 이행 필요성을 판정한다. 자본변동은 현행 검증 수준과 gap을 유지한다.
5. 원문이 없는 과거 정상 데이터에 가짜 raw JSON을 만들거나 cache 채우기용 전체
   재다운로드를 하지 않는다. `원문 없음, 기존 정규화 데이터 재사용 가능`을 표현한다.
6. 이미 받은 원문을 잃지 않도록 operations/data 두 파일의 기존 백업·복구 경계를 유지한다.
   새 테이블은 additive migration으로 추가하고 기존 배포 migration을 다시 쓰지 않는다.
   migration 자체는 네트워크 호출 0회이며 중단/재실행이 가능해야 한다.
7. 이전 버전에서 남은 QUEUED/RUNNING/WAITING_DATA/일일 quota 대기 요청도 새 정책으로
   재평가한다. 오래된 forced refresh 계획을 재시작만으로 실행하지 않는다. 기존 리스/완료
   처리의 중복 방지 계약도 유지한다.

이미 불필요한 재수집으로 덮인 값은 이번 코드 수정만으로 과거 값이 복원되지 않는다.
이전 snapshot/백업의 존재와 차이를 읽기 전용으로 확인하고, 복구가 필요하면 별도 범위를
제시한다. 현재 값을 과거 값으로 추측해 고치거나 정상 신규 수집분까지 되돌리지 않는다.

### 5.2 KRX 영속 원문 재생

새 KRX 원문 저장소는 기존 DART 원문처럼 서버 operations DB에 둔다. agent 배포용
data snapshot에 대량 원문·키를 넣지 않는다. 원천 요청 키는 공급자 환경/데이터 namespace,
endpoint(시장/지수 구분), 기준일, 데이터 의미에 영향을 주는 요청 인자를 포함한다.
테스트 source와 운영 source는 충돌하지 않아야 하고 인증키는 식별자에 포함하지 않는다.

응답 봉투 전체, 해시, 수집 시각, 요청 정체성, 응답 상태를 **파싱·필터링 전에** 저장한다.
미사용 필드와 행 순서를 보존하고 파서 오류가 발생해도 받은 원문은 남긴다. 통신 실패나
오류 봉투를 정상 완료로 표시하지 않는다. 새 승인 갱신 시 기존 정상 원문을 파괴하지 않고
전후 근거를 추적할 수 있어야 한다. 장기 무제한 보관 정책을 임의로 추가하지 말고 최소한
활성/직전 원문 및 진행 중 작업이 참조한 원문은 보존한다.

한 endpoint를 성공적으로 저장하고 다음 endpoint에서 실패한 경우 재시작은 성공한 응답을
재사용한다. 동일 endpoint/기준일은 일봉·시총·거래대금·거래불가일 경로가 공유한다.
동시 preview/스케줄러/backfill도 동일 실제 요청을 공유하고 완료 원문을 먼저 조회한다.

빈 응답은 게시 전/일시 미제공인지 정상 확정 무자료인지 구분한다. 사용하는 endpoint의
확정 시각 근거가 없다면 임의 시간을 만들어 확정하지 않는다. 미확정 날짜는 작업 차단/
대기 사유로 표현하고 사용자가 필요한 최신 구간 정책을 결정하도록 한다. 정상 확정
휴장·0건 자료는 반복 fetch하지 않는다. DART 013도 새 보고서 근거 없이 매번 요청하지 않는다.

## 6. DART 일일 최신성 확인과 로컬 재처리

### 6.1 일일 목록 작업

- 단일 서버 일일 작업의 claim/성공/실패/페이지 진행을 operations DB에 남긴다. 재시작과
  중복 tick, 여러 preview가 같은 공시 목록 조회를 반복하지 않아야 한다.
- 완료 기준은 조회 구간의 모든 페이지 저장이다. 실패/한도 대기 시 성공으로 표시하지 않고
  미완료 지점부터 같은 작업을 재개한다. 저장된 페이지/접수번호를 중복 소비하지 않는다.
- 최소한 원래 공시 행의 회사 고유번호·종목코드·접수번호·접수일·보고서명·정정/철회 표식과
  해석 전 정보를 보존한다. 기존 `PeriodicFiling`처럼 사업연도만 남기면 분기/본문 요청을
  최소화할 수 없으므로 보고서 코드로의 명시적인 해석과 실패 상태가 필요하다.
- KST 하루 경계의 지연 제출을 놓치지 않도록 최근 경계를 겹쳐 조회하고 접수번호로 dedupe한다.
  날짜/페이지 번호만으로 변하는 당일 목록을 완전 확인했다고 표시하지 않는다. 일일 작업의
  기준시각 이후 공시는 다음 작업 대상이다. 과거 날짜까지의 완결 범위와 확인 시각을 기록한다.
- 90일 이상 중단된 경우 필요한 공백을 API 허용 기간 이하로 나눠 확인한다. 페이지 상한에
  도달하면 기간을 좁혀 재개한다. “오래됨 → 모든 본문 REFRESH” fallback은 제거한다.
  긴 공백 탐색은 quota 내에서 이어가며 완료 전까지 최신성 확인 미완료로 표시한다.
- 일일 스케줄의 구체 시각은 설정 가능하게 하고 KST 기준으로 문서화한다. 당일 실패/초기
  미실행 상태를 preview 자체의 공급자 조회로 보충하지 않는다.

일일 목록이 완료되지 않아도 기존 검증 데이터로 미리보기·백테스트를 허용한다. 마지막
성공 확인 시각, 확인 완료 구간, 최신성 미확인 사유를 응답·UI와 실행 입력의 출처에 남긴다.
캐시된 preview에도 현재 확인 상태를 표시하고 실행 시점에 사용한 상태를 고정한다. 확인
이력이 전혀 없으면 시각을 만들어내지 않고 `확인 이력 없음`으로 표시한다. 다만 구체적인
손상·정정이 발견된 범위, 필수 입력이 없는 범위는 이 허용 규칙으로 통과시키지 않는다.

### 6.2 새 공시를 계산 입력에 반영

목록 확인 완료와 재무·자본변동 반영 완료는 별도 checkpoint다. 동일 접수번호를 재무가
처리했다고 자본변동까지 완료한 것으로 가정하지 않으며, 한 작업이 둘을 실제로 완료했다면
그때 각각 기록한다. 처리하지 못한 다른 연도를 전역 watermark로 건너뛰지 않는다.

서버는 새 목록에서 영향을 받는 종목/보고서/endpoint를 식별하여 pending 변경을 남기고,
preview 재사용 판정에 반영한다. 아직 원문 갱신/로컬 처리가 끝나지 않은 범위의 preview가
최신 입력으로 검증됐다고 표시되지 않아야 한다. agent snapshot에 전달할 최소 상태와
서버 완료 수락 조건을 함께 설계한다. 공시 발견 상태만 바뀌어도 cached preview가 그대로
통과하는 경로를 테스트한다.

기존 공식 API 요청 단위로 가능한 최소 범위만 받는다. 목록만으로 세부 endpoint 영향까지
입증할 수 없다면 해당 **한 보고서**의 현재 소비 endpoint 묶음을 계획에 명시할 수 있다.
종목 전체 연도 refresh로 넓히지 않는다. 누적 재무의 분기 차분/자본변동 전년도 앵커에
필요한 다른 보고서는 저장 원문을 재사용하고, 실제 미수집 앵커만 최초 수집한다.

공시 접수 직후 본문 API가 아직 013/이전 접수번호를 반환할 수 있다는 가능성은 명시적인
`PENDING_PUBLICATION`으로 처리한다. 그 상태를 최신 반영 완료로 기록하거나 preview마다
즉시 반복 호출하지 않는다. 구체적인 재확인 간격·상한은 endpoint 지연 근거와 일일 정책에
맞춰 결정하고, 임의 TTL을 과거 정상 자료 전체에 적용하지 않는다.

철회는 기존 정규화 결과를 그대로 최신이라고 인증하지 못한다는 사건이다. `list.json`만으로
모든 철회를 완벽히 검출한다고 약속하지 않는다. 지원되는 표식/수동 공급자 통보를 기록하고,
필요한 원문·정책이 없으면 해당 영향 범위의 작업을 차단한다.

### 6.3 원문 재생 정책 수정

- `rawSnapshotPolicy` 기본 REFRESH와 `mode=FULL`의 암묵적 외부 호출 권한을 없앤다.
  계산/정규화의 전체 재생과 원문 갱신은 별도 operation이다.
- 오래된 `fetchedAtMs`/watermark만으로 온전한 원문을 우회하지 않는다. 코드/protocol
  재처리는 일일 목록 작업 실패·DART 키 미설정 여부와 관계없이 로컬에서 가능해야 한다.
- 파싱/manifest 검증 시각과 원문 수집 시각·목록 조회 checkpoint를 분리한다. 로컬 재처리를
  수행했다고 오늘 공시를 확인한 것처럼 watermark를 당기지 않는다.
- 원문 없음, 해시 불일치, JSON 훼손, 새 파서 비호환, 요청 정체성 불일치를 구분한다.
  동일 `null`을 반환해 모든 경우를 새 fetch로 해결하지 않는다.
- `corpCode.xml` 원문/매핑을 영속하고 알려진 동일 종목 정체성은 재시작 후 재사용한다.
  신규 종목 등 실제 매핑이 필요할 때만 최소 갱신을 계획한다. 코드 재사용이 의심되면
  임의 회사로 재무를 연결하지 않는다. 현재 raw key에 회사 고유번호가 없다는 이행 한계를
  보존하고 식별자를 모르는 옛 원문을 추측해서 재라벨링하지 않는다.

## 7. 구현 작업 단위와 수정 대상

아래 순서로 구현하되, 단계마다 관련 회귀 테스트를 붙여 커밋한다. 새 인터페이스/테이블의
이름은 다음 구현자가 정할 수 있지만 API 허용 조건·데이터 보존·사용자 결정은 바꾸지 않는다.

### A. 호출 정책과 재현 테스트

공통 판정 타입/사유/범위 및 HTTP 직전 검증 계약을 만든다. `needsDart`, 준비 계획,
실행·미리보기 재사용·진행률이 같은 판정 결과를 쓰도록 설계한다. 먼저 현재 불필요한 호출을
실제 adapter의 `fetchImpl` 또는 로컬 fake HTTP 요청 카운터로 재현한다.

주요 파일: `src/server/modules/agents/application/agent-collection-runtime.ts`,
`agent-data-queue.ts`, `src/runtime/modules/facts/application/ports.ts`,
`src/runtime/modules/backtest/application/backtest-preparation-orchestrator.ts`,
`src/server/shared/rest-client.ts`.

### B. 실행 해시와 coverage 분리 및 기존 데이터 이행

KRX의 모든 collectionVersion 조건과 DART protocol 해시 결합을 제거/대체한다. 기존
manifest/gap 검증은 보존한다. 겹친 구간 이행 및 legacy 재사용 테스트를 함께 구현한다.

주요 파일: `src/runtime/modules/market-data/application/symbol-master-service.ts`,
`selection-metric-repository.ts`, `src/runtime/modules/facts/application/fact-coverage-store.ts`,
`corporate-action-coverage.ts`, `src/runtime/shared/db/data-schema.ts`, 새 data migration.

### C. KRX 원문 저장·로컬 복구·모든 진입점 통합

원문 저장소를 추가하고 KRX 어댑터에 주입한다. 수집 실패/재시작/동시성, 미사용 필드 재처리,
정상 0건, 기존 원문 없는 정상 자료를 다룬다. 지표·시총·비매매일·지수·CLI도 같은 경로를 쓴다.

주요 파일: `src/server/modules/market-data/infrastructure/krx/krx-historical-universe-source.ts`,
`krx-contract.ts`, `src/server/shared/db/collection-schema.ts`, 새 operations migration,
`src/server/modules/market-data/application/{benchmark-service,symbol-master-backfill,symbol-master-scheduler}.ts`,
`src/server/cli.ts`, 관련 routes. DART 저장소/테스트는 재사용 가능한 설계 참고자료다.

### D. DART 영속 공시 목록·고유번호·갱신 범위

일일 서버 작업과 영속 cursor/공시 원문·상태를 구현한다. 기존 blanket refresh/90일 fallback,
미완성 공시 행에 대한 전체연도 forced 처리를 제거하고 로컬 재생을 독립시킨다.

주요 파일: `src/server/modules/facts/application/fact-sync-service.ts`,
`src/server/modules/facts/infrastructure/dart/{dart-fact-source,dart-raw-snapshot-store,sqlite-dart-raw-snapshot-store,dart-corp-code-cache}.ts`,
`src/runtime/modules/facts/domain/sync-plan.ts`, `src/server/bootstrap/container.ts`,
`src/server/shared/db/collection-schema.ts` 및 새 scheduler/store/migration.

### E. 승인·차단 상태 및 운영 가시성

재수집 승인 대상을 공급자/endpoint/날짜 또는 회사/보고서/필드, 사유, 현재 보유 증거,
예상 최초 요청 수·retry 상한과 함께 표시한다. 승인 결과는 해당 계획 fingerprint와 범위에
묶어 영속화하고, 취소/재시작으로 권한이 넓어지지 않게 한다. 데이터가 바뀌어 계획이 달라지면
재판정한다. 같은 승인 요청을 여러 preview가 반복 생성하지 않는다.

미승인 작업은 기존 데이터·작업 이력을 보존한 차단 상태로 노출하고 실패/자정 quota 재개
루프에 넣지 않는다. 작업이 차단된 이유와 해소할 수집 범위가 UI/API에 함께 있어야 한다.
알 수 없는 필수 정보를 정상 0건으로 바꾸거나 임의 종목 제외로 승인을 우회하지 않는다.

`LOCAL_REPLAY`, `SOURCE_FETCH`, `FILING_DISCOVERY`, `DATASET_DOWNLOAD`, `BLOCKED`를
진행률·로그에서 구분한다. 실제 HTTP 로그에는 endpoint·요청 키·사유·근거·attempt·결과·호출
원장 수를 남긴다. 원문 본문과 인증키는 로그에 싣지 않는다.

### F. agent·snapshot·preview 연결과 문서 정합성

`src/shared/agent-protocol.ts`, `src/runtime/workers/preparation-runtime.ts`,
`src/runtime/workers/backtest-child.ts`, `src/server/modules/agents/application/{dataset-snapshots,agent-preparation-queue,agent-coordinator}.ts`,
`src/workers/dataset-publish-child.ts`의 collectionVersion 직접 사용과 `PreparationPreviewCache`의
previewVersion을 통한 간접 영향을 재검토한다. 원문은 서버 소유, agent는 계산만 수행한다는
경계를 유지한다. 진행 중 old
snapshot 결과를 무조건 최신으로 수락하지도, 코드 해시 차이를 fetch 필요로 돌리지도 않는다.

실제 계산 입력 변경 시 데이터 revision과 preview 검증은 여전히 작동해야 한다. 메타데이터
쓰기 때문에 snapshot이 재게시되더라도 외부 원천을 다시 받지는 않는다. 모든 no-op DB 쓰기
최적화는 별도 성능 과제이며 이번 수리의 필수 조건으로 확대하지 않는다.

`docs/DECISIONS.md` D-095의 coverage/실행해시 결합과 D-083의 FULL/90일 재수집 정책을
새 결정으로 명시적으로 대체하고, `docs/AGENT_RUNTIME_BOUNDARY.md`, `docs/AGENT_OPERATIONS.md`,
`docs/SPEC.md`, 관련 구현 상태 문서를 맞춘다. 기존 기록을 삭제해 과거 의사결정을 숨기지 않는다.

## 8. 검증 계약

### 8.1 테스트 방법

실 KRX/DART 인증키와 운영 DB를 사용하지 않는다. 테스트 기본 fetch는 외부 주소에 대해
실패하도록 설정하고 승인된 mock 또는 loopback fake server만 사용한다. API 포트의 호출
횟수는 로컬 재생까지 포함할 수 있으므로, **HTTP attempt 카운터와 quota 원장 증분**을 최종
검증 기준으로 삼는다. 성공 테스트가 실 공급자 호출을 했다는 뜻이 되어서는 안 된다.

같은 수집 fixture에 대해 배포·DB migration·agent 재시작 전후를 비교한다. 값과 row count,
coverage 구간, raw hash, 수집 시각, 공시 checkpoint, 기존 결과 pin을 함께 검증한다.
단순히 collectionVersion 문자열 비교만 없어진 것을 확인하는 테스트로 끝내지 않는다.
정정 수용 후에도 기존 완료 실행의 입력·결과를 사후 덮어쓰지 않는다. 새 정정 fact의
가용시점을 과거로 당겨 PIT를 깨뜨리지 않는지 기존 재무/자본변동 테스트와 함께 검증한다.

### 8.2 필수 시나리오

| 번호 | 입력/사건 | 기대 결과 |
| --- | --- | --- |
| T01 | 기존 정상 KRX/DART + code hash 변경/진행률 변경 | 모든 공급자 HTTP 0회. 기존 coverage·값 보존. |
| T02 | data DB 분리/컬럼·인덱스 추가/경로 이동/Node 또는 TS 변경 | migration 후 기존 데이터 재사용. 공급자 HTTP 0회. |
| T03 | NULL·A·B 해시 coverage가 겹치고 중간에 진짜 미수집 하루가 있음 | 완료 구간 합집합 유지, 진짜 gap 보존. 새 gap만 허용 계획. |
| T04 | 원문 없는 legacy지만 현재 필요 데이터 정상 | API 없이 사용. raw 캐시 채우기용 요청 없음. |
| T05 | 정상 raw에 미사용 필드 존재, 새 파서/컬럼으로 처리 | raw hash/수집시각 불변, 로컬 출력만 갱신. API/key 불필요. |
| T06 | 같은 해석 계약의 재무 fact 행 삭제/값 훼손, raw 정상 | 기존 manifest 검사 실패를 감지하고 로컬 복구. HTTP 0회. |
| T07 | 필수 미저장 원문/필드 때문에 신규 계산 불가능 | 데이터 보존 및 범위별 차단. 미승인 HTTP 0회. 승인 후 대상 키만 요청. |
| T08 | raw 해시/JSON/정체성 손상, 정상 로컬 사본 있음 | 검증된 사본으로 복구. API 0회. 원본 실패 근거 보존. |
| T09 | T08의 로컬 복구도 불가능 | 사용자 승인 전 0회, 승인된 손상 키만 요청. 영향 없는 키 0회. |
| T10 | KRX 첫 날짜 정상 거래일, 이어서 동일 preview 두 번/재시작 | 첫 일별매매 2+기본정보 2회, 이후 0회. 지표/비매매일에서 중복 요청 없음. |
| T11 | KRX 한 endpoint 원문 저장 후 다음 요청 실패/처리 중 crash | 저장 완료 endpoint 0회, 미완료 요청만 재개. |
| T12 | KRX 정상 휴장/시총 0건/거래불가 0건/지수 평일 무자료 | 완료 증거 재사용. 반복 호출 없음. 게시 전 미확정 응답은 별도 상태. |
| T13 | 동일 키 preview·스케줄러·backfill 동시 실행 | 물리 요청 중복 없음. 진행/완료·승인 상태 일관. |
| T14 | DART 일일 목록 완료 후 같은 날 preview·서버 재시작 | 추가 목록 요청 0회. 본문 변화 없음이면 본문 0회. |
| T15 | 목록 다중 페이지·당일 새 접수·자정 경계·quota 중단 | 페이지 저장/경계 겹침/dedupe, 완료 범위 앞지름 없음. 미완료 작업 재개만 허용. |
| T16 | 90일 이상 지난 watermark와 온전한 과거 raw | 전체연도 본문 재수집 없음. 목록 공백 확인을 이어가거나 최신성 미확인 표시. |
| T17 | 새/정정공시 한 건, 필요한 endpoint 일부만 변경 | 최초 수집과 기존 원문 정정 분리. 기존 원문 교체는 승인 전 0회/승인 후 최소 키만. 나머지 보고서·전년도 앵커 raw 재사용. |
| T18 | 같은 접수번호 반복, 재무/자본변동 처리 순서·중간 실패 | 각 소비 완료 checkpoint 보존. 완료한 본문 반복 요청 없음, 미완료 건 누락 없음. |
| T19 | 목록의 날짜/연도/접수번호 해석 실패 | 불확실 상태 기록. 전체연도 본문 강제 조회 없음. |
| T20 | DART 013·새 보고서 게시 대기·이전 receipt 본문 응답 | 정상 무자료 재사용, 새 사건은 pending 유지. preview 반복 요청/거짓 완료 없음. |
| T21 | FULL/기본옵션 생략/old queue 복구/자정 재시도 | 기존 원문 자동 우회 없음. 승인 범위 밖 HTTP 0회. |
| T22 | 코드 버전만 다른 agent/snapshot vs 실제 데이터 변경 | 전자는 재계산/호환성 처리, 후자는 preview 무효화. 어느 쪽도 독자적인 fetch 권한 아님. |
| T23 | 일일 목록이 새 변경을 발견했으나 cached preview가 완성 상태 | pending 입력 범위는 재검증 필요. 기존 preview로 최신 검증을 우회하지 못함. |
| T24 | HTTP 429/5xx/retry·취소·다음날 재개 | 각 attempt에 사유/범위 및 quota 기록. 성공 raw는 다음 시도에서 재사용. |
| T25 | 키 미설정·목록 작업 장애·stale 상태에서 raw 로컬 재처리 | 로컬 재처리는 가능. freshness checkpoint를 오늘로 위조하지 않음. |
| T26 | 두 DB 백업·복원/migration 중단 및 재실행 | raw·coverage·공시/승인 checkpoint 보존, 원문 API 호출 0회. |
| T27 | 단축코드 재사용/회사 매핑 교체 | 다른 법인 raw/facts를 재사용하지 않음. 정체성 확인 불가면 범위 차단. |
| T28 | 목록 확인 장애/초기 미실행/긴 중단, 정상 검증 입력 존재 | 새 preview·실행 허용. 마지막 확인시각 또는 확인 이력 없음과 경고를 기록. preview HTTP 0회. |
| T29 | T28 상태에서 특정 보고서 손상·정정이 이미 확인됨 | 해당 입력 작업은 승인/복구까지 차단. 영향 없는 입력은 경고와 함께 사용 가능. |
| T30 | 승인 반복 클릭·취소·재시작·새 변경 발생 | 동일 계획 중복 fetch 없음. 승인 범위 확대/다른 원문 변경에 승인 권한 재사용 없음. |
| T31 | 승인된 정정 반영 및 로컬 파서 재생 | 기존 완료 결과/pin 불변. 현재 출력은 의미에 맞게 갱신하되 PIT 가용시점 위조 없음. |

현재 `tests/unit/collection-coverage.test.ts`는 다른 해시/NULL coverage 재호출을 정답으로
고정한다. 이 기대를 T01~T04로 교체한다. `tests/architecture/runtime-version-boundaries.test.ts`는
실행 해시가 바뀌는 테스트로 남길 수 있지만, 해시 변경이 HTTP를 유발하지 않는 통합 검증이
추가되어야 한다. 기존 재무 content hash·gap·가격 품질·PIT 검증은 약화시키지 않는다.

### 8.3 실행 단계

1. 기존 원인 재현 및 adapter/store/plan 단위 검증: `collection-coverage`, `dart-raw-snapshot-store`,
   `dart-fact-source`, `fact-sync-service`, `fact-coverage-store`, `corporate-action-coverage`,
   `selection-metric-repository`, `symbol-master-*`, `benchmark-service`와 새 정책/원문 테스트.
2. migration·DB 복원·동시성·영속 일일 작업 및 queue 회복 검증.
3. `backtest-preparation`, `backtest-universe-preview`, `native-agent-preparation`,
   `external-api-usage`, `dart-sync-resume` 통합 검증. 물리 HTTP 수를 기록한다.
4. `pnpm typecheck`, `pnpm lint`, `pnpm exec depcruise src --config .dependency-cruiser.cjs`,
   `pnpm test`, `pnpm build`, `pnpm test:agent-package`, `pnpm test:e2e`로 전체 연결 검증.
   패키징된 agent가 raw/공급자 키 없이 실행되는 것을 확인한다. 설치 도구·환경 제약에 따른
   실패는 제품 실패와 분리해서 기록하고 필수 검증 미완료 상태로 인계한다.
5. 쓰기 가능한 운영 복사본 또는 대표 fixture에 새 migration을 적용하고 외부 네트워크를
   차단한 상태에서 기존 preview/재처리를 수행한다. unknown 레코드는 목록으로 보고한다.
6. 승인된 제한 갱신을 fake server로 수행하여 정확한 요청 키/회수와 원문·revision 변화를
   확인한다. 실 API smoke는 이 계획의 필수 검증이 아니다.

## 9. 운영 적용·롤백과 완료 조건

운영 조치는 이 문서 작업 중 수행하지 않았다. 이미 불필요한 호출이 진행 중이라면 적용
담당자는 먼저 관련 수집 작업의 일시 중단과 복구 지점을 확인한다. 서비스 재시작만으로
old queue가 다시 대량 호출할 수 있다는 점을 고려하고 데이터/coverage/원문을 삭제하지 않는다.

적용 전 두 DB 백업과 원문/coverage/공시 checkpoint 통계를 확보한다. 새 코드가 시작하면서
old queue를 바로 처리하기 전에 migration과 정책 재평가가 끝나게 한다. 기존 데이터를
이용하는 preview를 실행해 공급자 호출 사유·횟수와 기대값을 비교한다. 해시 변경/NULL 이행
때문인 요청이 한 건이라도 있으면 배포 검증 실패다.

불필요한 호출이 나면 수집 소비자를 멈추고 작업 상태를 보존한다. 코드만 과거 버전으로
되돌리면 기존 실행해시 무효화 정책이 다시 작동할 수 있다. 두 DB의 호환성·백업·진행 중
리스/작업을 확인한 롤백 절차를 사용하고, 복구를 이유로 공급자 전체 재수집을 하지 않는다.

완료 기준:

- 코드·DB 구조 변경만으로 KRX/DART HTTP 요청이 발생하지 않는다.
- 원문이 있으면 미사용 필드/파서 변경과 정규화 손상을 로컬에서 처리한다.
- 원문 없는 legacy 데이터와 정상 무자료를 보존하고 불필요한 cache 채우기를 하지 않는다.
- 최초 수집·일일 공시 확인·확인된 변경·승인 복구에 각각 최소 요청 범위와 근거가 있다.
- 미리보기·스케줄러·CLI·지수·queue 재개·HTTP retry 중 정책을 우회하는 경로가 없다.
- 최신성 확인/갱신을 실패했는데 최신이라고 표시하지 않고, 원문이 온전한 로컬 재처리를
  자동 재다운로드로 바꾸지 않는다.
- 목록 확인 실패만 있는 경우에는 마지막 확인시각/경고를 표시해 기존 검증 데이터로 새
  작업을 허용한다. 구체적인 손상·정정·필수 입력 결손의 차단과 혼동하지 않는다.
- 테스트 결과, migration 전후 보존 결과, 실제 허용/차단 요청 수를 완료 보고서에 남긴다.

## 10. 이번 문서 작업의 검증 기록

- `git fetch origin main` 성공, 조사 기준과 원격 main 일치.
- Git 변경 파일과 `runtimeGraph` 교집합 확인: 진행률 커밋 `c36e570`의 4개 파일이
  collection graph에 포함; 그 다음 main merge `de9eea1`에는 해당 그래프 변경 없음.
- `pnpm exec vitest run tests/unit/collection-coverage.test.ts tests/unit/dart-raw-snapshot-store.test.ts tests/unit/fact-sync-service.test.ts tests/unit/dart-fact-source.test.ts`
  실행: **4개 파일, 125개 테스트 통과**. 현행 버그성 계약과 원문 재생 구현을 확인한 baseline이며
  이 문서의 목표 동작이 구현됐다는 뜻이 아니다.
- 운영 DB/공급자 인증키/실 데이터 API를 사용하지 않았다. 사용자 정책 선택은 1절에
  확정 기록했다. endpoint 게시 시각 등 외부 사실은 별도 확인이 필요하며, 새 제품 정책
  결정이 필요해지면 사용자에게 질문하고 승인 정책을 임의로 바꾸지 않는다.
