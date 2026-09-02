import { expect, type Page } from '@playwright/test';

/**
 * e2e 로그인 — 시드 운영자 자격 증명(scripts/e2e-server.ts)으로 대시보드까지 들어간다.
 *
 * 스펙마다 복사해 두면 로그인 폼의 라벨이나 시드 자격 증명이 바뀔 때 일부 스펙만
 * 고쳐지고 남은 하나가 `getByLabel('사용자 이름')` 타임아웃으로 죽는다. 파일명이
 * `*.spec.ts` 가 아니라서 playwright 가 테스트로 수집하지 않는다.
 */
export const USERNAME = 'e2e-operator';
export const PASSWORD = 'correct-horse-battery-staple';

export async function login(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page).toHaveURL(/\/login/);
  await page.getByLabel('사용자 이름').fill(USERNAME);
  await page.getByLabel('비밀번호').fill(PASSWORD);
  await page.getByRole('button', { name: '로그인' }).click();
  await expect(page.getByRole('heading', { name: '대시보드' })).toBeVisible();
  // 실제 제품에서는 새 작성 초안을 로그인 뒤에도 보존한다. E2E는 같은 운영자와 서버를
  // 모든 스펙이 공유하므로 테스트 시작마다 신규 작성 문맥만 지워 서로의 입력을 격리한다.
  const cleared = await page.evaluate(async () => {
    const response = await fetch('/api/v1/backtests/wizard-draft', { method: 'DELETE' });
    return response.status;
  });
  if (cleared !== 204) {
    throw new Error(`E2E 위저드 초안을 초기화하지 못했습니다: HTTP ${cleared}`);
  }
}
