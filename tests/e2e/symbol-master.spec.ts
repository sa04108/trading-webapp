import { expect, test } from '@playwright/test';
import { login } from './login';

/** 종목 마스터 화면의 동기화·필터·검색·페이징을 검증한다. */

const SEED_DATE = '2019-01-02';

/** 고정된 과거 평일 중 기존 커버리지와 인접하지 않는 날짜를 고른다. */
function uncoveredWeekday(ranges: { startDate: string; endDate: string }[]): string {
  for (const iso of ['2020-06-01', '2020-06-08', '2020-06-15', '2020-06-22', '2020-07-06', '2020-07-13', '2020-07-20', '2020-07-27']) {
    const date = new Date(`${iso}T00:00:00Z`);
    const previous = new Date(date.getTime() - 86_400_000).toISOString().slice(0, 10);
    const next = new Date(date.getTime() + 86_400_000).toISOString().slice(0, 10);
    if (ranges.every((range) => range.endDate < previous || range.startDate > next)) return iso;
  }
  throw new Error('고정 후보 중 기존 커버리지와 떨어진 미수집 평일이 없습니다.');
}

test('종목 마스터 기본 탭 — 미커버 날짜를 동기화하면 표와 타임라인이 갱신된다', async ({
  page,
}) => {
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

  // ── 기본 화면 확인 — /datasets 로 들어가면 종목 마스터로 이어진다.
  await page.goto('/datasets');
  await expect(page).toHaveURL(/\/datasets\/master$/);
  await page.goto(`/datasets/master?date=${SEED_DATE}`);
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
  const coverageResponse = await page.request.get('/api/v1/symbol-master/coverage');
  expect(coverageResponse.ok()).toBe(true);
  const coverage = await coverageResponse.json() as { ranges: { startDate: string; endDate: string }[] };
  const target = uncoveredWeekday(coverage.ranges);
  const coveredSegments = page.locator('span[class*="bg-primary/60"]');
  const segmentsBeforeSync = await coveredSegments.count();

  // 실제 기존 구간과 하루 이상 떨어진 날짜를 사용해 동기화 전후 변화를 확인한다.
  await page.goto(`/datasets/master?date=${target}`);
  await expect(page.getByText(/데이터 미수집/)).toBeVisible();
  const syncThisDate = page.getByRole('button', { name: '이 날짜 동기화' });
  await expect(syncThisDate).toBeVisible();
  // 이미 커버해 둔 실제 거래일이 있으니 "가장 가까운 수집일로 이동" 도 함께 뜬다.
  // findNearestTradingDate 는 tradingDates 가 비어 있을 때만 null 이다. 어느 날짜가
  // 뜨는지는 SEED_DATE 라고 단정하지 않는다 — 다른 스펙이 더 가까운 날짜를
  // 수집했을 수 있으므로 정확한 날짜
  // 대신 버튼이 뜨는 사실과 형태만 본다. 눌러서 실제로 어떤 커버된 날짜로든 점프하는지
  // 확인한 뒤, 미커버 시나리오를 이어가려고 타깃 날짜로 되돌아온다.
  const nearestButton = page.getByRole('button', { name: /가장 가까운 수집일\(\d{4}-\d{2}-\d{2}\)로 이동/ });
  await expect(nearestButton).toBeVisible();
  await nearestButton.click();
  await expect(page.getByText(/기준 5종목/)).toBeVisible();
  await page.goto(`/datasets/master?date=${target}`);
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
