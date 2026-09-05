export type PreparationIssueSource =
  | 'KRX_CLASSIFICATION'
  | 'KRX_SELECTION_METRIC'
  | 'KRX_PRICE'
  | 'DART_FINANCIAL'
  | 'DART_CORPORATE_ACTION'
  | 'KRX_TRADING_STATUS';

export interface PreparationIssue {
  readonly source: PreparationIssueSource;
  readonly reason: string;
  readonly disposition: 'EXCLUDED' | 'NOTICE';
  readonly symbol: string;
  readonly period: string;
  readonly detail: string;
}

export interface PreparationIssueGroup {
  readonly key: string;
  readonly source: PreparationIssueSource;
  readonly reason: string;
  readonly disposition: PreparationIssue['disposition'];
  readonly symbols: readonly {
    readonly symbol: string;
    readonly details: readonly { readonly period: string; readonly detail: string }[];
  }[];
}

export const PREPARATION_SOURCE_LABELS: Record<PreparationIssueSource, string> = {
  KRX_CLASSIFICATION: 'KRX · 종목정보',
  KRX_SELECTION_METRIC: 'KRX · 선정지표',
  KRX_PRICE: 'KRX · 일봉',
  DART_FINANCIAL: 'DART · 재무',
  DART_CORPORATE_ACTION: 'DART · 자본변동',
  KRX_TRADING_STATUS: 'KRX · 거래상태',
};

const SOURCES: Record<string, PreparationIssueSource> = {
  'KRX 종목 분류': 'KRX_CLASSIFICATION',
  'KRX 선정 지표': 'KRX_SELECTION_METRIC',
  'KRX 가격': 'KRX_PRICE',
  'DART 재무': 'DART_FINANCIAL',
  '자본변동': 'DART_CORPORATE_ACTION',
  'DART 자본변동': 'DART_CORPORATE_ACTION',
};

const SOURCE_ORDER = Object.keys(PREPARATION_SOURCE_LABELS);

/** 날짜나 수량이 달라도 같은 원인을 묶고, 원문은 종목 상세에 보존한다. */
function reasonLabel(source: PreparationIssueSource, detail: string): string {
  if (source === 'KRX_CLASSIFICATION') {
    if (detail.includes('기본정보 행 누락')) return '종목 기본정보 누락';
    if (detail.includes('상장주식수 누락')) return '상장주식수 누락';
    if (detail.includes('종목 분류 필드')) return '종목 분류 해석 불가';
  }
  if (source === 'KRX_SELECTION_METRIC') {
    if (detail.includes('MARKET_CAP')) return '시가총액 누락';
    if (detail.includes('TRADING_VALUE')) return '거래대금 누락';
    if (detail.includes('VOLUME')) return '거래량 누락';
  }
  if (source === 'KRX_PRICE') {
    if (/거래일 일봉 부족/.test(detail)) return '계산에 필요한 거래일 일봉 부족';
    if (/활성 기간의 KRX 일봉 .*누락/.test(detail)) return '편입 기간의 일봉 누락';
  }
  if (source === 'DART_FINANCIAL' || source === 'DART_CORPORATE_ACTION') {
    if (detail.includes('corp_code')) return '기업코드 매핑 없음';
    if (detail.includes('응답 필드를 읽을 수 없습니다')) {
      const field = /응답 필드를 읽을 수 없습니다:\s*([^\s(/]+)/.exec(detail)?.[1];
      const fieldLabels: Record<string, string> = {
        isu_dcrs_stle: '발행형태', isu_dcrs_de: '자본변동 일자', isu_dcrs_qy: '변동 수량',
        rcept_no: '접수번호', account_id: '계정 코드', account_nm: '계정명',
      };
      return field && fieldLabels[field] ? `${fieldLabels[field]} 필드 누락` : '필수 응답 필드 누락';
    }
    if (detail.includes('분류할 수 없는 발행형태')) return '발행형태 분류 불가';
    if (detail.includes('정렬할 수 없는 자본변동')) return 'KRX 상장주식수 변경일과 대응 불가';
    if (detail.includes('공시마다 다릅니다')) return '공시 간 자본변동 수치 불일치';
    if (detail.includes('주식분할 변동 수량')) return '발행주식수와 분할 수량 불일치';
    if (detail.includes('이벤트 직전 발행주식수')) return '보정에 필요한 직전 발행주식수 없음';
    if (detail.includes('보정 비율이 유효하지')) return '유효하지 않은 보정 비율';
    if (detail.includes('변동 수량을 읽을 수')) return '변동 수량 해석 불가';
    if (detail.includes('자본변동 일자를 읽을 수')) return '자본변동 일자 해석 불가';
    if (detail.includes('접수번호를 읽을 수')) return '접수번호 해석 불가';
    if (detail.includes('coverage')) return '필요 연도 데이터 확보 불가';
    if (detail.includes('재무 계정·연속 분기·신선도')) return '전략에 필요한 재무 이력 부족';
    if (detail.includes('재무 fact 없음')) return '편입 기간에 사용 가능한 재무 데이터 없음';
    if (detail.includes('PIT 재무 값 누락')) {
      return detail.includes('PER') ? 'PER 계산에 필요한 재무 값 누락' : 'ROE 계산에 필요한 재무 값 누락';
    }
    if (detail.includes('매핑되지 않은 계정')) return '재무 계정 매핑 불가';
    if (detail.includes('금액을 읽을 수')) return '재무 금액 해석 불가';
    if (detail.includes('계정 유형이 일치하지')) return '재무 계정 유형 불일치';
    if (detail.includes('같은 보고서 안에서')) return '보고서 내 재무 값 불일치';
    if (detail.includes('직전 분기 누적값')) return '직전 분기 누적값 누락';
    if (detail.includes('직전 분기가 다른 사업연도')) return '연속 분기 사업연도 불일치';
    if (detail.includes('보고서 코드가 일치하지')) return '보고서 코드 불일치';
    if (detail.includes('행의 사업연도')) return '사업연도 불일치';
    if (detail.includes('응답 행이 모두 필터에서 제외')) return '사용 가능한 재무 응답 행 없음';
    if (detail.includes("'보통주' 행")) return '보통주 발행주식수 행 누락';
    if (detail.includes('발행주식수를 읽을 수')) return '발행주식수 해석 불가';
    if (detail.includes('원천·파서 gap')) return '원천 데이터·해석 문제';
  }
  return detail;
}

/**
 * 준비 당시 저장한 경고를 읽으므로 과거 결과와 캐시에도 같은 분류를 적용한다.
 * 형식을 확인한 준비 경고만 분리하며, 알 수 없는 문구는 나머지 경고에 남긴다.
 */
export function splitPreparationWarnings(warnings: readonly string[]): {
  readonly issues: readonly PreparationIssue[];
  readonly otherWarnings: readonly string[];
} {
  const issues: PreparationIssue[] = [];
  const otherWarnings: string[] = [];
  for (const warning of warnings) {
    const excluded = /^(.*?) 정보를 온전히 확보할 수 없어 종목 ([A-Za-z0-9._-]+)을 매매 대상에서 제외했습니다 — ([\s\S]+)\.$/.exec(warning);
    const source = excluded?.[1] ? SOURCES[excluded[1]] : undefined;
    if (excluded && source) {
      // 세미콜론은 뒤에 새 기간과 ': '가 있을 때만 경계다. 사유 원문 속 문장부호는 보존한다.
      const causes = excluded[3]!.split(/; (?=(?:\d{4}|-)[^:;]*: )/);
      for (const cause of causes) {
        const separator = cause.indexOf(': ');
        const period = separator < 0 ? '기간 정보 없음' : cause.slice(0, separator);
        const detail = separator < 0 ? cause : cause.slice(separator + 2);
        // 재무 연도 경고는 '분기: 사유 / 분기: 사유'로 여러 원인을 포함할 수 있다.
        const financialExamples = source === 'DART_FINANCIAL' && /^(?:\d{4}|-)[^:]*: /.test(detail)
          ? detail.split(/ \/ (?=(?:\d{4}|-)[^/:]*: )/)
          : null;
        for (const example of financialExamples ?? [detail]) {
          const innerSeparator = financialExamples ? example.indexOf(': ') : -1;
          const actualDetail = innerSeparator < 0 ? example : example.slice(innerSeparator + 2);
          issues.push({
            source,
            reason: reasonLabel(source, actualDetail),
            disposition: 'EXCLUDED',
            symbol: excluded[2]!,
            period: innerSeparator < 0 ? period : example.slice(0, innerSeparator),
            detail: actualDetail,
          });
        }
      }
      continue;
    }
    const notice = /^(?:.*\(([A-Za-z0-9._-]+)\)|([A-Za-z0-9._-]+)): (.+)$/.exec(warning);
    const detail = notice?.[3];
    if (notice && detail && /거래정지·무거래 기록|상장폐지됐습니다/.test(detail)) {
      issues.push({
        source: 'KRX_TRADING_STATUS',
        reason: detail.includes('상장폐지됐습니다') ? '상장폐지 이력' : '거래정지·무거래 이력',
        disposition: 'NOTICE',
        symbol: (notice[1] ?? notice[2])!,
        period: /^\d{4}-\d{2}-\d{2}(?:~\d{4}-\d{2}-\d{2})?/.exec(detail)?.[0] ?? '기간 정보 없음',
        detail,
      });
      continue;
    }
    otherWarnings.push(warning);
  }
  return { issues, otherWarnings };
}

export function groupPreparationIssues(issues: readonly PreparationIssue[]): PreparationIssueGroup[] {
  const groups = new Map<string, {
    source: PreparationIssueSource;
    reason: string;
    disposition: PreparationIssue['disposition'];
    symbols: Map<string, Map<string, { period: string; detail: string }>>;
  }>();
  for (const issue of issues) {
    const key = JSON.stringify([issue.source, issue.reason, issue.disposition]);
    let group = groups.get(key);
    if (!group) {
      group = { source: issue.source, reason: issue.reason, disposition: issue.disposition, symbols: new Map() };
      groups.set(key, group);
    }
    let details = group.symbols.get(issue.symbol);
    if (!details) {
      details = new Map();
      group.symbols.set(issue.symbol, details);
    }
    details.set(JSON.stringify([issue.period, issue.detail]), { period: issue.period, detail: issue.detail });
  }
  return [...groups].map(([key, group]) => ({
    key,
    source: group.source,
    reason: group.reason,
    disposition: group.disposition,
    symbols: [...group.symbols].sort(([a], [b]) => a.localeCompare(b)).map(([symbol, details]) => ({
      symbol,
      details: [...details.values()].sort((a, b) => a.period.localeCompare(b.period) || a.detail.localeCompare(b.detail)),
    })),
  })).sort((a, b) => SOURCE_ORDER.indexOf(a.source) - SOURCE_ORDER.indexOf(b.source)
    || a.reason.localeCompare(b.reason, 'ko'));
}
