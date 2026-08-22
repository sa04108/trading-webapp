import { expect, test } from '@playwright/test';
// 자격 증명은 한 곳에서만 — mvp-flow.spec.ts 와 같은 관례(그 파일 헤더 참고)
import { PASSWORD, USERNAME } from './login';
import { advanceFromPeriod } from './backtest-wizard';

/**
 * Task 12 — 단계형 유니버스 편집기(Task 9)와 신규 재무전략 두 개(Task 8)의 위저드
 * 흐름을 browser boundary 에서 확인한다. 수치 계산(순위·PIT·N 상한 규칙 자체)은
 * 이미 단위 테스트(`universe-pipeline.test.ts`, `universe-rule-resolver.test.ts`)와
 * 통합 테스트(`backtest-universe-preview.test.ts`, `backtest-universe-rule-run.test.ts`)
 * 가 촘촘히 덮는다 — 여기서는 그 결과가 실제 화면에 그대로 나타나는지만 본다.
 *
 * mvp-flow.spec.ts 와 같은 서버를 공유한다(playwright.config workers:1) — 그 파일이
 * 쓰는 기간(PERIOD·holidayPeriodFor·delisted-stock 기간)과 겹치지 않는 새 구간을 쓴다.
 * 이 스펙은 새 데이터셋 카드나 별도 등록 종목을 만들지 않는다 — 위저드가 자동
 * 등록하는 종목은 005930 하나뿐이고, mvp-flow.spec.ts 도 같은 종목을 이미 등록해
 * 두므로 정리할 것이 없다(그 파일이 지우는 900010 과 달리 005930 은 여러 스펙이
 * 공유해도 되는 항상-존재 종목이다).
 */
/**
 * to는 적어도 한 달 뒤까지 — 되돌린 주기(매월 1회)가 이 기간 안에 최소 한 번은
 * 있어야 한다(rebalanceIntervalFitsPeriod, mvp-flow.spec.ts 의 같은 회귀 참고).
 *
 * mobile·desktop 프로젝트가 같은 서버를 공유하므로(playwright.config workers:1)
 * 같은 기간을 쓰면 한 프로젝트가 먼저 완료해 둔 준비 결과를 다른 프로젝트가
 * "이미 미리보기한 상태"로 재사용하게 된다 — 이 test는 화면이 직접 시가총액
 * 단일 단계로 되돌리는 조작까지 다시 거치므로 재사용 자체는 문제가 아니지만,
 * 정확히 같은 요청이 거의 동시에 겹치면 위저드가 그 사이 값을 최신으로
 * 재판정하는 타이밍(리뷰에서 재현된 순간 경합)에 따라 '검토'·'실행' 단계가
 * 그 재판정 전 상태로 잠겨 있을 수 있다. mvp-flow.spec.ts `holidayPeriodFor`
 * 와 같은 이유로 프로젝트마다 다른 기간을 쓴다.
 */
function pipelinePeriodFor(projectName: string): { from: string; to: string } {
  return projectName === 'mobile'
    ? { from: '2026-06-01', to: '2026-07-05' }
    : { from: '2026-08-01', to: '2026-09-05' };
}

async function login(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('사용자 이름').fill(USERNAME);
  await page.getByLabel('비밀번호').fill(PASSWORD);
  await page.getByRole('button', { name: '로그인' }).click();
  await expect(page.getByRole('heading', { name: '대시보드' })).toBeVisible();
}

test('새 전략 목록에 이익 가속·저PER·고ROE 순위가 있고 기본 보유 종목 수는 40이다', async ({
  page,
}) => {
  await login(page);
  await page.goto('/backtests/new');

  const earningsCard = page.getByRole('button', { name: /이익 가속·가격 확인 순위/ });
  const lowPerCard = page.getByRole('button', { name: /저PER·고ROE 순위/ });
  await expect(earningsCard).toBeVisible();
  await expect(lowPerCard).toBeVisible();

  await earningsCard.click();
  await expect(page.getByLabel('보유 종목 수', { exact: true })).toHaveValue('40');
  await earningsCard.click(); // 선택 해제 — 다른 시나리오에 영향을 남기지 않는다

  await lowPerCard.click();
  await expect(page.getByLabel('보유 종목 수', { exact: true })).toHaveValue('40');
});

test('리밸런스 주기 입력은 편집 중 임시값을 허용하고 blur에서 보정한다', async ({
  page,
}) => {
  await login(page);
  await page.goto('/backtests/new');
  await page.getByRole('button', { name: /전고점 돌파/ }).click();
  await page.getByLabel('돌파 기준 봉 수', { exact: true }).fill('10');
  await page.getByLabel('변동성(ATR) 계산 기간', { exact: true }).fill('5');
  await page.getByRole('button', { name: '다음' }).click();

  await page.getByLabel('시작일').fill('2026-01-01');
  await page.getByLabel('종료일').fill('2026-12-31');
  await advanceFromPeriod(page);

  const interval = page.getByLabel('리밸런스 주기', { exact: true });
  await expect(interval).toHaveValue('1');

  await interval.fill('');
  await expect(interval).toHaveValue('');
  await interval.fill('3');
  await expect(interval).toHaveValue('3');

  await interval.fill('99');
  await expect(interval).toHaveValue('99');
  await interval.blur();
  await expect(interval).toHaveValue('12');

  await interval.fill('0');
  await expect(interval).toHaveValue('0');
  await interval.blur();
  await expect(interval).toHaveValue('1');

  await interval.fill('3');
  await interval.fill('');
  await interval.blur();
  await expect(interval).toHaveValue('3');
});

test('단계별 N 입력은 편집 중 임시값을 허용하고 blur에서 복구·clamp한다', async ({
  page,
}) => {
  await login(page);
  await page.goto('/backtests/new');
  await page.getByRole('button', { name: /전고점 돌파/ }).click();
  await page.getByLabel('돌파 기준 봉 수', { exact: true }).fill('10');
  await page.getByLabel('변동성(ATR) 계산 기간', { exact: true }).fill('5');
  await page.getByRole('button', { name: '다음' }).click();
  await page.getByLabel('시작일').fill('2026-01-01');
  await page.getByLabel('종료일').fill('2026-12-31');
  await advanceFromPeriod(page);

  const first = page.locator('#stage-limit-0');
  await expect(first).toHaveValue('200');
  await first.fill('');
  await expect(first).toHaveValue('');
  await first.fill('500');
  await expect(first).toHaveValue('500');
  await first.blur();
  await expect(first).toHaveValue('200');

  await first.fill('50');
  await page.getByRole('button', { name: 'PER 단계 추가' }).click();
  const second = page.locator('#stage-limit-1');
  await expect(second).toHaveValue('50');
  await second.fill('99');
  await expect(second).toHaveValue('99');
  await second.blur();
  await expect(second).toHaveValue('50');

  await first.fill('0');
  await expect(first).toHaveValue('0');
  await first.blur();
  await expect(first).toHaveValue('1');
  await expect(second).toHaveValue('1');
  await expect(
    page.getByText('앞 단계 N을 넘지 않도록 뒤 단계 값을 함께 조정했습니다.'),
  ).toBeVisible();

  await first.fill('37');
  await first.fill('');
  await first.blur();
  await expect(first).toHaveValue('37');
});

test('유니버스 정렬 방향을 기준별 문구로 명시해 고른다', async ({ page }) => {
  await login(page);
  await page.goto('/backtests/new');
  await page.getByRole('button', { name: /전고점 돌파/ }).click();
  await page.getByLabel('돌파 기준 봉 수', { exact: true }).fill('10');
  await page.getByLabel('변동성(ATR) 계산 기간', { exact: true }).fill('5');
  await page.getByRole('button', { name: '다음' }).click();
  await page.getByLabel('시작일').fill('2026-01-01');
  await page.getByLabel('종료일').fill('2026-12-31');
  await advanceFromPeriod(page);

  await expect(page.locator('#stage-direction-0')).toHaveValue('HIGH');
  await expect(page.locator('#stage-direction-0 option')).toHaveText(['상위', '하위']);

  await page.getByRole('button', { name: 'PER 단계 추가' }).click();
  await expect(page.locator('#stage-direction-1')).toHaveValue('LOW');
  await expect(page.locator('#stage-direction-1 option')).toHaveText(['낮음', '높음']);
  await page.locator('#stage-direction-1').selectOption('HIGH');
  await expect(page.locator('#stage-direction-1')).toHaveValue('HIGH');

  await page.getByRole('button', { name: '가격 변동 단계 추가' }).click();
  await expect(page.locator('#stage-direction-2')).toHaveValue('HIGH');
  await expect(page.locator('#stage-direction-2 option')).toHaveText(['급상승', '급하락']);
  await page.locator('#stage-direction-2').selectOption('LOW');
  await expect(page.locator('#stage-direction-2')).toHaveValue('LOW');

  await page.getByRole('button', { name: '거래량 단계 추가' }).click();
  await page.getByRole('button', { name: '거래대금 단계 추가' }).click();
  await page.getByRole('button', { name: 'ROE 단계 추가' }).click();
  await expect(page.locator('[id^="stage-criterion-"]')).toHaveCount(6);
  await expect(page.getByRole('button', { name: /단계 추가/ })).toHaveCount(0);
  await expect(page.locator('#stage-direction-5 option')).toHaveText(['높음', '낮음']);
});

test('단계 추가·N 기본 복사·cascade 안내·순서 변경·주기 초과 차단을 거쳐 준비→제출까지 완주한다', async ({
  page,
}, testInfo) => {
  const period = pipelinePeriodFor(testInfo.project.name);
  await login(page);
  await page.goto('/backtests/new');
  await page.getByRole('button', { name: /전고점 돌파/ }).click();
  await page.getByLabel('돌파 기준 봉 수', { exact: true }).fill('10');
  await page.getByLabel('변동성(ATR) 계산 기간', { exact: true }).fill('5');
  await page.getByRole('button', { name: '다음' }).click(); // 전략 → 기간

  await page.getByLabel('시작일').fill(period.from);
  await page.getByLabel('종료일').fill(period.to);
  await advanceFromPeriod(page); // 기간 → 벤치마크 동기화(필요 시) → 유니버스

  // 1. 시가총액 단계 뒤 PER와 가격 변동을 추가한다.
  await page.locator('#stage-limit-0').fill('50');
  await page.getByRole('button', { name: 'PER 단계 추가' }).click();
  await page.getByRole('button', { name: '가격 변동 단계 추가' }).click();
  await expect(page.locator('#stage-criterion-0')).toHaveValue('MARKET_CAP');
  await expect(page.locator('#stage-criterion-1')).toHaveValue('PER');
  await expect(page.locator('#stage-criterion-2')).toHaveValue('DECLINE');

  // 2. N 기본 복사 — 새 단계는 직전 단계의 현재 N을 그대로 받는다(universe-pipeline.ts addStage).
  await expect(page.locator('#stage-limit-1')).toHaveValue('50');
  await expect(page.locator('#stage-limit-2')).toHaveValue('50');

  // 2-1. cascade 안내 — 앞 단계 N을 뒤 단계보다 작게 줄이면 뒤 단계도 함께 줄고 안내가 뜬다.
  await page.locator('#stage-limit-0').fill('10');
  await expect(page.locator('#stage-limit-1')).toHaveValue('10');
  await expect(page.locator('#stage-limit-2')).toHaveValue('10');
  await expect(
    page.getByText('앞 단계 N을 넘지 않도록 뒤 단계 값을 함께 조정했습니다.'),
  ).toBeVisible();

  // 3. 위/아래 버튼으로 순서를 바꾼다 — 가격 변동(3단계)을 PER(2단계) 앞으로 올린다.
  await page.getByRole('button', { name: '3단계 위로 이동' }).click();
  await expect(page.locator('#stage-criterion-1')).toHaveValue('DECLINE');
  await expect(page.locator('#stage-criterion-2')).toHaveValue('PER');
  // 되돌린다 — 이후 단계 삭제 순서를 예측 가능하게 유지한다.
  await page.getByRole('button', { name: '2단계 아래로 이동' }).click();
  await expect(page.locator('#stage-criterion-1')).toHaveValue('PER');
  await expect(page.locator('#stage-criterion-2')).toHaveValue('DECLINE');

  // 4. 리밸런싱 주기가 기간을 넘으면 차단한다 — 주기 단위를 '년'으로 바꾸면(자동 값 1)
  // 이 짧은 기간(10일)보다 항상 길다. shadcn Select 는 네이티브 select 가 아니라
  // combobox 를 열고 option 을 눌러야 한다(symbol-master.spec.ts 와 같은 관례).
  await page.getByRole('combobox', { name: '주기 단위' }).click();
  await page.getByRole('option', { name: '년' }).click();
  await expect(
    page.getByText('리밸런스 주기가 기간보다 길어 리밸런스가 한 번도 일어나지 않습니다'),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: '미리보기' })).toBeDisabled();
  // 되돌린다 — 매월 1회로 이 짧은 기간에서도 리밸런스가 정확히 한 번 일어난다.
  await page.getByRole('combobox', { name: '주기 단위' }).click();
  await page.getByRole('option', { name: '개월' }).click();
  await expect(
    page.getByText('리밸런스 주기가 기간보다 길어 리밸런스가 한 번도 일어나지 않습니다'),
  ).toHaveCount(0);

  // 5. PER·급하락 단계를 지워 시가총액 단일 단계로 되돌린다 — 이 스펙은 화면 동작만
  // 보는 것이 목적이라, DART 재무 왕복 없이 곧바로 준비→제출까지 갈 수 있게 한다.
  await page.getByRole('button', { name: '2단계 삭제' }).click();
  await page.getByRole('button', { name: '2단계 삭제' }).click();
  await expect(page.locator('#stage-criterion-0')).toHaveValue('MARKET_CAP');
  await expect(page.locator('#stage-limit-0')).toHaveValue('10');
  await page.locator('#stage-direction-0').selectOption('LOW');

  // 6. 준비 진행률 → 완료 preview → 백테스트 제출.
  const initialPreview = page.waitForResponse(
    (resp) =>
      resp.url().includes('/backtests/universe-preview') && resp.request().method() === 'POST',
  );
  await page.getByRole('button', { name: '미리보기' }).click();
  const first = await initialPreview;
  if (first.status() === 202) {
    await expect(page.getByText('데이터 준비')).toBeVisible();
    const completed = page.waitForResponse(
      (resp) =>
        resp.url().includes('/backtests/universe-preview') && resp.request().method() === 'POST',
      { timeout: 200_000 },
    );
    await completed;
  }
  await expect(page.getByText('리밸런스 일정')).toBeVisible();
  // 기간이 한 달을 넘으므로(주기 초과 차단을 확인하려고 위에서 늘렸다) 리밸런스는
  // 매월 규칙대로 2회다 — 정확한 횟수보다는 준비가 끝나 실제 일정이 그려졌다는
  // 사실이 이 test의 관심사다.
  await expect(page.getByText(/리밸런스 \d+회/)).toBeVisible();

  await page.getByRole('button', { name: '다음' }).click(); // 유니버스 → 자본·비용
  await page.getByRole('button', { name: '다음' }).click(); // 자본·비용 기본값 → 검토
  await page.getByRole('button', { name: '다음' }).click(); // 검토 → 실행

  await page.getByRole('button', { name: '백테스트 실행' }).click();
  await expect(page).toHaveURL(/\/backtests\/bt_/);
  const jobId = page.url().split('/').at(-1)!;
  await page.goto(`/backtests/new?from=${jobId}`);
  await expect(page.getByRole('heading', { name: '재설정 및 복제' })).toBeVisible();
  await page.getByRole('button', { name: '다음' }).click();
  await page.getByRole('button', { name: '다음' }).click();
  await expect(page.locator('#stage-direction-0')).toHaveValue('LOW');
});
