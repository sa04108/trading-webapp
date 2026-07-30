/**
 * 비용·슬리피지 프로파일의 요율 표기 — id 만으로는 얼마가 붙는지 알 수 없어
 * 위저드 선택지와 재현 정보에 요율을 함께 적는다.
 */
function percent(rate: number): string {
  // 0.00015 → '0.015%' — 지수 표기 없이, 뒤쪽 0 은 버린다
  return `${Number.parseFloat((rate * 100).toFixed(6))}%`;
}

export function costProfileLabel(profile: {
  buyCommissionRate: number;
  sellCommissionRate: number;
  sellTaxRate: number;
}): string {
  const { buyCommissionRate: buy, sellCommissionRate: sell, sellTaxRate: tax } = profile;
  if (buy === 0 && sell === 0 && tax === 0) return '무비용';
  const commission =
    buy === sell ? `수수료 ${percent(buy)}` : `수수료 매수 ${percent(buy)} · 매도 ${percent(sell)}`;
  return `${commission} · 매도세 ${percent(tax)}`;
}

export function slippageProfileLabel(profile: { bps: number; fixed: number }): string {
  if (profile.bps === 0 && profile.fixed === 0) return '무슬리피지';
  return profile.fixed > 0 ? `${profile.bps}bp + ${profile.fixed}원` : `${profile.bps}bp`;
}
