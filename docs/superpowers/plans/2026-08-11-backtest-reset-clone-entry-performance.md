# 백테스트 재설정 및 복제 진입 성능 개선 Implementation Plan

**Goal:** 재설정 및 복제의 전략 화면 진입에서는 저장 요청 재기준과 전략 조회만 수행하고,
유니버스·종목·비용 프로필 작업은 필요한 단계로 미룬다.

**Architecture:** 기존 `clone-draft` 응답 모양은 유지하면서 유니버스 준비와 제출 검증을
제거한다. React Query의 `enabled` 조건으로 종목 목록과 비용 프로필 조회 시점을 각 단계의
실제 소비 시점에 맞춘다.

**Tech Stack:** TypeScript, Fastify, React, TanStack Query, Vitest, Playwright.

설계: [2026-08-11-backtest-reset-clone-entry-performance-design.md](../specs/2026-08-11-backtest-reset-clone-entry-performance-design.md)

## Task 1: `clone-draft`를 재기준 전용으로 축소

**Files:**

- Modify: `tests/integration/job-queue.test.ts`
- Modify: `src/server/modules/backtest/presentation/backtest-routes.ts`

- [ ] 유니버스 준비 오케스트레이터가 실패해도 초안이 열리는 통합 테스트를 먼저 추가한다.
- [ ] 테스트가 현재 구현에서 500으로 실패하는지 확인한다.
- [ ] route에서 `getReadyPreview`와 유니버스·coverage 검증을 제거한다.
- [ ] 응답은 `{ request, warnings, blockers: [] }`로 유지한다.
- [ ] 기존 초안 테스트를 새 책임에 맞게 고치고 통합 테스트를 통과시킨다.

## Task 2: 화면의 종목·비용 프로필 조회를 지연한다

**Files:**

- Modify: `tests/e2e/step-urls.spec.ts`
- Modify: `src/web/features/backtests/new-backtest-wizard.tsx`

- [ ] 전략 단계 진입에서 `/symbols`와 `/backtests/profiles`가 요청되지 않는 브라우저 테스트를
  먼저 추가한다.
- [ ] 테스트가 현재 구현에서 실패하는지 확인한다.
- [ ] `/symbols` query는 유효한 preview가 만든 `unionSymbols`가 있을 때만 활성화한다.
- [ ] `/backtests/profiles` query는 비용 설정 단계에서만 활성화한다.
- [ ] 기존 게이트가 query 로딩 중 재무 부재로 오판하지 않는지 확인한다.

## Task 3: 회귀 검증

- [ ] 관련 Vitest 통합 테스트를 실행한다.
- [ ] 관련 Playwright 시나리오를 실행한다.
- [ ] `pnpm typecheck`와 `pnpm lint`를 실행한다.
- [ ] 전체 Vitest suite를 실행한다.
- [ ] diff를 검토해 즉시 복제와 최종 제출의 전체 검증이 유지됐는지 확인한다.
