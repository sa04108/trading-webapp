import {
  BACKTEST_WIZARD_DRAFT_STEPS,
  type BacktestWizardDraftPayloadMap,
  type BacktestWizardDraftStep,
} from '../../../shared/schemas/backtest-wizard-draft.js';
import { api } from '@/lib/api-client';

export type BacktestWizardDraftBundle = {
  [S in BacktestWizardDraftStep]?: BacktestWizardDraftPayloadMap[S];
};

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
  await api(`/backtests/wizard-draft/${step}${contextQuery(sourceJobId)}`, {
    method: 'PUT',
    body: JSON.stringify(payload),
    // 큰 유니버스 미리보기는 브라우저 keepalive body 상한을 넘을 수 있어 unload 때만 쓴다.
    keepalive: options.keepalive,
  });
}

export async function clearBacktestWizardDraft(sourceJobId: string | null): Promise<void> {
  await api(`/backtests/wizard-draft${contextQuery(sourceJobId)}`, { method: 'DELETE' });
}
