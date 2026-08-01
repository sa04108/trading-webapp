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

  // 7-1. 재무 조합 게이트 — 픽스처의 005930 은 재무가 없다. 「재무 필요」 전략을 고르면
  // 종목을 고르는 그 자리에서 막혀야 한다 (제출 후 422 를 받는 왕복을 없앤다).
  await page.goto('/backtests/new');
  await page.getByRole('button', { name: /밸류·퀄리티 랭킹/ }).click();
  await page.getByRole('button', { name: '2. 데이터·종목' }).click();
  await page.getByRole('button', { name: /kr-hourly-v1/ }).click();
  await expect(page.getByText(/재무 데이터가 필요하지만 선택한 종목에는 없습니다/)).toBeVisible();
  // 앞 단계로 가는 버튼이 잠기고 이유를 들고 있다. `disabled` 로 죽이지 않고
  // `aria-disabled` + title 로 두는 것이 §17 규칙이다 — 왜 못 가는지 모른 채 회색
  // 버튼만 보는 상태를 만들지 않는다. (그래서 클릭이 아니라 상태를 검증한다.)
  const periodStep = page.getByRole('button', { name: '3. 기간' });
  await expect(periodStep).toHaveAttribute('aria-disabled', 'true');
  await expect(periodStep).toHaveAttribute('title', /재무 데이터가 필요하지만/);
  await page.screenshot({ path: 'test-results/fundamentals-gate.png' });

  // 봉만 쓰는 전략으로 바꾸면 같은 종목이 통과한다 — 게이트가 전략에만 반응한다
  await page.getByRole('button', { name: '1. 전략' }).click();
  await page.getByRole('button', { name: /밸류·퀄리티 랭킹/ }).click(); // 선택 해제
  await page.getByRole('button', { name: /전고점 돌파/ }).click();
  await page.getByRole('button', { name: '2. 데이터·종목' }).click();
  await expect(
    page.getByText(/재무 데이터가 필요하지만 선택한 종목에는 없습니다/),
  ).toHaveCount(0);

  // 8. 데이터 화면 — 데이터셋/종목 두 구획 (설계 2026-07-31-symbol-as-first-class)
  await page.goto('/datasets');

  // 8-1. 데이터셋 구획은 참조 묶음을 보여준다 — 봉·재무는 종목 소관이다
  await expect(page.getByText('kr-hourly-v1')).toBeVisible();
  await expect(page.getByRole('tab', { name: '데이터셋' })).toHaveAttribute(
    'aria-selected',
    'true',
  );

  // 8-2. 종목 구획 — 슬라이스별 봉 배지와 슬라이스별 마지막 수집을 표시한다.
  // 픽스처는 1m CSV 라 분봉만 데이터가 있다 — 「봉 있음」 하나로 접으면 숨는 사실이다.
  await page.getByRole('tab', { name: '종목' }).click();
  await expect(page.getByText('삼성전자')).toBeVisible();
  await expect(page.getByText(/분봉 방금|분봉 \d+분 전/)).toBeVisible();
  await expect(page.getByText('데이터셋 1곳')).toBeVisible();

  // 8-3. 편집 모드 → 체크박스 + 하단 고정 동작 바. 하나도 안 고르면 동작은 잠긴다.
  await page.getByRole('button', { name: '편집' }).click();
  const syncButton = page.getByRole('button', { name: '동기화' });
  await expect(syncButton).toBeDisabled();
  await page.getByRole('checkbox', { name: /삼성전자 선택/ }).check();
  await expect(page.getByText('1개 선택')).toBeVisible();
  await expect(syncButton).toBeEnabled();
  await expect(page.getByRole('button', { name: '제거' })).toBeEnabled();
  // 재무는 DART 키 미설정이라 잠기고 이유가 보여야 한다 (D-027 의 원칙)
  await expect(page.getByText(/DART 인증키가 설정되지 않아/)).toBeVisible();
  await page.screenshot({ path: 'test-results/symbols-edit.png' });
  await page.getByRole('button', { name: '완료' }).click();

  // 8-4. 데이터셋 편집 화면 — 포함할 종목만 정한다. 구성은 종목 탭과 같고(같은 행·검색·
  // 페이징) 왼쪽 체크박스와 전체/페이지내 전체 선택이 더해진다. 수집 컨트롤은 없다.
  await page.getByRole('tab', { name: '데이터셋' }).click();
  await page.getByRole('button', { name: '종목 편집' }).click();
  const editDialog = page.getByRole('dialog');
  await expect(editDialog.getByText('1개 선택')).toBeVisible();
  // 수집은 종목 탭 소관이다 — 이 화면에 동기화·수집 봉·재무가 새어 들어오면 "무엇을 언제
  // 수집했나" 의 답이 두 화면으로 흩어진다
  await expect(editDialog.getByRole('button', { name: '동기화' })).toHaveCount(0);
  await expect(editDialog.getByLabel('수집 봉')).toHaveCount(0);
  await expect(editDialog.getByText('재무 수집')).toHaveCount(0);
  // 종목 탭과 같은 행이다 — 슬라이스별 봉 배지가 여기에도 있어야 한다
  await expect(editDialog.getByText('분봉').first()).toBeVisible();
  // 체크를 풀면 0종목이 되므로 저장이 잠긴다 — 서버 400 을 미리 막는 자리다
  await editDialog.getByRole('checkbox').first().uncheck();
  await expect(editDialog.getByText(/최소 1개 남아야/)).toBeVisible();
  await expect(editDialog.getByRole('button', { name: '저장' })).toBeDisabled();
  await editDialog.getByRole('checkbox').first().check();
  await expect(editDialog.getByRole('button', { name: '저장' })).toBeDisabled(); // 변경 없음
  await page.screenshot({ path: 'test-results/dataset-symbols-edit.png' });
  await editDialog.getByRole('button', { name: '취소' }).click();

  // 8-5. 데이터 검증 차트 — 편집 모드가 아닐 때 종목 이름을 눌러 드로어를 연다
  await page.getByRole('tab', { name: '종목' }).click();
  await page.getByRole('button', { name: /삼성전자/ }).click();
  await expect(page.getByText(/데이터 검증/)).toBeVisible();
  await expect(page.locator('.recharts-surface').first()).toBeVisible();
  await page.screenshot({ path: 'test-results/candle-inspect.png' });
  await page.keyboard.press('Escape');

  // 8-6. 일괄 추가 — 쉼표로 구분한 코드를 한 번에 등록한다. CSV 가져오기와 다른 것:
  // 저기는 tohlcv 봉 파일이고 여기는 심볼 목록이다.
  //
  // 아래 8-6~8-9 는 넣은 것을 다시 지워 상태를 되돌린다. 서버 하나를 mobile·desktop
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

  // 8-7. 데이터셋 편집 화면의 페이징과 두 범위의 전체 선택. 종목이 3개뿐이라 페이지당을
  // 1로 낮춰 3페이지를 만든다 — 「페이지내 전체 선택」은 페이지가 둘 이상일 때만 뜬다
  // (한 페이지면 「전체 선택」과 같은 동작이라 버튼을 둘 둘 이유가 없다).
  // 저장하지 않고 취소해 참조를 그대로 둔다.
  await page.getByRole('tab', { name: '데이터셋' }).click();
  await page.getByRole('button', { name: '종목 편집' }).click();
  const pagedDialog = page.getByRole('dialog');
  await pagedDialog.getByLabel('종목 선택 페이지당 표시 수').fill('1');
  await expect(pagedDialog.getByText('총 3종목')).toBeVisible();
  await expect(pagedDialog.getByRole('checkbox')).toHaveCount(1);

  const pagination = pagedDialog.getByRole('navigation', { name: '종목 선택 페이지 이동' });
  const currentPage = pagination.getByRole('button', { name: '현재 1페이지' });
  await expect(currentPage).toHaveAttribute('aria-current', 'page');
  await expect(currentPage).toHaveClass(/font-bold/);
  await expect(pagination.getByRole('button', { name: '첫 페이지' })).toBeDisabled();
  await expect(pagination.getByRole('button', { name: '이전 페이지' })).toBeDisabled();

  const paginationOverflow = await pagination.evaluate(
    (element) => element.scrollWidth - element.clientWidth,
  );
  expect(paginationOverflow, '종목 선택 페이지 이동 가로 스크롤').toBeLessThanOrEqual(0);

  await expect(pagedDialog.getByRole('button', { name: '페이지내 해제' })).toBeVisible();
  await pagination.getByRole('button', { name: '2페이지로 이동' }).click();
  await expect(pagination.getByRole('button', { name: '현재 2페이지' })).toBeVisible();
  await pagedDialog.getByRole('button', { name: '페이지내 전체 선택' }).click();
  await expect(pagedDialog.getByText('2개 선택')).toBeVisible();

  await pagination.getByRole('button', { name: '마지막 페이지' }).click();
  await expect(pagination.getByRole('button', { name: '현재 3페이지' })).toBeVisible();
  await expect(pagination.getByRole('button', { name: '다음 페이지' })).toBeDisabled();
  await expect(pagination.getByRole('button', { name: '마지막 페이지' })).toBeDisabled();

  await pagedDialog.getByRole('button', { name: '전체 선택', exact: true }).click();
  await expect(pagedDialog.getByText('3개 선택')).toBeVisible();
  await page.screenshot({ path: 'test-results/dataset-edit-paged.png' });
  await pagedDialog.getByRole('button', { name: '취소' }).click();

  // 8-8. 검색 — 이름과 코드 두 축을 한 입력으로 맞힌다. 탭을 오가면 패널이 unmount 돼
  // 검색이 초기화되므로, 검색을 쓰는 8-9 바로 앞에서 건다.
  await page.getByRole('tab', { name: '종목' }).click();
  const symbolSearch = page.getByLabel('종목 검색');
  await symbolSearch.fill('삼성전');
  await expect(page.getByText('삼성전자')).toBeVisible();
  await expect(page.getByText('900001')).toHaveCount(0);
  await symbolSearch.fill('9000');
  await expect(page.getByText('900001')).toBeVisible();
  await expect(page.getByText('삼성전자')).toHaveCount(0);
  await expect(page.getByText('2/3종목')).toBeVisible();
  await page.screenshot({ path: 'test-results/symbols-search.png' });

  // 8-9. 검색 결과 전체 선택 → 제거. 전체 선택 대상은 **검색 결과** 이고, 그 사실이
  // 라벨에 적혀 있어야 한다 — 「전체 선택」이 3종목을 담을 것처럼 보이면 거짓말이다.
  await page.getByRole('button', { name: '편집' }).click();
  await page.getByRole('button', { name: '검색 결과 2종목 선택' }).click();
  await expect(page.getByText('2개 선택')).toBeVisible();
  await page.getByRole('button', { name: '제거' }).click();
  const removeDialog = page.getByRole('dialog');
  await expect(removeDialog.getByText(/참조하는 데이터셋이 없습니다/)).toBeVisible();
  await removeDialog.getByRole('button', { name: '제거' }).click();
  await expect(page.getByText('900001')).toHaveCount(0);
  await page.getByRole('button', { name: '완료' }).click();

  // 8-10. 데이터셋 이름 변경 — PATCH 로 가야 한다. 메서드가 안 맞아 온 404 는 화면에서
  // "요청한 리소스를 찾을 수 없습니다" 로 읽혀 원인이 드러나지 않았다 (D-035).
  // 원래 이름으로 되돌려 두 번째 프로젝트 실행이 같은 상태에서 시작하게 한다.
  await page.getByRole('tab', { name: '데이터셋' }).click();
  await page.getByRole('button', { name: '이름 수정' }).click();
  await page.getByRole('textbox', { name: '데이터셋 이름' }).fill('kr-hourly-renamed');
  await page.getByRole('button', { name: '이름 저장' }).click();
  await expect(page.getByText('kr-hourly-renamed')).toBeVisible();
  await expect(page.getByText(/찾을 수 없습니다/)).toHaveCount(0);
  await page.getByRole('button', { name: '이름 수정' }).click();
  await page.getByRole('textbox', { name: '데이터셋 이름' }).fill('kr-hourly-v1');
  await page.getByRole('button', { name: '이름 저장' }).click();
  await expect(page.getByText('kr-hourly-v1')).toBeVisible();

  // 9. 로그아웃
  await page.getByRole('button', { name: '로그아웃' }).click();
  await expect(page).toHaveURL(/\/login/, { timeout: 10_000 });
});

/**
 * 위저드는 데이터셋 **자체만** 보여 준다 (D-038). 종목을 고치는 자리는 데이터 화면
 * 하나이고, 「편집」이 거기로 데려간다 — 참조를 바꾸는 화면이 둘이면 무엇이 최신인지
 * 알 수 없다. 라우팅·딥링크는 타입도 단위 테스트도 볼 수 없는 층이라 e2e 로 겨눈다.
 */
test('wizard hands symbol editing over to the dataset edit tab', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('사용자 이름').fill(USERNAME);
  await page.getByLabel('비밀번호').fill(PASSWORD);
  await page.getByRole('button', { name: '로그인' }).click();
  await expect(page.getByRole('heading', { name: '대시보드' })).toBeVisible();

  await page.goto('/backtests/new');
  await page.getByRole('button', { name: /전고점 돌파/ }).click();
  await page.getByRole('button', { name: '다음' }).click();
  await page.getByRole('button', { name: /kr-hourly-v1/ }).click();

  // 종목을 하나씩 켜고 끄는 카드는 없어졌다
  await expect(page.getByText('종목 선택')).toHaveCount(0);
  await expect(page.getByRole('checkbox')).toHaveCount(0);

  // 「편집」은 데이터셋 편집 탭으로 보내고, 그 데이터셋의 「종목 편집」을 열어 둔다 —
  // 탭만 열어 주고 다이얼로그를 다시 찾게 하면 왕복이 그대로 남는다
  await page.getByRole('button', { name: '편집' }).click();
  await expect(page).toHaveURL(/\/datasets\?tab=datasets/);
  const editDialog = page.getByRole('dialog');
  await expect(editDialog.getByText(/포함할 종목만 정합니다/)).toBeVisible();
  await editDialog.getByRole('button', { name: '취소' }).click();

  // 딥링크는 한 번 쓰고 지운다 — 새로고침이 닫은 다이얼로그를 되열면 안 된다
  await expect(page).not.toHaveURL(/edit=/);
  await page.reload();
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

/**
 * 정렬은 종목 탭과 데이터셋 편집이 **같은 컨트롤**을 쓴다 (D-038). e2e 환경엔 증권사
 * 자격 증명이 없어 지표가 비는데, 그때 규모 정렬을 눌러도 순서가 그대로면 사용자는
 * 정렬이 고장 났다고 읽는다 — 잠그고 이유를 적는 쪽을 검증한다.
 */
test('symbol sort is shared by both screens and explains itself without quotes', async ({
  page,
}) => {
  await page.goto('/login');
  await page.getByLabel('사용자 이름').fill(USERNAME);
  await page.getByLabel('비밀번호').fill(PASSWORD);
  await page.getByRole('button', { name: '로그인' }).click();
  await expect(page.getByRole('heading', { name: '대시보드' })).toBeVisible();

  await page.goto('/datasets?tab=symbols');
  const sort = page.getByRole('combobox', { name: '종목 정렬' });
  await expect(sort).toHaveText('가나다순');
  await expect(page.getByText(/증권사 시세를 받지 못해 규모 정렬을 쓸 수 없습니다/)).toBeVisible();
  await sort.click();
  await expect(page.getByRole('option', { name: '시가총액순' })).toBeDisabled();
  await expect(page.getByRole('option', { name: '거래대금순' })).toBeDisabled();
  await expect(page.getByRole('option', { name: '가나다순' })).toBeEnabled();
  await page.keyboard.press('Escape');

  // 데이터셋의 「종목 편집」에도 같은 컨트롤이 있다 — 두 화면이 갈라지면 한쪽만 정렬된다
  await page.getByRole('tab', { name: '데이터셋' }).click();
  await page.getByRole('button', { name: '종목 편집' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('combobox', { name: '포함할 종목 정렬' })).toBeVisible();
  await dialog.getByRole('button', { name: '취소' }).click();
});

/** 미지원 시장(US) 은 종목 추가 dialog 에서 고를 수 없고, 이유가 항상 보인다 —
 *  고를 수 있게 두고 코드를 넣은 뒤 400 을 받게 하는 것은 명시가 아니다 (D-027). */
test('unsupported market is disabled with reason shown on symbol add dialog', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('사용자 이름').fill(USERNAME);
  await page.getByLabel('비밀번호').fill(PASSWORD);
  await page.getByRole('button', { name: '로그인' }).click();
  await expect(page.getByRole('heading', { name: '대시보드' })).toBeVisible();

  await page.goto('/datasets?tab=symbols');
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

  await page.goto('/datasets?tab=symbols');
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
  // '/datasets?tab=symbols' 를 넣는 이유: 종목 행이 이름·코드·배지 3개·수집 시각을
  // 한 줄에 담고 하단 고정 바에 버튼 4개가 붙는다 — 390px 에서 가장 먼저 넘칠 화면이다
  for (const path of [
    '/',
    '/backtests',
    '/backtests/new',
    '/datasets',
    '/datasets?tab=symbols',
    '/settings',
  ]) {
    await page.goto(path);
    await page.waitForLoadState('networkidle');
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, `${path} 가로 스크롤`).toBeLessThanOrEqual(0);
  }
});
