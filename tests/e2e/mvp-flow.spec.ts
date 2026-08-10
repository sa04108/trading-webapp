import { expect, test, type Page } from '@playwright/test';
// 자격 증명은 한 곳에서만 — 시드 운영자가 바뀔 때 일부 스펙만 고쳐지는 일을 막는다
import { PASSWORD, USERNAME } from './login';

/**
 * 위저드가 실제로 실행하는 기간 — 가짜 KRX 서버가 005930 에 내는 추세
 * (scripts/e2e-server.ts `samsungCloseFor`)는 꾸준히 오르며 6일 주기로
 * 오르내림도 겪는다. 이 정도 길이의 기간이면 그 등락을 여러 번 지나 실제
 * 매수·매도가 반복된다.
 *
 * 종목 마스터 e2e(다른 스펙, tests/e2e/symbol-master.spec.ts)가 쓰는
 * SEED_DATE(2024-12-30)와 겹치지 않는다 — 두 스펙이 같은 서버를
 * 공유해도(playwright.config workers:1) coverage 판정에서 서로 간섭하지 않는다.
 */
const PERIOD = { from: '2026-01-05', to: '2026-03-31' };
/** KOSPI 상위 1종목만 — 900010(상장폐지예정1호)은 시가총액이 더 낮아 순위 밖으로 빠진다 */
const TOP_N = 1;

/**
 * "기간 전체 동기화" 완주 대기 상한 — 백필은 날짜마다 KRX 를 최소 4회(KOSPI·KOSDAQ ×
 * 기본정보·일별매매) 부르고 그 사이 250ms 간격을 지킨다(krx-historical-universe-source.ts
 * `groupMinIntervalMs`). 실측(로컬, fake KRX 서버 기준): PERIOD(86일) 백필은 약 90초
 * 걸린다 — 예전 30초 상한은 Task 4 가 "날짜별 순차 POST" 를 "기간 전체 백그라운드
 * 백필"로 바꾸며(스펙 2026-08-06) 더는 맞지 않게 됐다(Task 4 는 `pnpm test:e2e` 를
 * 돌리지 않아 이 어긋남이 그때는 드러나지 않았다). 상한을 짧게 두면 이 대기만
 * 실패하는 게 아니라, 프런트가 포기해도 서버의 `SymbolMasterBackfill` 은 백그라운드에서
 * 계속 돌아 다음 테스트가 다른 기간을 요청할 때 "다른 구간 수집이 진행 중입니다" 로
 * 밀려나는 연쇄 실패로 번진다(리뷰에서 재현·확인).
 */
const BACKFILL_WAIT_TIMEOUT_MS = 150_000;
/**
 * durable 준비 작업(Task 6) 완료 대기 상한. 재무·자본변동 DART 호출은 실제로 일어나지
 * 않는다(`seedCorporateActionCoverageOnRegistration` 이 등록 시점에 커버리지를 이미
 * 채워 `FactSyncService.runSync` 가 남은 연도 0건으로 건너뛴다 — scripts/e2e-server.ts
 * 주석 참고). 그런데도 시장 데이터 phase는 짧지 않다 — `range-breakout` 의
 * `priceWarmupBars` 요구 때문에 `syncMarketData` 가 price.from(≈ period.from - 36일)
 * ~ price.to(period.to) 전체를 하루 단위로 순회하며 `ingestDate` 를 부른다(옛
 * "기간 전체 동기화" 가 하던 일을 이 준비 작업이 그대로 흡수했다) — KOSPI·KOSDAQ ×
 * 기본정보·일별매매 최소 4호출을 250ms 간격으로 반복하므로(krx-historical-universe-source.ts
 * `groupMinIntervalMs`) 실측(로컬)으로 약 100~130초 걸린다. 기간 전체 백필
 * (`BACKFILL_WAIT_TIMEOUT_MS`)과 같은 일을 하므로 상한도 비슷하게 넉넉히 잡는다.
 */
const PREPARATION_WAIT_TIMEOUT_MS = 200_000;

/**
 * 준비 작업(Task 6)이 202로 시작됐으면, 완료 뒤 컴포넌트가 같은 params로 자동
 * 재요청하는 응답(universe-rule-step.tsx COMPLETED effect)까지 기다린다. 200으로
 * 바로 끝났으면(이미 준비된 요청) 아무 것도 하지 않는다.
 */
async function waitForDurablePreparation(
  page: Page,
  firstResponse: { status(): number },
): Promise<void> {
  if (firstResponse.status() !== 202) return;
  const autoRetried = page.waitForResponse(
    (resp) =>
      resp.url().includes('/backtests/universe-preview') && resp.request().method() === 'POST',
    { timeout: PREPARATION_WAIT_TIMEOUT_MS },
  );
  await autoRetried;
}

/**
 * 위저드 유니버스 단계 — [미리보기] 를 누르고, ① durable 준비 작업(202)이 시작되면
 * `waitForDurablePreparation` 으로 완료를 기다리고, ② 그 결과에 리밸런스 날짜가
 * 아직 커버되지 않았다는 경고가 뜨면 [기간 전체 동기화] 로 기간 전체
 * (period.from~to)를 채운다(Task 4, 스펙 2026-08-06). 서버가 백그라운드 백필을
 * 돌리는 동안 컴포넌트가 `GET /symbol-master/coverage` 를 폴링하고, 백필이 끝나면
 * 같은 params 로 미리보기를 자동으로 다시 던진다(universe-rule-step.tsx
 * `syncFullPeriod`) — 그 응답을 기다리면 버튼이 사라진(=기간 전체가 커버된) 상태로
 * 정리된다.
 *
 * 이미 같은 기간을 동기화해 둔 뒤(예: 이 파일의 재무 게이트 시나리오가 앞선 시나리오와
 * 같은 PERIOD 를 쓴다) 다시 부르면 202도, 경고도 뜨지 않아 아무 것도 누르지 않고
 * 끝난다 — 그래서 두 시나리오가 이 함수를 그대로 공유해도 안전하다.
 */
async function previewAndSyncUniverse(page: Page): Promise<void> {
  const initialPreview = page.waitForResponse(
    (resp) =>
      resp.url().includes('/backtests/universe-preview') && resp.request().method() === 'POST',
  );
  await page.getByRole('button', { name: '미리보기' }).click();
  const first = await initialPreview;
  await waitForDurablePreparation(page, first);

  // 클릭 직후 count() 는 자동 대기하지 않는다 — 응답이 아직 안 온 시점의 DOM(버튼 0개)
  // 을 그대로 읽으면 실제로는 곧 뜨는데도 없는 것으로 판정해 버린다. 위에서 이미
  // (durable 작업이 있었다면) 그 완료 응답까지 기다렸으므로 여기서는 곧바로 확인한다.
  const fullSync = page.getByRole('button', { name: '기간 전체 동기화' });
  if ((await fullSync.count()) === 0) return;

  const previewRefreshed = page.waitForResponse(
    (resp) =>
      resp.url().includes('/backtests/universe-preview') && resp.request().method() === 'POST',
    { timeout: BACKFILL_WAIT_TIMEOUT_MS },
  );
  await fullSync.click();
  await previewRefreshed;
  // 백필이 끝나면 컴포넌트가 미리보기를 다시 던지는데, 리밸런스 날짜가 휴장일이면
  // (재구성 앵커가 백필 구간 밖이라) 그 재미리보기에도 uncoveredDates 가 남을 수
  // 있다 — 그러면 syncFullPeriod 가 남은 날짜만 개별 소급(ensureTradingDay)한 뒤
  // 한 번 더 미리보기를 던진다(universe-rule-step.tsx). `previewRefreshed` 는 그
  // 여러 번 중 **첫 응답**에서 끝나므로, 버튼이 실제로 사라지기까지는 그 추가
  // 왕복만큼 더 걸릴 수 있다 — 기본 5초 재시도로는 빠듯해 넉넉히 잡는다.
  await expect(page.getByRole('button', { name: '기간 전체 동기화' })).toHaveCount(0, {
    timeout: 30_000,
  });
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
  // 단계형 유니버스 편집기(Task 9)가 라벨을 '상위 N (시가총액)'에서 단계 공용 'N'으로
  // 바꿨다 — 이 시나리오는 항상 기본 단일 MARKET_CAP 단계뿐이라 'N' 하나만 있다.
  await page.getByLabel('N', { exact: true }).fill(String(TOP_N));
  await previewAndSyncUniverse(page);
  await expect(page.getByText('종목 1개 · 리밸런스 3회')).toBeVisible();
  // 봉 주기를 고르는 UI 는 없다 — `Timeframe` 이 `'1d'` 하나뿐이라(D-041) 고를
  // 것이 없다. 나머지 단언(거래 내역·정렬 등)은 가짜 KRX 서버가 005930 에 내는
  // 추세 있는 일별 시세(scripts/e2e-server.ts `samsungCloseFor`)로 성립한다.

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
  await expect(page.getByText('KOSPI · 시가총액 1 · 매월').first()).toBeVisible();

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
  await expect(page.getByText('KOSPI · 시가총액 1 · 매월')).toBeVisible();
  // 별도 "미청산 포지션" 카드는 제거되고 거래 내역 테이블에 통합됐다
  await expect(page.getByText('미청산 포지션', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('row').filter({ hasText: '미청산' }).first()).toBeVisible();
  // 미청산 행이 있는 실행이므로 "마지막 확인일" 열이 뜬다 (Task 11) — lastPriceTsMs 가
  // 서버 응답부터 화면까지 이어졌다는 증거다.
  await expect(page.getByRole('columnheader', { name: '마지막 확인일' })).toBeVisible();
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
  await page.getByLabel('N', { exact: true }).fill(String(TOP_N));
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

  // 8. 로그아웃 (가격 데이터 화면·CSV 가져오기·증권사 동기화는
  // 2026-08-07-price-data-removal 계획으로 제거됐다 — D-041. 종목 목록·검색·
  // 일괄 추가·데이터 검증 차트가 그 화면에 딸려 있었고, 그 화면과 함께 사라졌다.
  // 종목 마스터 화면(`/datasets/master`)의 검증은 tests/e2e/symbol-master.spec.ts
  // 가 맡는다.
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
 * 물어도 같은 유니버스 구성을 낸다"는 전제를 깨뜨린다(리뷰에서 지적된 회귀) — 고정
 * 집합은 상대 날짜와 영원히 안 겹친다. mobile·desktop 두 프로젝트가 같은 서버 상태를
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

  await page.getByLabel('N', { exact: true }).fill(String(TOP_N));

  const firstPreview = page.waitForResponse(
    (resp) =>
      resp.url().includes('/backtests/universe-preview') && resp.request().method() === 'POST',
  );
  await page.getByRole('button', { name: '미리보기' }).click();
  const first = await firstPreview;
  // 이 기간(휴장일 포함 두 리밸런스 날짜)은 처음 요청되므로 시장 데이터가 durable
  // 준비 작업(202)으로 시작된다 — 완료를 먼저 기다려야 그 다음 "기간 전체 동기화"
  // 판단이 최신 상태를 본다.
  // durable 준비 작업(Task 6)의 시장 데이터 phase가 range-breakout의 price warm-up
  // 요구 때문에 기간 전체(휴장일 포함)를 이미 하루 단위로 순회해 채운다 — 옛
  // "기간 전체 동기화" 버튼이 하던 일을 이 준비 작업이 흡수했으므로(이 파일
  // `PREPARATION_WAIT_TIMEOUT_MS` 주석 참고) 완료 뒤에는 그 버튼 없이 곧바로
  // 리밸런스 일정이 뜬다.
  await waitForDurablePreparation(page, first);
  await expect(page.getByRole('button', { name: '기간 전체 동기화' })).toHaveCount(0);
  await expect(page.getByText('리밸런스 일정')).toBeVisible();

  // 휴장 리밸런스 날짜(1월 1일)는 소급된 직전 거래일이 덧붙어 보이고, 정상 거래일
  // (2월 1일)은 요청 날짜와 같아 아무것도 덧붙지 않는다 — 표기 규약(잡음 없음)이다.
  await expect(
    page.getByRole('cell', { name: `${period.from} (적용 ${previousTradingDate})`, exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('cell', { name: period.to, exact: true })).toBeVisible();
});

/**
 * 생존편향 제거(스펙 2026-08-06) 회귀 — 증권사가 봉을 주지 않는 상장폐지 종목도
 * KRX 일봉만으로 유니버스에 들어와 백테스트가 실행까지 간다. 900010(가짜 KRX
 * 서버의 '상장폐지예정1호', scripts/e2e-server.ts)은 시가총액이 005930 보다 작아
 * topN 을 2로 올려야 유니버스에 들어온다 — mvp-flow 의 다른 시나리오(TOP_N=1)는
 * 이 종목을 건드리지 않는다.
 *
 * 이 기간은 다른 시나리오의 PERIOD·holidayPeriodFor·SEED_DATE 와 겹치지 않는
 * 새 구간이다 — previewAndSyncUniverse 가 "기간 전체 동기화" 버튼을 실제로
 * 눌러야 하는 경로(이미 커버된 기간을 재사용하는 우회가 아니다)를 그대로 탄다.
 *
 * 검증 대상은 실행 완주 여부다: 900010 은 증권사 이름·봉을 전혀 갖지 않으므로
 * (등록은 유니버스 미리보기의 자동 등록이 전담한다), 미리보기가 이 종목을
 * missingCandleSymbols 로 잘못 표시하거나 제출이 "봉이 없습니다"로 막히면 이
 * 기능 전체의 목적(생존편향 제거)이 무너진 것이다.
 */
test('backtest run completes using only KRX daily bars for a delisted stock', async ({ page }) => {
  // to는 적어도 한 달 뒤까지 — 단계 편집기의 주기 초과 차단(Task 9,
  // rebalanceIntervalFitsPeriod)이 기본 주기(매월)로 다음 리밸런스가 기간 안에 한
  // 번도 올 수 없는 기간을 막는다. 20일짜리 옛 기간은 이제 이 검증에 걸려
  // '미리보기'가 계속 비활성 상태로 남는다 — 리밸런스는 여전히 1회(4월 1일)뿐이다.
  const period = { from: '2026-04-01', to: '2026-04-30' };

  await page.goto('/login');
  await page.getByLabel('사용자 이름').fill(USERNAME);
  await page.getByLabel('비밀번호').fill(PASSWORD);
  await page.getByRole('button', { name: '로그인' }).click();
  await expect(page.getByRole('heading', { name: '대시보드' })).toBeVisible();

  await page.goto('/backtests/new');
  await page.getByRole('button', { name: /전고점 돌파/ }).click();
  await page.getByLabel('돌파 기준 봉 수', { exact: true }).fill('10');
  await page.getByLabel('변동성(ATR) 계산 기간', { exact: true }).fill('5');
  await page.getByRole('button', { name: '다음' }).click(); // 전략 → 기간

  await page.getByLabel('시작일').fill(period.from);
  await page.getByLabel('종료일').fill(period.to);
  await page.getByRole('button', { name: '다음' }).click(); // 기간 → 유니버스

  await page.getByLabel('N', { exact: true }).fill('2');
  await previewAndSyncUniverse(page);

  // 두 종목 모두 유니버스에 들어왔고, 봉이 없다는 경고가 없다 — 상장폐지 종목도
  // KRX 일봉만으로 "봉 있음" 판정을 받았다는 뜻이다(missingCandleSymbols 회귀 fix).
  await expect(page.getByText('종목 2개 · 리밸런스 1회')).toBeVisible();
  await expect(
    page.getByText(/다음 종목은 아직 봉 데이터가 없어 백테스트를 실행할 수 없습니다/),
  ).toHaveCount(0);

  await page.getByRole('button', { name: '다음' }).click(); // 유니버스 → 자본·비용
  await page.getByRole('button', { name: '다음' }).click(); // 자본·비용 기본값 → 검토
  await page.getByRole('button', { name: '다음' }).click(); // 검토 → 실행

  await page.getByRole('button', { name: '백테스트 실행' }).click();
  await expect(page).toHaveURL(/\/backtests\/bt_/);
  await expect(page.getByText('완료', { exact: true })).toBeVisible({ timeout: 90_000 });

  // 대시보드는 전략 한국어 이름을 보인다 — kebab-case 식별자가 새면 안 된다 (D-044)
  await page.goto('/');
  const recent = page.getByText('최근 결과').locator('..').locator('..');
  await expect(recent.getByText('전고점 돌파').first()).toBeVisible();
  await expect(page.getByText('range-breakout')).toHaveCount(0);

  // 알림 항목 설명은 전략 이름과 수익률을 첫 줄에 함께 진다 (D-044)
  await page.goto('/notifications');
  const completed = page
    .getByRole('button', { name: /백테스트가 완료되었습니다/ })
    .first();
  await expect(completed).toContainText('전고점 돌파');
  await expect(completed).toContainText('수익률');

  // 이 테스트가 미리보기로 자동 등록한 900010 을 되돌린다 — 상장폐지 종목이
  // 다른 시나리오의 등록 종목 목록에 계속 남아 있을 이유가 없다. 두 프로젝트
  // (mobile·desktop)가 같은 서버를 공유하므로(playwright.config workers:1),
  // 여기서 지워도 이 시나리오가 이미 채운 krx_daily_bars 는 그대로 남아
  // 재등록 시 다시 쓰인다(symbols 삭제는 KRX 일봉을 지우지 않는다 —
  // symbol-service.ts removeSymbols 주석 참고).
  await page.request.post('/api/v1/symbols/remove', { data: { codes: ['900010'] } });
});

test('mobile layout has no horizontal scroll on core screens (스펙 §38)', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile', 'mobile 전용 검증');

  await page.goto('/login');
  await page.getByLabel('사용자 이름').fill(USERNAME);
  await page.getByLabel('비밀번호').fill(PASSWORD);
  await page.getByRole('button', { name: '로그인' }).click();
  await expect(page.getByRole('heading', { name: '대시보드' })).toBeVisible();

  // /backtests/new/strategy 가 목록에 있는 이유: 단계 버튼 6개를 3열 × 2행으로 깔면서
  // 44px 터치 영역을 지킨다 — 390px 에서 가장 먼저 넘칠 화면이 여기다.
  // '/datasets/master' 를 넣는 이유: 종목 마스터의 타임라인 슬라이더가 390px 에서
  // 가장 먼저 넘칠 화면이다(가격 데이터 화면은 2026-08-07-price-data-removal
  // 계획으로 제거돼 더는 목록에 없다).
  for (const path of ['/', '/backtests', '/backtests/new/strategy', '/datasets/master', '/settings']) {
    await page.goto(path);
    await page.waitForLoadState('networkidle');
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, `${path} 가로 스크롤`).toBeLessThanOrEqual(0);
  }
});
