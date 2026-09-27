# 테스트 아키텍처 및 전환 계획

> 이 문서는 테스트 분류와 실행 시점을 표준화해 개발자가 필요한 검증을 직접 선택하고 결과를 예측하기 쉽게 하기 위한 설계 및 전환 체크리스트다. 테스트 개수나 특정 실행 시간 달성을 수용 조건으로 삼지 않는다.

기준 코드 스냅샷은 `ba3834e` (`origin/main`, 2026-09-27)이다. 이 문서는 확정된 설계와 전환 기준을 적으며, 마지막 절에 이 문서와 함께 커밋하는 변경의 실제 검증 결과를 구분해 기록한다.

## 확정된 운영 계약

| 시점 | 검증 | 기준 |
| --- | --- | --- |
| 개발 중 | 필요한 테스트 파일·수집 목록 확인 | 전체 검증을 기다리지 않고 선택적으로 수행 가능 |
| 커밋·PR 전 | `pnpm test --project unit --project component` | 빠른 회귀 검증. integration을 구현 중 실행하지 않은 사실만으로 커밋을 막지 않음 |
| 배포 | `pnpm test --project integration` | integration을 실제 실행. 전체 Vitest를 호출하는 `pnpm test`의 의미는 유지 |
| 별도 수동 배포 전 검증 | `pnpm test:e2e` | 로컬 테스트 서버 및 테스트가 제공하는 fake 응답으로 Playwright 검증. `build-release`에 자동 연결하지 않음 |
| 릴리스 산출물 | 기존 릴리스 절차 | `pnpm build` → `dist/build-info.json` 작성 → `pnpm build:agent --prepared` → `pnpm test:agent-package` 순서 유지 |

`pnpm test`는 세 Vitest project를 모두 실행한다. 허용된 프로젝트 구분은 `unit`, `component`, `integration`이다. `test:all`, `test:fast`, `test:integration`, `test:architecture` 등 새 package script를 추가하지 않는다. 기존 `test`, `test:e2e`, `test:agent-package` 명령을 유지한다. 새 테스트 러너, 실행 조정 CLI, 제품 코드 구조 변경은 이 전환 범위에 포함하지 않는다.

## 계층과 분류

분류는 속도가 아닌 실제 검증 경계에 따른다.

| Project | 계약 경계 | 예시 |
| --- | --- | --- |
| `unit` | 단일 함수·클래스의 계산, 정책, 상태 전이 | fake 의존성을 사용할 수 있다. fake 사용이나 파일 확장자만으로 component로 올리지 않으며, JSX 파일이어도 순수 함수만 검증하면 unit이다 |
| `component` | 실제 하위 시스템 동작 | 실제 전략을 포함한 엔진, UI 렌더링, 실제 REST client/parser와 fake fetch를 결합한 공급자 adapter, `FactSyncService`, 재무/PIT 조회, universe resolver |
| `integration` | 실제 저장소·파일·프로세스·통신 경계의 연결 및 수명주기 | SQLite 원자성, 파일시스템·의존성 구조, IPC, 실행 산출물 |

component 분류는 새 coordinator 주입 경계나 제품 코드 리팩터링을 요구하지 않는다. 이미 있는 주입 경계에서 실제 하위 시스템을 결합한다. architecture 검사는 개념상 정적 구조 계약이며 별도 동작 계층은 아니다. 기존 두 파일 `module-boundaries.test.ts`, `runtime-version-boundaries.test.ts`에 들어 있는 세 사례(첫 파일 1개, 둘째 파일 2개)는 `tests/integration/architecture`에 두어 integration 실행에 포함하고 보존한다. 프로젝트 간 이동은 이름만 바꾸는 작업이 아니며, 실제 의존성과 보호 계약을 확인해 분류한다.

```text
tests/
  unit/                      독립적인 계산·정책·상태 전이
  component/                 실제 하위 시스템과 제어된 외부 의존성
  integration/               실제 DB·파일·프로세스·통신 경계
    architecture/            실제 소스·의존성 그래프 검사
  e2e/                       Playwright 브라우저 시나리오
  fixtures/                  테스트 입력
  helpers/                   테스트 조립과 정리
  setup/                     공통 실행 환경과 보호 설정
```

기존 파일에 여러 경계의 사례가 섞여 있으면 실제로 사용하는 가장 넓은 경계에 파일 전체를 배치한다. 이번 전환에서는 사례를 분할하거나 검증 조건을 약화하지 않는다. 이동에 필요한 상대 경로와 배포 선택 명령의 기대값만 갱신한다. 새 계약의 테스트 위치는 기존 파일의 위치를 기계적으로 따르지 않고 최소 충분한 범위로 정한다. 예를 들어 수량 계산 규칙만 검증하면 `unit`, 전략·체결·회계를 함께 실행하면 `component`, SQL 갱신의 원자성을 검증하면 `integration`이다.

목록은 `pnpm exec vitest list --project unit`처럼 테스트 본문을 실행하지 않고 확인할 수 있다. 이 명령도 설정·setup·테스트 모듈을 로드하므로 테스트 환경에서 사용한다. 특정 계약은 `pnpm test --project unit tests/unit/position-sizing.test.ts`처럼 파일 경로로 선택하며, 커밋·PR 전에는 해당 단계의 unit·component 전체를 실행한다.

## 테스트 추가 및 보존 기준

- 기존 테스트가 새 계약을 보호하지 않으면, 제품 코드 변경 유무와 관계없이 영구 테스트를 추가한다. 기존 테스트가 그 계약을 이미 충분히 보호하는지 먼저 확인한다.
- 기존 테스트 보완으로 충분하면 이를 우선한다. 새 테스트가 필요하면 계약을 보호하는 최소 충분 범위를 택하고, 가능하면 unit으로 검증한다. 이미 보호되는 계약에 component·integration·E2E를 중복 추가하지 않는다.
- 중요한 계약과 대표 반례를 유지하고, 테스트 수를 맞추려고 검증 범위를 줄이지 않는다. 이번 전환에서는 테스트를 이동하며 assertion·입력·사례를 삭제하거나 합치지 않는다. 이후 중복 테스트 통합을 제안하려면 동일한 중요 계약과 실패 사례의 검출 근거를 남긴다.
- 테스트를 이동·재분류할 때 계약·입력·자원 상한을 보존한다. 공통 보호 설정, alias, 런타임 버전 초기화, 격리와 외부 연결 guard도 유지한다.
- 실제 파일시스템·의존성 그래프 검사는 기존 architecture의 2개 파일과 3개 사례를 integration 내 경로로 옮기되 내용을 보존한다.
- coordinator 등 제품 코드의 구조 리팩터링은 이 작업의 목표가 아니다. 이미 있는 주입 경계를 사용하고 테스트 편의만을 위한 새 추상화를 만들지 않는다.

## 격리와 실행 환경

Vitest의 변경 가능한 fixture는 테스트마다 격리한다. 테스트가 공유하는 가변 DB·파일·프로세스 상태를 재사용해 실행 순서에 의존하게 하지 않는다. 불변 입력 재사용은 동작과 안전성이 확인되는 범위에서만 허용한다.

E2E는 현재 공유 테스트 서버와 DB 구성을 유지한다. E2E에는 Vitest의 테스트별 fixture 격리 조건을 적용하지 않는다. Playwright는 자체 로컬 서버와 시나리오별 fake API 응답을 사용하며 운영 서버를 검사하지 않는다. E2E는 별도 수동 배포 전 검증이며 정기적인 `pnpm test`나 릴리스 스크립트에 넣지 않는다.

테스트 설정의 공통 forks, isolation, network guard, alias, `QUANT_SOURCE_RUNTIME_VERSIONS` 초기화, 런타임 버전 조건은 이번 분류 변경으로 제거하거나 바꾸지 않는다. 기존 실제 SQLite, 프로세스, 메모리 제한 및 패키징 검증이 지키는 계약을 보존한다.

일반 Vitest는 명시적인 `forks`, 파일별 격리, 재시도 0회, 최대 worker 2개로 실행한다. 테스트 자체가 시작하는 자식 프로세스는 이 worker 수와 별개다. 기존의 테스트별 timeout과 자원 상한은 그대로 둔다.

## 전환 체크리스트

1. **기준선 확인:** `ba3834e` 이후 현재 변경을 확인하고, 기존 runner의 수집 목록 및 테스트 입력·assertion을 기록한다. 테스트 목록 확인은 가능하지만 이를 실행 통과 결과로 표현하지 않는다.
2. **분류 이동:** 기존 테스트를 실제 경계에 따라 unit/component/integration으로 재분류한다. Vitest 설정을 세 project로 구성하고 공통 보호 설정을 보존한다.
3. **기존 계약 보존:** 파일 이동과 import 보정을 끝낸 뒤 테스트명·assertion·입력·사례가 소실되지 않았는지 비교한다. architecture 테스트는 2개 파일의 3개 사례를 유지한다.
4. **TypeScript 범위 반영:** JSX를 사용하는 component 테스트가 타입 검사에 포함되고, 제품 빌드의 테스트 파일 범위는 기존 의도대로 제외되는지 tsconfig include/exclude를 조정한다.
5. **릴리스 연결:** 배포 검증에 integration project를 실제 실행으로 포함한다. `pnpm test`는 전체 Vitest 명령으로 유지하되 커밋 전 필수 명령은 unit·component 선택 실행으로 둔다. `pnpm build`와 build-info 작성 뒤의 agent 준비 및 패키지 검사 순서를 보존한다. E2E는 자동 릴리스 게이트에 추가하지 않는다.
6. **문서 및 검증 기록:** README 실행 표와 이 문서를 설정·명령에 맞춘다. 실제 수행한 명령, 스냅샷, 종료 상태와 미검증 범위를 기록한다. 실행하지 않은 integration·E2E·패키지 검사는 미검증으로 남긴다.

## 운영상의 제한과 불확실성

100개 테스트 또는 180초는 측정·수용 조건이 아니다. 이 수치를 위해 테스트를 감축하거나 기존 계약을 약화하지 않는다. 이번 설계는 계약 분류와 실행 시점을 명확히 하지만, 실제 테스트별 경계 판단 및 실행 성공은 해당 검증을 수행하고 결과를 남겨야 확정할 수 있다.

integration, E2E, agent package 검증은 배포 시 실제 실행한다. 구현 중에는 필요한 경우 수집 목록과 설정을 확인할 수 있으나, 목록 확인은 테스트 동작 검증을 대체하지 않는다. 외부 환경 오류나 미실행으로 남은 검증은 이유와 함께 보고하고 통과로 표시하지 않는다.

## 전환 결과와 검증

검증 대상은 `ba3834e`에 이 문서와 함께 커밋하는 전환 변경을 적용한 스냅샷이다. Linux x64, Node 24.19.0, pnpm 11.25.0, Vitest 4.1.10에서 확인했다. 설치에는 `pnpm install --offline --frozen-lockfile`을 사용했고 lockfile과 package script는 변경하지 않았다.

| Vitest project | 파일 수 | 수집 사례 수 | 실행 상태 |
| --- | ---: | ---: | --- |
| unit | 91 | 963 | 전체 통과 |
| component | 29 | 470 | 전체 통과 |
| integration | 96 | 851 | 수집 확인, 배포 단계 실행 예정 |
| 합계 | 216 | 2,284 | 전환 전후 사례 수 동일 |

기존 unit 파일 62개를 integration으로, 29개를 component로 이동했고 architecture 2개 파일을 integration 하위로 이동했다. 93개 파일의 원문을 대조해 테스트 입력과 검증 내용이 보존됐음을 확인했다. 변경된 테스트 내용은 실제 상대 경로 세 곳과 릴리스 검사의 `test --project integration` 기대값뿐이다. 새 영구 테스트는 추가하지 않았다. 제품 소스는 이동한 테스트를 가리키는 주석만 갱신했으며, 주석을 제외한 TypeScript 구문 트리는 동일하다.

| 수행한 검증 | 결과 |
| --- | --- |
| `pnpm exec vitest list --json=…` 전환 전후 대조 | 종료 0. 이동 경로를 대응시킨 파일·전체 테스트명 기준 누락·추가 중복 0건 |
| `pnpm test --project unit --project component` 및 JSON reporter | 종료 0. 120개 파일, 1,433개 사례 통과, 실패·skip·todo 0건 |
| `pnpm lint`, `pnpm typecheck` | 최종 코드에서 각각 종료 0 |
| `bash -n scripts/build-release.sh`, `git diff --check` | 각각 종료 0 |
| TypeScript include/exclude 확인 | JSX 테스트 8개는 웹에서만 검사, 제품 build에 테스트 파일 0개 |
| `pnpm exec vitest list --config vitest.agent-package.config.ts --json=…` | 종료 0. 패키징 2개 사례 수집 |
| `pnpm exec playwright test --list --reporter=json` | 종료 0. E2E 논리 사례 32개, 두 프로젝트의 실행 인스턴스 64개 수집 |

Vitest의 전체 목록을 수집했지만 integration 본문을 실행한 것은 아니다. E2E·패키징도 목록만 확인했으며 설정과 테스트는 유지했다. 제품 빌드·배포는 수행하지 않았다. 이 결과는 커밋·PR 단계 검증 완료이며 배포 단계 검증 완료를 의미하지 않는다.
