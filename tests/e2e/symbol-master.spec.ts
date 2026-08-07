import { expect, test } from '@playwright/test';
import { login } from './login';

/**
 * 종목 마스터 화면(설계 2026-08-05-symbol-master-design) — 데이터 탭이 데이터셋·종목
 * 대신 종목 마스터·가격 데이터로 갈리며 새로 생긴 화면이다. 브리프 시나리오
 * 1·4 를 이 파일이 담당한다(시나리오 3 은 위저드 흐름이라 mvp-flow.spec.ts).
 *
 * 가격 데이터 구획(시나리오 2)은 2026-08-07-price-data-removal 계획으로
 * 제거됐다. 데이터 화면에 남은 구획이 종목 마스터 하나뿐이라 탭 nav 자체가
 * 없다 — 이 파일의 남은 시나리오는 URL 로만 화면을 확인한다.
 *
 * 이 스펙이 만든 커버리지·체크포인트를 되돌리는 afterEach 가 없다 — 옛
 * krx-universe.spec.ts 의 자동 생성 데이터셋 정리와 달리, 여기서는 지울 게 없다.
 * (1) 체크포인트·coverage 는 감사 기록이라 지울 API 자체가 없다(스냅샷 레코드가
 * 불변이던 것과 같은 이유, dataset-service.ts 옛 주석 참고). (2) 그 데이터는 이
 * 화면에서 "카드 목록" 처럼 쌓여 다른 스펙의 strict-mode 셀렉터를 깨뜨리지 않는다 —
 * 옛 파일의 정리가 필요했던 이유(mvp-flow.spec.ts 가 데이터셋 카드 개수를 정확히
 * 세는 셀렉터를 쓴다) 자체가 이 화면엔 없다. 그래서 스펙이 스스로를 정리하는 방법은
 * "지우기" 가 아니라 "다른 스펙과 절대 겹치지 않는 날짜만 쓰기" 다 — 아래 SEED_DATE
 * 주석 참고.
 */

/** SymbolMasterPanel 의 `todayIso()` 와 같은 계산 — 로컬 달력 기준 오늘 */
function todayIso(): string {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
}

/** `iso` 에서 `days`일을 뺀 날짜(UTC 자정 기준 — SymbolMasterPanel 의 날짜 비교와 같은 기준) */
function daysBeforeIso(iso: string, days: number): string {
  const [year, month, day] = iso.split('-').map(Number);
  const date = new Date(Date.UTC(year!, month! - 1, day!));
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}

/**
 * 과거의 임의의 하루 — 실제 날짜값 자체는 유니버스 구성에 의미가 없다. 가짜
 * KRX 서버는 어느 날짜를 물어도 같은 종목·시가총액을 낸다(scripts/e2e-server.ts
 * 참고). 005930 의 일별 가격만은 날짜에 따라 추세를 그리지만, 이 스펙은 가격을
 * 보지 않으므로 무관하다.
 *
 * 이 값이 하는 일은 딱 하나: mvp-flow.spec.ts 가 쓰는 2026년 리밸런스 날짜들과
 * 겹치지 않는 것. "오늘"보다 충분히 이전이어야 타임라인이 폭을 가진다(아래
 * 본문 주석 참고).
 */
const SEED_DATE = '2024-12-30';

test('종목 마스터 기본 탭 — 미커버 날짜를 동기화하면 표와 타임라인이 갱신된다', async ({
  page,
}, testInfo) => {
  await login(page);

  /**
   * 과거 하루를 API 로 직접 커버해 둔다. UI 로는 이걸 할 수 없다 — 커버된 날짜가
   * 하나도 없으면 SymbolMasterPanel 의 범위가 [오늘, 오늘] 로 접혀(rangeStart 가
   * hasCoverage 없이는 today 로 떨어진다) 과거 날짜를 고를 방법이 아예 없다. 실제
   * 서비스라면 백필이 이 구간을 채우지만, 백필은 이 스펙의 관심사가 아니다.
   */
  const seedResponse = await page.request.post('/api/v1/symbol-master/sync', {
    data: { date: SEED_DATE },
  });
  expect(seedResponse.ok()).toBeTruthy();

  // ── 기본 화면 확인 — /datasets 로 들어가면 종목 마스터로 이어지고, 이미 커버된
  // 날짜를 기본으로 보여준다. 데이터 화면에 구획이 하나뿐이라(가격 데이터 구획은
  // 2026-08-07-price-data-removal 계획으로 제거됨) 탭 nav 자체가 없다 — URL 로 확인한다.
  await page.goto('/datasets');
  await expect(page).toHaveURL(/\/datasets\/master$/);
  await expect(page.getByText(/기준 5종목/)).toBeVisible();
  // exact — '삼성전자우' 도 '삼성전자' 를 부분 문자열로 포함해 strict-mode 위반이 난다
  await expect(page.getByText('삼성전자', { exact: true })).toBeVisible();
  await expect(page.getByText('카카오', { exact: true })).toBeVisible();
  await expect(page.getByText('PREFERRED_STOCK')).toBeVisible(); // 삼성전자우
  await expect(page.getByText('SPAC')).toBeVisible(); // 한국기업인수목적1호스팩

  // CoverageTimeline 은 aria-label 을 Radix Slider 의 Root(래퍼)에 붙인다 — role="slider" 는
  // 그 안쪽 Thumb 에 있고 이름이 없어(getByRole('slider', {name: ...}) 는 못 찾는다),
  // disabled 여부도 Root 쪽 aria-disabled 로만 읽을 수 있다(toBeEnabled/toBeDisabled 는
  // 이름 없는 role 이나 role 이 없는 이 래퍼 자체엔 못 쓴다).
  const timelineSlider = page.locator('[aria-label="커버리지 타임라인"]');
  await expect(timelineSlider).toHaveAttribute('aria-disabled', 'false');
  // 다른 스펙(mvp-flow.spec.ts)이 이미 만들어 둔 구간이 있을 수 있어 절대 개수 대신
  // 이 테스트가 만드는 변화량(+1)만 본다 — 실행 순서에 기대지 않기 위해서다.
  const coveredSegments = page.locator('span[class*="bg-primary/60"]');
  const segmentsBeforeSync = await coveredSegments.count();

  // ── 미커버 날짜로 이동 → 빈 상태 → [이 날짜 동기화] → 표 렌더 → 타임라인 반영 ──
  // mobile·desktop 두 프로젝트가 같은 서버를 공유하고(playwright.config workers:1)
  // 이 스펙을 각자 한 번씩 돌리므로, 둘 다 "오늘"을 타깃으로 쓰면 나중에 도는
  // 프로젝트는 이미 커버된 날짜를 만난다 — 프로젝트별로 다른 날을 써서 피한다.
  // 하루 차이로만 떨어뜨리면 mergeCoverage 가 두 프로젝트의 구간을 하나로 합쳐
  // "세그먼트가 하나 늘었는지" 판정이 깨진다 — 충분히 떨어뜨려 별개 구간으로 남긴다.
  const target = daysBeforeIso(todayIso(), testInfo.project.name === 'mobile' ? 1 : 10);
  await page.goto(`/datasets?tab=master&date=${target}`);
  await expect(page.getByText(/데이터 미수집/)).toBeVisible();
  const syncThisDate = page.getByRole('button', { name: '이 날짜 동기화' });
  await expect(syncThisDate).toBeVisible();
  // 이미 커버해 둔 날짜가 있으니(coverage.ranges 가 비어 있지 않다) "가장 가까운
  // 수집일로 이동" 도 함께 뜬다 — findNearestCoveredDate 는 ranges 가 아예 없을 때만
  // null 이지, 한 구간뿐이어도 그 구간의 경계를 후보로 낸다. 어느 날짜가 뜨는지는
  // SEED_DATE 라고 단정하지 않는다 — 다른 스펙(mvp-flow.spec.ts)이 이미 만든 구간이
  // target(오늘)에 더 가까울 수 있어(그쪽이 이기면 그 날짜가 뜬다) 정확한 날짜 대신
  // 버튼이 뜨는 사실과 형태만 본다. 눌러서 실제로 어떤 커버된 날짜로든 점프하는지
  // 확인한 뒤, 미커버 시나리오를 이어가려고 타깃 날짜로 되돌아온다.
  const nearestButton = page.getByRole('button', { name: /가장 가까운 수집일\(\d{4}-\d{2}-\d{2}\)로 이동/ });
  await expect(nearestButton).toBeVisible();
  await nearestButton.click();
  await expect(page.getByText(/기준 5종목/)).toBeVisible();
  await page.goto(`/datasets?tab=master&date=${target}`);
  await expect(page.getByText(/데이터 미수집/)).toBeVisible();

  await syncThisDate.click();

  await expect(page.getByText(/데이터 미수집/)).toHaveCount(0);
  await expect(page.getByText(/기준 5종목/)).toBeVisible();
  await expect(coveredSegments).toHaveCount(segmentsBeforeSync + 1);

  // 시장·유형 필터 — 종목 마스터 표가 새로 생긴 구획이라 최소한의 필터 동작도 함께 본다
  await page.getByLabel('시장 필터').click();
  await page.getByRole('option', { name: 'KOSDAQ' }).click();
  await expect(page.getByText('카카오')).toBeVisible();
  await expect(page.getByText('삼성전자', { exact: true })).toHaveCount(0);
  await page.getByLabel('시장 필터').click();
  await page.getByRole('option', { name: '전체 시장' }).click();

  await page.getByLabel('종목 검색').fill('상장폐지');
  await expect(page.getByText('상장폐지예정1호')).toBeVisible();
  await expect(page.getByText('카카오')).toHaveCount(0);
  await page.getByLabel('종목 검색').fill('');

  // 페이징 — 씨드 유니버스가 5종목이라 기본 20건에서는 페이지가 하나뿐이다.
  // 페이지당 2종목으로 줄여야 이동 컨트롤이 나타난다(Pagination 은 1페이지면 렌더하지 않는다).
  await page.getByLabel('종목 목록 페이지당 표시 수').fill('2');
  const universeRows = page.locator('tbody tr');
  await expect(universeRows).toHaveCount(2);
  await expect(page.getByText('총 5종목')).toBeVisible();
  await page.getByRole('navigation', { name: '종목 목록 페이지 이동' })
    .getByRole('button', { name: '마지막 페이지' })
    .click();
  await expect(universeRows).toHaveCount(1); // 5종목 = 2 + 2 + 1

  // 최근 이벤트 — 이름과 종류 드롭다운. 씨드 구간에 이벤트가 있는지는 실행 순서에
  // 달려 있어 목록 내용 대신 구획과 컨트롤이 있다는 것만 본다.
  // CardTitle 은 div 라 heading role 이 없다 — 문구로 찾는다
  await expect(page.getByText('최근 이벤트', { exact: true })).toBeVisible();
  await expect(page.getByLabel('이벤트 종류 필터')).toBeVisible();
  await page.getByLabel('이벤트 종류 필터').click();
  await expect(page.getByRole('option', { name: '주식수 변경' })).toBeVisible();
  await page.getByRole('option', { name: '전체 보기' }).click();
});
