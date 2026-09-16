# Provider data reuse 구현 상태

기준 문서: [provider data reuse / API policy 계획](./2026-09-16-provider-data-reuse-and-api-policy.md)

기준 브랜치: `docs/provider-data-reuse-plan` (`f762f2b82e425250c48a89070171fd20fa36a531`)

구현 브랜치: `feat/provider-data-reuse-20260916-h7m4`

## 상태

**부분 구현이며 문서 전체의 완료본이 아니다. 병합 전 남은 구현이 필요하다.**

사용자 요청에 따라 테스트 실행·typecheck·빌드·배포·운영 DB 검증은 하지 않았다. 아래 항목은 작성된 코드의 범위이며 실행 성공을 의미하지 않는다.

## 반영한 범위

### A — 공통 정책 계약과 HTTP attempt hook

- 요청 키에서 실행 해시·인증 인자를 분리하고 요청 인자를 정규화한다.
- 기존 데이터 재사용, legacy 재사용, 로컬 재생, 로컬 복구, 최초 수집, 해석 실패, 소스 필드 결손, 정정·손상 승인, 게시 대기를 구분하는 순수 정책 함수를 추가했다.
- 계획은 입력 객체와 분리된 불변 값이다. 요청 범위·근거가 바뀐 계획에 이전 fingerprint를 붙여 승인받을 수 없도록 검사한다.
- `RestClient.request`에 attempt별 `authorizeAttempt`와 취소 신호를 추가했다. 재시도 직전에도 hook을 호출하고, 거절되면 데이터 HTTP 및 quota hook을 호출하지 않는다.
- **KRX/DART 모든 어댑터가 이 정책을 강제하도록 연결한 상태는 아니다.** hook과 정책 함수만으로 전체 시스템의 무승인 재수집이 금지됐다고 해석하면 안 된다.

### B — 실행 해시와 수집 이력 분리

- KRX 종목 마스터·거래불가일·선정 지표의 완료 조회에서 `collectionVersion` 일치 조건을 제거했다.
- NULL·A·B 등 과거 수집 이력의 중첩·인접 구간을 읽을 때 합친다. 실제 미수집 날짜는 합치지 않으며, 거래일 앵커도 같은 연결 구간 안에서만 찾는다.
- 과거 이력 행의 실행 해시와 수집 시각은 읽기 과정에서 변경하지 않는다. 새 완료일은 별도 출처 기록으로 추가한다. 스키마 변경이나 과거 행의 일괄 재라벨링은 하지 않았다.
- 거래불가일 백필에서 완료일을 건너뛴다. 시가총액은 선정 지표 완료 이력과 저장값을 재사용하며 정상 무자료도 구분한다.
- DART 재무·자본변동 coverage에서 실행 해시 결합만 제거했다. 해석 protocol 번호, 재무 manifest의 내용 해시·건수, blocking gap 검증은 유지한다.
- 기존 `collection-coverage.test.ts`의 해시 변경 시 재수집 기대값을 재사용·원본 보존 기대값으로 변경했다.

## 남은 구현 — 완료로 간주하지 말 것

| 계획 단계 | 남은 범위 |
| --- | --- |
| A 연결 | 모든 KRX/DART 외부 호출 경로에서 현재 로컬 상태와 저장된 승인으로 정책을 강제하는 연결 |
| C | KRX 영속 원문 저장·무결성/identity 검증·로컬 사본 복구·재생, endpoint 단위 재시작/경합 처리, 게시 대기와 확정 무자료 구분 |
| D | DART 하루 1회 공시 탐색의 영속 cursor/페이지/재개·중복 제거, corpCode 영속화, 공시별 최소 재수집, 소비자별 checkpoint, FULL/REFRESH/90일 갱신 우회 제거 |
| E | 승인 계획/범위/시도 예산의 영속화, 승인 취소·소비·철회, blocked queue 상태, 승인 API·UI 및 운영 로그 연결 |
| F | snapshot/preview의 데이터 revision·freshness·실행 호환성 분리와 캐시 검증, DECISIONS/AGENTS/SPEC 최종 상태 갱신 |
| 통합 회귀 | 계획 T01–T31 전체를 실제 HTTP attempt 계수·두 DB 복원·재시작·UI/queue까지 연결하는 통합 회귀 |

원문/manifest 결손, 해석 protocol 변경, 강제 갱신 등 기존 수집 경로의 모든 재조회 사유가 제거된 것은 아니다. 승인 타입은 있으나 영속 승인 저장소나 승인 UI는 없다. 원문이 없는 기존 데이터에서 새 원문을 자동 생성하거나, 기존 정상 데이터를 현재 실행 해시로 일괄 덮어쓰지는 않았다.

## 작성한 회귀 테스트

- `tests/unit/provider-data-policy.test.ts`: 정책 분류, legacy 재사용, 승인 철회 후 retry 중단, 최초 거절/취소 시 실제 mock HTTP 0회 및 quota 0회.
- `tests/unit/provider-plan-identity.test.ts`: 계획 작성 뒤 원본 인자 변경, 다른 endpoint·근거에 대한 fingerprint 재사용, 소비된 승인 거부.
- `tests/unit/coverage-intervals.test.ts`: 중첩·인접·윤년·연말·실제 결손·원본 불변성.
- `tests/unit/collection-coverage.test.ts`: NULL/이전 해시 재사용, fact 변조·gap·해석 protocol 검증 보존, 증분 수집 호출 생략, KRX 원본 coverage/봉 보존, 거래일 앵커 및 정상 0건 재사용.

검증을 담당하는 사람이 사용할 수 있는 대상 명령이며, 이번 작업에서는 실행하지 않았다.

```sh
pnpm exec vitest run tests/unit/provider-data-policy.test.ts tests/unit/provider-plan-identity.test.ts tests/unit/coverage-intervals.test.ts tests/unit/collection-coverage.test.ts
pnpm typecheck
pnpm lint
```
