import { expect, test } from '@playwright/test';

const USERNAME = 'e2e-operator';
const PASSWORD = 'correct-horse-battery-staple';

/** 스펙 §33 E2E 흐름: 로그인 → 생성 → 제출 → 완료 → 결과 → 거래 필터 → clone → 로그아웃 */
test('full MVP flow', async ({ page }) => {
  // 종목명 소스를 스텁한다 — 테스트 환경엔 소스가 설정돼 있지 않아 이름이 항상
  // null 로 오는데, 그러면 '이름 없으면 코드만' 분기와 겹쳐 표시=value 바인딩
  // 버그(§아래 거래 필터 검증)를 절대 못 잡는다. 실제로 이름이 뜨게 만들어야
  // "표시는 이름, value 는 코드"가 실제로 갈리는 상태에서 검증할 수 있다.
  await page.route('**/api/v1/symbols/info**', async (route) => {
    const url = new URL(route.request().url());
    const requested = (url.searchParams.get('symbols') ?? '').split(',').filter(Boolean);
    const known: Record<string, string> = { '005930': '삼성전자' };
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        stocks: requested
          .filter((symbol) => symbol in known)
          .map((symbol) => ({
            symbol,
            name: known[symbol],
            englishName: null,
            market: 'KOSPI',
            status: 'ACTIVE',
          })),
      }),
    });
  });

  // 1. 로그인 (비밀번호 단일 단계, D-014)
  await page.goto('/');
  await expect(page).toHaveURL(/\/login/);
  await page.getByLabel('사용자 이름').fill(USERNAME);
  await page.getByLabel('비밀번호').fill(PASSWORD);
  await page.getByRole('button', { name: '로그인' }).click();
  await expect(page.getByRole('heading', { name: '대시보드' })).toBeVisible();

  // 2. 백테스트 생성 (6단계 위저드) — 픽스처에서 완결 거래가 나오도록 파라미터 조정
  await page.goto('/backtests/new');
  await page.getByRole('button', { name: /시간봉 돌파/ }).click();
  // exact — ⓘ 아이콘의 aria-label('… 설명') 과 부분 일치로 겹치지 않게 한다
  await page.getByLabel('돌파 기준 봉 수', { exact: true }).fill('10');
  await page.getByLabel('변동성(ATR) 계산 기간', { exact: true }).fill('5');
  await page.getByLabel('익절 폭 (변동성 배수) (선택)', { exact: true }).fill('3');
  // ⓘ 아이콘 — 클릭으로만 열린다 (모바일에 hover 가 없다)
  const hintButton = page.getByRole('button', { name: '돌파 기준 봉 수 설명' });
  const hint = page.getByRole('tooltip');
  await hintButton.hover();
  await expect(hint).toBeHidden();
  await hintButton.click();
  await expect(hint).toContainText('최고가');
  await expect(hint).toContainText('lookbackBars · 2~200 · 기본 20');
  // 다시 클릭하면 닫힌다
  await hintButton.click();
  await expect(hint).toBeHidden();
  // Escape 로도 닫힌다
  await hintButton.click();
  await expect(hint).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(hint).toBeHidden();
  await page.getByRole('button', { name: '다음' }).click();

  await page.getByRole('button', { name: /kr-hourly-v1/ }).click();
  await page.getByRole('button', { name: '다음' }).click();

  await page.getByLabel('시작일').fill('2026-01-05');
  await page.getByLabel('종료일').fill('2026-03-31');
  await page.getByRole('button', { name: '다음' }).click();

  await page.getByRole('button', { name: '다음' }).click(); // 자본·비용 기본값 → 검토
  await expect(page.getByRole('button', { name: '5. 검토' })).toHaveAttribute(
    'aria-current',
    'step',
  );

  // 2-1. 상단 단계 버튼 — 뒤로는 자유롭게, 앞으로는 검토까지만
  await page.getByRole('button', { name: '2. 데이터·종목' }).click();
  await expect(page.getByRole('button', { name: '2. 데이터·종목' })).toHaveAttribute(
    'aria-current',
    'step',
  );
  // 실행은 잠겨 있다 — 눌러도 이동하지 않고 이유만 알려 준다
  const runStep = page.getByRole('button', { name: '6. 실행' });
  // toBeDisabled() 가 아니라 속성을 직접 본다 — native disabled 로 바뀌면 그것도
  // 통과해 버리는데, 이 화면이 지켜야 하는 건 'aria-disabled 로만 잠근다' 쪽이다
  await expect(runStep).toHaveAttribute('aria-disabled', 'true');
  // force — Playwright 의 actionability 는 aria-disabled 도 '비활성' 으로 보고 클릭을
  // 거부한다. 하지만 브라우저는 막지 않으므로 실제 사용자는 누를 수 있다: 이 화면이
  // disabled 대신 aria-disabled 를 쓰는 이유(눌리되 이유를 알려 준다)가 바로 그것이라
  // 검증도 실제 클릭으로 해야 한다.
  await runStep.click({ force: true });
  await expect(page.getByText("'검토' 단계에서 '다음' 을 눌러 진행하세요")).toBeVisible();
  await expect(page.getByRole('button', { name: '2. 데이터·종목' })).toHaveAttribute(
    'aria-current',
    'step',
  );
  // 검토로는 한 번에 앞으로 갈 수 있다
  await page.getByRole('button', { name: '5. 검토' }).click();
  await expect(page.getByRole('button', { name: '5. 검토' })).toHaveAttribute(
    'aria-current',
    'step',
  );
  await page.getByRole('button', { name: '다음' }).click(); // 실행

  // 3. 작업 제출
  await page.getByRole('button', { name: '백테스트 실행' }).click();
  await expect(page).toHaveURL(/\/backtests\/bt_/);

  // 4. 완료 대기 (SSE 진행률 → 완료 badge)
  await expect(page.getByText('완료', { exact: true })).toBeVisible({ timeout: 90_000 });

  // 5. 결과 조회: 지표 카드 + 차트 + 거래 내역 (미청산 포지션은 거래 내역 상단 배지 행)
  await expect(page.getByText('누적 수익률', { exact: true })).toBeVisible();
  await expect(page.getByText('자산 곡선', { exact: true })).toBeVisible();
  await expect(page.getByText('월별 수익률')).toBeVisible();
  await expect(page.getByText('거래 내역', { exact: true })).toBeVisible();
  await expect(page.getByText('재현 정보')).toBeVisible();
  // 별도 "미청산 포지션" 카드는 제거되고 거래 내역 테이블에 통합됐다
  await expect(page.getByText('미청산 포지션', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('row').filter({ hasText: '미청산' }).first()).toBeVisible();
  const tradeRows = page.getByRole('row').filter({ hasText: '005930' });
  await expect(tradeRows.first()).toBeVisible();
  // 종목 표기: 위 스텁으로 '005930' 은 이름이 뜬다 — '삼성전자 (005930)' 형태로
  // 이름·코드가 둘 다 살아있어야 한다. SymbolLabel 이 이름 없이 코드만 렌더링하도록
  // 회귀하거나 코드가 잘리면 이 두 assertion 중 하나가 깨진다.
  const symbolCell = page.getByRole('cell', { name: /삼성전자/ }).first();
  await expect(symbolCell).toContainText('삼성전자');
  await expect(symbolCell).toContainText('005930');

  // 6. 거래 필터 (종목 선택) — 표시는 '삼성전자 (005930)' 이지만 select 의 value 는
  // 코드 '005930' 이어야 한다. 옵션은 표시 텍스트(이름 포함)로 찾되, 선택 후에도
  // 거래가 그대로 보여야 value 가 코드로 남아 서버 필터가 매치됐다는 뜻이다 — 누가
  // value 를 표시 문자열로 바꾸면 서버가 매치하지 못해 거래 목록이 사라진다.
  await page.getByRole('combobox', { name: '종목 필터' }).click();
  await page.getByRole('option', { name: /삼성전자/ }).click();
  await expect(tradeRows.first()).toBeVisible();

  // 7. clone → 새 작업 페이지
  const originalUrl = page.url();
  await page.getByRole('button', { name: '복제', exact: true }).click();
  await expect(page).toHaveURL(/\/backtests\/bt_/);
  await expect
    .poll(() => page.url(), { timeout: 10_000 })
    .not.toBe(originalUrl);

  // 8. 데이터 검증 차트 — 심볼 클릭 → 봉차트 드로어
  await page.goto('/datasets');

  // 8-1. 카드 스위치(일봉/분봉) + 자물쇠 — 픽스처는 1m CSV 로 임포트돼 분봉 슬라이스만
  // 데이터가 있다. defaultTimeframe 이 '1m' 이라 카드는 분봉 탭으로 열려야 한다.
  const monthTab = page.getByRole('tab', { name: '분봉' });
  const dayTab = page.getByRole('tab', { name: '일봉' });
  await expect(monthTab).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('button', { name: '005930', exact: true })).toBeVisible();

  // 일봉 탭으로 전환 — 데이터 없는 슬라이스는 자물쇠 빈 상태를 보여야 한다
  await dayTab.click();
  await expect(dayTab).toHaveAttribute('aria-selected', 'true');
  await expect(
    page.getByText('일봉 데이터가 없습니다 — 동기화가 필요합니다.'),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: '005930', exact: true })).toHaveCount(0);

  // 분봉 탭으로 복귀 — 커버리지 행이 다시 보여야 한다
  await monthTab.click();
  await expect(monthTab).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('button', { name: '005930', exact: true })).toBeVisible();

  await page.getByRole('button', { name: '005930', exact: true }).click();
  await expect(page.getByText(/데이터 검증/)).toBeVisible();
  await expect(page.locator('.recharts-surface').first()).toBeVisible();
  await page.screenshot({ path: 'test-results/candle-inspect.png' });
  await page.keyboard.press('Escape');

  // 9. 로그아웃
  await page.getByRole('button', { name: '로그아웃' }).click();
  await expect(page).toHaveURL(/\/login/, { timeout: 10_000 });
});

/** 미지원 시장(US) 은 데이터셋 생성 dialog 에서 고를 수 없고, 이유가 항상 보인다 —
 *  고를 수 있게 두고 종목을 다 넣은 뒤 400 을 받게 하는 것은 명시가 아니다 (Task 13/14). */
test('unsupported market is disabled with reason shown on dataset create dialog', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('사용자 이름').fill(USERNAME);
  await page.getByLabel('비밀번호').fill(PASSWORD);
  await page.getByRole('button', { name: '로그인' }).click();
  await expect(page.getByRole('heading', { name: '대시보드' })).toBeVisible();

  await page.goto('/datasets');
  await page.getByRole('button', { name: '증권사 데이터셋' }).click();
  await page.getByLabel('시장').click();
  // Radix SelectItem 은 native disabled 속성이 아니라 aria-disabled/data-disabled 를 쓴다 —
  // role="option" 은 toBeDisabled() 가 참조하는 kAriaDisabledRoles 에 포함돼 있어 그대로 쓸 수 있다.
  await expect(page.getByRole('option', { name: /US/ })).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(page.getByText(/US 는 아직 지원하지 않습니다/)).toBeVisible();
  await expect(page.getByText(/재무 데이터 수집은 국내 종목만 지원합니다/)).toBeVisible();
});

/** `/markets` 가 영구히 실패하면 목록은 영원히 비어(로딩 중과 같은 모양) 있는다 — 그 상태를
 *  로딩 중과 구분 못 하면 시장 선택이 이유 없이 잠긴 채로 남는다. 이 태스크의 취지(고를
 *  수 없는 이유는 항상 보여야 한다)를 실패 경로에서도 지킨다. */
test('market select stays disabled and explains itself when /markets fails', async ({ page }) => {
  await page.route('**/api/v1/markets**', async (route) => {
    await route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'internal' }),
    });
  });

  await page.goto('/login');
  await page.getByLabel('사용자 이름').fill(USERNAME);
  await page.getByLabel('비밀번호').fill(PASSWORD);
  await page.getByRole('button', { name: '로그인' }).click();
  await expect(page.getByRole('heading', { name: '대시보드' })).toBeVisible();

  await page.goto('/datasets');
  await page.getByRole('button', { name: '증권사 데이터셋' }).click();
  await expect(page.getByLabel('시장')).toBeDisabled();
  await expect(page.getByText(/시장 목록을 불러오지 못했습니다/)).toBeVisible();
});

test('mobile layout has no horizontal scroll on core screens (스펙 §38)', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile', 'mobile 전용 검증');

  await page.goto('/login');
  await page.getByLabel('사용자 이름').fill(USERNAME);
  await page.getByLabel('비밀번호').fill(PASSWORD);
  await page.getByRole('button', { name: '로그인' }).click();
  await expect(page.getByRole('heading', { name: '대시보드' })).toBeVisible();

  // /backtests/new 이 목록에 있는 이유: 단계 버튼 6개를 3열 × 2행으로 깔면서 44px
  // 터치 영역을 지킨다 — 390px 에서 가장 먼저 넘칠 화면이 여기다
  for (const path of ['/', '/backtests', '/backtests/new', '/datasets', '/settings']) {
    await page.goto(path);
    await page.waitForLoadState('networkidle');
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, `${path} 가로 스크롤`).toBeLessThanOrEqual(0);
  }
});
