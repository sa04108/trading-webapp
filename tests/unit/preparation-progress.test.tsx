import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { PreparationProgress } from '@/features/backtests/preparation-progress';
import {
  formatPreparationResumeTime,
  type BacktestPreparationJob,
} from '@/features/backtests/preparation-live';

function job(overrides: Partial<BacktestPreparationJob>): BacktestPreparationJob {
  return {
    id: 'prep_1',
    requestHash: 'hash_1',
    status: 'QUEUED',
    phase: 'MARKET_DATA',
    doneSymbols: 0,
    totalSymbols: 0,
    savedFacts: 0,
    gapCount: 0,
    nextResumeAtMs: null,
    error: null,
    ...overrides,
  };
}

describe('PreparationProgress', () => {
  it('QUEUED 는 대기 문구를 보여주고 취소할 수 있다', () => {
    const html = renderToStaticMarkup(
      <PreparationProgress job={job({ status: 'QUEUED' })} onCancel={() => undefined} />,
    );
    expect(html).toContain('데이터 준비 대기 중');
    expect(html).toContain('취소');
  });

  it('RUNNING 은 phase 문구와 진행 수치, 취소 버튼을 보여준다', () => {
    const html = renderToStaticMarkup(
      <PreparationProgress
        job={job({ status: 'RUNNING', phase: 'SYNCING_FACTS', doneSymbols: 3, totalSymbols: 10 })}
        onCancel={() => undefined}
      />,
    );
    expect(html).toContain('재무');
    expect(html).toContain('3');
    expect(html).toContain('10');
    expect(html).toContain('취소');
    // 진행 중 화면을 떠나도 준비가 계속된다는 안내 — 사용자가 붙어 있을 필요가 없다.
    expect(html).toContain('브라우저를 닫아도 계속됩니다');
  });

  it('WAITING_DAILY_QUOTA 는 일일 호출 한도와 다음 KST 재개 시각, 취소 버튼을 보여준다', () => {
    const waitingJob = job({
      status: 'WAITING_DAILY_QUOTA',
      phase: 'SYNCING_FACTS',
      nextResumeAtMs: Date.UTC(2026, 7, 10, 15, 0, 0),
    });
    const html = renderToStaticMarkup(
      <PreparationProgress job={waitingJob} onCancel={() => undefined} />,
    );
    expect(html).toContain('일일 호출 한도');
    expect(html).toContain(formatPreparationResumeTime(waitingJob.nextResumeAtMs));
    expect(html).toContain('취소');
  });

  it('COMPLETED 는 취소·재시도 버튼 없이 완료를 알린다', () => {
    const html = renderToStaticMarkup(
      <PreparationProgress job={job({ status: 'COMPLETED' })} onCancel={() => undefined} />,
    );
    expect(html).not.toContain('취소');
    expect(html).not.toContain('재시도');
    expect(html).not.toContain('다시 준비');
  });

  it('FAILED 는 오류와 재시도 버튼을 보여준다', () => {
    const html = renderToStaticMarkup(
      <PreparationProgress
        job={job({ status: 'FAILED', error: '동기화 실패' })}
        onCancel={() => undefined}
        onRestart={() => undefined}
      />,
    );
    expect(html).toContain('동기화 실패');
    expect(html).toContain('재시도');
  });

  it('CANCELLED 는 취소됨과 다시 준비 버튼을 보여준다', () => {
    const html = renderToStaticMarkup(
      <PreparationProgress
        job={job({ status: 'CANCELLED' })}
        onCancel={() => undefined}
        onRestart={() => undefined}
      />,
    );
    expect(html).toContain('취소됨');
    expect(html).toContain('다시 준비');
  });
});
