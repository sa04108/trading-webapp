import { expect, test } from '@playwright/test';
import { login } from './login';

/**
 * 화면 단계 URL(설계 2026-08-07-step-urls-design) — 페이지 단위로 화면이 바뀌는
 * 이동이 이력에 한 칸을 차지하는지 본다. 위저드 폼 채우기 전체 흐름은
 * mvp-flow.spec.ts 가 이미 다루므로 여기서는 URL 과 값 보존만 확인한다.
 */

test('위저드 단계마다 URL 이 있고 뒤로가기가 직전 단계로 돌아간다', async ({ page }) => {
  await login(page);

  // slug 없는 진입은 첫 단계로 이어진다
  await page.goto('/backtests/new');
  await expect(page).toHaveURL(/\/backtests\/new\/strategy$/);

  const strategy = page.getByRole('button', { name: /전고점 돌파/ });
  await strategy.click();
  await expect(strategy).toHaveAttribute('aria-pressed', 'true');

  await page.getByRole('button', { name: '다음' }).click();
  await expect(page).toHaveURL(/\/backtests\/new\/period$/);

  await page.goBack();
  await expect(page).toHaveURL(/\/backtests\/new\/strategy$/);
  // 이 단언이 이 설계의 핵심 전제다 — 같은 라우트에서 param 만 바뀌면 위저드가
  // 재마운트되지 않으므로 폼 값이 살아 있다. 재마운트되면 선택이 풀려 여기서 깨진다.
  await expect(page.getByRole('button', { name: /전고점 돌파/ })).toHaveAttribute(
    'aria-pressed',
    'true',
  );

  await page.goForward();
  await expect(page).toHaveURL(/\/backtests\/new\/period$/);
});
test('다른 페이지로 나간 위저드는 신규 진입에서 동의를 받은 뒤 마지막 단계로 복원한다', async ({
  page,
}) => {
  await login(page);

  await page.goto('/backtests/new');
  await page.getByRole('button', { name: /전고점 돌파/ }).click();
  await page.getByRole('button', { name: '다음' }).click();
  await page.getByLabel('시작일').fill('2026-01-05');
  await page.getByLabel('종료일').fill('2026-03-31');

  await expect.poll(async () => page.evaluate(async () => {
    const response = await fetch('/api/v1/backtests/wizard-draft/strategy');
    const body = await response.json() as {
      draft: { payload: { currentStep?: string } } | null;
    };
    return body.draft?.payload.currentStep ?? null;
  })).toBe('period');

  await page.getByRole('link', { name: '대시보드' }).click();
  await page.getByRole('link', { name: '빠른 백테스트' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByRole('heading', { name: '이전에 준비하던 백테스트가 있습니다' }))
    .toBeVisible();

  await page.getByRole('button', { name: '이전 작업 이어서 하기' }).click();
  await expect(page).toHaveURL(/\/backtests\/new\/period$/);
  await expect(page.getByLabel('시작일')).toHaveValue('2026-01-05');
  await expect(page.getByLabel('종료일')).toHaveValue('2026-03-31');

  await page.getByRole('link', { name: '대시보드' }).click();
  await page.getByRole('link', { name: '빠른 백테스트' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('button', { name: '새로 시작' }).click();
  await expect(page).toHaveURL(/\/backtests\/new\/strategy$/);
  await expect(page.getByRole('button', { name: /전고점 돌파/ })).toHaveAttribute(
    'aria-pressed',
    'false',
  );
});

test('새로고침 뒤에도 현재 단계와 단계별 입력·미리보기를 복원한다', async ({ page }) => {
  await login(page);

  await page.route('**/api/v1/benchmarks?**', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        benchmarkId: 'KOSPI',
        points: [
          { date: '2026-01-05', close: 2_500 },
          { date: '2026-03-31', close: 2_600 },
        ],
        covered: true,
        backfill: {
          benchmarkId: null,
          state: 'IDLE',
          cursorDate: null,
          from: null,
          to: null,
          error: null,
        },
      }),
    });
  });
  await page.route('**/api/v1/backtests/universe-preview', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        schedule: [{
          rebalanceDate: '2026-01-05',
          effectiveDate: '2026-01-05',
          members: [{ symbol: '005930' }],
        }],
        unionSymbols: ['005930'],
        fundamentalSymbols: [],
        scheduleHash: 'a'.repeat(64),
        uncoveredDates: [],
        periodCovered: true,
        missingCandleSymbols: [],
        warnings: [],
      }),
    });
  });

  await page.goto('/backtests/new');
  await page.getByRole('button', { name: /전고점 돌파/ }).click();
  await page.getByLabel('돌파 기준 봉 수', { exact: true }).fill('17');
  await page.getByRole('button', { name: '다음' }).click();
  await page.getByLabel('시작일').fill('2026-01-05');
  await page.getByLabel('종료일').fill('2026-03-31');
  await page.getByRole('button', { name: '다음' }).click();
  await expect(page).toHaveURL(/\/backtests\/new\/universe$/);
  await page.getByRole('button', { name: '미리보기' }).click();
  await expect(page.getByText('리밸런스 일정')).toBeVisible();
  await page.getByRole('button', { name: '다음' }).click();
  await expect(page).toHaveURL(/\/backtests\/new\/capital$/);

  await page.getByLabel('초기 자본 (KRW)').fill('12345678');
  await page.getByLabel('동시 보유 종목 상한').fill('7');
  await page.getByLabel('난수 시드').fill('99');

  // 디바운스 저장 완료를 서버 응답으로 확인한 뒤 새 문서 탐색을 재현한다.
  await expect.poll(async () => page.evaluate(async () => {
    const response = await fetch('/api/v1/backtests/wizard-draft/capital');
    const body = await response.json() as { draft: { payload: { initialCash: string } } | null };
    return body.draft?.payload.initialCash ?? null;
  })).toBe('12345678');
  await expect.poll(async () => page.evaluate(async () => {
    const response = await fetch('/api/v1/backtests/wizard-draft/universe');
    const body = await response.json() as { draft: { payload: { lastPreview: unknown } } | null };
    return body.draft?.payload.lastPreview !== null;
  })).toBe(true);

  await page.reload();
  await expect(page).toHaveURL(/\/backtests\/new\/capital$/);
  await expect(page.getByLabel('초기 자본 (KRW)')).toHaveValue('12345678');
  await expect(page.getByLabel('동시 보유 종목 상한')).toHaveValue('7');
  await expect(page.getByLabel('난수 시드')).toHaveValue('99');

  await page.getByRole('button', { name: '이전' }).click();
  await expect(page).toHaveURL(/\/backtests\/new\/universe$/);
  await expect(page.getByText('리밸런스 일정')).toBeVisible();
  await page.getByRole('button', { name: '이전' }).click();
  await expect(page.getByLabel('시작일')).toHaveValue('2026-01-05');
  await expect(page.getByLabel('종료일')).toHaveValue('2026-03-31');
  await page.getByRole('button', { name: '이전' }).click();
  await expect(page.getByLabel('돌파 기준 봉 수', { exact: true })).toHaveValue('17');
});


test('기간의 벤치마크가 부족하면 동기화 완료 전까지 유니버스 단계를 열지 않는다', async ({
  page,
}) => {
  await login(page);

  let backfillStarted = false;
  let backfillCompleted = false;
  await page.route('**/api/v1/benchmarks**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === 'POST' && url.pathname.endsWith('/benchmarks/backfill')) {
      backfillStarted = true;
      await route.fulfill({
        status: 202,
        contentType: 'application/json',
        body: JSON.stringify({
          benchmarkId: 'KOSPI',
          state: 'RUNNING',
          cursorDate: '2026-01-05',
          from: '2026-01-05',
          to: '2026-01-09',
          error: null,
        }),
      });
      return;
    }
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        benchmarkId: 'KOSPI',
        points: backfillCompleted
          ? [
              { date: '2026-01-05', close: 2_500 },
              { date: '2026-01-09', close: 2_510 },
            ]
          : [],
        covered: backfillCompleted,
        backfill: {
          benchmarkId: backfillStarted ? 'KOSPI' : null,
          state: backfillStarted && !backfillCompleted ? 'RUNNING' : 'IDLE',
          cursorDate: backfillStarted && !backfillCompleted ? '2026-01-05' : null,
          from: backfillStarted ? '2026-01-05' : null,
          to: backfillStarted ? '2026-01-09' : null,
          error: null,
        },
      }),
    });
  });

  await page.goto('/backtests/new');
  await page.getByRole('button', { name: /전고점 돌파/ }).click();
  await page.getByRole('button', { name: '다음' }).click();
  await page.getByLabel('시작일').fill('2026-01-05');
  await page.getByLabel('종료일').fill('2026-01-09');
  const universeStep = page.getByRole('button', { name: '3. 유니버스' });
  await expect(universeStep).toHaveAttribute('aria-disabled', 'true');
  // Playwright는 aria-disabled도 실제 disabled처럼 취급한다. 브라우저 이벤트를 강제로
  // 보내 화면이 잠금 이유를 설명하는 기존 접근성 계약까지 확인한다.
  await universeStep.click({ force: true });
  await expect(page).toHaveURL(/\/backtests\/new\/period$/);
  await expect(page.getByText(/벤치마크 기간을 확인하세요/)).toBeVisible();
  await page.getByRole('button', { name: '다음' }).click();

  await expect(page).toHaveURL(/\/backtests\/new\/period$/);
  await expect(page.getByText(/벤치마크 기간 데이터가 부족합니다/)).toBeVisible();
  const sync = page.getByRole('button', { name: '동기화', exact: true });
  await expect(sync).toBeVisible();
  await sync.click();
  await expect(page.getByRole('button', { name: '동기화 중…', exact: true })).toBeDisabled();

  backfillCompleted = true;
  const next = page.getByRole('button', { name: '다음', exact: true });
  await expect(next).toBeEnabled({ timeout: 5_000 });
  await next.click();
  await expect(page).toHaveURL(/\/backtests\/new\/universe$/);

  // 유니버스 시장을 바꾸면 기본 벤치마크도 따라 바뀐다. 이전 KOSPI 확인을 KOSDAQ에
  // 재사용하지 않고 기간 단계로 되돌려 새 벤치마크를 확인해야 한다.
  await page.getByLabel('시장').click();
  await page.getByRole('option', { name: 'KOSDAQ' }).click();
  await expect(page).toHaveURL(/\/backtests\/new\/period$/);
  await expect(page.getByLabel('벤치마크')).toContainText('코스닥');
  await expect(page.getByRole('button', { name: '3. 유니버스' })).toHaveAttribute(
    'aria-disabled',
    'true',
  );
});

test('기간 확인 중 입력이 바뀌면 이전 응답으로 다음 단계를 열지 않는다', async ({ page }) => {
  await login(page);

  let releaseFirst!: () => void;
  let markFirstRequested!: () => void;
  const firstRequested = new Promise<void>((resolve) => { markFirstRequested = resolve; });
  const firstReleased = new Promise<void>((resolve) => { releaseFirst = resolve; });
  let requestCount = 0;
  await page.route('**/api/v1/benchmarks?**', async (route) => {
    requestCount += 1;
    if (requestCount === 1) {
      markFirstRequested();
      await firstReleased;
    }
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        benchmarkId: 'KOSPI',
        points: [
          { date: '2026-01-05', close: 2_500 },
          { date: '2026-01-09', close: 2_510 },
        ],
        covered: true,
        backfill: {
          benchmarkId: null,
          state: 'IDLE',
          cursorDate: null,
          from: null,
          to: null,
          error: null,
        },
      }),
    });
  });

  await page.goto('/backtests/new');
  await page.getByRole('button', { name: /전고점 돌파/ }).click();
  await page.getByRole('button', { name: '다음' }).click();
  await page.getByLabel('시작일').fill('2026-01-05');
  await page.getByLabel('종료일').fill('2026-01-09');
  await page.getByRole('button', { name: '다음' }).click();
  await firstRequested;

  await page.getByLabel('종료일').fill('2026-01-12');
  releaseFirst();
  await page.waitForTimeout(100);
  await expect(page).toHaveURL(/\/backtests\/new\/period$/);

  await page.getByRole('button', { name: '다음' }).click();
  await expect(page).toHaveURL(/\/backtests\/new\/universe$/);
  expect(requestCount).toBe(2);
});

test('갈 수 없는 단계 URL 은 갈 수 있는 마지막 단계로 되돌린다', async ({ page }) => {
  await login(page);

  // 빈 폼으로 검토 단계에 딥링크 — 게이트가 첫 단계로 되돌린다
  await page.goto('/backtests/new/review');
  await expect(page).toHaveURL(/\/backtests\/new\/strategy$/);

  // replace 라서 튕겨 나온 review 가 이력에 없다 — 뒤로가기는 위저드 밖으로 나간다
  await page.goBack();
  await expect(page).not.toHaveURL(/\/backtests\/new/);
});

test('모르는 단계 slug 는 첫 단계로 접힌다', async ({ page }) => {
  await login(page);
  await page.goto('/backtests/new/nonexistent-step');
  await expect(page).toHaveURL(/\/backtests\/new\/strategy$/);
});

test('복제 진입의 ?from= 은 단계를 옮겨도 남는다', async ({ page }) => {
  await login(page);
  const saved = await page.evaluate(async () => {
    const response = await fetch('/api/v1/backtests/wizard-draft/strategy', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        strategyId: 'range-breakout',
        parameters: { lookbackBars: '17' },
        currentStep: 'period',
      }),
    });
    return response.status;
  });
  expect(saved).toBe(200);

  // 없는 작업 id 로도 확인할 수 있다 — 초안 조회는 실패하고 위저드가 빈 폼을 보여주지만,
  // 확인 대상은 리다이렉트가 쿼리를 잃지 않는지다.
  await page.goto('/backtests/new?from=bt_nonexistent');
  await expect(page).toHaveURL(/\/backtests\/new\/strategy\?from=bt_nonexistent$/);
  await expect(page.getByRole('dialog')).toHaveCount(0);

  const previousDraft = await page.evaluate(async () => {
    const response = await fetch('/api/v1/backtests/wizard-draft');
    return response.json() as Promise<{ candidate: unknown }>;
  });
  expect(previousDraft).toEqual({ candidate: null });

  // 진입 리다이렉트만이 아니라 **단계 이동**도 쿼리를 지켜야 한다 — goToSlug 가
  // location.search 를 다시 붙이지 않으면 '다음' 을 누른 순간 복제 맥락이 사라진다.
  await page.getByRole('button', { name: /전고점 돌파/ }).click();
  await page.getByRole('button', { name: '다음' }).click();
  await expect(page).toHaveURL(/\/backtests\/new\/period\?from=bt_nonexistent$/);
});

test('재설정 및 복제의 전략 단계는 종목과 비용 프로필을 미리 조회하지 않는다', async ({
  page,
}) => {
  await login(page);

  await page.route('**/api/v1/backtests/bt_clone_fixture/clone-draft', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        request: {
          strategyId: 'range-breakout',
          parameters: {
            lookbackBars: 10,
            atrPeriod: 5,
            stopAtrMultiplier: 2,
            takeProfitAtrMultiplier: 3,
            riskPerTradePercent: 2,
          },
          universeRule: {
            markets: ['KOSPI'],
            stages: [{ criterion: 'MARKET_CAP', direction: 'HIGH', limit: 1 }],
            rebalanceInterval: { value: 1, unit: 'MONTH' },
          },
          timeframe: '1d',
          period: { from: '2026-01-05', to: '2026-03-31' },
          capital: { initialCash: 10_000_000, currency: 'KRW' },
          execution: {
            fillTiming: 'NEXT_BAR_OPEN',
            commissionProfileId: 'kr-equity-default',
            slippageProfileId: 'fixed-5bps',
          },
          risk: { maxPositions: 5 },
          randomSeed: 42,
        },
        warnings: [],
        blockers: [],
      }),
    });
  });

  // 새 문서 탐색으로 앱의 Query cache를 비운 뒤 이 진입에서 발생한 요청만 관찰한다.
  const apiRequests: string[] = [];
  page.on('request', (request) => {
    const pathname = new URL(request.url()).pathname;
    if (pathname.startsWith('/api/v1/')) apiRequests.push(pathname);
  });

  await page.goto('/backtests/new/strategy?from=bt_clone_fixture');
  await expect(page.getByRole('heading', { name: '재설정 및 복제' })).toBeVisible();
  await expect(page.getByRole('button', { name: /전고점 돌파/ })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  // schema 조회와 프리필까지 끝난 안정 시점 — mount 직후만 보고 금지 요청을 단언하지 않는다.
  await expect(page.getByLabel('돌파 기준 봉 수', { exact: true })).toHaveValue('10');

  expect(apiRequests).toContain('/api/v1/backtests/bt_clone_fixture/clone-draft');
  expect(apiRequests).toContain('/api/v1/strategies');
  expect(apiRequests).toContain('/api/v1/strategies/range-breakout/schema');
  expect(apiRequests).not.toContain('/api/v1/backtests/universe-preview');
  expect(apiRequests).not.toContain('/api/v1/symbols');
  expect(apiRequests).not.toContain('/api/v1/backtests/profiles');
});

test('제출 화면 URL 을 직접 열면 검토를 거치도록 되돌린다', async ({ page }) => {
  await login(page);

  // 빈 폼으로 실행 단계 딥링크 — 큐를 검토 없는 제출로부터 지키는 유일한 방어선이다
  await page.goto('/backtests/new/run');
  await expect(page).toHaveURL(/\/backtests\/new\/strategy$/);
  await expect(page.getByRole('button', { name: '백테스트 실행' })).toHaveCount(0);
});

test('모르는 데이터 하위 경로도 기본 구획으로 이어진다', async ({ page }) => {
  await login(page);

  // 알 수 없는 자식 경로는 종목 마스터 기본 화면으로 복구한다.
  await page.goto('/datasets/symbols');
  await expect(page).toHaveURL(/\/datasets\/master$/);
  await expect(page.getByRole('checkbox', { name: '자동 동기화(KRX)' })).toBeVisible();
});
