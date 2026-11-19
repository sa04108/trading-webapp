# 브라우저 테스트 검토 기록

기준: `853d8b0b`, `tests/e2e` 전체와 Playwright 설정. 모바일·데스크톱은 단일 서버와 DB를 공유한다. 파일을 병합하거나 삭제하지 않았다. 아래의 fixture는 브라우저 HTTP 경계의 통제이며 실제 서버 경로를 대체하는지 여부를 구별한다.

| 파일 | 판단과 근거 |
| --- | --- |
| api-reference-settings.spec.ts | 유지: 발급 본문, 일회성 비밀, 폐기와 명세 검색·실행 금지를 브라우저 요청과 화면으로 검증한다. |
| auth-refresh.spec.ts | 유지: 인증 재조회 오류·복구·401에서 선택과 포커스 및 경로를 검증한다. |
| backtest-clone-actions.spec.ts | 유지: 화면 크기별 복제 배치, 시드 비의존 전략 및 실패 후 준비 액션을 검증한다. |
| backtest-experiment-navigation.spec.ts | 유지: 원본·실험·자식 이동과 직접 새로고침한 경로를 검증한다. |
| backtest-history.spec.ts | 유지: 전략별 페이징·정렬 조건·열 배치·선택·삭제 및 지연 재조회 시 상태를 검증한다. |
| backtest-result-benchmarks.spec.ts | 유지: 선택 저장·실패 복구·비교 재조회·수집 요청을 검증한다. |
| backtest-validation.spec.ts | 유지: 난수 비의존 전략의 입력 비활성과 제출 값, 비중 경계를 검증한다. |
| backtest-wizard.ts | 유지: 기간 단계 이동과 URL을 확인하는 공통 helper다. |
| dart-fixture.ts | 추가: 각 실제 준비 사례의 자본변동·주식수 무자료 원문만 준비하고 커버리지는 실제 수집이 기록한다. |
| configuration-search.spec.ts | 유지: 요청 설정, 마우스·터치·키보드 조정, 지연 응답 무효화를 검증한다. |
| intraday.spec.ts | 유지: 수집·차트·상태·실행·복제·기간검증·계좌 생성의 화면과 요청을 검증한다. 일별 보고서 fixture는 도메인 생성 함수를 사용하므로 독립적인 계산 정확성 검사는 아니다. |
| jobs.spec.ts | 유지: 폴링 상태 전이, 종료 후 중단, 선택·필터·삭제 본문 및 지연 갱신을 검증한다. |
| login.ts | 유지: 독립 브라우저 컨텍스트에서 실제 시드 계정 로그인 helper다. |
| mvp-flow.spec.ts | 변경: 실제 서버 준비·실행·복제·거래 필터, 휴장 적용일 및 상장폐지 종목 경로를 검증한다. 공유 DB와 고정 기간을 사용한다. 실패 화면 캡처는 프로젝트별 출력 경로로 분리했다. |
| notifications.spec.ts | 유지: 선택 보존, 상한 밖 전체 선택과 제외 항목 삭제 본문을 검증한다. |
| period-validation.spec.ts | 변경: 재연결 테스트의 실시간 5.1초 대기 두 번을 제어 가능한 브라우저 시계 진행으로 대체했다. 실패·복구·404 및 입력·포커스 assertion은 유지한다. |
| preparation-issues.spec.ts | 유지: 경고 집계와 두 상세 보기의 행, 접근성 및 화면 경계를 검증한다. |
| step-urls.spec.ts | 변경: 위저드 이력·저장·재개·제출 거절과 직접 접근 게이트를 검증한다. 해당 사례에서 필요한 DART 원문을 준비한다. |
| symbol-master.spec.ts | 변경: 실제 시드 날짜를 명시적으로 열고 현재 coverage와 인접하지 않는 미수집 평일을 선택해 재실행·프로젝트 순서에 따른 충돌을 피한다. 수집 전 빈 상태와 새 세그먼트 검사는 유지한다. 날짜 후보가 모두 소진되면 명시적으로 실패한다. |
| trading-account.spec.ts | 유지: 갱신 중 초안 보존, 활성화 확인, 시세 폴링, 복구 및 실제 계좌별 저장을 검증한다. 실제 계좌 생성은 공유 DB에 기록을 남긴다. |
| universe-pipeline.spec.ts | 변경: 단계 편집·입력 경계·시장 저장 및 실제 준비·제출·복제를 검증한다. 각 프로젝트의 기간과 필요한 원문을 사례에서 준비한다. |

DART 원문 fixture는 실제 준비 시나리오별 종목·연도만 제공하며 재무 원문과 커버리지는 직접 만들지 않는다. KRX 준비량과 같은 단일 사례의 전후 시간은 [전체 검토 기록](testing-audit-vitest-update.md)에 있다.

독립 검증: `pnpm exec playwright test tests/e2e/universe-pipeline.spec.ts --reporter=line` 12 passed, exit 0; `pnpm exec playwright test tests/e2e/step-urls.spec.ts --reporter=line` 20 passed, exit 0; `pnpm exec playwright test tests/e2e/symbol-master.spec.ts --reporter=line` 2 passed, exit 0. 각 실행은 새 서버·DB에서 모바일과 데스크톱을 순서대로 실행했다. `mvp-flow.spec.ts`는 5 passed, 2 failed, 1 skipped, exit 1: 두 전체 흐름에서 서버 완료 후 화면이 실행 중으로 남았고, 별도 원인 분석에서 완료 revision 처리 결함이 확인되었다. 휴장과 상장폐지 실행은 양 프로젝트 통과했다. 완료 화면 두 건을 분리하고 나머지 전부를 `pnpm exec playwright test --grep-invert 'full MVP flow'`로 검증했다. 종료 코드 0, 145개 통과, 모바일 레이아웃 전용 검사의 데스크톱 1개는 기존 설정에 따라 건너뛰었다. 여기에는 두 프로젝트의 시계 복구, 슬라이더 조정, 세 시장 선택·저장 검사가 포함된다.

종목 마스터는 빈 DB에서 프로젝트 순서를 데스크톱→모바일로 뒤집어 실행한 경우에도 2개 모두 통과했다.

실패한 두 전체 흐름에서 완료 상세 응답의 진행 번호가 각각 10→1, 11→1로 바뀌었다. 같은 작업의 진행 중 상태(번호 9)와 완료 상태(번호 1)를 실제 화면의 상태 선택 함수에 전달해도 진행 중을 반환했다. 테스트의 완료 표시 단언과 제한 시간은 유지했다.

상세 조회와 실시간 이벤트가 공유하는 상태 선택 함수에서 같은 작업의 종료 상태를 진행 번호보다 먼저 반영하도록 수정했다. 빌드 후 `pnpm exec playwright test tests/e2e/mvp-flow.spec.ts --grep "full MVP flow"`를 실행해 모바일(390×844)과 데스크톱(1440×900) 모두 실제 서버의 완료 응답, 화면의 누적 수익률, 거래 필터와 복제를 확인했다. 두 사례 모두 통과했다.

최종 작업 트리에서 필터 없이 `pnpm exec playwright test`를 실행한 결과 147건 통과, 종료 코드 0이었다. 모바일 전용 가로 스크롤 검사의 데스크톱 실행 1건은 기존 조건에 따라 건너뛰었다.

별도 임시 Playwright 설정에 Chromium의 Pixel 7 기기 프로필을 적용해 터치 드래그와 전체 백테스트를 다시 실행했다. 슬라이더 양쪽 핸들의 값 변경과 완료 결과 화면을 포함해 2건 모두 통과했다. 모바일 검증에는 에뮬레이션을 사용했다.
