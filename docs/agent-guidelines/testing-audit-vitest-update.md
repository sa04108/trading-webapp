# 테스트 전체 재검토

`853d8b0b`를 기준으로 `git ls-files tests`의 305개 파일과 실행 설정, 브라우저 서버, 수동 KRX 진단을 검토했다. 기존 265개 Vitest 파일은 일반 회귀 264개와 패키지 통합 1개로 구성된다. Playwright에는 spec 18개와 helper 2개가 있었고, 이 작업에서 사례별 DART 원문 helper 1개를 추가했다. 브라우저 파일별 판단은 [브라우저 검토 기록](testing-audit-browser-update.md)에 있다.

[기존 파일별 감사](testing-audit.md)가 적용된 `0d115e3a`와 비교해 현재 내용이 달라진 Vitest 39개와 삭제된 3개는 변경된 입력, 단언, 문서 계약을 대조했다. 같은 blob 226개는 당시의 본문 검토를 재사용하고 이후 변경된 의존성의 영향을 재평가했다. 별도 패키지·Windows PowerShell·컨테이너 이미지의 실행 설정도 확인했다.

## 기존 파일의 영향 판단

상대 import와 동적 import의 문자열 리터럴을 따라 변경된 모듈에 도달하는지 조사했다. 이 목록에는 타입 의존성도 포함된다. SQL 마이그레이션, 파일을 읽는 아키텍처 검사, 별도 프로세스·패키지 실행은 import 목록 밖에서도 입력이 바뀌므로 각각 실제 실행 경계로 확인한다.

- **DB와 외부 자료**. 마이그레이션 0029는 난수 배치만 제거하고 0030은 기존 모의 계좌·주문을 옮긴다. 이전 DB에서 이행하는 테스트와 SQLite를 새로 여는 테스트를 모두 유지했다. 원문 해시 손상, coverage 합집합, 재시도 후 최종 상태, 종목별 PIT cutoff는 저장 결과를 검증한다. 공용 종목 마스터 fixture가 2000년부터 2099년까지 수집 완료로 표시하던 행을 없앴다. 시총·거래일을 확인하는 사례는 요청일만, 워커/재시작이 필요한 사례는 해당 요청의 워밍업 구간만 지정한다. 운영 DB와 데이터 DB의 구분 및 데이터셋 게시 전 검사는 파일 복구·버전 교체 계약을 계속 담당한다.
- **실행·시계열·거래**. 기간 시작 전 워밍업과 실제 진입일·수량·첫 결과일을 확인하는 워커 검사, 재무정보 적용 시각, 거래 불가 종목 제외와 일정별 편출입은 서로 다른 결함을 검출한다. 분봉 집계와 일별 평가의 독립 OHLCV·손익 기대값도 유지했다. 거래 브로커의 견적/주문과 주문 직전 취소 계약은 모의투자의 신규 슬롯·비용 검사와 함께 남겼다.
- **시장 선택·화면**. 과거 저장된 단일 시장 입력은 여전히 유효하다. 유니버스 순위·페이징·기간 분할 전용 입력의 KOSPI 또는 KOSDAQ 한 개를 일괄 변경하지 않았다. 합산 순위는 실제 DB 테스트, 최초 기본값과 선택 변경은 화면 테스트가 확인한다. 준비 마법사의 저장/재개·직렬화, 기간검증 SSR 표시와 실제 브라우저의 포커스 복원은 계층별 계약을 유지한다.
- **공용 앱·프로세스**. `createTestApp`을 경유하는 인증·권한·토큰 만료·경로·헤더 검사는 응답 코드와 상태가 독립 기대값이고 KRX 대기 주입을 사용하지 않는다. 실제 자식 프로세스의 종료·stderr 배출, 작업 임대·취소·파일 정리와 저장된 데이터셋 재사용은 해당 helper/DB와 함께 검증한다. 아키텍처 검사는 그래프·마이그레이션과 가상 실행 코드 변경 전후 버전 집합을 직접 비교한다.
- **변경한 경계**. 기간검증 실험이 원본과 자식을 참조하면 큐 직접 삭제도 각각 거부되어야 한다. KRX 복구는 서비스 fake가 전달하는 옵션 외에 실제 어댑터가 양 시장의 공식 개장을 판정하고 승인 없는 복구 HTTP를 차단해야 한다. 두 경계를 기존 파일에서 보강했다. 취소 중인 분봉 작업의 해제와 매도 주문 거절 fixture도 기존 사례에서 수정했다.

### 이전 감사 이후 변경·삭제된 테스트

| 파일 | 이번 판단 | 근거 |
| --- | --- | --- |
| `tests/integration/backtest-experiments.test.ts` | 유지 | 설정 탐색 자식·형제 삭제와 원본 보존을 실제 SQL/API로 확인하고, 기간검증 경로·OOS 평균을 유지한다. 제거된 seed 경로는 폐기된 테이블·라우트에 한정된다. |
| `tests/integration/backtest-facts-worker.test.ts` | 수정 | 폐기된 배치 대신 시드가 다른 설정 복제 두 건의 실제 저장 요청과 두 일정 모두 NOFACTS 포함을 확인한다. |
| `tests/integration/backtest-history.test.ts` | 유지 | 기존 50개 페이지·정렬은 유지한다. 삭제된 101개 배치 조회는 제거된 batch API 계약이며 현재 실험 삭제와 소유권은 backtest-experiments에서 확인한다. |
| `tests/integration/backtest-refresh-service.test.ts` | 수정 | 실행 중인 갱신은 완료 원본의 직접 삭제를 막고, 갱신 완료 후 삭제와 행 정리가 가능함을 확인했다. 폐기된 RANDOM_SEEDS 대신 기간검증으로 요청 충돌 및 버전 변경 복구를 확인하고 영속 상태·소유자 분리를 유지한다. |
| `tests/integration/backtest-split-alignment.test.ts` | 유지 | 실제 워커에서 미정렬·상충·연도 gap의 신규 매수 금지, 빈 포지션과 경고를 확인한다. 준비 시에는 종목과 경고를 저장해 SPEC 90의 변경을 반영한다. |
| `tests/integration/configuration-search.test.ts` | 유지 | 구 API 404·우회 갱신 400 및 저장 행 불변, API 문서와 randomSeed 탐색 노출을 확인한다. |
| `tests/integration/daily-strategy-parity.test.ts` | 유지 | 실제 백테스트와 일봉 판단 checkpoint를 비교하고 전략별 BUY 수량, STOP, 편출·부분 체결·gap, 종목 우선순위와 실제 paper service 잔고를 구체적으로 확인한다. 동등성은 계산 정답 전체가 아니라 양쪽 일치 계약이다. |
| `tests/integration/intraday-flow.test.ts` | 유지 | 실시간 누락 봉 병합·동시 요청 합침·휴장/달력 오류·과거 수집과 분리·과거 결과 replay 변조를 검사한다. 수집 gate는 cleanup에서 해제한다. |
| `tests/integration/intraday-paper.test.ts` | 수정 | 부분 체결 후 재시작의 주문·비용·잔고, OFF 중 늦은 응답, 오류 시 잔량 취소 및 ON 이전 신호 억제를 검사한다. 중간 예외에도 gate를 finally에서 해제하도록 수정했다. |
| `tests/integration/job-center.test.ts` | 유지 | 105건 페이지 밖 종료 작업 일괄 제외, 소유권·활성 보존과 selectionCount를 실제 DB/API로 확인한다. 삭제한 배치 자식은 폐기 기능이다. |
| `tests/integration/job-queue.test.ts` | 유지 | 공통 생성·복제의 준비 TOCTOU와 큐 계약은 유지하며 폐기된 배치 생성/취소/삭제 경로만 제거됐다. 현 설정 탐색 취소는 configuration-search-service, 삭제 원자성은 backtest-experiments에 남는다. |
| `tests/integration/notification-routes.test.ts` | 유지 | 205개 중 필터·예외의 저장 행과 200개 페이지 경계, 유효하지 않은 입력과 선택 수를 확인한다. |
| `tests/integration/trading-decision-fork.test.ts` | 유지 | 실제 자식 및 SQLite로 진입 주문, 미보유 gap 보류, 보유 gap 복구 요청과 누락 봉 요청을 구분한다. |
| `tests/unit/backtest-corporate-action-gaps.test.ts` | 유지 | 미상 일자 gap의 연도 범위 및 주말 사이 coverage를 확인한다. SPEC 90의 불확실 기간 보류와 일치한다. |
| `tests/unit/backtest-engine-universe-schedule.test.ts` | 유지 | gap으로 우선 후보가 취소될 때 편출 후보 차단과 자금 부족 다음 후보 체결을 구체적 종목·수량으로 검사한다. |
| `tests/unit/backtest-preparation-orchestrator.test.ts` | 유지 | 자본변동 gap 대상은 준비 단계에서 유지·경고하고 실제 SQLite coverage 변경에 따라 cached/isolated preview를 무효화한다. |
| `tests/unit/backtest-refresh-dialog.test.tsx` | 유지 | 중첩 기간검증 설정을 복사하여 원본 변이 후 동일 요청 ID 재사용과 다른 입력의 새 ID를 확인한다. |
| `tests/unit/backtest-request.test.ts` | 유지 | 두 시장 양방향 순서 및 단일 시장 보존과 중복·미지원·빈 배열 거부를 스키마에서 확인한다. |
| `tests/unit/backtests-page.test.tsx` | 유지 | 폐기된 seed 열·링크를 제거하고 기간검증 링크와 통계 SSR을 유지한다. 클릭 상호작용은 이 검사의 범위가 아니다. |
| `tests/unit/configuration-search-catalog.test.ts` | 유지 | 통합·개별 시장 세 선택이 전체 배열에 반영되고 원본 요청이 불변인지 확인한다. |
| `tests/unit/corporate-action-effective-date.test.ts` | 유지 | KRX 짝이 없으면 matchedFacts가 비고 원래 일자와 unaligned가 남는 경계를 검사한다. |
| `tests/unit/dart-fact-source.test.ts` | 유지 | 보통주/보통주식 별칭, 충돌·누락·접수일·기준일, 우선주 구분과 잘못된 분할 앵커를 원문 형식으로 검증한다. |
| `tests/unit/history-table-preferences.test.tsx` | 유지 | 폐기된 seed 열을 복원 설정에서 제거하고 중복·미지원 열 처리 계약을 유지한다. |
| `tests/unit/intraday-engine.test.ts` | 유지 | 부분 체결 상태 직렬화·재개가 단일 실행의 신호·체결·잔고 상태와 일치함을 확인한다. 별도 기존 사례가 체결 계산값을 검사한다. |
| `tests/unit/intraday-store.test.ts` | 유지 | 기존 확정 봉 보존·다른 월 파일 유지·retention 경계·100종목 제한을 임시 Parquet에서 확인한다. |
| `tests/unit/notification-wiring.test.ts` | 유지 | 삭제된 batch listener와 자식 억제만 제거됐다. 일반 백테스트 알림·실패 격리는 유지되고 새 설정 탐색 별도 경계가 있다. |
| `tests/unit/paper-trading-broker.test.ts` | 유지 | 실제 SQLite로 계좌별 주문·잔고·비용과 타 슬롯 주문 조회/취소 거부를 검사한다. |
| `tests/unit/paper-trading-migration.test.ts` | 유지 | 기존 계좌·배포·주문 모든 행 보존, 외래키·고유 제약과 2번 슬롯 입력을 실제 이전 스키마에서 확인한다. |
| `tests/unit/preparation-issues-card.test.tsx` | 유지 | 자본변동 경고를 전기간 제외가 아닌 NOTICE로 해석하는 명시적 필드와 문구를 검사한다. |
| `tests/unit/preparation-reference-service.test.ts` | 유지 | 삭제된 batch 참조를 제거하고 공유 job·wizard 참조가 있는 준비의 수명과 원자성은 유지한다. |
| `tests/unit/runtime-domain-migration.test.ts` | 유지 | operations/agent 이행 2회 후 행·외래키 보존과 batch 제거, 구 갱신만 폐기하고 공유 준비는 취소하지 않는 것을 확인한다. |
| `tests/unit/symbol-master-ingest.test.ts` | 수정 | 공식 개장일 빈 coverage 복구의 실패/경쟁 요청, KRX 원문 보존, 이후 SCD 주식수 유지 및 재호출을 실제 SQLite·loopback으로 확인한다. |
| `tests/unit/trading-data-preparation.test.ts` | 유지 | 서버가 결정한 기간별 증분/강제 재수집 인자, gap 유형·오류·취소 전달을 좁은 공급자 fake로 검사한다. |
| `tests/unit/trading-decision-valid.test.ts` | 유지 | 종목별 신규 상장 warmup, 보유/미보유 gap과 재무 복구·시점 제한·checkpoint 경계를 구체적인 주문과 요청으로 검사한다. |
| `tests/unit/trading-routes.test.ts` | 유지 | 인증되지 않은 쓰기 및 복구 입력 추가 필드 거부, 정상 revision·사용자 전달과 202를 확인한다. |
| `tests/unit/trading-service.test.ts` | 수정 | 계좌별 동시성, 복구와 늦은 결과, 실제 모의체결 비용·잔고·수량·우선순위를 검사한다. 매도 거절 사례는 다섯 번째 시세 호출 대신 실제 매도 주문 경계에서 시세를 일시 주입하고 finally에서 복원하여 호출 횟수 의존을 제거했다. |
| `tests/unit/trading-symbol-history.test.ts` | 유지 | 신규/복귀 종목 지표·분할 이력과 cooldown을 백테스트 재생과 비교하고 다른 종목 상태 보존을 확인한다. |
| `tests/unit/universe-rule-resolver.test.ts` | 수정 | 실제 KRX fixture와 DB에서 두 시장 합산 상위 순위와 시장별 identity를 확인한다. |
| `tests/unit/universe-stage-editor-markup.test.tsx` | 유지 | 신규 기본 시장 두 개 및 기존 단계·접근성 SSR 경계를 보존한다. |
| `tests/unit/preparation-reference-seed-batch.test.ts` | 삭제 확인 | 삭제된 batch 참조 전용 검사다. 마이그레이션이 해당 테이블을 제거하며 공유 job 참조는 preparation-reference-service가 검사한다. |
| `tests/unit/seed-clone-batch-page.test.tsx` | 삭제 확인 | 폐기된 seed batch 화면과 라우터 삭제에 따른 전용 SSR 검사 삭제다. 설정 탐색 화면은 별도 검사한다. |
| `tests/unit/seed-clone-batch-service.test.ts` | 삭제 확인 | 폐기된 seed batch 서비스 및 스키마 삭제에 따른 검사 삭제다. 설정 탐색 서비스의 취소·복구와 DB 이행은 별도 검증한다. |

### 동일했던 226개 파일의 대조 목록

아래 경로는 `tests/` 기준이다. 각 파일의 원래 검출 대상과 유지 근거는 기존 감사표에서 같은 이름으로 찾을 수 있다. 이 목록은 정비 전 스냅샷의 분류다. 이번 정비에서 수정한 파일은 아래 실행 경계와 변경 내역에 기록했다.

**직접 import · 81개**

- `integration/`  `agent-client-diagnostics.test.ts`, `automatic-provider-collection.test.ts`, `backtest-facts.test.ts`, `backtest-preparation.test.ts`, `backtest-result-artifact-versions.test.ts`, `backtest-universe-preview.test.ts`, `backtest-wizard-drafts.test.ts`, `backtest-wizard-recovery.test.ts`, `benchmark-comparison.test.ts`, `dart-sync-resume.test.ts`, `distributed-universe-preparation.test.ts`, `external-api-usage.test.ts`, `intraday-validations.test.ts`, `local-agent-fallback.test.ts`, `maintenance.test.ts`, `native-agent-preparation.test.ts`, `notification-service.test.ts`, `packaged-agent-runtime.check.ts`, `period-validation-service.test.ts`, `preparation-reference-lifecycle.test.ts`, `symbol-library.test.ts`
- `unit/`  `agent-client-memory-guard.test.ts`, `agent-leases.test.ts`, `agent-outbox.test.ts`, `api-reference.test.ts`, `backtest-candle-data-exclusions.test.ts`, `backtest-preparation-fixtures.test.ts`, `backtest-result-lease.test.ts`, `backtest-results-service.test.ts`, `backtest-runner.test.ts`, `backtest-symbol-identity.test.ts`, `benchmark-service.test.ts`, `collection-coverage.test.ts`, `configuration-search-service.test.ts`, `container-lifecycle.test.ts`, `cost-profiles.test.ts`, `cost-summary.test.ts`, `cross-sectional-momentum.test.ts`, `dart-raw-snapshot-store.test.ts`, `dart-receipt-refresh.test.ts`, `earnings-acceleration-rank.test.ts`, `ema-trend-switch.test.ts`, `engine-chunked.test.ts`, `engine-facts.test.ts`, `engine-liquidity.test.ts`, `engine-non-trading.test.ts`, `engine.test.ts`, `execution.test.ts`, `forked-submission-validator.test.ts`, `fred-benchmark-source.test.ts`, `job-orchestrator.test.ts`, `krx-contract.test.ts`, `krx-historical-universe-source.test.ts`, `prefill.test.ts`, `preparation-issues.test.ts`, `preparation-notification-wiring.test.ts`, `range-breakout.test.ts`, `rsi-reversion.test.ts`, `scoped-filing-collection.test.ts`, `submission-validation.test.ts`, `swing-strategies.test.ts`, `symbol-info-service.test.ts`, `symbol-master-backfill.test.ts`, `symbol-master-daily-bars.test.ts`, `symbol-master-ensure-trading-day.test.ts`, `symbol-master-market-caps.test.ts`, `symbol-master-non-trading.test.ts`, `symbol-master-scheduler.test.ts`, `symbol-master-service.test.ts`, `symbol-master-shares-changes.test.ts`, `symbol-master-trading-days.test.ts`, `symbol-master-version-ingest.test.ts`, `test-app-helper.test.ts`, `toss-stock-info-source.test.ts`, `trading-decision-engine.test.ts`, `universe-executor.test.ts`, `universe-preview-params.test.tsx`, `universe-resolution-partitions.test.ts`, `universe-stage-ranking.test.ts`, `universe-summary.test.ts`, `value-quality-rank.test.ts`

**간접 import · 68개**

- `integration/`  `api-reference.test.ts`, `auth.test.ts`, `backtest-universe-rule-run.test.ts`, `backtest-warning-download.test.ts`, `dataset-publisher.test.ts`, `execution-preparation-progress.test.ts`, `fact-repository.test.ts`, `internal-provider-collection.test.ts`, `openapi-token.test.ts`, `route-surface.test.ts`, `symbol-info-fallback.test.ts`, `symbol-master-routes.test.ts`
- `unit/`  `agent-container.test.ts`, `agent-coordinator.test.ts`, `agent-resources.test.ts`, `automatic-collection-scheduling.test.ts`, `backtest-financial-coverage.test.ts`, `backtest-financial-data-readiness.test.ts`, `backtest-financial-execution-window.test.ts`, `backtest-lease-service-lifecycle.test.ts`, `backtest-memory-plan.test.ts`, `backtest-preparation-plan.test.ts`, `backtest-telemetry-report-cli.test.ts`, `backtest-telemetry-report.test.ts`, `candle-coverage-service.test.ts`, `collected-data-reuse.test.ts`, `compression.test.ts`, `corporate-action-coverage.test.ts`, `dart-corp-code-recovery.test.ts`, `database-storage.test.ts`, `dataset-schema-version.test.ts`, `fact-coverage-store.test.ts`, `fact-sync-service.test.ts`, `filing-metadata.test.ts`, `financial-fact-availability.test.ts`, `forked-backtest-result-completer.test.ts`, `internal-filing-discovery.test.ts`, `intraday-chart-bars.test.ts`, `intraday-daily-evaluation.test.ts`, `intraday-source.test.ts`, `krx-daily-bars-schema.test.ts`, `krx-daily-candle-repository.test.ts`, `open-position-rows.test.ts`, `period-validation-plan.test.ts`, `period-validation-result.test.tsx`, `period-validation-summary.test.ts`, `preparation-preview-cache.test.ts`, `provider-request-policy.test.ts`, `rebalance-interval.test.ts`, `remote-result-upload-manager.test.ts`, `risk-free-rate-service.test.ts`, `security-headers.test.ts`, `selection-metric-repository.test.ts`, `symbol-identity-lifetime.test.ts`, `symbol-master-schema.test.ts`, `test-fixtures.test.ts`, `toss-client.test.ts`, `toss-trading-broker.test.ts`, `trade-sort.test.ts`, `trading-artifacts.test.ts`, `universe-compute-broker.test.ts`, `universe-pipeline.test.ts`, `universe-provenance-label.test.ts`, `universe-rebalancing.test.ts`, `universe-resolution-wire.test.ts`, `universe-rule-resolver-non-trading.test.ts`, `wizard-draft-api.test.ts`, `wizard-steps.test.ts`

**그 밖의 의존성 · 77개**

- `architecture/`  `module-boundaries.test.ts`, `runtime-version-boundaries.test.ts`
- `integration/`  `agent-worker-diagnostics.test.ts`
- `unit/`  `agent-image-retention.test.ts`, `agent-resource-sampling.test.ts`, `agent-worker-diagnostics.test.ts`, `api-client.test.ts`, `backtest-fundamental-view.test.ts`, `backtest-warning-summary.test.ts`, `bar-estimate.test.ts`, `build-info.test.ts`, `calendar-month.test.ts`, `collection-settings.test.tsx`, `config.test.ts`, `corporate-action-adjust.test.ts`, `dart-account-map.test.ts`, `dart-balance-sections.test.ts`, `dart-corp-code-cache.test.ts`, `dart-report-parser.test.ts`, `data-contract.test.ts`, `diagnostics.test.ts`, `ecos-rate-source.test.ts`, `execution-warning-summary.test.ts`, `exit-reason.test.ts`, `format.test.ts`, `indicators.test.ts`, `intraday-cache.test.ts`, `intraday-reproduction-info.test.tsx`, `intraday-signals.test.ts`, `intraday-trades.test.ts`, `job-groups.test.ts`, `job-timeframe.test.ts`, `krx-filter-policy.test.ts`, `kst-date.test.ts`, `low-per-high-roe-rank.test.ts`, `market-support.test.ts`, `metrics.test.ts`, `non-trading-day.test.ts`, `notification-link-target.test.ts`, `page-size.test.ts`, `pagination.test.ts`, `pair-groups.test.ts`, `param-specs.test.ts`, `pit-fact-view.test.ts`, `position-sizing.test.ts`, `preparation-live.test.ts`, `preparation-progress.test.tsx`, `profile-labels.test.ts`, `provider-collection-migration.test.ts`, `rank-risk.test.ts`, `rebalance-spacing.test.ts`, `recent-candle-history.test.ts`, `request-observability.test.ts`, `rest-client.test.ts`, `runtime-observer.test.ts`, `runtime-versions.test.ts`, `server-operations-script.test.ts`, `session-policy.test.ts`, `sqlite-errors.test.ts`, `stale-days.test.ts`, `strategy-data-requirement.test.ts`, `strategy-label.test.ts`, `strategy-registry.test.ts`, `strategy-shared.test.ts`, `strategy-source-hash.test.ts`, `symbol-master-diff.test.ts`, `symbol-master-event-types.test.ts`, `symbol-master-timeline-model.test.ts`, `symbol-master-version-overlay.test.ts`, `symbol-summary.test.ts`, `sync-plan.test.ts`, `totp.test.ts`, `trading-decision-lifecycle.test.ts`, `trailing-stop.test.ts`, `universe-rebalancing-section.test.tsx`, `wait-for-condition.test.ts`, `worker-cancellation.test.ts`

통합 사례에서 준비 기간을 명시하거나 워밍업 구간을 보존한 파일은 `backtest-facts-worker.test.ts`, `backtest-preparation.test.ts`, `backtest-universe-rule-run.test.ts`, `distributed-universe-preparation.test.ts`, `local-agent-fallback.test.ts`, `native-agent-preparation.test.ts`, `packaged-agent-runtime.check.ts`, `preparation-reference-lifecycle.test.ts`이다. 단위 검사 `submission-validation.test.ts`는 리밸런스에 필요한 날 앞뒤가 계속 미수집 상태인지도 확인한다.

## Helper와 별도 실행 경계

- `tests/helpers`의 TypeScript 파일 14개, `tests/setup/provider-network-guard.ts`, `tests/fixtures/slow-submission-preload.mjs`를 확인했다. 격리 DB와 앱의 종료 순서, KRX loopback의 동적 포트, 대기 상한, 외부 fetch 차단 및 fork 오류 주입을 확인했다. 종목 마스터와 유니버스 해석의 단위 테스트 10개 파일은 사례별 SQLite·시계·로거·KRX loopback만 기동한다. API 통합 fixture만 실제 앱을 불러온다. 같은 10파일·2워커의 134개 사례가 전후 모두 통과했고 프로세스 시간은 41.93초에서 18.45초였다. 단일 측정이므로 부하 차이가 포함된다.
- `backtest-jobs.ts`는 자식까지 포함한 저장 행을 읽고 `backtest-preparation.ts`는 준비 API의 202·완료·200과 참조를 확인한다. `backtest-preparation-stubs.ts`는 수집이 목적이 아닌 큐 사례에 한해 요청의 준비 범위를 채운다.
- `database-fixtures.ts`, `test-app.ts`, `test-fixtures.ts`, `wait-for-condition.ts`는 격리 DB, 실제 앱·자식 종료, 사례별 자원 해제, 제한 시간이 있는 비동기 대기를 각각 맡는다. `seed.ts`와 `symbol-master-seed.ts`는 입력으로 받은 종목·봉·거래일을 저장한다.
- `krx-fixtures.ts`는 날짜·경로별 가짜 HTTP 응답을 제공하고 `krx-test-fixtures.ts`는 테스트별 DB·로컬 공급자를 정리한다. `rank-controls.ts`, `swing-controls.ts`의 명시적 전략 매개변수와 `strategy-versions.ts`의 버전 조회는 기존 계약을 유지한다.
- `packaged-agent-bootstrap.mjs`는 압축을 푼 패키지의 AgentClient와 환경 설정을 읽어 실제 통신·종료를 검증한다. 패키지 통합 사례는 1,093건의 경고 전달 후 처음과 마지막 준비 경고가 모두 요약에 남는지 확인한다. 빈 요약도 통과하던 길이 단언을 보강했다. `container-server-smoke.mjs`는 일회용 컨테이너에서 DB 준비, 버전과 빌드 SHA, 웹 자산과 준비 응답, SIGTERM을 확인한다.
- `container-agent-smoke.mjs`에서 버전 합의 없이 CAPACITY만 보내도 정상 연결로 판정하는 결함을 재현했다. 동일 소켓에서 HELLO/WELCOME 이후 스키마에 맞는 CAPACITY와 초기 데이터셋 버전 0이 와야 통과하게 했다. 정상 이미지와 순서를 어긴 일회용 CLI로 전후 차이를 확인했다.
- `tests/windows/agent-installer.test.ps1`는 관련 없는 컨테이너에도 잘못된 이미지 ID를 줘 한 검사가 다른 검사를 대신 통과할 수 있었다. 각각 한 입력만 바꾸고 검사 대상까지 도달했는지와 기존 컨테이너 보존을 함께 확인한다.
- `scripts/krx-smoke.ts`는 별도 실응답 진단이다. 한 시장의 분류 표본이 0건인 응답이 성공하던 문제를 loopback에서 재현했다. 시장별 표본과 원문 필드의 존재를 확인하고, 확인할 수 없는 조합은 실패로 보고한다. 실제 인증키나 호출 예산은 사용하지 않았다.

## KRX 준비량 측정

동일한 Node 24.22.2, pnpm 11.25.0, Playwright 단일 워커, 빈 SQLite와 같은 모바일 슬라이더 사례로 비교했다. `pnpm exec playwright test tests/e2e/configuration-search.spec.ts -g '범위 핸들을' --project=mobile`은 두 번 모두 종료 코드 0이었다. SQL로 서버 종료 후 `krx_raw_api_snapshots`를 집계했다.

| 측정 | 변경 전 | 요청 시 수집 |
| --- | ---: | ---: |
| 슬라이더 1회 후 KRX 원문 행 | 8,988 | 0 |
| 서로 다른 거래기준일 | 1,498 | 0 |
| 프로세스 실행 시간 | 16.22초 | 9.13초 |

동일 비교는 한 번씩 측정했다. 다른 테스트 정비까지 반영한 뒤 슬라이더 단독 실행을 한 번 더 확인한 결과 9.09초, 원문 0건이었다. 별도의 빈 DB에서 종목 마스터 테스트를 두 프로젝트로 실행한 결과 2019-01-02, 2020-06-01, 2020-06-08에 각각 KOSPI·KOSDAQ 기본정보와 일별매매 4건씩 저장됐다. 두 사례 모두 통과했고 벤치마크 원문은 0건이었다. 실제 수집 어댑터와 저장소를 사용하며, 가짜 loopback 공급자에만 요청 대기를 주입했다. 수집 조립 코드 변경으로 collectionVersion·previewVersion·validationVersion이 바뀌었고 실행·에이전트 버전은 동일했다.

## 실행 확인

테스트 환경은 Node 24.22.2, pnpm 11.25.0, Linux x64다. 저장소 lockfile과 fork pool을 사용했다. 변경한 Vitest 사례부터 집중 실행한 후 전체 회귀를 실행했다.

| 실행 | 결과 |
| --- | --- |
| `pnpm test --maxWorkers=2` | 264개 파일, 2,834건 통과, skip 0, 종료 코드 0. 실행 도중 준비 기간을 한 번 더 좁힌 분산 파일은 최종 코드로 별도 재실행해 통과 |
| `pnpm build` | 서버와 웹 빌드 성공 |
| `pnpm lint`, `pnpm typecheck` | 종료 코드 0 |
| `pnpm build:agent` 후 `pnpm test:agent-package` | 실제 런타임 압축 파일을 풀어 검사, 2개 통과 |
| `tests/windows/agent-installer.test.ps1` | Linux PowerShell의 Docker·REST 대역 시나리오 수정 전후 종료 코드 0. Windows 5.1의 네이티브 인자 변환은 Windows CI 전용 |
| `container-agent-smoke.mjs` | 게시된 Agent 이미지 digest `87d4094e…` 정상 통과. HELLO 없이 CAPACITY만 전송한 별도 CLI에서 수정 전 0, 수정 후 순서 단언에서 1 |
| `container-server-smoke.mjs` | 기존 `b0f54757` 서버 이미지에서 DB·HTTP·자산·종료 확인. 이 검사는 검사 스크립트가 사용하는 게시 산출물 기준 |
| `scripts/krx-smoke.ts --date 2022-01-07 --years 2020` | 실제 CLI에 loopback 입력을 제공. 두 시장 표본은 종료 코드 0, 한 시장의 연도별 분류 표본 또는 기준일 기본정보가 비면 종료 코드 1 |

공용 KRX 어댑터의 양 시장 공식 개장과 복구 요청을 구분하는 단위 검사는 변경 전 29개, 변경 후 31개 통과했다. 모의투자 매도 거절과 분봉 취소의 정리 경로를 함께 실행해 55개, 기간검증 큐 거부 27개, 원본 갱신 중 삭제 방지 12개가 통과했다. 15개 종목 마스터 fixture 소비 파일을 함께 검증해 190개를 통과했다. 슬라이더·시장 선택 및 완료 화면의 브라우저 결과는 [브라우저 검토 기록](testing-audit-browser-update.md)에 있다.

검토 기준은 `853d8b0b` 위 작업 트리다. 문서 제외 변경 소스 41개의 최종 내용 지문(SHA-256)은 `789d4708f92fc930610a16117da144675babad50ccddaf2bc660ba084dbab223`이다. 브라우저에서 확인된 완료 화면 결함을 포함할지는 별도로 결정해야 한다.
