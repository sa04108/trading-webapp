import {
  BACKTEST_WIZARD_DRAFT_STEPS,
  type BacktestWizardPageStep,
  type BacktestWizardDraftPayloadMap,
  type BacktestWizardDraftStep,
} from '../../../shared/schemas/backtest-wizard-draft.js';
import { api } from '@/lib/api-client';

export type BacktestWizardDraftBundle = {
  [S in BacktestWizardDraftStep]?: BacktestWizardDraftPayloadMap[S];
};

export interface BacktestWizardResumeCandidate {
  sourceJobId: string | null;
  currentStep: BacktestWizardPageStep;
  updatedAtMs: number;
}

const pendingDraftSaves = new Set<Promise<unknown>>();

function trackDraftSave<T>(request: Promise<T>): Promise<T> {
  pendingDraftSaves.add(request);
  void request.then(
    () => pendingDraftSaves.delete(request),
    () => pendingDraftSaves.delete(request),
  );
  return request;
}

/** 같은 문서에서 막 시작한 unload/unmount 저장보다 진입 판정이 앞서는 경합을 막는다. */
async function waitForPendingDraftSaves(): Promise<void> {
  while (pendingDraftSaves.size > 0) {
    await Promise.allSettled([...pendingDraftSaves]);
  }
}

function contextQuery(sourceJobId: string | null): string {
  if (sourceJobId === null) return '';
  return `?${new URLSearchParams({ sourceJobId })}`;
}

export async function loadBacktestWizardDraft(
  sourceJobId: string | null,
): Promise<BacktestWizardDraftBundle> {
  const query = contextQuery(sourceJobId);
  const entries = await Promise.all(BACKTEST_WIZARD_DRAFT_STEPS.map(async (step) => {
    const response = await api<{
      draft: { payload: BacktestWizardDraftPayloadMap[typeof step] } | null;
    }>(`/backtests/wizard-draft/${step}${query}`);
    return response.draft === null ? null : [step, response.draft.payload] as const;
  }));
  return Object.fromEntries(entries.filter((entry) => entry !== null)) as BacktestWizardDraftBundle;
}

export async function saveBacktestWizardDraftStep<S extends BacktestWizardDraftStep>(
  sourceJobId: string | null,
  step: S,
  payload: BacktestWizardDraftPayloadMap[S],
  options: { keepalive?: boolean } = {},
): Promise<void> {
  await trackDraftSave(api(`/backtests/wizard-draft/${step}${contextQuery(sourceJobId)}`, {
    method: 'PUT',
    body: JSON.stringify(payload),
    // 큰 유니버스 미리보기는 브라우저 keepalive body 상한을 넘을 수 있어 unload 때만 쓴다.
    keepalive: options.keepalive,
  }));
}

export async function clearBacktestWizardDraft(sourceJobId: string | null): Promise<void> {
  await waitForPendingDraftSaves();
  await api(`/backtests/wizard-draft${contextQuery(sourceJobId)}`, { method: 'DELETE' });
}

export async function clearAllBacktestWizardDrafts(): Promise<void> {
  await waitForPendingDraftSaves();
  await api('/backtests/wizard-draft?all=true', { method: 'DELETE' });
}

export async function loadBacktestWizardResumeCandidate(): Promise<
  BacktestWizardResumeCandidate | null
> {
  await waitForPendingDraftSaves();
  const response = await api<{ candidate: BacktestWizardResumeCandidate | null }>(
    '/backtests/wizard-draft',
  );
  return response.candidate;
}
