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
import { DART_MIN_INTERVAL_MS } from '../../domain/sync-plan.js';
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
  REPORT_ORDER,
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
 * (toss-stock-info-source.ts 와 같은 관례). 필드 이름이 틀리면 파싱이 gap 으로
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
    // 목적은 일일 한도 절약이 아니라 초당 폭주 방지다. 이 값을 화면 추정치와 공유하기
    // 위해 domain/sync-plan.ts 에서 가져온다 — 두 곳에 숫자를 두면 한쪽만 고쳐진다.
    groupMinIntervalMs: { default: DART_MIN_INTERVAL_MS },
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
        throw new Error(`DART 종목 코드 목록을 내려받지 못했습니다 (HTTP ${response.status})`);
      }
      return Buffer.from(await response.arrayBuffer());
    });

  // stockTotqySttus(주식의 총수 현황)는 fetchFinancials 와 fetchCorporateActions 양쪽에서
  // (corp_code, year, reportCode) 조합마다 필요하다 — 같은 소스 인스턴스 안에서 두 번
  // 부르면 호출 수가 그만큼 늘어 수집 시간이 길어진다. 결과를 공유한다.
  const shareRowsCache = new Map<string, Promise<readonly DartShareRow[]>>();
  function fetchShareRows(
    corpCode: string,
    year: number,
    reportCode: DartReportCode,
  ): Promise<readonly DartShareRow[]> {
    const cacheKey = `${corpCode}:${year}:${reportCode}`;
    const cached = shareRowsCache.get(cacheKey);
    if (cached) return cached;
    const promise = call<DartShareRow>('/api/stockTotqySttus.json', {
      corp_code: corpCode,
      bsns_year: String(year),
      reprt_code: reportCode,
    });
    shareRowsCache.set(cacheKey, promise);
    return promise;
  }

  /** 응답 행에서 '보통주' 행만 골라낸다. se 가 문자열이 아니면(필드명이 바뀐 경우)
   *  .replace 가 TypeError 를 던지므로 typeof 로 먼저 막는다 — 그런 행은 매칭 실패로
   *  취급해 호출부가 gap 을 남기게 한다. */
  function findCommonShareRow(rows: readonly DartShareRow[]): DartShareRow | undefined {
    return rows.find((row) => typeof row.se === 'string' && row.se.replace(/\s/g, '') === '보통주');
  }

  /** istc_totqy 가 문자열이 아니면 parseAmount 가 아니라 여기서 먼저 null 로 떨어뜨린다
   *  — 그래야 "발행주식수를 읽을 수 없습니다" gap 으로 이어지지 bare TypeError 로
   *  전체 수집이 죽지 않는다. */
  function readShareAmount(row: DartShareRow): number | null {
    return typeof row.istc_totqy === 'string' ? parseAmount(row.istc_totqy) : null;
  }

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

      for (const year of request.years) {
        const rowsByReport = new Map<DartReportCode, readonly DartFinancialRow[]>();

        for (const reportCode of REPORT_ORDER) {
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
          if (relevant.length > 0) {
            rowsByReport.set(reportCode, relevant);
          } else if (rows.length > 0) {
            // 행은 왔는데 필터를 통과한 게 하나도 없다 — sj_div/bsns_year 필드 이름이나
            // 값이 기대와 다르면 이렇게 된다. 조용히 넘기면 이 보고서 전체가 이유 없이
            // 사라진 것처럼 보이므로(파서 호출 자체가 스킵되어 gap 도 안 남는다) 여기서
            // 명시적으로 gap 을 남긴다 — 파일 헤더가 약속하는 "조용히 0 이 되지 않는다"
            // 를 이 필터 통과 시점에도 지킨다.
            gaps.push({
              symbol,
              periodKey: `${year}Q${REPORT_CODE_TO_QUARTER[reportCode]}`,
              // 값(행 수)은 반드시 괄호 안이나 콜론 뒤에 둔다 — CLI 의 gap 묶기는
              // 첫 ':' 또는 '(' 앞까지를 버킷 라벨로 쓰므로, 앞부분에 값이 섞이면
              // 같은 실패 유형이 값마다 다른 버킷으로 쪼개져 리포트가 커진다.
              reason: `응답 행이 모두 필터에서 제외됐습니다 (sj_div/bsns_year 필드 확인, ${rows.length}행)`,
            });
          }
        }

        if (rowsByReport.size > 0) {
          const parsed = parseFinancialRows(symbol, rowsByReport);
          facts.push(...parsed.facts);
          gaps.push(...parsed.gaps);
        }
      }

      // 발행주식수 — 정기보고서별로 조회하고 그 보고서의 분기에 붙인다. DART
      // stockTotqySttus 는 사업보고서뿐 아니라 분기·반기보고서에도 '주식의 총수
      // 현황' 섹션을 담고 있어 네 보고서 모두 조회 대상이다.
      //
      // shareYears 는 years 의 각 연도마다 직전 1년을 더한 집합이라 원소 수가 다르다 —
      // 재무 루프 안에 두면 연도가 어긋나므로 별도 루프로 돈다.
      for (const year of request.shareYears) {
        for (const reportCode of REPORT_ORDER) {
          const shareRows = await fetchShareRows(corpCode, year, reportCode);
          // 보통주만 쓴다 — 시가총액은 봉 종가(보통주 가격) × 보통주 수다.
          // '합계' 행을 쓰면 우선주가 섞여 시가총액이 과대계상된다.
          const common = findCommonShareRow(shareRows);
          const periodKey = `${year}Q${REPORT_CODE_TO_QUARTER[reportCode]}`;
          if (common) {
            const value = readShareAmount(common);
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
    }

    return { facts, gaps };
  }

  async function fetchCorporateActions(
    request: FetchFinancialsRequest,
  ): Promise<FactIngestionResult> {
    const facts: Fact[] = [];
    const gaps: FactIngestionGap[] = [];

    for (const symbol of request.symbols) {
      const corpCode = await corpCodes.resolve(symbol);
      if (corpCode === null) {
        gaps.push({ symbol, periodKey: '-', reason: 'DART corp_code 매핑에 없는 종목코드입니다' });
        continue;
      }

      // 같은 (field, periodKey) 자본변동을 접는다 — 아래 루프 주석 참고. 심볼 루프
      // 안에서 매번 새로 만든다 — 바깥에 두고 매 심볼 끝에 clear() 하는 방식은, 나중에
      // 누군가 clear() 호출 앞에 continue 를 추가하면 이전 심볼의 항목이 다음 심볼로
      // 새어나가는데(이 맵의 키에는 symbol 이 들어있지 않다) 그 실수를 컴파일러도
      // 테스트도 아닌 리뷰에만 의존해 잡아야 한다 — 스코프 자체를 좁혀 구조적으로
      // 불가능하게 만든다.
      const actionByKey = new Map<string, Fact>();

      /** 'YYYY-MM-DD' → 그 시점 직전 발행주식수. 분기 공시값 중 이벤트 이전 최신값 */
      const sharesByPeriod: Array<{ dateKey: string; shares: number }> = [];

      // 앵커 때문에 shareYears 를 돈다 — 대상 연도만 읽으면 그 연도 연초 이벤트의
      // 직전 발행주식수가 없어 비율이 gap 이 되고, 불연속 구간의 앵커가 빠지면 구멍
      // 건너편의 낡은 공시가 분모로 잡혀 gap 도 없이 틀린다 (domain/sync-plan.ts 참고)
      for (const year of request.shareYears) {
        for (const reportCode of REPORT_ORDER) {
          const shareRows = await fetchShareRows(corpCode, year, reportCode);
          const common = findCommonShareRow(shareRows);
          if (!common) continue;
          const shares = readShareAmount(common);
          const asOf = receiptDateToAsOfTsMs(common.rcept_no);
          if (shares === null || shares <= 0 || asOf === null) continue;
          sharesByPeriod.push({ dateKey: new Date(asOf).toISOString().slice(0, 10), shares });
        }
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

      for (const year of request.years) {
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
    }

    return { facts, gaps };
  }

  return { fetchFinancials, fetchCorporateActions };
}
