/** 손익 표기: 색상만으로 표현하지 않고 항상 부호를 붙인다 (스펙 §17) */
export function formatSignedPct(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '-';
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(digits)}%`;
}

export function formatKrw(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '-';
  return `${Math.round(value).toLocaleString('ko-KR')}원`;
}

export function formatSignedKrw(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '-';
  const sign = value > 0 ? '+' : '';
  return `${sign}${Math.round(value).toLocaleString('ko-KR')}원`;
}

export function formatNumber(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '-';
  return value.toFixed(digits);
}

export function formatDateTime(tsMs: number | null | undefined): string {
  if (!tsMs) return '-';
  const date = new Date(tsMs);
  return `${date.getFullYear()}.${String(date.getMonth() + 1).padStart(2, '0')}.${String(
    date.getDate(),
  ).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(
    date.getMinutes(),
  ).padStart(2, '0')}`;
}

export function formatDate(tsMs: number | null | undefined): string {
  if (!tsMs) return '-';
  return new Date(tsMs).toISOString().slice(0, 10);
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '-';
  const hours = Math.floor(ms / 3_600_000);
  const days = Math.floor(hours / 24);
  if (days > 0) return `${days}일 ${hours % 24}시간`;
  const minutes = Math.floor((ms % 3_600_000) / 60_000);
  return hours > 0 ? `${hours}시간 ${minutes}분` : `${minutes}분`;
}

/** 봉 주기 표기 — 화면에는 '1m' 같은 코드가 아니라 사람이 읽는 이름만 쓴다 */
export function timeframeLabel(timeframe: string): string {
  if (timeframe === '1m') return '1분봉';
  if (timeframe === '1h') return '1시간봉';
  if (timeframe === '1d') return '일봉';
  return timeframe;
}

/**
 * 데이터셋의 봉 주기 표기 — 보관 실체 기준. 1h 종류 데이터셋은 1분봉을 수집해
 * 보관하는 것이므로(시간봉은 파생 집계) '1분봉' 으로 말한다. 시간봉 소비 여부는
 * 백테스트 위저드의 봉 주기 선택지가 답한다.
 */
export function datasetTimeframeLabel(timeframe: string): string {
  return timeframe === '1h' ? '1분봉' : timeframeLabel(timeframe);
}

/** 손익 텍스트 색상 클래스 — 부호와 함께 사용 */
export function pnlClass(value: number | null | undefined): string {
  if (value === null || value === undefined || value === 0) return 'text-muted-foreground';
  return value > 0 ? 'text-gain' : 'text-loss';
}
