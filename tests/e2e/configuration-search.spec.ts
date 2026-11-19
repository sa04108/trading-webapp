import { expect, test, type Locator, type Page } from '@playwright/test';
import { login } from './login';
import type { ConfigurationSearchCatalog, ConfigurationSearchConfig, ConfigurationSearchDetail } from '../../src/shared/schemas/configuration-search.js';

const sourceId = 'search-source';
const period = { from: '2020-01-01', to: '2024-01-01' };
const daily: ConfigurationSearchCatalog = { mode: 'daily', sourceJobId: sourceId, strategyId: 'daily-strategy', strategyName: '일봉 전략', period, maxCount: 100, fields: [
  { key: 'parameters.threshold', label: '임계값', group: 'strategy', current: 2, kind: 'number', min: 0.1, max: 10, step: 0.1, integer: false, recommended: [1, 3], allowUnset: true },
  { key: 'parameters.enabled', label: '사용 여부', group: 'strategy', current: true, kind: 'choice', options: [{ value: true, label: '사용' }, { value: false, label: '사용 안 함' }], recommended: [true, false] },
] };
const intraday: ConfigurationSearchCatalog = { ...daily, mode: 'intraday', strategyId: 'intraday-strategy', strategyName: '분봉 전략', fields: [
  { key: 'parameters.fast', label: '빠른 기간', group: 'strategy', current: 10, kind: 'number', min: 1, max: 100, step: 1, integer: true, recommended: [5, 20] },
] };

async function setup(page: Page, catalog: ConfigurationSearchCatalog, delayed = false) {
  await login(page);
  const prefix = catalog.mode === 'daily' ? `/backtests/${sourceId}` : `/intraday/runs/${sourceId}`;
  let posted: { requestId: string; config: ConfigurationSearchConfig } | null = null;
  let started: string | null = null;
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  let experiment: ConfigurationSearchDetail | null = null;
  await page.route(`**/api/v1${prefix}/lineage`, route => route.fulfill({ json: { complete: true, kind: 'original', roleLabel: '결과', items: [{ label: '백테스트', href: '/backtests' }, { label: '원본' }] } }));
  await page.route(`**/api/v1${prefix}/configuration-search/catalog`, route => route.fulfill({ json: { catalog } }));
  await page.route(`**/api/v1${prefix}/configuration-search`, route => route.fulfill({ json: { experiments: experiment ? [experiment] : [] } }));
  await page.route(`**/api/v1${prefix}/configuration-search/preview`, async route => {
    posted = route.request().postDataJSON();
    const config = posted!.config;
    experiment = { id: 'preview-exact', sourceJobId: sourceId, mode: catalog.mode, strategyId: catalog.strategyId, strategyName: catalog.strategyName, period, config, catalog, status: 'PREVIEW', totalCount: config.count, completedCount: 0, failedCount: 0, pendingCount: config.count, runningCount: 0, createdAtMs: 1, completedAtMs: null, error: null, sourceHref: `/backtests/${sourceId}`,
      items: [{ id: 'item-1', ordinal: 0, status: 'PENDING', values: { [catalog.fields[0]!.key]: 1.5 }, request: {} as ConfigurationSearchDetail['items'][number]['request'], jobId: null, resultHref: null, error: null, metrics: null }] };
    if (delayed) await blocked;
    await route.fulfill({ json: { experiment } });
  });
  await page.route('**/api/v1/configuration-searches/preview-exact/start', route => { started = 'preview-exact'; return route.fulfill({ json: { experiment: { ...experiment!, status: 'ACTIVE' } } }); });
  await page.route('**/api/v1/configuration-searches/preview-exact', route => route.fulfill({ json: { experiment: { ...experiment!, status: 'ACTIVE' } } }));
  await page.goto(catalog.mode === 'daily' ? `/backtests/${sourceId}/search` : `/backtests/intraday/${sourceId}/search`);
  return { get posted() { return posted; }, get started() { return started; }, release };
}

test('일봉 설정을 고정 해제하고 미리 본 조합 그대로 실행한다', async ({ page }) => {
  const state = await setup(page, daily);
  const preview = page.getByRole('button', { name: '조합 미리보기' });
  await expect(preview).toBeDisabled();
  const numberRow = page.locator('div.grid.border-b').filter({ hasText: '임계값' });
  await expect(numberRow.getByRole('checkbox', { name: '임계값 고정', exact: true })).toBeChecked();
  await numberRow.getByRole('checkbox', { name: '임계값 고정', exact: true }).uncheck();
  await expect(page.getByLabel('임계값 최소 슬라이더')).toBeVisible();
  await expect(page.getByText('허용 0.1 ~ 10 · 간격 0.1 · 추천 1 ~ 3')).toBeVisible();
  await page.getByLabel('임계값 최소', { exact: true }).fill('1.5');
  await page.getByLabel('사용 안 함 포함').check();
  await page.locator('div.grid.border-b').filter({ hasText: '사용 여부' }).getByRole('checkbox', { name: '사용 여부 고정', exact: true }).uncheck();
  await page.getByLabel('사용 안 함', { exact: true }).uncheck();
  await page.getByLabel('생성 개수 (1~100)').fill('2');
  await preview.click();
  await expect.poll(() => state.posted).toMatchObject({ config: { count: 2, settings: { 'parameters.threshold': { kind: 'RANGE', min: 1.5, max: 3, includeUnset: true }, 'parameters.enabled': { kind: 'CHOICE', values: [true] } } } });
  expect(Object.keys(state.posted!)).toEqual(['requestId', 'config']);
  await expect(page.getByText('생성될 조합 미리보기')).toBeVisible();
  await expect(page.getByRole('cell', { name: '1.5', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '이 조합으로 실행' }).click();
  await expect(page.getByRole('dialog')).toContainText('최신 상태로 자동 준비');
  expect(state.started).toBeNull();
  await page.getByRole('dialog').getByRole('button', { name: '실행 시작' }).click();
  await expect.poll(() => state.started).toBe('preview-exact');
  await expect(page).toHaveURL('/backtests/searches/preview-exact');
});

test('범위 핸들을 드래그하고 키보드로 조정한 값을 새 미리보기에 반영한다', async ({ page }, testInfo) => {
  const state = await setup(page, daily);
  await page.getByRole('checkbox', { name: '임계값 고정', exact: true }).uncheck();
  const minimum = page.getByRole('slider', { name: '임계값 최소 슬라이더' });
  const maximum = page.getByRole('slider', { name: '임계값 최대 슬라이더' });
  const preview = page.getByRole('button', { name: '조합 미리보기' });
  await preview.click();
  await expect(page.getByText('생성될 조합 미리보기')).toBeVisible();

  const drag = async (thumb: Locator, targetX: number) => {
    await thumb.scrollIntoViewIfNeeded();
    const box = await thumb.boundingBox();
    if (!box) throw new Error('범위 슬라이더 핸들을 찾지 못했습니다');
    const x = box.x + box.width / 2, y = box.y + box.height / 2;
    if (testInfo.project.name === 'mobile') {
      const session = await page.context().newCDPSession(page);
      try {
        await session.send('Emulation.setTouchEmulationEnabled', { enabled: true });
        await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] });
        // 실제 손가락처럼 세로 이동을 섞어 브라우저 스크롤이 드래그를 취소하는 회귀도 검출한다.
        for (let step = 1; step <= 12; step++) {
          await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + (targetX - x) * step / 12, y: y + step * 2, id: 1 }] });
        }
        await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      } finally {
        await session.detach();
      }
    } else {
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(targetX, y + 24, { steps: 12 });
      await page.mouse.up();
    }
  };

  await drag(maximum, page.viewportSize()!.width - 1);
  await expect(maximum).toHaveAttribute('aria-valuenow', '10');
  await expect(page.getByLabel('임계값 최대', { exact: true })).toHaveValue('10');
  await expect(minimum).toHaveAttribute('aria-valuenow', '1');
  await expect(page.getByText('생성될 조합 미리보기')).toHaveCount(0);
  await drag(minimum, 0);
  await expect(minimum).toHaveAttribute('aria-valuenow', '0.1');
  await expect(page.getByLabel('임계값 최소', { exact: true })).toHaveValue('0.1');
  await expect(maximum).toHaveAttribute('aria-valuenow', '10');
  await minimum.press('ArrowRight');
  await maximum.press('ArrowLeft');
  await expect(page.getByLabel('임계값 최소', { exact: true })).toHaveValue('0.2');
  await expect(page.getByLabel('임계값 최대', { exact: true })).toHaveValue('9.9');
  await preview.click();
  await expect.poll(() => state.posted).toMatchObject({ config: { settings: { 'parameters.threshold': { kind: 'RANGE', min: 0.2, max: 9.9 } } } });
});

test('분봉 미리보기 요청 중 설정을 변경하면 늦은 응답을 실행할 수 없다', async ({ page }) => {
  const state = await setup(page, intraday, true);
  await expect(page.getByText('빠른 기간', { exact: true })).toBeVisible();
  await expect(page.getByText('임계값', { exact: true })).toHaveCount(0);
  await page.locator('div.grid.border-b').filter({ hasText: '빠른 기간' }).getByRole('checkbox', { name: '빠른 기간 고정', exact: true }).uncheck();
  await page.getByRole('button', { name: '조합 미리보기' }).click();
  await expect.poll(() => state.posted).not.toBeNull();
  await page.getByLabel('빠른 기간 최대', { exact: true }).fill('30');
  state.release();
  await expect(page.getByRole('button', { name: '조합 미리보기' })).toBeEnabled();
  await expect(page.getByText('생성될 조합 미리보기')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '이 조합으로 실행' })).toHaveCount(0);
  expect(state.started).toBeNull();
});
