/**
 * KRX Open API 실응답 smoke test (REVIEW §11.4, §12-4 · Task 16).
 *
 *   pnpm exec tsx scripts/krx-smoke.ts --date 2016-01-04 --years 2010,2015,2020,2025
 *
 * 단위·통합 테스트는 고정 fixture 로 계약·필터·조인 로직을 검증하지만, KRX 실응답이
 * 그 fixture 와 실제로 같은 모양인지는 인증키가 있어야만 확인할 수 있다. 이 스크립트는
 * 그 마지막 게이트다 — 통과 전에는 과거 유니버스 기능을 실서비스에 열지 않는다
 * (REVIEW §12-4, docs/DECISIONS.md D-040).
 *
 * 계약 파싱(krx-contract.ts)과 분류 정책(krx-filter-policy.ts)은 그대로 import 해서
 * 쓴다 — 같은 로직을 이 파일에 다시 옮기면 두 곳이 갈라질 수 있다. 이 스크립트가
 * 직접 하는 일은 (1) 원문 응답의 필드 이름을 눈으로 볼 수 있게 모으는 것과
 * (2) 계약·정책이 통과시킨 뒤에도 남는 진단 정보(조인 무결성 개수, 연도별 분류값
 * 목록, 호출 수)를 세는 것뿐이다.
 *
 * 이 파일을 작성한 환경에는 KRX 인증키가 없어 실호출로 검증하지 못했다. 로컬에서
 * 확인한 것은 실행 구조뿐이다: `--help` 출력과 KRX_API_KEY 없이 실행했을 때의
 * 안내+exit 1. 실응답 대조는 인증키 발급 후 사람이 한 번 돌려 확인해야 한다
 * (남은 외부 게이트, REVIEW §12-2·4).
 */
import { pino } from 'pino';
import { createKrxHistoricalUniverseSource } from '../src/server/modules/market-data/infrastructure/krx/krx-historical-universe-source.js';
import {
  KrxApprovalExpiredError,
  KrxContractError,
  KrxNotConfiguredError,
  type KrxHistoricalUniverseSource,
} from '../src/server/modules/market-data/application/ports.js';
import {
  classifyKrxIssue,
  UnknownKrxClassificationError,
} from '../src/server/modules/market-data/domain/krx-filter-policy.js';
import {
  KRX_CONTRACT_VERSION,
  type KrxDailyTradeRow,
  type KrxIssueBaseInfoRow,
  type KrxMarket,
} from '../src/server/modules/market-data/domain/krx-universe-types.js';
import { addCalendarDays, KRX_DATA_EPOCH, kstDateOf, kstHourOf } from '../src/server/modules/market-data/domain/kst-date.js';
import { systemClock } from '../src/server/shared/clock.js';

const MARKETS: readonly KrxMarket[] = ['KOSPI', 'KOSDAQ'];

// REVIEW §4.2 — 완전한 거래소 휴장일 달력이 없어 이전 거래일 탐색을 최대 31일로 제한한다.
// 운영 서비스(historical-universe-service.ts)의 규칙을 그대로 되풀이한 값이다.
const MAX_TRADING_DAY_SEARCH = 31;

// 항상 휴장인 날 — KRX 는 1월 1일에 어떤 예외도 없이 휴장한다. 이 날 일별 응답이 비지
// 않으면 계약·데이터 자체가 의심스러운 상태다.
const KNOWN_HOLIDAY_DATE = '2024-01-01';

type CheckStatus = 'PASS' | 'FAIL' | 'INFO';

interface CheckResult {
  readonly id: string;
  readonly label: string;
  readonly status: CheckStatus;
  readonly detail: string;
}

const USAGE = `사용법: pnpm exec tsx scripts/krx-smoke.ts [--date YYYY-MM-DD] [--years y1,y2,...]

KRX Open API 네 서비스(KOSPI·KOSDAQ 종목기본정보·일별매매정보)의 실응답이 계약
v1(krx-contract.ts)·필터 정책(krx-filter-policy.ts)과 맞는지 확인한다 (REVIEW §11.4).

옵션:
  --date <YYYY-MM-DD>   상장폐지 포함·조인 무결성을 확인할 기준일 (기본 2016-01-04)
  --years <y1,y2,...>   분류 필드 allowlist 를 대조할 연도 목록 (기본 2010,2015,2020,2025)
  --help                이 도움말 출력

필수 환경변수: KRX_API_KEY (없으면 즉시 안내하고 exit 1)
선택 환경변수: KRX_BASE_URL(기본 https://data-dx.krx.co.kr), KRX_APPROVAL_EXPIRY

실패 항목이 하나라도 있으면 exit 1로 끝난다 — 통과 전에는 실서비스 사용을 열지 않는다.`;

interface Args {
  readonly date: string;
  readonly years: readonly number[];
}

function parseArgs(argv: readonly string[]): Args {
  const flags = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (key?.startsWith('--') && value !== undefined) flags.set(key.slice(2), value);
  }

  const date = flags.get('date') ?? '2016-01-04';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(`--date 는 YYYY-MM-DD 형식이어야 합니다: ${date}`);
  }

  const yearsRaw = flags.get('years') ?? '2010,2015,2020,2025';
  const years = yearsRaw.split(',').map((part) => Number(part.trim()));
  if (years.length === 0 || years.some((year) => !Number.isInteger(year))) {
    throw new Error(`--years 는 정수를 쉼표로 구분한 목록이어야 합니다: ${yearsRaw}`);
  }

  return { date, years };
}

function record(results: CheckResult[], id: string, label: string, status: CheckStatus, detail: string): void {
  results.push({ id, label, status, detail });
  const tag = status === 'PASS' ? '[통과]' : status === 'FAIL' ? '[실패]' : '[참고]';
  console.log(`${tag} ${id}. ${label} — ${detail}`);
}

/** 응답 field 이름은 진단용 표시일 뿐이다 — 계약 통과 여부는 parseBaseInfoRows/parseDailyRows(호출부인 source)가 이미 판정한다. */
function rawFieldNamesOf(rows: readonly Record<string, unknown>[]): readonly string[] {
  const fields = new Set<string>();
  for (const row of rows) for (const key of Object.keys(row)) fields.add(key);
  return [...fields].sort();
}

/**
 * KOSPI 일별 응답을 기준으로 이전 거래일을 찾는다. 운영 서비스의 해소 규칙과 같은
 * 의미다 — 두 시장은 같은 KRX 휴장일 달력을 공유하므로 KOSPI 로 찾은 날짜를 KOSDAQ
 * 조회에도 그대로 쓴다.
 */
async function resolveTradingDate(
  source: KrxHistoricalUniverseSource,
  requestedDate: string,
): Promise<{ readonly date: string; readonly kospiDaily: readonly KrxDailyTradeRow[] }> {
  for (let offset = 0; offset < MAX_TRADING_DAY_SEARCH; offset += 1) {
    const date = addCalendarDays(requestedDate, -offset);
    if (date < KRX_DATA_EPOCH) break;
    const kospiDaily = await source.fetchDailyTrades('KOSPI', date);
    if (kospiDaily.length > 0) return { date, kospiDaily };
  }
  throw new Error(`${requestedDate}부터 이전 ${MAX_TRADING_DAY_SEARCH}일 안에 KOSPI 거래일을 찾지 못했습니다.`);
}

interface JoinIntegritySummary {
  readonly duplicateBaseShortCodes: readonly string[];
  readonly duplicateDailyShortCodes: readonly string[];
  readonly unjoinedDailyShortCodes: readonly string[];
}

/** 일별 ISU_CD(=단축코드) 가 기본정보 ISU_SRT_CD 에 1:1 로 조인되는지 세기만 한다 — 판정은 하지 않는다. */
function joinIntegrityOf(
  baseRows: readonly KrxIssueBaseInfoRow[],
  dailyRows: readonly KrxDailyTradeRow[],
): JoinIntegritySummary {
  const baseCounts = new Map<string, number>();
  for (const row of baseRows) baseCounts.set(row.shortCode, (baseCounts.get(row.shortCode) ?? 0) + 1);
  const dailyCounts = new Map<string, number>();
  for (const row of dailyRows) dailyCounts.set(row.shortCode, (dailyCounts.get(row.shortCode) ?? 0) + 1);

  return {
    duplicateBaseShortCodes: [...baseCounts.entries()].filter(([, count]) => count > 1).map(([code]) => code),
    duplicateDailyShortCodes: [...dailyCounts.entries()].filter(([, count]) => count > 1).map(([code]) => code),
    unjoinedDailyShortCodes: [...dailyCounts.keys()].filter((code) => !baseCounts.has(code)),
  };
}

function mergeJoinSummaries(summaries: readonly JoinIntegritySummary[]): JoinIntegritySummary {
  return {
    duplicateBaseShortCodes: summaries.flatMap((s) => s.duplicateBaseShortCodes),
    duplicateDailyShortCodes: summaries.flatMap((s) => s.duplicateDailyShortCodes),
    unjoinedDailyShortCodes: summaries.flatMap((s) => s.unjoinedDailyShortCodes),
  };
}

/** REVIEW §4.2 — 최신 전 거래일 데이터는 다음 날 08시(KST) 이후 공개된다는 안내를 반영한다. */
function publishedThroughDate(nowMs: number): string {
  const yesterday = addCalendarDays(kstDateOf(nowMs), -1);
  return kstHourOf(nowMs) < 8 ? addCalendarDays(yesterday, -1) : yesterday;
}

/** 1. 네 API 원문 필드 목록을 계약 v1(krx-contract.ts) 대조 — 실패는 parseBaseInfoRows/parseDailyRows 가 던진다. */
async function checkContractFields(
  results: CheckResult[],
  source: KrxHistoricalUniverseSource,
  captureRawRows: () => readonly Record<string, unknown>[],
  effectiveDate: string,
): Promise<{
  readonly kospiBase: readonly KrxIssueBaseInfoRow[];
  readonly kosdaqBase: readonly KrxIssueBaseInfoRow[];
  readonly kospiDaily: readonly KrxDailyTradeRow[];
  readonly kosdaqDaily: readonly KrxDailyTradeRow[];
}> {
  const fieldsByEndpoint = new Map<string, readonly string[]>();
  let failure: string | null = null;

  async function fetchAndCapture<T>(name: string, fetcher: () => Promise<T>): Promise<T> {
    const rows = await fetcher();
    fieldsByEndpoint.set(name, rawFieldNamesOf(captureRawRows()));
    return rows;
  }

  let kospiBase: readonly KrxIssueBaseInfoRow[] = [];
  let kosdaqBase: readonly KrxIssueBaseInfoRow[] = [];
  let kospiDaily: readonly KrxDailyTradeRow[] = [];
  let kosdaqDaily: readonly KrxDailyTradeRow[] = [];

  try {
    kospiBase = await fetchAndCapture('KOSPI 종목기본정보', () => source.fetchIssueBaseInfo('KOSPI', effectiveDate));
    kosdaqBase = await fetchAndCapture('KOSDAQ 종목기본정보', () => source.fetchIssueBaseInfo('KOSDAQ', effectiveDate));
    kospiDaily = await fetchAndCapture('KOSPI 일별매매정보', () => source.fetchDailyTrades('KOSPI', effectiveDate));
    kosdaqDaily = await fetchAndCapture('KOSDAQ 일별매매정보', () => source.fetchDailyTrades('KOSDAQ', effectiveDate));
  } catch (error) {
    failure = error instanceof KrxContractError
      ? `계약 v1 위반: ${error.message}`
      : `조회 실패: ${error instanceof Error ? error.message : String(error)}`;
  }

  for (const [name, fields] of fieldsByEndpoint) {
    console.log(`     ${name} 원문 필드: ${fields.join(', ') || '(행 없음)'}`);
  }

  if (failure) {
    record(results, '1', '실응답 필드 vs 계약 v1 대조', 'FAIL', `${effectiveDate} 조회 중 ${failure}`);
  } else {
    record(
      results,
      '1',
      '실응답 필드 vs 계약 v1 대조',
      'PASS',
      `${effectiveDate} 네 API 모두 계약 v1(${KRX_CONTRACT_VERSION})을 통과 — 필드 목록은 위 로그 참고`,
    );
  }

  return { kospiBase, kosdaqBase, kospiDaily, kosdaqDaily };
}

/** 2. 상장폐지 종목(한진해운, 117930)이 2016-01-04 KOSPI 기본정보에 포함되는지 확인한다. */
function checkDelistedFixture(
  results: CheckResult[],
  kospiBase: readonly KrxIssueBaseInfoRow[],
  effectiveDate: string,
  requestedDate: string,
): void {
  const FIXTURE_DATE = '2016-01-04';
  const FIXTURE_SHORT_CODE = '117930';
  const FIXTURE_NAME = '한진해운';

  if (requestedDate !== FIXTURE_DATE) {
    record(
      results,
      '2',
      '상장폐지 종목 포함 확인',
      'INFO',
      `기본 fixture(${FIXTURE_NAME} ${FIXTURE_SHORT_CODE})는 ${FIXTURE_DATE} 전용 검증이라 --date ${requestedDate} 에서는 건너뜁니다.`,
    );
    return;
  }

  const match = kospiBase.find((row) => row.shortCode === FIXTURE_SHORT_CODE);
  if (!match) {
    record(
      results,
      '2',
      '상장폐지 종목 포함 확인',
      'FAIL',
      `${effectiveDate} KOSPI 기본정보에서 ${FIXTURE_NAME}(${FIXTURE_SHORT_CODE})을 찾지 못했습니다 — 과거 유효 종목 포함 여부를 재확인하세요.`,
    );
    return;
  }

  record(
    results,
    '2',
    '상장폐지 종목 포함 확인',
    'PASS',
    `${FIXTURE_NAME}(${FIXTURE_SHORT_CODE}) 포함 확인 — 표준코드 ${match.standardCode}, 종목명 ${match.name}`,
  );
}

/** 3. 연도별 SECUGRP_NM·KIND_STKCERT_TP_NM·SECT_TP_NM 고유값을 모으고, classifyKrxIssue 로 미지값을 나열한다. */
async function checkYearlyClassification(
  results: CheckResult[],
  source: KrxHistoricalUniverseSource,
  years: readonly number[],
): Promise<void> {
  const uniqueBySection = { securityGroup: new Set<string>(), stockKind: new Set<string>(), section: new Set<string>() };
  const unknowns = new Set<string>();
  const perYearNotes: string[] = [];
  let hadFetchFailure = false;

  for (const year of years) {
    const date = `${year}-01-04`;
    try {
      const rows = (
        await Promise.all(MARKETS.map((market) => source.fetchIssueBaseInfo(market, date)))
      ).flat();
      for (const row of rows) {
        uniqueBySection.securityGroup.add(row.securityGroupRaw);
        if (row.stockKindRaw !== null) uniqueBySection.stockKind.add(row.stockKindRaw);
        if (row.sectionRaw !== null) uniqueBySection.section.add(row.sectionRaw);
        try {
          classifyKrxIssue(row);
        } catch (error) {
          if (error instanceof UnknownKrxClassificationError) {
            unknowns.add(`${error.field}=${error.value} (예: ${row.shortCode})`);
          } else {
            throw error;
          }
        }
      }
      perYearNotes.push(`${year}(${date}): ${rows.length}행`);
    } catch (error) {
      hadFetchFailure = true;
      perYearNotes.push(`${year}(${date}): 조회 실패 — ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  console.log(`     연도별 조회: ${perYearNotes.join(' / ')}`);
  console.log(`     SECUGRP_NM 고유값: ${[...uniqueBySection.securityGroup].join(', ') || '(없음)'}`);
  console.log(`     KIND_STKCERT_TP_NM 고유값: ${[...uniqueBySection.stockKind].join(', ') || '(없음)'}`);
  console.log(`     SECT_TP_NM 고유값: ${[...uniqueBySection.section].join(', ') || '(없음)'}`);

  if (unknowns.size > 0) {
    record(
      results,
      '3',
      '연도별 분류값 vs allowlist 대조',
      'FAIL',
      `필터 정책(krx-filter-policy.ts)이 모르는 값 ${unknowns.size}건: ${[...unknowns].join('; ')}`,
    );
    return;
  }
  if (hadFetchFailure) {
    record(
      results,
      '3',
      '연도별 분류값 vs allowlist 대조',
      'FAIL',
      '일부 연도 조회에 실패해 allowlist 대조를 완전히 마치지 못했습니다 — 위 연도별 조회 로그를 확인하세요.',
    );
    return;
  }
  record(
    results,
    '3',
    '연도별 분류값 vs allowlist 대조',
    'PASS',
    `${years.join(', ')}년 모두 미지 분류값 없음 (필터 정책 버전은 domain/krx-filter-policy.ts 참고)`,
  );
}

/** 4. 일별 ISU_CD(단축코드) 와 기본정보 ISU_SRT_CD 의 조인 무결성 — 미조인·중복 수를 센다. */
function checkJoinIntegrity(
  results: CheckResult[],
  kospiBase: readonly KrxIssueBaseInfoRow[],
  kosdaqBase: readonly KrxIssueBaseInfoRow[],
  kospiDaily: readonly KrxDailyTradeRow[],
  kosdaqDaily: readonly KrxDailyTradeRow[],
  effectiveDate: string,
): void {
  if (kospiDaily.length === 0 || kosdaqDaily.length === 0) {
    record(
      results,
      '4',
      '일별↔기본정보 조인 무결성',
      'FAIL',
      `${effectiveDate} 두 시장의 일별매매정보가 모두 있어야 조인을 확인할 수 있습니다 (KOSPI ${kospiDaily.length}행, KOSDAQ ${kosdaqDaily.length}행).`,
    );
    return;
  }

  const merged = mergeJoinSummaries([
    joinIntegrityOf(kospiBase, kospiDaily),
    joinIntegrityOf(kosdaqBase, kosdaqDaily),
  ]);
  const problemCount =
    merged.duplicateBaseShortCodes.length
    + merged.duplicateDailyShortCodes.length
    + merged.unjoinedDailyShortCodes.length;

  if (problemCount > 0) {
    record(
      results,
      '4',
      '일별↔기본정보 조인 무결성',
      'FAIL',
      `${effectiveDate} 미조인 ${merged.unjoinedDailyShortCodes.length}건, 기본정보 중복 ${merged.duplicateBaseShortCodes.length}건, `
      + `일별 중복 ${merged.duplicateDailyShortCodes.length}건 — 예: `
      + [...merged.unjoinedDailyShortCodes, ...merged.duplicateBaseShortCodes, ...merged.duplicateDailyShortCodes]
        .slice(0, 5)
        .join(', '),
    );
    return;
  }
  record(
    results,
    '4',
    '일별↔기본정보 조인 무결성',
    'PASS',
    `${effectiveDate} KOSPI ${kospiDaily.length}행, KOSDAQ ${kosdaqDaily.length}행 모두 미조인·중복 0건`,
  );
}

/** 5. 휴장일·과거일·최근 공개일을 각 1회만 조회해 요약한다 — 재탐색하지 않는다. */
async function checkCalendarEdges(results: CheckResult[], source: KrxHistoricalUniverseSource, nowMs: number): Promise<void> {
  const recentDate = publishedThroughDate(nowMs);

  async function once(label: string, date: string): Promise<{ readonly rows: number; readonly error: string | null }> {
    try {
      const rows = await source.fetchDailyTrades('KOSPI', date);
      return { rows: rows.length, error: null };
    } catch (error) {
      return { rows: 0, error: error instanceof Error ? error.message : String(error) };
    }
  }

  const holiday = await once('휴장일', KNOWN_HOLIDAY_DATE);
  const old = await once('과거일', KRX_DATA_EPOCH);
  const recent = await once('최근 공개일', recentDate);

  console.log(`     휴장일 ${KNOWN_HOLIDAY_DATE}: ${holiday.error ?? `${holiday.rows}행`}`);
  console.log(`     과거일(공식 시작일) ${KRX_DATA_EPOCH}: ${old.error ?? `${old.rows}행`}`);
  console.log(`     최근 공개일 ${recentDate}: ${recent.error ?? `${recent.rows}행`} (거래일이 아니면 0행일 수 있음)`);

  const failures: string[] = [];
  if (holiday.error) failures.push(`휴장일 조회 오류: ${holiday.error}`);
  else if (holiday.rows !== 0) failures.push(`휴장일(${KNOWN_HOLIDAY_DATE})인데 일별 응답이 ${holiday.rows}행 — KRX 는 1월 1일에 항상 휴장한다`);
  if (old.error) failures.push(`과거일 조회 오류: ${old.error}`);
  else if (old.rows === 0) failures.push(`공식 제공 시작일(${KRX_DATA_EPOCH})인데 일별 응답이 비어 있음`);
  if (recent.error) failures.push(`최근 공개일 조회 오류: ${recent.error}`);

  if (failures.length > 0) {
    record(results, '5', '휴장일·과거일·최근 공개일 조회', 'FAIL', failures.join(' / '));
    return;
  }
  record(
    results,
    '5',
    '휴장일·과거일·최근 공개일 조회',
    'PASS',
    `휴장일 0행, 과거일 ${old.rows}행, 최근 공개일(${recentDate}) ${recent.rows}행 — 위 로그 참고`,
  );
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(USAGE);
    return;
  }

  const args = parseArgs(argv);

  const apiKey = process.env.KRX_API_KEY;
  if (!apiKey) {
    console.error('KRX_API_KEY 가 설정되지 않았습니다.');
    console.error('KRX Open API 인증키를 발급받고 KOSPI·KOSDAQ 종목기본정보·일별매매정보 네 API 이용 승인을 받은 뒤,');
    console.error('KRX_API_KEY 환경변수로 설정하고 다시 실행하세요 (infra/app.env.example 참고).');
    console.error('선택: KRX_BASE_URL(기본 https://data-dx.krx.co.kr), KRX_APPROVAL_EXPIRY(YYYY-MM-DD)도 함께 설정할 수 있습니다.');
    process.exitCode = 1;
    return;
  }

  const logger = pino({
    level: process.env.LOG_LEVEL ?? 'warn',
    redact: { paths: ['AUTH_KEY', 'apiKey'], censor: '[REDACTED]' },
  });

  let capturedRawRows: readonly Record<string, unknown>[] = [];
  // RestClient 의 fetchImpl 을 감싸 원문 JSON 을 곁눈질한다 — source 가 파싱해 버리기 전
  // 필드 이름을 보는 유일한 방법이다. 이 변수를 읽는 곳은 checkContractFields 뿐이고,
  // 그 안에서는 네 호출을 항상 순차(await)로만 하므로 "바로 전 호출의 원문"이라는
  // 전제가 어긋나지 않는다. 다른 검사(연도별 분류 등)는 동시 호출을 쓰지만 이 변수를
  // 읽지 않으므로 뒤섞여도 무해하다.
  const capturingFetch: typeof fetch = async (input, init) => {
    const response = await fetch(input, init);
    if (response.ok) {
      try {
        const payload = (await response.clone().json()) as { OutBlock_1?: unknown };
        capturedRawRows = Array.isArray(payload.OutBlock_1) ? (payload.OutBlock_1 as Record<string, unknown>[]) : [];
      } catch {
        capturedRawRows = [];
      }
    }
    return response;
  };

  const source = createKrxHistoricalUniverseSource(
    {
      baseUrl: process.env.KRX_BASE_URL ?? 'https://data-dx.krx.co.kr',
      apiKey,
      approvalExpiry: process.env.KRX_APPROVAL_EXPIRY ?? null,
    },
    systemClock,
    logger,
    { fetchImpl: capturingFetch },
  );

  console.log(`KRX smoke test 시작 — date=${args.date}, years=${args.years.join(',')}`);
  const results: CheckResult[] = [];

  try {
    const { date: effectiveDate } = await resolveTradingDate(source, args.date);
    if (effectiveDate !== args.date) {
      console.log(`     요청일 ${args.date} → 적용일 ${effectiveDate} (이전 거래일로 해소)`);
    }

    const { kospiBase, kosdaqBase, kospiDaily, kosdaqDaily } = await checkContractFields(
      results,
      source,
      () => capturedRawRows,
      effectiveDate,
    );
    checkDelistedFixture(results, kospiBase, effectiveDate, args.date);
    checkJoinIntegrity(results, kospiBase, kosdaqBase, kospiDaily, kosdaqDaily, effectiveDate);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    record(results, '1', '실응답 필드 vs 계약 v1 대조', 'FAIL', `기준일 해소 실패: ${message}`);
    record(results, '2', '상장폐지 종목 포함 확인', 'FAIL', '1번 항목 실패로 확인할 수 없습니다.');
    record(results, '4', '일별↔기본정보 조인 무결성', 'FAIL', '1번 항목 실패로 확인할 수 없습니다.');
  }

  await checkYearlyClassification(results, source, args.years);
  await checkCalendarEdges(results, source, systemClock.now());

  const totalCalls = source.todayCallCount();
  record(results, '6', '총 호출 수', 'INFO', `오늘 누적 ${totalCalls}회 (일일 한도 10,000회, REVIEW §10)`);

  const failed = results.filter((result) => result.status === 'FAIL');
  console.log('');
  console.log(`요약: 통과 ${results.filter((r) => r.status === 'PASS').length}건 / 실패 ${failed.length}건 / 참고 ${results.filter((r) => r.status === 'INFO').length}건`);
  if (failed.length > 0) {
    console.log('실패 항목이 있어 과거 유니버스 기능을 실서비스에 열 수 없습니다:');
    for (const result of failed) console.log(`  - ${result.id}. ${result.label}: ${result.detail}`);
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  if (error instanceof KrxNotConfiguredError || error instanceof KrxApprovalExpiredError) {
    console.error(error.message);
  } else {
    console.error(error instanceof Error ? error.stack ?? error.message : error);
  }
  process.exitCode = 1;
});
