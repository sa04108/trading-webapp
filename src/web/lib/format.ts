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

/**
 * "얼마나 지났나" 를 사람 말로. 절대 시각만 보여 주면 사용자가 오늘 날짜와 머릿속에서
 * 빼야 하는데, 데이터가 묵었는지는 그 뺄셈의 결과로만 판단할 수 있다.
 *
 * 문턱을 두고 경고하지는 않는다 — 며칠이면 묵은 것인지는 봉 주기(분봉/일봉)와 시장
 * 휴장에 따라 다르고, 여기서 정하면 화면이 근거 없는 정책을 말하게 된다. 경과 시간만
 * 있는 대로 보여 주고 판단은 사용자에게 맡긴다.
 */
export function formatRelativeTime(
  tsMs: number | null | undefined,
  nowMs: number,
): string {
  if (!tsMs) return '없음';
  const elapsed = nowMs - tsMs;
  // 미래 시각(시계 어긋남·서버 시각 차이)은 '방금' 으로 접는다 — '-3일 전' 은 의미가 없다
  if (elapsed < 60_000) return '방금';
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 60) return `${minutes}분 전`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}시간 전`;
  return `${Math.floor(hours / 24)}일 전`;
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

/** 손익 텍스트 색상 클래스 — 부호와 함께 사용 */
export function pnlClass(value: number | null | undefined): string {
  if (value === null || value === undefined || value === 0) return 'text-muted-foreground';
  return value > 0 ? 'text-gain' : 'text-loss';
}
