import { expect, test } from '@playwright/test';
import { login } from './login';

test('API 토큰을 한 번 표시하고 명세를 읽기 전용으로 탐색한다', async ({ page }) => {
  await login(page);
  let issued: unknown = null; let revoked = false; let unexpectedCalls = 0;
  const record = { id: 'token-id', name: '로컬 도구', prefix: 'api_abc', scope: 'READ_WRITE', createdAtMs: 1, expiresAtMs: 2_000_000_000_000, lastUsedAtMs: null, revokedAtMs: null };
  await page.route('**/api/v1/openapi-tokens', async route => {
    if (route.request().method() === 'POST') { issued = route.request().postDataJSON(); await route.fulfill({ status: 201, json: { token: 'api_secret_once', record } }); }
    else await route.fulfill({ json: { tokens: issued ? [{ ...record, revokedAtMs: revoked ? 1 : null }] : [] } });
  });
  await page.route('**/api/v1/openapi-tokens/token-id', route => { revoked = true; return route.fulfill({ status: 204 }); });
  await page.route('**/api/v1/system/api-reference', route => route.fulfill({ json: { version: '1', generatedAtMs: 1, basePath: '/api/v1', authentication: { description: '세션 또는 토큰', bearerExample: 'Authorization: Bearer TOKEN', tokenManagement: '설정에서 관리' }, endpoints: [
    { id: 'example', method: 'POST', path: '/backtests', group: '백테스트', title: '실행 생성', description: '실행을 만듭니다.', authentication: 'SESSION_OR_TOKEN', parameters: [], requestBody: { contentType: 'application/json', example: { count: 1 } }, responses: [{ status: 201, description: '생성됨', example: { id: 'one' } }] },
    { id: 'other', method: 'GET', path: '/jobs', group: '작업', title: '작업 목록', description: '목록', authentication: 'SESSION', parameters: [], responses: [{ status: 200, description: '목록' }] },
  ] } }));
  await page.route('**/api/v1/backtests', route => { unexpectedCalls++; return route.fulfill({ status: 500 }); });
  await page.goto('/settings');
  await page.getByLabel('토큰 이름').fill('로컬 도구');
  await expect(page.getByLabel('유효 기간 (일)')).toHaveValue('365');
  await page.getByRole('button', { name: 'API 토큰 발급' }).click();
  await expect.poll(() => issued).toEqual({ name: '로컬 도구', scope: 'READ_WRITE', expiresInDays: 365 });
  await expect(page.getByText('api_secret_once')).toBeVisible();
  await page.getByRole('button', { name: '닫기', exact: true }).click();
  await expect(page.getByText('api_secret_once')).toHaveCount(0);
  await expect(page.getByText(/api_abc/)).toBeVisible();
  await page.getByRole('button', { name: '폐기', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '폐기' }).click();
  await expect.poll(() => revoked).toBe(true);
  await expect(page.getByText(/폐기됨/)).toBeVisible();
  await page.getByRole('link', { name: 'API 명세 열기' }).click();
  await expect(page).toHaveURL('/settings/api-reference');
  await page.getByLabel('API 검색').fill('/backtests');
  await expect(page.getByRole('heading', { name: '실행 생성' })).toBeVisible();
  await expect(page.getByText('application/json')).toBeVisible();
  await expect(page.getByText(/"count": 1/)).toBeVisible();
  await expect(page.getByRole('button', { name: /^(요청 보내기|실행|Try it)$/i })).toHaveCount(0);
  expect(unexpectedCalls).toBe(0);
});
