import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { PreparationIssueDetails, PreparationIssuesCard } from '@/features/backtests/preparation-issues-card';
import { ResultWarnings } from '@/features/backtests/result-warnings';
import { groupPreparationIssues, splitPreparationWarnings } from '@/features/backtests/preparation-issues';

const warnings = [
  'KRX 가격 정보를 온전히 확보할 수 없어 종목 000001을 매매 대상에서 제외했습니다 — 2026-01-05: DECLINE 계산에 필요한 20개 거래일 일봉 부족; 2026-02-05: DECLINE 계산에 필요한 60개 거래일 일봉 부족.',
  'KRX 가격 정보를 온전히 확보할 수 없어 종목 000002을 매매 대상에서 제외했습니다 — 2026-01-05: DECLINE 계산에 필요한 20개 거래일 일봉 부족.',
  '자본변동 정보를 온전히 확보할 수 없어 종목 000001을 매매 대상에서 제외했습니다 — 2025년/2025-01-03: 분류할 수 없는 발행형태: 원문값.',
];
const groups = groupPreparationIssues(splitPreparationWarnings(warnings).issues);

describe('준비 확인사항 표', () => {
  it('요약은 종목 코드 없이 고유 종목 수를 오른쪽 끝에 표시하고 상세 버튼을 하나만 둔다', () => {
    const html = renderToStaticMarkup(<PreparationIssuesCard warnings={warnings} />);
    expect(html).toContain('종목 수</th></tr>');
    expect(html).toContain('>2</td>');
    expect(html).toContain('>1</td>');
    expect(html).not.toContain('000001');
    expect(html).not.toContain('000002');
    expect(html.match(/자세히 보기<\/button>/g)).toHaveLength(1);
  });

  it('기본보기는 API·사유를 합치고 종목코드부터 행을 나눈다', () => {
    const html = renderToStaticMarkup(<PreparationIssueDetails groups={groups} mode="reason" />);
    expect(html).toMatch(/rowSpan="2"[^>]*>KRX · 일봉/);
    expect(html).toMatch(/rowSpan="2"[^>]*>계산에 필요한 거래일 일봉 부족/);
    expect(html.match(/>000001<\/td>/g)).toHaveLength(2);
    expect(html).toContain('2026-02-05');
    expect(html).toContain('분류할 수 없는 발행형태: 원문값');
  });

  it('종목별보기는 가장 왼쪽 코드 하나를 기준으로 모든 사유를 묶는다', () => {
    const html = renderToStaticMarkup(<PreparationIssueDetails groups={groups} mode="symbol" />);
    expect(html).toMatch(/<thead[^>]*><tr[^>]*><th[^>]*>종목코드/);
    expect(html).toMatch(/rowSpan="2"[^>]*>000001/);
    expect(html.match(/>000001<\/td>/g)).toHaveLength(1);
    expect(html).toContain('KRX · 일봉');
    expect(html).toContain('DART · 자본변동');
  });

  it('결과 화면도 준비 요약을 쓰며 나머지 경고는 코드 없이 개수와 한계를 표시한다', () => {
    const html = renderToStaticMarkup(<ResultWarnings warnings={[
      ...warnings,
      '999999 매수 거부: 현금 부족 (2026-01-03T05:00:00.000Z)',
      '999999 매수 거부: 현금 부족 (2026-01-04T05:00:00.000Z)',
      '이 백테스트가 보정하지 않는 것: 배당',
    ]} />);
    expect(html).toContain('유니버스 준비 확인사항 요약');
    expect(html).toContain('2건');
    expect(html).not.toContain('999999');
    expect(html).toContain('실행 중 발생한 경고');
    expect(html).toContain('계산 방식·한계');
    expect(html).toContain('배당');
  });

  it('빈 확인사항은 카드를 만들지 않고 미인식 확인사항은 상세 안내에 남긴다', () => {
    expect(renderToStaticMarkup(<PreparationIssuesCard warnings={[]} />)).toBe('');
    const html = renderToStaticMarkup(<PreparationIssuesCard warnings={['새 확인사항']} />);
    expect(html).toContain('기타 확인사항 1건');
  });
});
