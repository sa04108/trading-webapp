import {
  BACKTEST_WIZARD_DRAFT_STEPS,
  type BacktestWizardPageStep,
  type BacktestWizardDraftPayloadMap,
  type BacktestWizardDraftStep,
} from '../../../shared/schemas/backtest-wizard-draft.js';
import { api } from '../../lib/api-client.js';

export type BacktestWizardDraftBundle = {
  [S in BacktestWizardDraftStep]?: BacktestWizardDraftPayloadMap[S];
};

export interface BacktestWizardResumeCandidate {
  sourceJobId: string | null;
  currentStep: BacktestWizardPageStep;
  updatedAtMs: number;
}

const pendingDraftSaves = new Set<Promise<unknown>>();
const lastDraftSaveByKey = new Map<string, Promise<unknown>>();

function trackDraftSave<T>(request: Promise<T>): Promise<T> {
  pendingDraftSaves.add(request);
  void request.then(
    () => pendingDraftSaves.delete(request),
    () => pendingDraftSaves.delete(request),
  );
  return request;
}

/**
 * 같은 문맥·단계의 저장은 호출 순서대로 보낸다. 이전 자동 저장이 늦게 끝나 최신
 * unmount 저장을 덮는 경합을 막되, 서로 다른 단계는 병렬로 저장한다.
 */
function enqueueDraftSave<T>(key: string, write: () => Promise<T>): Promise<T> {
  const previous = lastDraftSaveByKey.get(key);
  const request = (previous ?? Promise.resolve())
    .catch(() => undefined)
    .then(write);
  lastDraftSaveByKey.set(key, request);
  void request.then(
    () => {
      if (lastDraftSaveByKey.get(key) === request) lastDraftSaveByKey.delete(key);
    },
    () => {
      if (lastDraftSaveByKey.get(key) === request) lastDraftSaveByKey.delete(key);
    },
  );
  return trackDraftSave(request);
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
  const write = () =>
    api(`/backtests/wizard-draft/${step}${contextQuery(sourceJobId)}`, {
      method: 'PUT',
      body: JSON.stringify(payload),
      // 큰 유니버스 미리보기는 브라우저 keepalive body 상한을 넘을 수 있어 unload 때만 쓴다.
      keepalive: options.keepalive,
    });
  const key = JSON.stringify([sourceJobId, step]);
  // pagehide에서는 브라우저가 문서를 곧 폐기하므로 Promise queue 뒤에 두지 않고
  // keepalive 요청을 즉시 시작한다. SPA unmount와 평상시 자동 저장은 순서를 보장한다.
  await (
    options.keepalive
      ? trackDraftSave(write())
      : enqueueDraftSave(key, write)
  );
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
