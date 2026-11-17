import { expect, test } from '@playwright/test';
import { login } from './login';

/**
 * 화면 단계 URL(설계 2026-08-07-step-urls-design) — 페이지 단위로 화면이 바뀌는
 * 이동이 이력에 한 칸을 차지하는지 본다. 위저드 폼 채우기 전체 흐름은
 * mvp-flow.spec.ts 가 이미 다루므로 여기서는 URL 과 값 보존만 확인한다.
 */

const CLONE_DRAFT_FIXTURE = {
  request: {
    strategyId: 'range-breakout',
    parameters: {
      lookbackBars: 10,
      atrPeriod: 5,
      stopAtrMultiplier: 2,
      trailAtrMultiplier: 2,
      takeProfitAtrMultiplier: 3,
      riskPerTradePercent: 2,
      maxPositionWeightPercent: 20,
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
  reusablePreview: null,
};

test('위저드 단계마다 URL 이 있고 뒤로가기가 직전 단계로 돌아간다', async ({ page }) => {
  await login(page);

  // slug 없는 진입은 첫 단계로 이어진다
  await page.goto('/backtests/new');
  await expect(page).toHaveURL(/\/backtests\/new\/strategy\?wizard=/);

  const strategy = page.getByRole('button', { name: /전고점 돌파/ });
  await strategy.click();
  await expect(strategy).toHaveAttribute('aria-pressed', 'true');

  await page.getByRole('button', { name: '다음' }).click();
  await expect(page).toHaveURL(/\/backtests\/new\/period\?wizard=/);

  await page.goBack();
  await expect(page).toHaveURL(/\/backtests\/new\/strategy\?wizard=/);
  // 이 단언이 이 설계의 핵심 전제다 — 같은 라우트에서 param 만 바뀌면 위저드가
  // 재마운트되지 않으므로 폼 값이 살아 있다. 재마운트되면 선택이 풀려 여기서 깨진다.
  await expect(page.getByRole('button', { name: /전고점 돌파/ })).toHaveAttribute(
    'aria-pressed',
    'true',
  );

  await page.goForward();
  await expect(page).toHaveURL(/\/backtests\/new\/period\?wizard=/);
});
test('두 위저드는 독립적으로 저장되고 작업 목록에서 선택해 이어간다', async ({ page }) => {
  await login(page);
  await page.goto('/backtests/new');
  await page.getByRole('button', { name: /전고점 돌파/ }).click();
  await page.getByRole('button', { name: '다음' }).click();
  const firstId = new URL(page.url()).searchParams.get('wizard')!;
  await page.getByLabel('시작일').fill('2026-01-05');
  await page.getByLabel('종료일').fill('2026-03-31');
  await expect.poll(async () => page.evaluate(async (id) => {
    const response = await fetch(`/api/v1/backtests/wizard-draft/period?wizardId=${id}`);
    return (await response.json()).draft?.payload.from;
  }, firstId)).toBe('2026-01-05');
  // 새 문서 탐색은 Query 캐시를 비워 재개 버그를 숨긴다. 앱 안에서 작업을 다시 연다.
  // 작업 목록의 링크가 이전 단계여도 서버에 저장한 마지막 단계가 우선한다.
  await page.route('**/api/v1/jobs?*', async route => {
    const response = await route.fetch();
    const body = await response.json();
    for (const job of body.jobs) {
      if (job.id === `backtest-wizard:${firstId}`) job.link = `/backtests/new/strategy?wizard=${firstId}`;
    }
    await route.fulfill({ response, json: body });
  }, { times: 1 });
  await page.getByRole('link', { name: '작업', exact: true }).click();
  await page.locator(`a[href*="wizard=${firstId}"]`).click();
  await expect(page).toHaveURL(new RegExp(`/backtests/new/period\\?wizard=${firstId}$`));
  await expect(page.getByLabel('시작일')).toHaveValue('2026-01-05');
  await expect(page.getByLabel('종료일')).toHaveValue('2026-03-31');
  await page.goto('/backtests/new');
  await expect(page.getByRole('button', { name: /전고점 돌파/ })).toBeVisible();
  const secondId = new URL(page.url()).searchParams.get('wizard')!;
  expect(secondId).not.toBe(firstId);
  await page.goto('/jobs');
  await page.locator(`a[href*="wizard=${firstId}"]`).click();
  await expect(page.getByLabel('시작일')).toHaveValue('2026-01-05');
  await expect(page.getByLabel('종료일')).toHaveValue('2026-03-31');
  expect(new URL(page.url()).searchParams.get('wizard')).toBe(firstId);
});

test('새로고침 뒤에도 현재 단계와 단계별 입력·미리보기를 복원한다', async ({ page }) => {
  await login(page);

  await page.goto('/backtests/new');
  await page.getByRole('button', { name: /전고점 돌파/ }).click();
  await page.getByLabel('돌파 기준 봉 수', { exact: true }).fill('17');
  await page.getByRole('button', { name: '다음' }).click();
  await page.getByLabel('시작일').fill('2026-01-05');
  await page.getByLabel('종료일').fill('2026-03-31');
  await page.getByRole('button', { name: '다음' }).click();
  await expect(page).toHaveURL(/\/backtests\/new\/universe\?wizard=/);
  await page.locator('#stage-limit-0').fill('1');
  const initialPreview = page.waitForResponse(
    (resp) =>
      resp.url().includes('/backtests/universe-preview') && resp.request().method() === 'POST',
  );
  await page.getByRole('button', { name: '미리보기' }).click();
  const firstPreview = await initialPreview;
  if (firstPreview.status() === 202) {
    await expect(page.getByText('데이터 준비', { exact: true })).toBeVisible();
    await page.waitForResponse(
      (resp) =>
        resp.url().includes('/backtests/universe-preview') && resp.request().method() === 'POST',
      { timeout: 200_000 },
    );
  }
  await expect(page.getByText('리밸런스 일정')).toBeVisible();
  await page.getByRole('button', { name: '다음' }).click();
  await expect(page).toHaveURL(/\/backtests\/new\/capital\?wizard=/);

  await page.getByLabel('초기 자본 (KRW)').fill('12345678');
  await page.getByLabel('동시 보유 종목 상한').fill('7');
  await page.getByLabel('난수 시드').fill('99');

  // 디바운스 저장 완료를 서버 응답으로 확인한 뒤 새 문서 탐색을 재현한다.
  await expect.poll(async () => page.evaluate(async () => {
    const response = await fetch(`/api/v1/backtests/wizard-draft/capital?wizardId=${new URL(location.href).searchParams.get('wizard')}`);
    const body = await response.json() as { draft: { payload: { initialCash: string } } | null };
    return body.draft?.payload.initialCash ?? null;
  })).toBe('12345678');
  await expect.poll(async () => page.evaluate(async () => {
    const response = await fetch(`/api/v1/backtests/wizard-draft/universe?wizardId=${new URL(location.href).searchParams.get('wizard')}`);
    const body = await response.json() as {
      draft: {
        payload: { lastPreview: { result?: { preparationJobId?: string } } | null }
      } | null;
    };
    return body.draft?.payload.lastPreview?.result?.preparationJobId ?? null;
  })).toBeTruthy();

  let resumedPreviewRequests = 0;
  page.on('request', request => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/v1/backtests/universe-preview') resumedPreviewRequests += 1;
  });
  const wizardId = new URL(page.url()).searchParams.get('wizard')!;
  await page.getByRole('link', { name: '작업', exact: true }).click();
  await page.locator(`a[href*="wizard=${wizardId}"]`).click();
  await expect(page).toHaveURL(/\/backtests\/new\/capital\?wizard=/);
  await expect(page.getByLabel('초기 자본 (KRW)')).toHaveValue('12345678');
  await page.reload();
  await expect(page).toHaveURL(/\/backtests\/new\/capital\?wizard=/);
  await expect(page.getByLabel('초기 자본 (KRW)')).toHaveValue('12345678');
  await expect(page.getByLabel('동시 보유 종목 상한')).toHaveValue('7');
  await expect(page.getByLabel('난수 시드')).toHaveValue('99');

  await page.getByRole('button', { name: '이전' }).click();
  await expect(page).toHaveURL(/\/backtests\/new\/universe\?wizard=/);
  await expect(page.getByText('리밸런스 일정')).toBeVisible();
  expect(resumedPreviewRequests).toBe(0);
  await page.getByRole('button', { name: '이전' }).click();
  await expect(page.getByLabel('시작일')).toHaveValue('2026-01-05');
  await expect(page.getByLabel('종료일')).toHaveValue('2026-03-31');
  await page.getByRole('button', { name: '이전' }).click();
  await expect(page.getByLabel('돌파 기준 봉 수', { exact: true })).toHaveValue('17');

  // 검토를 마치고 실행 직전까지 간 작업도 복원 중 임시 게이트에 밀리지 않는다.
  await page.getByRole('button', { name: '5. 검토', exact: true }).click();
  await page.getByRole('button', { name: '다음', exact: true }).click();
  await expect(page).toHaveURL(/\/backtests\/new\/run\?wizard=/);
  await page.getByRole('link', { name: '작업', exact: true }).click();
  await page.locator(`a[href*="wizard=${wizardId}"]`).click();
  await expect(page).toHaveURL(/\/backtests\/new\/run\?wizard=/);
  await expect(page.getByRole('button', { name: '백테스트 실행', exact: true })).toBeEnabled();
  expect(resumedPreviewRequests).toBe(0);
});


test('제출 거절 사유를 실행 화면에 남기고 사용자가 선택한 재확인만 한 번 실행한다', async ({ page }) => {
  await login(page);
  let previewRequests = 0;
  await page.route('**/api/v1/backtests/universe-preview', route => {
    previewRequests += 1;
    return route.fulfill({ json: {
      schedule: [{ rebalanceDate: '2026-01-05', effectiveDate: '2026-01-05', members: [{ symbol: '005930' }] }],
      unionSymbols: ['005930'], scheduleHash: 'validated-preview',
      uncoveredDates: [], periodCovered: true, missingCandleSymbols: [], warnings: [],
    } });
  });
  const reason = '미리보기 완료 후 데이터가 변경되었습니다. 미리보기를 다시 확인하세요.';
  let submissions = 0;
  await page.route('**/api/v1/backtests?*', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    submissions += 1;
    return submissions === 1
      ? route.fulfill({ status: 409, json: { error: 'PREPARATION_REQUIRED', reason: 'DATA_REVISION_CHANGED', message: reason } })
      : route.fulfill({ status: 201, json: { job: { id: 'bt_revalidated' } } });
  });
  await page.goto('/backtests/new');
  await page.getByRole('button', { name: /전고점 돌파/ }).click();
  await page.getByRole('button', { name: '다음', exact: true }).click();
  await page.getByLabel('시작일').fill('2026-01-05');
  await page.getByLabel('종료일').fill('2026-03-31');
  await page.getByRole('button', { name: '다음', exact: true }).click();
  await expect(page).toHaveURL(/\/universe\?wizard=/);
  await page.getByLabel('N', { exact: true }).fill('1');
  await page.getByRole('button', { name: '미리보기', exact: true }).click();
  await expect(page.getByText('리밸런스 일정')).toBeVisible();
  for (const slug of ['capital', 'review', 'run']) {
    await page.getByRole('button', { name: '다음', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/${slug}\\?wizard=`));
  }
  await page.getByRole('button', { name: '백테스트 실행', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText(reason);
  await expect(page).toHaveURL(/\/run\?wizard=/);
  await expect(page.getByRole('button', { name: '백테스트 실행', exact: true })).toBeDisabled();
  expect(previewRequests).toBe(1);

  await page.getByRole('button', { name: '유니버스 다시 확인', exact: true }).click();
  await expect(page).toHaveURL(/\/universe\?wizard=/);
  await expect(page.getByText('리밸런스 일정')).toBeVisible();
  await expect(page.getByText(reason, { exact: true })).toHaveCount(0);
  expect(previewRequests).toBe(2);
  await page.getByRole('button', { name: '다음', exact: true }).click();
  await expect(page).toHaveURL(/\/capital\?wizard=/);
  await page.getByRole('button', { name: '이전', exact: true }).click();
  await expect(page).toHaveURL(/\/universe\?wizard=/);
  await expect(page.getByText('리밸런스 일정')).toBeVisible();
  for (const slug of ['capital', 'review', 'run']) {
    await page.getByRole('button', { name: '다음', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/${slug}\\?wizard=`));
  }
  // 단계를 다시 연 뒤 검토를 마치고 실제 제출까지 진행해 effect가 요청을 재생하지
  // 않았는지 확인한다. 고정 시간 대기는 쓰지 않는다.
  await page.getByRole('button', { name: '백테스트 실행', exact: true }).click();
  await expect(page).toHaveURL(/\/backtests\/bt_revalidated$/);
  expect(previewRequests).toBe(2);
  expect(submissions).toBe(2);
});

test('유효한 기간은 벤치마크 조회 없이 유니버스 단계를 연다', async ({ page }) => {
  await login(page);
  const benchmarkRequests: string[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.startsWith('/api/v1/benchmarks')) benchmarkRequests.push(request.url());
  });
  await page.goto('/backtests/new');
  await page.getByRole('button', { name: /전고점 돌파/ }).click();
  await page.getByRole('button', { name: '다음' }).click();
  await page.getByLabel('시작일').fill('2026-01-09');
  await page.getByLabel('종료일').fill('2026-01-05');
  await page.getByRole('button', { name: '다음' }).click();
  await expect(page.getByText('시작일이 종료일보다 늦습니다')).toBeVisible();
  await page.getByLabel('종료일').fill('2026-01-09');
  await page.getByRole('button', { name: '다음' }).click();
  await expect(page).toHaveURL(/\/backtests\/new\/universe\?wizard=/);
  expect(benchmarkRequests).toEqual([]);
});

test('갈 수 없는 단계 URL 은 갈 수 있는 마지막 단계로 되돌린다', async ({ page }) => {
  await login(page);

  // 빈 폼으로 검토 단계에 딥링크 — 게이트가 첫 단계로 되돌린다
  await page.goto('/backtests/new/review');
  await expect(page).toHaveURL(/\/backtests\/new\/strategy\?wizard=/);

  // replace 라서 튕겨 나온 review 가 이력에 없다 — 뒤로가기는 위저드 밖으로 나간다
  await page.goBack();
  await expect(page).not.toHaveURL(/\/backtests\/new/);
});

test('모르는 단계 slug 는 첫 단계로 접힌다', async ({ page }) => {
  await login(page);
  await page.goto('/backtests/new/nonexistent-step');
  await expect(page).toHaveURL(/\/backtests\/new\/strategy\?wizard=/);
});

test('재설정 및 복제의 전략 단계는 종목과 비용 프로필을 미리 조회하지 않는다', async ({
  page,
}) => {
  await login(page);

  await page.route('**/api/v1/backtests/bt_clone_fixture/clone-draft', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify(CLONE_DRAFT_FIXTURE),
    });
  });

  await page.route('**/api/v1/backtests/wizards/clone-fixture', route => route.fulfill({ json: { wizard: {
    id: 'clone-fixture', sourceJobId: 'bt_clone_fixture', currentStep: 'strategy', status: 'WAITING', phase: 'DRAFT', error: null,
    preparationJobId: null, preparationInput: null, backtestJobId: null, createdAtMs: 1, updatedAtMs: 1, finishedAtMs: null, link: '/backtests/new/strategy?wizard=clone-fixture',
    recovery: { status: 'WAITING_INPUT', message: '버전 변경 재준비 완료 · 사용자 입력 대기', error: null },
  } } }));

  // 새 문서 탐색으로 앱의 Query cache를 비운 뒤 이 진입에서 발생한 요청만 관찰한다.
  const apiRequests: string[] = [];
  page.on('request', (request) => {
    const pathname = new URL(request.url()).pathname;
    if (pathname.startsWith('/api/v1/')) apiRequests.push(pathname);
  });

  await page.goto('/backtests/new/strategy?wizard=clone-fixture');
  await expect(page.getByRole('heading', { name: '재설정 및 복제' })).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: '버전 변경 재준비 완료 · 사용자 입력 대기' })).toBeVisible();
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
  await expect(page).toHaveURL(/\/backtests\/new\/strategy\?wizard=/);
  await expect(page.getByRole('button', { name: '백테스트 실행' })).toHaveCount(0);
});

test('모르는 데이터 하위 경로도 기본 구획으로 이어진다', async ({ page }) => {
  await login(page);

  // 알 수 없는 자식 경로는 종목 마스터 기본 화면으로 복구한다.
  await page.goto('/datasets/symbols');
  await expect(page).toHaveURL(/\/datasets\/master$/);
  await expect(page.getByRole('checkbox', { name: '자동 동기화(KRX)' })).toBeVisible();
});
