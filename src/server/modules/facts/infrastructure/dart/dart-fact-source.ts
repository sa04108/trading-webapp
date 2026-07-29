import type { Logger } from '../../../../shared/logger.js';
import { RestClient } from '../../../../shared/rest-client.js';
import {
  FactSourceNotConfiguredError,
  type FactIngestionGap,
  type FactIngestionResult,
  type FactSource,
  type FetchFinancialsRequest,
} from '../../application/ports.js';
import type { Fact } from '../../domain/fact.js';
import {
  createDartCorpCodeCache,
  type CorpCodeResolver,
} from './dart-corp-code-cache.js';
import {
  parseAmount,
  parseFinancialRows,
  parseIssuanceRows,
  receiptDateToAsOfTsMs,
  REPORT_CODE_TO_QUARTER,
  type DartFinancialRow,
  type DartIssuanceRow,
  type DartReportCode,
} from './dart-report-parser.js';

export interface DartConfig {
  /** 예: https://opendart.fss.or.kr */
  readonly baseUrl: string;
  readonly apiKey: string;
}

interface DartEnvelope<T> {
  readonly status: string;
  readonly message: string;
  readonly list?: readonly T[];
}

interface DartShareRow {
  readonly rcept_no: string;
  /** 주식 종류 구분. '보통주' / '우선주' / '합계' */
  readonly se: string;
  /** 발행한 주식의 총수 */
  readonly istc_totqy: string;
}

const REPORT_CODES = Object.keys(REPORT_CODE_TO_QUARTER) as DartReportCode[];

/**
 * 발행주식수(stockTotqySttus)는 사업보고서에서만 갱신된다
 * (domain/fact.ts `periodKeyOf` 문서 참고). 분기보고서 코드로 반복 조회해도 같은
 * 값을 되풀이해 돌려줄 뿐이라 호출을 늘릴 이유가 없다 — 사업보고서 코드 하나만 쓴다.
 */
const ANNUAL_REPORT_CODE: DartReportCode = '11011';

/** 조회 결과 없음 — 에러가 아니다 (신규 상장·미제출 분기) */
const NO_DATA_STATUS = '013';
const OK_STATUS = '000';

/**
 * DART OpenAPI 어댑터.
 *
 * 인증은 `crtfc_key` 쿼리 파라미터다 — 공용 REST 클라이언트를 `tokenProvider` 없이
 * 쓴다 (Authorization 헤더를 붙이지 않는다). rate limit·backoff·재시도는 클라이언트가
 * 담당한다.
 *
 * 엔드포인트 경로·응답 필드 이름은 **API 키 발급 후 실제 응답으로 검증해 조정한다**
 * (kiwoom-market-data-source.ts 와 같은 관례). 필드 이름이 틀리면 파싱이 gap 으로
 * 남으므로 수집 리포트에 드러난다 — 조용히 0 이 되지 않는다.
 */
export function createDartFactSource(
  config: DartConfig | null,
  logger: Logger,
  options: {
    fetchImpl?: typeof fetch;
    sleep?: (ms: number) => Promise<void>;
    corpCodeResolver?: CorpCodeResolver;
  } = {},
): FactSource {
  if (!config) {
    return {
      fetchFinancials: () => Promise.reject(new FactSourceNotConfiguredError()),
      fetchCorporateActions: () => Promise.reject(new FactSourceNotConfiguredError()),
    };
  }
  // 내부 함수(call, corp_code fetcher)들은 나중에 호출되므로 nullable 파라미터에 대한
  // 좁힘(narrowing)이 클로저 안까지 전달되지 않는다 — non-null 로컬 상수에 옮겨 담는다
  const dartConfig: DartConfig = config;

  const client = new RestClient({
    baseUrl: dartConfig.baseUrl,
    logger,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.sleep ? { sleep: options.sleep } : {}),
    // DART 일일 한도(2만 건)를 아끼기보다 초당 폭주를 막는 것이 목적이다
    groupMinIntervalMs: { default: 120 },
  });

  async function call<T>(
    path: string,
    params: Record<string, string>,
  ): Promise<readonly T[]> {
    const query = new URLSearchParams({ crtfc_key: dartConfig.apiKey, ...params });
    const envelope = await client.request<DartEnvelope<T>>('default', `${path}?${query.toString()}`);
    if (envelope.status === NO_DATA_STATUS) return [];
    if (envelope.status !== OK_STATUS) {
      // 인증 실패·한도 초과를 빈 결과로 흡수하면 "수집했는데 0건" 으로 오해된다
      throw new Error(`DART 응답 오류 ${envelope.status}: ${envelope.message}`);
    }
    return envelope.list ?? [];
  }

  // 종목코드 → DART corp_code. 주입되지 않으면 corpCode.xml 을 1회 내려받아 캐시한다.
  const corpCodes: CorpCodeResolver =
    options.corpCodeResolver ??
    createDartCorpCodeCache(async () => {
      const query = new URLSearchParams({ crtfc_key: dartConfig.apiKey });
      const response = await (options.fetchImpl ?? fetch)(
        `${dartConfig.baseUrl}/api/corpCode.xml?${query.toString()}`,
      );
      if (!response.ok) {
        throw new Error(`corpCode.xml 다운로드 실패: ${response.status}`);
      }
      return Buffer.from(await response.arrayBuffer());
    });

  async function fetchFinancials(request: FetchFinancialsRequest): Promise<FactIngestionResult> {
    const facts: Fact[] = [];
    const gaps: FactIngestionGap[] = [];
    const fsDiv = request.consolidated ? 'CFS' : 'OFS';

    for (const symbol of request.symbols) {
      const corpCode = await corpCodes.resolve(symbol);
      if (corpCode === null) {
        // 조용히 건너뛰면 "수집했는데 이 종목만 0건" 이 되고 원인을 알 수 없다
        gaps.push({ symbol, periodKey: '-', reason: 'DART corp_code 매핑에 없는 종목코드입니다' });
        continue;
      }

      for (let year = request.fromYear; year <= request.toYear; year += 1) {
        const rowsByReport = new Map<DartReportCode, readonly DartFinancialRow[]>();

        for (const reportCode of REPORT_CODES) {
          const rows = await call<DartFinancialRow>('/api/fnlttSinglAcntAll.json', {
            corp_code: corpCode,
            bsns_year: String(year),
            reprt_code: reportCode,
            fs_div: fsDiv,
          });
          // 손익·재무상태표만 쓴다 — 현금흐름표·자본변동표는 이 전략들이 보지 않는다.
          // 파서가 소비하지 않는 통계(sj_div)를 애초에 걸러 넘겨야 '매핑되지 않은
          // 계정' gap 이 CF·SCE 행 수백 개로 부풀지 않는다.
          //
          // bsns_year 도 요청한 year 로 걸러 넘긴다: 파서는 버킷의 기준 연도를 배열의
          // 첫 행(rows[0].bsns_year)에서 가져온다 — 만약 API 가 다른 사업연도의 행을
          // 섞어 반환하고 하필 그 행이 배열 맨 앞에 오면, 기준 연도 자체가 틀어져
          // 실제로는 맞는 나머지 행 전부가 gap 이 된다(다수결이 뒤집힌다). 요청 자체가
          // bsns_year=year 로 스코프되어 있으므로 여기서 한 번 더 걸러도 손해가 없고,
          // 첫 행이 항상 올바른 연도를 가리키도록 보장한다.
          const relevant = rows.filter(
            (row) =>
              (row.sj_div === 'BS' || row.sj_div === 'IS' || row.sj_div === 'CIS') &&
              row.bsns_year === String(year),
          );
          if (relevant.length > 0) rowsByReport.set(reportCode, relevant);
        }

        if (rowsByReport.size > 0) {
          const parsed = parseFinancialRows(symbol, rowsByReport);
          facts.push(...parsed.facts);
          gaps.push(...parsed.gaps);
        }

        // 발행주식수 — 사업보고서 기준으로 연 1회만 조회한다 (ANNUAL_REPORT_CODE 주석 참고)
        const shareRows = await call<DartShareRow>('/api/stockTotqySttus.json', {
          corp_code: corpCode,
          bsns_year: String(year),
          reprt_code: ANNUAL_REPORT_CODE,
        });
        // 보통주만 쓴다 — 시가총액은 봉 종가(보통주 가격) × 보통주 수다.
        // '합계' 행을 쓰면 우선주가 섞여 시가총액이 과대계상된다.
        const common = shareRows.find((row) => row.se.replace(/\s/g, '') === '보통주');
        const periodKey = `${year}Q${REPORT_CODE_TO_QUARTER[ANNUAL_REPORT_CODE]}`;
        if (common) {
          const value = parseAmount(common.istc_totqy);
          const asOf = receiptDateToAsOfTsMs(common.rcept_no);
          if (value === null || value <= 0 || asOf === null) {
            gaps.push({ symbol, periodKey, reason: `발행주식수를 읽을 수 없습니다: ${common.istc_totqy}` });
          } else {
            facts.push({
              scope: 'SYMBOL',
              key: symbol,
              field: 'SHARES_OUTSTANDING',
              periodKey,
              asOfTsMs: asOf,
              value,
              unit: 'SHARES',
            });
          }
        } else if (shareRows.length > 0) {
          // 응답에 행은 있는데 '보통주' 로 매칭되는 행이 없다 — se 표기가 예상과 다를 수
          // 있으므로 조용히 넘기지 않고 gap 으로 남긴다 (그렇지 않으면 시가총액이 조용히
          // 계산 불가 상태가 되어도 수집 리포트에는 드러나지 않는다)
          gaps.push({
            symbol,
            periodKey,
            reason: `'보통주' 행을 찾을 수 없습니다 (se 값: ${shareRows.map((row) => row.se).join(', ')})`,
          });
        }
      }
    }

    return { facts, gaps };
  }

  async function fetchCorporateActions(
    request: FetchFinancialsRequest,
  ): Promise<FactIngestionResult> {
    const facts: Fact[] = [];
    const gaps: FactIngestionGap[] = [];

    /** 같은 (field, periodKey) 자본변동을 종목 단위로 접는다 — 아래 루프 주석 참고 */
    const actionByKey = new Map<string, Fact>();

    for (const symbol of request.symbols) {
      const corpCode = await corpCodes.resolve(symbol);
      if (corpCode === null) {
        gaps.push({ symbol, periodKey: '-', reason: 'DART corp_code 매핑에 없는 종목코드입니다' });
        continue;
      }
      /** 'YYYY-MM-DD' → 그 시점 직전 발행주식수. 분기 공시값 중 이벤트 이전 최신값 */
      const sharesByPeriod: Array<{ dateKey: string; shares: number }> = [];

      for (let year = request.fromYear; year <= request.toYear; year += 1) {
        // 발행주식수는 사업보고서에서만 갱신된다 — 연 1회만 조회한다 (ANNUAL_REPORT_CODE 주석 참고)
        const shareRows = await call<DartShareRow>('/api/stockTotqySttus.json', {
          corp_code: corpCode,
          bsns_year: String(year),
          reprt_code: ANNUAL_REPORT_CODE,
        });
        const common = shareRows.find((row) => row.se.replace(/\s/g, '') === '보통주');
        if (!common) continue;
        const shares = parseAmount(common.istc_totqy);
        const asOf = receiptDateToAsOfTsMs(common.rcept_no);
        if (shares === null || shares <= 0 || asOf === null) continue;
        sharesByPeriod.push({ dateKey: new Date(asOf).toISOString().slice(0, 10), shares });
      }
      sharesByPeriod.sort((a, b) => (a.dateKey < b.dateKey ? -1 : 1));

      const sharesBefore = (dateKey: string): number | null => {
        let found: number | null = null;
        for (const entry of sharesByPeriod) {
          if (entry.dateKey >= dateKey) break;
          found = entry.shares;
        }
        return found;
      };

      for (let year = request.fromYear; year <= request.toYear; year += 1) {
        const rows = await call<DartIssuanceRow>('/api/irdsSttus.json', {
          corp_code: corpCode,
          bsns_year: String(year),
          reprt_code: '11011', // 자본변동 이력은 사업보고서 기준으로 누적 제공된다
        });
        if (rows.length === 0) continue;
        const parsed = parseIssuanceRows(symbol, rows, sharesBefore);
        for (const fact of parsed.facts) {
          // irdsSttus 는 자본변동 이력을 연도별로 누적 제공한다 — 같은 분할이 해마다
          // 다른 rcept_no 로 반복되고, asOfTsMs 가 다르면 저장소 dedupe 를 통과한다.
          // 그대로 두면 adjusted-price 가 비율을 곱해 2:1 분할이 2년치에서 factor 4 가
          // 된다. 같은 (field, periodKey) 는 가장 이른 공시만 남긴다.
          const key = `${fact.field} ${fact.periodKey}`;
          const existing = actionByKey.get(key);
          if (!existing) {
            actionByKey.set(key, fact);
            continue;
          }
          if (existing.value !== fact.value) {
            gaps.push({
              symbol,
              periodKey: fact.periodKey,
              reason: `같은 기준일의 자본변동 비율이 공시마다 다릅니다 (${existing.value} vs ${fact.value})`,
            });
            continue;
          }
          if (fact.asOfTsMs < existing.asOfTsMs) actionByKey.set(key, fact);
        }
        gaps.push(...parsed.gaps);
      }

      facts.push(...actionByKey.values());
      actionByKey.clear();
    }

    return { facts, gaps };
  }

  return { fetchFinancials, fetchCorporateActions };
}
