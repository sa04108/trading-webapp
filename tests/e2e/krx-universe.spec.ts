import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';

const USERNAME = 'e2e-operator';
const PASSWORD = 'correct-horse-battery-staple';

/** e2e-server.ts 가짜 KRX 서버 fixture — 2024-12-30 거래일, 2025-01-01 은 휴장(빈 응답). */
const REQUESTED_DATE = '2025-01-01';
const EFFECTIVE_DATE = '2024-12-30';
const USABLE_FROM_DATE = '2024-12-31';
/** 005930 의 실제 캔들 보유 구간(scripts/e2e-server.ts buildTrendingHourlyCsv) 안의 기간 — 제출 성공에 쓴다. */
const USABLE_PERIOD_FROM = '2026-01-05';
const USABLE_PERIOD_TO = '2026-03-31';

const HOUR_MS = 3_600_000;
/** 백테스트에서 실제로 쓰는 어떤 기간과도 겹치지 않는 과거 하루 — 900010 의 유일한 가격 데이터를 여기 둔다. */
const DELISTED_CANDLE_DAY_UTC_MS = Date.UTC(2020, 0, 2);
const DELISTED_SYMBOL_CODE = '900010';

/**
 * 이 스펙이 확인하지 않는 것: KRX_API_KEY 가 없어 조회 자체가 잠기는 상태는
 * e2e 서버 하나를 여러 시나리오가 공유하는 구성상 재현할 수 없다(재시작 없이 키를
 * 껐다 켤 수 없다) — `tests/integration/universe-routes.test.ts` 가 담당한다.
 */

async function login(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page).toHaveURL(/\/login/);
  await page.getByLabel('사용자 이름').fill(USERNAME);
  await page.getByLabel('비밀번호').fill(PASSWORD);
  await page.getByRole('button', { name: '로그인' }).click();
  await expect(page.getByRole('heading', { name: '대시보드' })).toBeVisible();
}

/** 1단계(전략) — range-breakout 은 lookbackBars·atrPeriod 에 기본값이 없어 채워야 '다음' 뒤에도 요청이 유효하다. */
async function selectRangeBreakoutStrategy(page: Page): Promise<void> {
  await page.getByRole('button', { name: /전고점 돌파/ }).click();
  await page.getByLabel('돌파 기준 봉 수', { exact: true }).fill('10');
  await page.getByLabel('변동성(ATR) 계산 기간', { exact: true }).fill('5');
  await page.getByRole('button', { name: '다음' }).click();
}

/** 2단계에서 '과거 KRX 시점' 탭으로 옮기고 기준일을 조회한다. */
async function queryKrxPreview(page: Page, requestedDate: string): Promise<void> {
  await page.getByRole('tab', { name: '과거 KRX 시점' }).click();
  await page.getByLabel('기준일').fill(requestedDate);
  await page.getByRole('button', { name: '조회' }).click();
}

/** 세션(09:00~15:30 KST) 안에 드는 하루치 1분봉 7개 — scripts/e2e-server.ts 의 CSV 픽스처와 같은 정렬. */
function buildSingleDayMinuteCsv(dayStartUtcMs: number): string {
  const lines = ['timestamp,open,high,low,close,volume'];
  for (let barIndex = 0; barIndex < 7; barIndex += 1) {
    const ts = dayStartUtcMs + barIndex * HOUR_MS;
    const open = 1000 + barIndex * 10;
    const close = open + 5;
    lines.push(`${ts},${open},${close + 5},${open - 5},${close},1000`);
  }
  return lines.join('\n');
}

/**
 * 900010(상장폐지예정1호) 을 이 스펙이 직접 CSV 가져오기 UI 로 등록한다 —
 * e2e-server.ts 시드에 넣지 않는 이유: e2e 서버 하나를 여러 스펙이 공유하는데
 * (playwright.config workers:1), `/datasets?tab=symbols` 등록 종목 수를 정확히
 * 세는 다른 스펙(mvp-flow.spec.ts §8)이 있어 전역 카탈로그를 건드리면 그 스펙이
 * 깨진다. 이 스펙이 만든 것은 이 스펙이 스스로 지운다(아래 `removeSymbolIfPresent`,
 * `afterEach` 참고).
 *
 * 캔들은 백테스트 기간과 절대 겹치지 않는 하루(2020-01-02)만 넣는다 — 그래야
 * "가격 데이터가 없는 스냅샷 종목" 차단(REVIEW §9.1)이 재현된다: 종목은 로컬
 * 카탈로그에 있어(timeframe 해소는 통과) 실제 요청 기간에는 겹치는 캔들이 없다.
 */
async function importDelistedSymbol(page: Page): Promise<void> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'krx-e2e-'));
  const csvPath = path.join(tempDir, `${DELISTED_SYMBOL_CODE}.csv`);
  fs.writeFileSync(csvPath, buildSingleDayMinuteCsv(DELISTED_CANDLE_DAY_UTC_MS));

  await page.goto('/datasets?tab=symbols');
  await page.getByRole('button', { name: 'CSV' }).click();
  const csvDialog = page.getByRole('dialog');
  await csvDialog.getByLabel('종목 코드').fill(DELISTED_SYMBOL_CODE);
  await csvDialog.getByLabel('봉').click();
  await page.getByRole('option', { name: '분봉' }).click();
  await csvDialog.getByLabel('CSV 파일').setInputFiles(csvPath);
  await csvDialog.getByRole('button', { name: '가져오기' }).click();
  await expect(csvDialog).toHaveCount(0);
}

/**
 * 종목 탭에서 편집 모드로 들어가 코드 하나를 제거한다 — 존재할 때만.
 *
 * 크래시 안전한 정리(afterEach)가 부르므로 두 상태를 모두 받아야 한다: (1) 이
 * 스펙의 시나리오가 끝까지 가서 900010 을 실제로 만든 경우, (2) `importDelistedSymbol`
 * 이전에 다른 assertion 이 먼저 실패해 900010 이 아예 존재하지 않는 경우. 체크박스
 * 존재 여부로 두 경우를 가른다 — 없는 종목을 제거하려고 기다리다 타임아웃으로
 * 걸리면 정리 자체가 실패해 오염이 남는 원래 문제를 그대로 재현한다.
 */
async function removeSymbolIfPresent(page: Page, code: string): Promise<void> {
  await page.goto('/datasets?tab=symbols');
  await page.getByRole('button', { name: '편집' }).click();
  const checkbox = page.getByRole('checkbox', { name: `${code} 선택` });
  if ((await checkbox.count()) === 0) {
    await page.getByRole('button', { name: '완료' }).click();
    return;
  }
  await checkbox.check();
  const impactResponse = page.waitForResponse((resp) => resp.url().includes('/symbols/removal-impact'));
  await page.getByRole('button', { name: '제거' }).click();
  await impactResponse;
  const removeDialog = page.getByRole('dialog');
  await expect(removeDialog.getByText(/참조하는 데이터셋이 없습니다/)).toBeVisible();
  await removeDialog.getByRole('button', { name: '제거' }).click();
  await expect(page.getByText(code)).toHaveCount(0);
  await page.getByRole('button', { name: '완료' }).click();
}

/** 이 스펙의 시나리오가 스냅샷 확정으로 남기는 데이터셋 이름은 모두 이 문자열을 담는다. */
const AUTO_DATASET_NAME_PATTERN = new RegExp(`KRX ${EFFECTIVE_DATE} 시가총액순`);

/**
 * 스냅샷 확정이 남긴 데이터셋 카드를 모두 UI 로 지운다(카드의 「삭제」 → 확인
 * 다이얼로그). 데이터셋(참조 묶음)은 지울 수 있다 — 지울 수 없는 건 감사용
 * 스냅샷 레코드뿐이다(dataset-service.ts `deleteDataset` 주석 참고, REVIEW §9.2).
 *
 * `pnpm test:e2e`(플레이라이트 전체 실행)는 이 파일과 mvp-flow.spec.ts 가 서버
 * 하나를 공유한다(playwright.config workers:1). mvp-flow.spec.ts 의
 * 「편집」·「종목 편집」·「데이터 동기화」 selector 는 페이지 전체에서 유일 매치를
 * 기대하는데, 그 버튼들은 데이터셋 카드마다 하나씩 있어 카드가 둘 이상이면
 * strict-mode 위반으로 깨진다 — 시나리오 1~4·5·스냅샷 기록 테스트가 만드는 카드를
 * 이 파일이 스스로 다 지워야 한다(mvp-flow.spec.ts 는 건드리지 않는다).
 *
 * 카드를 지울 때마다 목록이 다시 그려지므로 매번 남은 첫 번째 카드를 다시
 * 찾는다(`removeSymbolIfPresent` 와 같은 크래시 안전 패턴 — 만들지 않은 테스트에서는
 * 카드가 0개라 즉시 끝난다). `removeSymbolIfPresent` 보다 먼저 불러야 한다 —
 * 900010 을 참조하는 데이터셋이 아직 있으면 제거 확인 다이얼로그의 영향 범위
 * 조회(`/symbols/removal-impact`)가 응답을 받기 전 기본값(빈 배열)으로 "참조하는
 * 데이터셋이 없습니다" 를 잠깐 보여준 뒤 실제 응답으로 뒤집는 경합이 있다(앱의
 * 경합, 이 스펙이 고칠 대상은 아니다) — 데이터셋을 먼저 지워 두면 그 응답도 같은
 * "없습니다" 로 정착해 경합이 사라진다.
 */
async function removeAutoDatasetsIfPresent(page: Page): Promise<void> {
  // `.count()` 는 지금 DOM 을 그대로 읽을 뿐 자동 대기하지 않는다 — 목록 GET 응답을
  // 기다리지 않고 곧바로 세면, 이동 직후 아직 로딩 중인 빈 목록을 "카드 없음"으로
  // 잘못 읽어 정리를 통째로 건너뛴다. 이동 전에 리스너를 걸어 두고 이동 뒤 기다린다.
  const listResponse = page.waitForResponse(
    (resp) => resp.url().includes('/api/v1/datasets') && resp.request().method() === 'GET',
  );
  await page.goto('/datasets?tab=datasets');
  await listResponse;
  const cards = page.locator('[data-slot="card"]').filter({ hasText: AUTO_DATASET_NAME_PATTERN });
  while ((await cards.count()) > 0) {
    await cards.first().getByRole('button', { name: '삭제' }).click();
    const confirmDialog = page.getByRole('dialog');
    await confirmDialog.getByRole('button', { name: '삭제' }).click();
    await expect(confirmDialog).toHaveCount(0);
  }
}

/**
 * 900010 을 만드는 테스트는 시나리오 5 하나뿐이지만, 그 테스트의 assertion 이
 * 중간에 실패해도(예: 리뷰가 실측한 강제 실패 주입) 정리가 실행돼야 한다 —
 * try/finally 를 시나리오 안에 두면 시나리오 자체가 아니라 이 파일의 다른
 * 테스트가 실패했을 때는 지켜주지 못한다. 파일 전역 afterEach 로 모든 테스트
 * 뒤에 걸어 두면 어느 테스트가 어떻게 실패하든 같은 보장이 선다. 900010 을
 * 만들지 않는 시나리오 1~4 테스트에서는 `removeSymbolIfPresent` 가 즉시
 * 아무 일도 하지 않고 끝난다. 데이터셋 정리를 먼저 두는 순서는
 * `removeAutoDatasetsIfPresent` 주석 참고.
 */
test.afterEach(async ({ page }) => {
  await removeAutoDatasetsIfPresent(page);
  await removeSymbolIfPresent(page, DELISTED_SYMBOL_CODE);
});

test('위저드 조회·선택·확정·게이트·성공 제출 (Task 15 시나리오 1~4)', async ({ page }) => {
  // 조회 + 스냅샷 확정 + 시작일 게이트 차단 + 실제 백테스트 완료 대기(최대 90초)
  // 까지 한 흐름에 담아 위저드 상태(selectedSnapshot)를 시나리오 사이에 그대로
  // 이어 쓴다 — 기본 120초로는 여유가 부족하다.
  test.setTimeout(150_000);

  await login(page);

  // ── 1) 조회: '요청 2025-01-01 → 적용 2024-12-30', 보통주 수·제외 수·출처 문구 ──
  await page.goto('/backtests/new');
  await selectRangeBreakoutStrategy(page);
  await queryKrxPreview(page, REQUESTED_DATE);

  await expect(
    page.getByText(`요청 ${REQUESTED_DATE} → 적용 ${EFFECTIVE_DATE}`),
  ).toBeVisible();
  await expect(page.getByText('출처: 한국거래소 통계정보')).toBeVisible();
  // 원시 5(KOSPI 3 + KOSDAQ 2) · 적격 3(삼성전자·카카오·상장폐지예정1호) · unknown 0
  await expect(
    page.getByText('원시 5종목 · 보통주 적격 3종목 · 시가총액 확인 불가 0종목'),
  ).toBeVisible();
  // 우선주(005935)·스팩(900099) 각 1건 제외
  await expect(page.getByText('유형별 제외 PREFERRED_STOCK 1, SPAC 1')).toBeVisible();
  // 정렬 기준 Select 는 시가총액 상위가 기본값이다
  await expect(page.getByLabel('정렬 기준')).toContainText('시가총액 상위');

  // ── 2) 페이지 선택 → 전체 해제 확인 → 전체 선택 → 검색 후 선택 유지 → 005930 만 남기고 수동 해제 → 확정 ──
  // 후보 3개가 한 페이지에 다 있어 「페이지 선택」이 「전체 선택」과 같은 결과를 낸다
  await page.getByRole('button', { name: '페이지 선택' }).click();
  await expect(page.getByText('3개 선택')).toBeVisible();
  await page.getByRole('button', { name: '전체 해제' }).click();
  await expect(page.getByText('0개 선택')).toBeVisible();
  await page.getByRole('button', { name: '전체 선택' }).click();
  await expect(page.getByText('3개 선택')).toBeVisible();

  const candidateSearch = page.getByLabel('후보 종목 검색');
  await candidateSearch.fill('카카오');
  await expect(page.getByText('검색 결과 1/3종목')).toBeVisible();
  // 필터는 표시만 줄인다 — 선택 개수는 그대로다
  await expect(page.getByText('3개 선택')).toBeVisible();
  await candidateSearch.fill('');

  await page.getByRole('checkbox', { name: '카카오 선택' }).uncheck();
  await page.getByRole('checkbox', { name: '상장폐지예정1호 선택' }).uncheck();
  await expect(page.getByText('1개 선택')).toBeVisible();

  await page.getByRole('button', { name: '스냅샷 확정' }).click();
  // 확정 카드와 '기존 스냅샷 다시 쓰기' 목록(같은 스냅샷을 즉시 재조회) 둘 다 같은
  // 문구를 낼 수 있다 — 확정 성공 자체를 확인하는 게 목적이라 첫 매치로 충분하다.
  await expect(page.getByText(`적용 ${EFFECTIVE_DATE} · 1종목`).first()).toBeVisible();
  await expect(page.getByText('고정 유니버스').first()).toBeVisible();

  await page.getByRole('button', { name: '다음' }).click(); // 데이터·종목 → 기간

  // ── 3) 시작일 == 적용일 → 제출 차단, 두 날짜 + 해결책 문구 ──
  await page.getByLabel('시작일').fill(EFFECTIVE_DATE);
  await page.getByLabel('종료일').fill('2026-06-01');
  await page.getByRole('button', { name: '다음' }).click(); // 기간 → 자본·비용
  await page.getByRole('button', { name: '다음' }).click(); // 자본·비용(기본값) → 검토

  await expect(
    page.getByText(`KRX ${EFFECTIVE_DATE} 기준·고정 유니버스`),
  ).toBeVisible();
  await expect(
    page.getByText(
      `이 스냅샷은 ${USABLE_FROM_DATE}부터 시작일로 쓸 수 있습니다 — 그 이전 시작일은 그 시점에 알 수 없던 정보를 미리 쓰는 셈이라 제출이 막힙니다.`,
    ),
  ).toBeVisible();

  await page.getByRole('button', { name: '다음' }).click(); // 검토 → 실행
  await page.getByRole('button', { name: '백테스트 실행' }).click();
  await expect(
    page.getByText(
      `적용일 ${EFFECTIVE_DATE}는 시작일 ${EFFECTIVE_DATE}보다 이전이어야 합니다`,
    ),
  ).toBeVisible();
  await expect(page.getByText('더 이른 스냅샷을 선택하거나 시작일을 늦추세요')).toBeVisible();

  // ── 4) 시작일을 뒤로 옮기면 제출 성공 → 결과 화면에 고정 유니버스 문구·적용일 ──
  await page.getByRole('button', { name: '3. 기간' }).click(); // 뒤로는 언제나 자유롭다
  await page.getByLabel('시작일').fill(USABLE_PERIOD_FROM);
  await page.getByLabel('종료일').fill(USABLE_PERIOD_TO);
  await page.getByRole('button', { name: '다음' }).click(); // 기간 → 자본·비용
  await page.getByRole('button', { name: '다음' }).click(); // 자본·비용 → 검토
  await expect(
    page.getByText(`KRX ${EFFECTIVE_DATE} 기준·고정 유니버스`),
  ).toBeVisible();

  await page.getByRole('button', { name: '다음' }).click(); // 검토 → 실행
  await page.getByRole('button', { name: '백테스트 실행' }).click();
  await expect(page).toHaveURL(/\/backtests\/bt_/);
  await expect(page.getByText('완료', { exact: true })).toBeVisible({ timeout: 90_000 });

  // 결과 화면 — REVIEW §9.3 고정 유니버스 문구와 적용일
  await expect(page.getByText(`KRX ${EFFECTIVE_DATE} 기준·고정 유니버스`).first()).toBeVisible();
  await expect(
    page.getByText(
      `이 실행은 ${EFFECTIVE_DATE}의 KRX 종목·시가총액으로 구성한 고정 유니버스를 전체 기간에 사용했습니다. 기간 중 시가총액 재산정이나 종목 편입·편출은 수행하지 않았습니다.`,
    ),
  ).toBeVisible();
  await expect(page.getByText(`KRX ${EFFECTIVE_DATE} 스냅샷 · 1종목`)).toBeVisible();
  await expect(page.getByText('수동 선택')).toBeVisible(); // 선정 방식 — topN 에서 수동 해제했으므로 MANUAL

  // ── 5) 정리 ── 확정이 남긴 데이터셋은 파일 전역 afterEach(removeAutoDatasetsIfPresent)가
  // 지운다 — 이유는 그 함수 주석 참고.
});

/**
 * 가격 없는 종목 시나리오를 별도 테스트로 분리했다(리뷰 Important) — 위저드
 * 상태를 이어 쓸 필요가 없는 독립 흐름이고(새 preview·새 스냅샷), 분리해 두면
 * 이 테스트 하나가 실패해도 위 시나리오 1~4 는 별도로 보고된다. 900010 을
 * 만드는 유일한 테스트라 정리 대상도 이 테스트로 한정된다(afterEach 는 그래도
 * 파일 전체에 걸려 있다 — 크래시 안전을 테스트 경계에 의존하지 않기 위해서다).
 */
test('가격 없는 종목 포함 스냅샷은 제출을 차단한다 (Task 15 시나리오 5)', async ({ page }) => {
  await login(page);
  await importDelistedSymbol(page);

  // ── 5) 가격 없는 종목(900010) 포함 스냅샷 → 제출 차단에 코드 나열 ──
  await page.goto('/backtests/new');
  await selectRangeBreakoutStrategy(page);
  await queryKrxPreview(page, REQUESTED_DATE);
  await expect(page.getByText(`요청 ${REQUESTED_DATE} → 적용 ${EFFECTIVE_DATE}`)).toBeVisible();

  // 카카오는 그대로 두고 삼성전자·상장폐지예정1호만 수동 선택한다
  await page.getByRole('checkbox', { name: '삼성전자 선택' }).check();
  await page.getByRole('checkbox', { name: '상장폐지예정1호 선택' }).check();
  await expect(page.getByText('2개 선택')).toBeVisible();

  await page.getByRole('button', { name: '스냅샷 확정' }).click();
  await expect(page.getByText(`적용 ${EFFECTIVE_DATE} · 2종목`).first()).toBeVisible();

  await page.getByRole('button', { name: '다음' }).click(); // 데이터·종목 → 기간
  // 005930 은 이 구간에 캔들이 있지만 900010 은 2020-01-02 하루치뿐이라 겹치지 않는다
  await page.getByLabel('시작일').fill(USABLE_PERIOD_FROM);
  await page.getByLabel('종료일').fill(USABLE_PERIOD_TO);
  await page.getByRole('button', { name: '다음' }).click(); // 기간 → 자본·비용
  await page.getByRole('button', { name: '다음' }).click(); // 자본·비용 → 검토
  await page.getByRole('button', { name: '다음' }).click(); // 검토 → 실행
  await page.getByRole('button', { name: '백테스트 실행' }).click();

  await expect(
    page.getByText(`선택한 기간에 가격 데이터가 없는 스냅샷 종목이 있습니다: ${DELISTED_SYMBOL_CODE}`),
  ).toBeVisible();
  await expect(page.getByText('생존 편향을 막기 위해')).toBeVisible();

  // ── 6) 정리 ──
  // 확정이 남긴 데이터셋(005930+900010)과 900010 자체는 파일 전역 afterEach
  // (removeAutoDatasetsIfPresent → removeSymbolIfPresent 순서)가 되돌린다 — 이유는
  // 그 함수들의 주석 참고. 스냅샷 레코드 자체는 불변 저장이라(REVIEW §9.2) 지울
  // API 가 없어 그대로 둔다. 위 assertion들이 실패해도 afterEach 는 여전히
  // 실행되므로 여기서 별도로 부르지 않는다.
});

/**
 * 스냅샷 확정이 데이터셋 자동 생성까지 이어지는지는 위 시나리오들에 이어 붙여
 * 확인할 수 없다 — 확인하려면 `/datasets` 로 이동해야 하는데, 그 이동이 위저드
 * 상태(selectedSnapshot)를 지워 시나리오 1~4 뒷부분(시작일 게이트·제출)을 깨뜨린다.
 * 그래서 새 조회·새 확정을 쓰는 별도 테스트로 뗀다.
 *
 * 시나리오 1~4 의 확정도 005930 하나로 좁혀 같은 이름(`KRX {적용일} 시가총액순 1종목`)의
 * 데이터셋을 남긴다 — 이름이 겹치면 서버가 이 테스트의 것에 ' (2)' 접미를 붙이므로
 * 정확 일치 대신 정규식 + `.last()` 로 이 테스트가 만든 카드를 집는다(새 데이터셋은
 * 목록 끝에 쌓인다). 이 카드도 파일 전역 afterEach(removeAutoDatasetsIfPresent)가
 * 지운다 — 이유는 그 함수 주석 참고.
 */
test('스냅샷 확정은 데이터셋으로도 기록된다', async ({ page }) => {
  await login(page);
  await page.goto('/backtests/new');
  await selectRangeBreakoutStrategy(page);
  await queryKrxPreview(page, REQUESTED_DATE);
  await page.getByRole('checkbox', { name: '삼성전자 선택' }).check();
  await page.getByRole('button', { name: '스냅샷 확정' }).click();
  await expect(page.getByText(`적용 ${EFFECTIVE_DATE} · 1종목`).first()).toBeVisible();

  await page.goto('/datasets?tab=datasets');
  const autoCard = page
    .locator('[data-slot="card"]')
    .filter({ hasText: new RegExp(`KRX ${EFFECTIVE_DATE} 시가총액순 1종목`) })
    .last();
  await expect(autoCard).toBeVisible();
  await expect(autoCard.getByText(`KRX ${EFFECTIVE_DATE} 기준`)).toBeVisible();
  await expect(autoCard.getByText('시가총액순 정렬')).toBeVisible();
});
