import type {
  BacktestUniversePreview,
  PreparationInput,
} from '../../src/runtime/modules/backtest/application/backtest-preparation-orchestrator.js';
import type { TestApp } from './test-app.js';
import { waitForCondition } from './wait-for-condition.js';

export interface PrepareSubmissionOptions {
  readonly signal: AbortSignal;
  readonly timeoutMs?: number;
}

export interface PreparedSubmission {
  readonly preparationJobId: string;
  readonly preview: BacktestUniversePreview;
}

/** 준비 API의 202→terminal→200 흐름과 현재 사용자의 wizard 참조를 확정한다. */
export async function prepareSubmission(
  ctx: TestApp,
  cookie: string,
  input: PreparationInput,
  options: PrepareSubmissionOptions,
): Promise<PreparedSubmission> {
  const request = () => ctx.app.inject({
    method: 'POST',
    url: '/api/v1/backtests/universe-preview',
    cookies: { session: cookie },
    payload: input,
  });
  let response = await request();
  if (response.statusCode !== 200 && response.statusCode !== 202)
    throw new Error(`preparation 시작 실패: ${response.statusCode} ${response.body}`);

  let preparationJobId: string;
  if (response.statusCode === 202) {
    preparationJobId = response.json<{ job: { id: string } }>().job.id;
    const job = await waitForCondition(
      () => ctx.container.backtestPreparationOrchestrator.get(preparationJobId),
      (value) => value?.status === 'COMPLETED'
        || value?.status === 'FAILED'
        || value?.status === 'CANCELLED',
      {
        signal: options.signal,
        timeoutMs: options.timeoutMs ?? 5_000,
        label: `preparation ${preparationJobId}`,
        describe: (value) => value === null ? null : {
          id: value.id,
          status: value.status,
          phase: value.phase,
          overallProgress: value.overallProgress,
          doneSymbols: value.doneSymbols,
          totalSymbols: value.totalSymbols,
          savedFacts: value.savedFacts,
          gapCount: value.gapCount,
          error: value.error,
        },
      },
    );
    if (job?.status !== 'COMPLETED')
      throw new Error(`preparation 실패: ${JSON.stringify(job)}`);
    response = await request();
  } else {
    preparationJobId = response.json<BacktestUniversePreview>().preparationJobId ?? '';
  }

  if (response.statusCode !== 200)
    throw new Error(`preparation 완료 확인 실패: ${response.statusCode} ${response.body}`);
  const preview = response.json<BacktestUniversePreview>();
  const resolvedId = preview.preparationJobId ?? preparationJobId;
  if (resolvedId.length === 0)
    throw new Error('preparation 완료 응답에 job id가 없습니다');
  return { preparationJobId: resolvedId, preview };
}
