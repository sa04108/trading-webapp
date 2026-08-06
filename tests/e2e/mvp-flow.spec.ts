import { expect, test, type Locator, type Page } from '@playwright/test';

const USERNAME = 'e2e-operator';
const PASSWORD = 'correct-horse-battery-staple';

/**
 * 위저드가 실제로 실행하는 기간 — 005930 의 캔들이 이 구간에 있다
 * (scripts/e2e-server.ts buildTrendingHourlyCsv). 종목 마스터 e2e(다른 스펙,
 * tests/e2e/symbol-master.spec.ts)가 쓰는 SEED_DATE(2024-12-30)와 겹치지 않는다 —
 * 두 스펙이 같은 서버를 공유해도(playwright.config workers:1) coverage 판정에서
 * 서로 간섭하지 않는다.
 */
const PERIOD = { from: '2026-01-05', to: '2026-03-31' };
/** KOSPI 상위 1종목만 — 900010(상장폐지예정1호)은 시가총액이 더 낮아 순위 밖으로 빠진다 */
const TOP_N = 1;

/**
 * 위저드 유니버스 단계 — [미리보기] 를 누르고, 리밸런스 날짜가 아직 커버되지 않았다는
 * 경고가 뜨면 [N개 날짜 모두 동기화] 로 한꺼번에 해소한다.
 *
 * 이미 같은 기간을 동기화해 둔 뒤(예: 이 파일의 재무 게이트 시나리오가 앞선 시나리오와
 * 같은 PERIOD 를 쓴다) 다시 부르면 경고 자체가 뜨지 않아 반복문이 0회 돌고 끝난다 —
 * 그래서 두 시나리오가 이 함수를 그대로 공유해도 안전하다.
 */
async function previewAndSyncUniverse(page: Page): Promise<void> {
  const initialPreview = page.waitForResponse(
    (resp) =>
      resp.url().includes('/backtests/universe-preview') && resp.request().method() === 'POST',
  );
  await page.getByRole('button', { name: '미리보기' }).click();
  // 클릭 직후 count() 는 자동 대기하지 않는다 — 응답이 아직 안 온 시점의 DOM(동기화
  // 버튼 0개)을 그대로 읽으면 아래 while 이 실제로는 우다 목록이 곧 뜨는데도 0회로
  // 끝나 버린다. 첫 미리보기 응답을 기다린 뒤에야 목록을 센다.
  await initialPreview;

  // 미커버 날짜는 버튼 하나로 한꺼번에 동기화한다 — 날짜별 버튼은 2년치면 24번을
  // 누르게 해서 없앴다. 한 번 눌러도 남는 경우(소급 상한 초과 등)를 대비해 반복한다.
  let bulkSync = page.getByRole('button', { name: /개 날짜 모두 동기화$/ });
  while ((await bulkSync.count()) > 0) {
    // 모든 날짜를 순차 동기화한 뒤 컴포넌트가 같은 params 로 미리보기를 자동으로 다시
    // 던진다(universe-rule-step.tsx `syncAllUncovered`) — 그 응답을 기다려야 갱신된
    // 목록에서 다음 반복의 count() 를 읽는다.
    const previewRefreshed = page.waitForResponse(
      (resp) =>
        resp.url().includes('/backtests/universe-preview') && resp.request().method() === 'POST',
    );
    await bulkSync.click();
    await previewRefreshed;
    bulkSync = page.getByRole('button', { name: /개 날짜 모두 동기화$/ });
  }
}

/**
 * `locator.fill()` 대신 클릭 + 실제 키 입력을 쓴다 — 종목 목록 화면은 `/symbols` 를
 * 5초마다 폴링하는데(symbols-panel.tsx `refetchInterval`), 그 폴링이 `fill()` 의
 * 원자적 값 설정과 겹치는 순간에 실행되면(데스크톱 프로젝트에서 재현됨, 모바일은
 * 타이밍이 달라 재현되지 않았다) 입력값이 그대로 사라져 검색이 전혀 걸리지 않는
 * 채로 남는다. 실제 키 입력은 한 글자씩 이벤트를 발생시켜 이 경합에 영향받지 않는다.
 */
async function typeInto(locator: Locator, text: string): Promise<void> {
  await locator.click();
  await locator.press('Control+A');
  await locator.press('Backspace');
  await locator.pressSequentially(text);
}

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

  // 2. 백테스트 생성 (6단계 위저드: 전략 → 기간 → 유니버스 → 자본·비용 → 검토 → 실행,
  // 스펙 2026-08-05 — 데이터셋·스냅샷 선택이 유니버스 규칙으로 바뀌었다)
  await page.goto('/backtests/new');
  await page.getByRole('button', { name: /전고점 돌파/ }).click();
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
  await page.getByRole('button', { name: '다음' }).click(); // 전략 → 기간

  // 2-1. 기간 — 유니버스 미리보기가 리밸런스 날짜 계산에 이 값을 쓰므로 유니버스보다 앞이다
  await page.getByLabel('시작일').fill(PERIOD.from);
  await page.getByLabel('종료일').fill(PERIOD.to);
  await page.getByRole('button', { name: '다음' }).click(); // 기간 → 유니버스

  // 2-2. 유니버스 규칙 — 위저드는 이제 종목을 하나씩 고르지 않는다. 체크박스가
  // 하나도 없다는 사실 자체가 그 회귀를 잡는다.
  await expect(page.getByRole('button', { name: '3. 유니버스' })).toHaveAttribute(
    'aria-current',
    'step',
  );
  await expect(page.getByRole('checkbox')).toHaveCount(0);
  await expect(page.getByLabel('시장')).toContainText('KOSPI');
  await page.getByLabel('상위 N (시가총액)').fill(String(TOP_N));
  await previewAndSyncUniverse(page);
  await expect(page.getByText('종목 1개 · 리밸런스 3회')).toBeVisible();
  // 005930 은 분봉만 있어 1시간봉/분봉 중에서 고른다 — 기본값(1시간봉)을 그대로 쓴다
  await expect(page.getByText('1시간봉')).toBeVisible();

  await page.getByRole('button', { name: '다음' }).click(); // 유니버스 → 자본·비용
  await expect(page.getByRole('button', { name: '4. 자본·비용' })).toHaveAttribute(
    'aria-current',
    'step',
  );
  await page.getByRole('button', { name: '다음' }).click(); // 자본·비용 기본값 → 검토
  await expect(page.getByRole('button', { name: '5. 검토' })).toHaveAttribute(
    'aria-current',
    'step',
  );
  // 검토 줄은 데이터셋이 아니라 유니버스 규칙을 적는다(universe-summary.ts) — 실제
  // 리밸런스 결과 종목 수는 여기 적지 않는다(다시 미리보기해야 아는 값이라서다)
  await expect(page.getByText('KOSPI 시가총액 상위 1').first()).toBeVisible();

  // 2-3. 상단 단계 버튼 — 뒤로는 자유롭게, 앞으로는 검토까지만
  await page.getByRole('button', { name: '3. 유니버스' }).click();
  await expect(page.getByRole('button', { name: '3. 유니버스' })).toHaveAttribute(
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
  await expect(page.getByRole('button', { name: '3. 유니버스' })).toHaveAttribute(
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
  // 재현 정보의 긴 값은 잘리지 않고 접힌다 — 해시가 「a1b2…」로 잘리면 다른 실행과 같은지
  // 비교할 수 없다. 390px 에서 가로 스크롤이 생기지 않는 것은 아래 mobile 전용 테스트가 본다.
  const feeModelValue = page
    .locator('[data-slot="card"]')
    .filter({ hasText: '재현 정보' })
    .getByText(/kr-equity-default@/);
  await expect(feeModelValue).toHaveCSS('overflow-wrap', 'anywhere');
  await expect(feeModelValue).not.toHaveCSS('text-overflow', 'ellipsis');
  // 5-1. 설명 줄은 종목을 나열하지 않고 유니버스 규칙을 적는다(스펙 2026-08-05) —
  // 데이터셋·스냅샷 개념 자체가 제거됐다. 여기에 id(ds_…) 가 뜨면 옛 경로로 되돌아간 것이다.
  await expect(page.getByText('KOSPI 시가총액 상위 1')).toBeVisible();
  // 별도 "미청산 포지션" 카드는 제거되고 거래 내역 테이블에 통합됐다
  await expect(page.getByText('미청산 포지션', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('row').filter({ hasText: '미청산' }).first()).toBeVisible();
  const tradeRows = page.getByRole('row').filter({ hasText: '005930' });
  await expect(tradeRows.first()).toBeVisible();

  const tradesPagination = page.getByRole('navigation', {
    name: '거래 내역 페이지 이동',
  });
  await expect(tradesPagination.getByRole('button', { name: '현재 1페이지' })).toBeVisible();
  await tradesPagination.getByRole('button', { name: '마지막 페이지' }).click();
  await expect(tradesPagination.getByRole('button', { name: '현재 2페이지' })).toBeVisible();
  await tradesPagination.getByRole('button', { name: '첫 페이지' }).click();
  await expect(tradesPagination.getByRole('button', { name: '현재 1페이지' })).toBeVisible();

  await expect(page.getByRole('navigation', { name: '경고 목록 페이지 이동' })).toHaveCount(0);
  await page.getByLabel('경고 목록 페이지당 표시 수').fill('1');
  const warningsPagination = page.getByRole('navigation', {
    name: '경고 목록 페이지 이동',
  });
  await expect(warningsPagination.getByRole('button', { name: '현재 1페이지' })).toBeVisible();
  await warningsPagination.getByRole('button', { name: '2페이지로 이동' }).click();
  await expect(warningsPagination.getByRole('button', { name: '현재 2페이지' })).toBeVisible();

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

  // 6-1. 거래 내역 정렬 — 정렬은 서버가 한다. 머리글을 눌러 거래가 **그대로 보이는지**가
  // 핵심이다: 화면과 라우트가 정렬 축 문자열을 따로 들면 조회가 400 이 되고 목록이
  // 사라지는데, 그 어긋남은 타입·단위 테스트가 볼 수 없는 층이다.
  const pnlHeader = page.getByRole('columnheader').filter({ hasText: '순손익' });
  await expect(pnlHeader).toHaveAttribute('aria-sort', 'none');
  await page.getByRole('button', { name: '순손익' }).click();
  // 크기 축은 큰 값부터 — 처음 누를 때 내림차순이다
  await expect(pnlHeader).toHaveAttribute('aria-sort', 'descending');
  await expect(tradeRows.first()).toBeVisible();
  await expect(page.getByText('순손익 높은 순으로 정렬했습니다.')).toBeVisible();
  // 같은 축을 다시 누르면 방향만 뒤집는다
  await page.getByRole('button', { name: '순손익' }).click();
  await expect(pnlHeader).toHaveAttribute('aria-sort', 'ascending');
  await expect(tradeRows.first()).toBeVisible();
  // 다른 축으로 옮기면 이전 축의 방향을 물려받지 않고, 이전 축의 표시가 풀린다
  await page.getByRole('button', { name: '진입' }).click();
  await expect(pnlHeader).toHaveAttribute('aria-sort', 'none');
  await expect(
    page.getByRole('columnheader').filter({ hasText: '진입' }),
  ).toHaveAttribute('aria-sort', 'ascending');
  await expect(tradeRows.first()).toBeVisible();

  // 7. clone → 새 작업 페이지
  const originalUrl = page.url();
  await page.getByRole('button', { name: '복제', exact: true }).click();
  await expect(page).toHaveURL(/\/backtests\/bt_/);
  await expect
    .poll(() => page.url(), { timeout: 10_000 })
    .not.toBe(originalUrl);

  // 7-1. 재무 조합 게이트 — 위저드는 종목을 직접 고르지 않으므로, 이 조합 판정은
  // '유니버스' 단계에서 미리보기가 유니버스 종목을 확정한 뒤에만 이뤄진다
  // (wizard-steps.ts `fundamentalsBlocker`). 픽스처의 005930 은 재무가 없다.
  await page.goto('/backtests/new');
  await page.getByRole('button', { name: /밸류·퀄리티 랭킹/ }).click();
  await page.getByRole('button', { name: '다음' }).click(); // 전략 → 기간
  await page.getByLabel('시작일').fill(PERIOD.from);
  await page.getByLabel('종료일').fill(PERIOD.to);
  await page.getByRole('button', { name: '다음' }).click(); // 기간 → 유니버스
  await page.getByLabel('상위 N (시가총액)').fill(String(TOP_N));
  // 이 전략은 리밸런스 주기 기본값이 3개월이라 이 기간엔 리밸런스 날짜가 하나뿐이고
  // (PERIOD.from), 위 시나리오가 이미 그 날짜를 동기화해 둬서 곧바로 통과한다.
  await previewAndSyncUniverse(page);
  await expect(
    page.getByText(/재무 데이터가 필요하지만 이 유니버스에는 재무 있는 종목이 없습니다/),
  ).toBeVisible();
  // 앞 단계로 가는 버튼이 잠기고 이유를 들고 있다. `disabled` 로 죽이지 않고
  // `aria-disabled` + title 로 두는 것이 §17 규칙이다 — 왜 못 가는지 모른 채 회색
  // 버튼만 보는 상태를 만들지 않는다. (그래서 클릭이 아니라 상태를 검증한다.)
  const capitalStep = page.getByRole('button', { name: '4. 자본·비용' });
  await expect(capitalStep).toHaveAttribute('aria-disabled', 'true');
  await expect(capitalStep).toHaveAttribute('title', /재무 데이터가 필요하지만/);
  await page.screenshot({ path: 'test-results/fundamentals-gate.png' });

  // 봉만 쓰는 전략으로 바꾸면 같은 유니버스가 통과한다 — 게이트가 전략에만 반응한다
  await page.getByRole('button', { name: '1. 전략' }).click();
  await page.getByRole('button', { name: /밸류·퀄리티 랭킹/ }).click(); // 선택 해제
  await page.getByRole('button', { name: /전고점 돌파/ }).click();
  await page.getByRole('button', { name: '3. 유니버스' }).click();
  // 전략을 바꾸면 리밸런스 주기(전략 파라미터 기반)도 바뀌어 이전 미리보기가
  // 무효화된다 — 다시 미리보기해야 한다(이미 동기화해 둔 날짜라 곧바로 통과한다).
  await previewAndSyncUniverse(page);
  await expect(
    page.getByText(/재무 데이터가 필요하지만 이 유니버스에는 재무 있는 종목이 없습니다/),
  ).toHaveCount(0);

  // 8. 데이터 화면 — 가격 데이터 탭 (종목 마스터 탭은 tests/e2e/symbol-master.spec.ts 가 다룬다)
  await page.goto('/datasets?tab=prices');
  await expect(page.getByRole('tab', { name: '가격 데이터' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  // 픽스처는 1m CSV 라 분봉만 데이터가 있다 — 「봉 있음」 하나로 접으면 숨는 사실이다.
  await expect(page.getByText('삼성전자')).toBeVisible();
  await expect(page.getByText(/분봉 방금|분봉 \d+분 전/)).toBeVisible();

  // 8-1. 편집 모드 → 체크박스 + 하단 고정 동작 바. 하나도 안 고르면 동작은 잠긴다.
  await page.getByRole('button', { name: '편집' }).click();
  const syncButton = page.getByRole('button', { name: '동기화' });
  await expect(syncButton).toBeDisabled();
  await page.getByRole('checkbox', { name: /삼성전자 선택/ }).check();
  await expect(page.getByText('1개 선택')).toBeVisible();
  await expect(syncButton).toBeEnabled();
  await expect(page.getByRole('button', { name: '제거' })).toBeEnabled();
  await syncButton.click();
  const symbolSyncDialog = page.getByRole('dialog');
  await expect(symbolSyncDialog.getByRole('heading', { name: '데이터 동기화' })).toBeVisible();
  await expect(symbolSyncDialog.getByText('대상 1종목')).toBeVisible();
  // 재무는 DART 키 미설정이라 잠기고 이유가 보인다 (D-027 의 원칙)
  await expect(symbolSyncDialog.getByText(/DART 인증키가 설정되지 않아/)).toBeVisible();
  await expect(symbolSyncDialog.getByLabel('재무 데이터 함께 동기화')).toBeDisabled();
  await page.screenshot({ path: 'test-results/symbols-edit.png' });
  await symbolSyncDialog.getByRole('button', { name: '취소' }).click();
  await page.getByRole('button', { name: '완료' }).click();

  // 8-2. 데이터 검증 차트 — 편집 모드가 아닐 때 종목 이름을 눌러 드로어를 연다
  await page.getByRole('button', { name: /삼성전자/ }).click();
  await expect(page.getByText(/데이터 검증/)).toBeVisible();
  await expect(page.locator('.recharts-surface').first()).toBeVisible();
  await page.screenshot({ path: 'test-results/candle-inspect.png' });
  await page.keyboard.press('Escape');

  // 8-3. 일괄 추가 — 쉼표로 구분한 코드를 한 번에 등록한다. CSV 가져오기와 다른 것:
  // 저기는 tohlcv 봉 파일이고 여기는 심볼 목록이다.
  //
  // 아래 8-3~8-4 는 넣은 것을 다시 지워 상태를 되돌린다. 서버 하나를 mobile·desktop
  // 두 프로젝트가 공유하므로(playwright.config workers:1) 남기면 두 번째 실행이 이미
  // 등록된 종목을 만나 실패한다.
  await page.getByRole('button', { name: '추가' }).click();
  const addDialog = page.getByRole('dialog');
  await addDialog.getByLabel('종목 코드').fill('900001, 900002, 900001');
  // 중복 입력은 걷어내고 개수로 알린다 — 두 번 붙였다고 실패시킬 이유가 없다
  await expect(addDialog.getByText(/2종목 추가 · 중복 입력 1건/)).toBeVisible();
  await page.screenshot({ path: 'test-results/symbols-bulk-add.png' });
  await addDialog.getByRole('button', { name: '2종목 추가' }).click();
  await expect(page.getByText('900001')).toBeVisible();
  await expect(page.getByText('900002')).toBeVisible();

  // 검색 — 이름과 코드 두 축을 한 입력으로 맞힌다
  const symbolSearch = page.getByLabel('종목 검색');
  await typeInto(symbolSearch, '삼성전');
  await expect(page.getByText('삼성전자')).toBeVisible();
  await expect(page.getByText('900001')).toHaveCount(0);
  await typeInto(symbolSearch, '9000');
  await expect(page.getByText('900001')).toBeVisible();
  await expect(page.getByText('삼성전자')).toHaveCount(0);
  await expect(page.getByText('2/3종목')).toBeVisible();
  await page.screenshot({ path: 'test-results/symbols-search.png' });

  // 8-4. 검색 결과 전체 선택 → 제거. 전체 선택 대상은 **검색 결과** 이고, 그 사실이
  // 라벨에 적혀 있어야 한다 — 「전체 선택」이 3종목을 담을 것처럼 보이면 거짓말이다.
  await page.getByRole('button', { name: '편집' }).click();
  await page.getByRole('button', { name: '검색 결과 2종목 선택' }).click();
  await expect(page.getByText('2개 선택')).toBeVisible();
  await page.getByRole('button', { name: '제거' }).click();
  const removeDialog = page.getByRole('dialog');
  // removal-impact 조회가 사라졌다(스펙 2026-08-05, 데이터셋 개념과 함께 제거) —
  // 비동기 조회 없이 확인 문구가 곧바로 뜬다.
  await expect(removeDialog.getByText('봉과 재무 데이터가 함께 지워집니다')).toBeVisible();
  await removeDialog.getByRole('button', { name: '제거' }).click();
  await expect(page.getByText('900001')).toHaveCount(0);
  await page.getByRole('button', { name: '완료' }).click();

  // 9. 로그아웃
  await page.getByRole('button', { name: '로그아웃' }).click();
  await expect(page).toHaveURL(/\/login/, { timeout: 10_000 });
});

/**
 * 리밸런스 적용 거래일 표기(Task 4, 2026-08-06 스펙) — 위저드 유니버스 단계가
 * 휴장 리밸런스 날짜를 어떻게 보여 주는지 확인한다. 가짜 KRX 서버는 정확히
 * 2025-01-01·2018-01-01 두 날짜만 휴장으로 낸다(scripts/e2e-server.ts
 * `HOLIDAY_BAS_DATES`) — "1월 1일이면 무조건 휴장" 같은 패턴이 아니라 이 스위트가
 * 쓰는 날짜만 정확히 지정한 고정 집합이다. 패턴으로 두면 다른 스펙
 * (symbol-master.spec.ts)이 쓰는 "오늘 기준 상대 날짜"가 매년 1월 2일·1월 11일에
 * 이 스위트를 돌릴 때 우연히 1월 1일과 겹쳐, 그 스펙의 "가짜 KRX 는 어느 날짜를
 * 물어도 같은 시세를 낸다"는 전제를 깨뜨린다(리뷰에서 지적된 회귀) — 고정 집합은
 * 상대 날짜와 영원히 안 겹친다. mobile·desktop 두 프로젝트가 같은 서버 상태를
 * 공유해도(playwright.config workers:1) 서로 다른 연도를 쓰면 커버리지가 부딪히지
 * 않는다.
 *
 * 두 연도 모두 "오늘"보다 한참 과거를 쓴다 — SymbolMasterPanel 은 기본 화면(날짜
 * 쿼리 없음)에서 coverage 의 가장 늦은 날짜를 보여주되 "오늘"을 넘지 않게 자른다
 * (symbol-master-panel.tsx `rangeEnd`/committedDate 클램프). 미래 연도를 동기화해
 * 두면 그 클램프에 걸려 기본 화면이 "오늘"로 밀리는데, 오늘은 어느 스펙도 동기화해
 * 두지 않아 다른 스펙(symbol-master.spec.ts)의 "기본 화면은 커버된 날짜를 보여준다"
 * 전제를 깨뜨린다 — 실제로 그렇게 재현됐던 회귀다.
 */
function holidayPeriodFor(projectName: string): { from: string; to: string } {
  // scripts/e2e-server.ts `HOLIDAY_BAS_DATES` 와 정확히 일치해야 한다 — 여기서
  // 연도를 바꾸면 그쪽 고정 집합도 같이 바꿔야 휴장이 재현된다.
  const year = projectName === 'mobile' ? 2025 : 2018;
  return { from: `${year}-01-01`, to: `${year}-02-01` };
}

test('rebalance schedule shows the applied trading day when a rebalance date falls on a market holiday', async ({
  page,
}, testInfo) => {
  const period = holidayPeriodFor(testInfo.project.name);
  // 1월 1일 리밸런스가 소급되면 닿는 직전 거래일 — 12월 31일은 '0101'로 끝나지 않아
  // 가짜 KRX 서버가 정상 거래일로 응답한다.
  const previousTradingDate = `${Number(period.from.slice(0, 4)) - 1}-12-31`;

  await page.goto('/login');
  await page.getByLabel('사용자 이름').fill(USERNAME);
  await page.getByLabel('비밀번호').fill(PASSWORD);
  await page.getByRole('button', { name: '로그인' }).click();
  await expect(page.getByRole('heading', { name: '대시보드' })).toBeVisible();

  await page.goto('/backtests/new');
  await page.getByRole('button', { name: /전고점 돌파/ }).click(); // 리밸런스 주기 기본값 1개월
  await page.getByLabel('돌파 기준 봉 수', { exact: true }).fill('10');
  await page.getByLabel('변동성(ATR) 계산 기간', { exact: true }).fill('5');
  await page.getByRole('button', { name: '다음' }).click(); // 전략 → 기간

  await page.getByLabel('시작일').fill(period.from);
  await page.getByLabel('종료일').fill(period.to);
  await page.getByRole('button', { name: '다음' }).click(); // 기간 → 유니버스

  await page.getByLabel('상위 N (시가총액)').fill(String(TOP_N));

  const firstPreview = page.waitForResponse(
    (resp) =>
      resp.url().includes('/backtests/universe-preview') && resp.request().method() === 'POST',
  );
  await page.getByRole('button', { name: '미리보기' }).click();
  await firstPreview;

  // 두 리밸런스 날짜(1월 1일 휴장, 2월 1일 정상 거래일) 모두 아직 커버되지 않아
  // 버튼 하나가 둘을 한꺼번에 맡는다.
  await expect(page.getByRole('button', { name: '2개 날짜 모두 동기화' })).toBeVisible();
  // 미커버 날짜 목록은 한 줄로 모아 보여준다 — 어느 날짜가 빠졌는지는 여전히 읽힌다.
  await expect(
    page.getByText(`${period.from}, ${period.to}`, { exact: true }),
  ).toBeVisible();

  let bulkSync = page.getByRole('button', { name: /개 날짜 모두 동기화$/ });
  while ((await bulkSync.count()) > 0) {
    const previewRefreshed = page.waitForResponse(
      (resp) =>
        resp.url().includes('/backtests/universe-preview') && resp.request().method() === 'POST',
    );
    await bulkSync.click();
    await previewRefreshed;
    bulkSync = page.getByRole('button', { name: /개 날짜 모두 동기화$/ });
  }

  // 휴장 리밸런스 날짜(1월 1일)는 소급된 직전 거래일이 덧붙어 보이고, 정상 거래일
  // (2월 1일)은 요청 날짜와 같아 아무것도 덧붙지 않는다 — 표기 규약(잡음 없음)이다.
  await expect(
    page.getByRole('cell', { name: `${period.from} (적용 ${previousTradingDate})`, exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('cell', { name: period.to, exact: true })).toBeVisible();
});

/**
 * 정렬은 종목 탭(가격 데이터) 하나만 남았다(D-038 이 전제하던 데이터셋의 「종목
 * 편집」공유 대상 자체가 제거됐다). e2e 환경엔 증권사 자격 증명이 없어 지표가
 * 비는데, 그때 규모 정렬을 눌러도 순서가 그대로면 사용자는 정렬이 고장 났다고
 * 읽는다 — 잠그고 이유를 적는 쪽을 검증한다.
 */
test('symbol sort explains itself without quotes when broker metrics are unavailable', async ({
  page,
}) => {
  await page.goto('/login');
  await page.getByLabel('사용자 이름').fill(USERNAME);
  await page.getByLabel('비밀번호').fill(PASSWORD);
  await page.getByRole('button', { name: '로그인' }).click();
  await expect(page.getByRole('heading', { name: '대시보드' })).toBeVisible();

  await page.goto('/datasets?tab=prices');
  const sort = page.getByRole('combobox', { name: '종목 정렬' });
  await expect(sort).toHaveText('가나다순');
  await expect(page.getByText(/증권사 시세를 받지 못해 규모 정렬을 쓸 수 없습니다/)).toBeVisible();
  await sort.click();
  await expect(page.getByRole('option', { name: '시가총액순' })).toBeDisabled();
  await expect(page.getByRole('option', { name: '거래대금순' })).toBeDisabled();
  await expect(page.getByRole('option', { name: '가나다순' })).toBeEnabled();
  await page.keyboard.press('Escape');
});

/** 미지원 시장(US) 은 종목 추가 dialog 에서 고를 수 없고, 이유가 항상 보인다 —
 *  고를 수 있게 두고 코드를 넣은 뒤 400 을 받게 하는 것은 명시가 아니다 (D-027). */
test('unsupported market is disabled with reason shown on symbol add dialog', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('사용자 이름').fill(USERNAME);
  await page.getByLabel('비밀번호').fill(PASSWORD);
  await page.getByRole('button', { name: '로그인' }).click();
  await expect(page.getByRole('heading', { name: '대시보드' })).toBeVisible();

  await page.goto('/datasets?tab=prices');
  await page.getByRole('button', { name: '추가' }).click();
  await page.getByLabel('시장').click();
  // Radix SelectItem 은 native disabled 속성이 아니라 aria-disabled/data-disabled 를 쓴다 —
  // role="option" 은 toBeDisabled() 가 참조하는 kAriaDisabledRoles 에 포함돼 있어 그대로 쓸 수 있다.
  await expect(page.getByRole('option', { name: /US/ })).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(page.getByText(/US 는 아직 지원하지 않습니다/)).toBeVisible();
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

  await page.goto('/datasets?tab=prices');
  await page.getByRole('button', { name: '추가' }).click();
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
  // '/datasets' 를 넣는 이유: 종목 마스터의 타임라인 슬라이더가 390px 에서 가장
  // 먼저 넘칠 화면이다. '/datasets?tab=prices' 는 종목 행이 이름·코드·배지 3개·
  // 수집 시각을 한 줄에 담고 하단 고정 바에 버튼 4개가 붙는다.
  for (const path of ['/', '/backtests', '/backtests/new', '/datasets', '/datasets?tab=prices', '/settings']) {
    await page.goto(path);
    await page.waitForLoadState('networkidle');
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, `${path} 가로 스크롤`).toBeLessThanOrEqual(0);
  }
});
