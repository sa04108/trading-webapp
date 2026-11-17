import {
  BACKTEST_WIZARD_DRAFT_STEPS,
  type BacktestWizardDraftPayloadMap,
  type BacktestWizardDraftStep,
} from "../../../shared/schemas/backtest-wizard-draft.js";
import { api } from "../../lib/api-client.js";

export type BacktestWizardDraftBundle = {
  [S in BacktestWizardDraftStep]?: BacktestWizardDraftPayloadMap[S];
};

const pendingDraftSaves = new Map<string, Set<Promise<unknown>>>();
const lastDraftSaveByKey = new Map<string, Promise<unknown>>();

function trackDraftSave<T>(wizardId: string, request: Promise<T>): Promise<T> {
  const pending = pendingDraftSaves.get(wizardId) ?? new Set();
  pendingDraftSaves.set(wizardId, pending);
  pending.add(request);
  const cleanup = (): void => {
    pending.delete(request);
    if (pending.size === 0 && pendingDraftSaves.get(wizardId) === pending)
      pendingDraftSaves.delete(wizardId);
  };
  void request.then(cleanup, cleanup);
  return request;
}

/**
 * 같은 문맥·단계의 저장은 호출 순서대로 보낸다. 이전 자동 저장이 늦게 끝나 최신
 * unmount 저장을 덮는 경합을 막되, 서로 다른 단계는 병렬로 저장한다.
 */
function enqueueDraftSave<T>(wizardId: string, key: string, write: () => Promise<T>): Promise<T> {
  const previous = lastDraftSaveByKey.get(key);
  const request = (previous ?? Promise.resolve())
    .catch(() => undefined)
    .then(write);
  lastDraftSaveByKey.set(key, request);
  const cleanup = (): void => {
    if (lastDraftSaveByKey.get(key) === request)
      lastDraftSaveByKey.delete(key);
  };
  void request.then(cleanup, cleanup);
  return trackDraftSave(wizardId, request);
}

/** 같은 문서에서 막 시작한 unload/unmount 저장보다 진입 판정이 앞서는 경합을 막는다. */
export async function waitForPendingDraftSaves(wizardId: string): Promise<void> {
  while (true) {
    const pending = pendingDraftSaves.get(wizardId);
    if (!pending || pending.size === 0) return;
    await Promise.allSettled([...pending]);
  }
}

function contextQuery(wizardId: string): string {
  return `?${new URLSearchParams({ wizardId })}`;
}

export async function loadBacktestWizardDraft(
  wizardId: string,
): Promise<BacktestWizardDraftBundle> {
  await waitForPendingDraftSaves(wizardId);
  const query = contextQuery(wizardId);
  const entries = await Promise.all(
    BACKTEST_WIZARD_DRAFT_STEPS.map(async (step) => {
      const response = await api<{
        draft: { payload: BacktestWizardDraftPayloadMap[typeof step] } | null;
      }>(`/backtests/wizard-draft/${step}${query}`);
      return response.draft === null
        ? null
        : ([step, response.draft.payload] as const);
    }),
  );
  return Object.fromEntries(
    entries.filter((entry) => entry !== null),
  ) as BacktestWizardDraftBundle;
}

export async function saveBacktestWizardDraftStep<
  S extends BacktestWizardDraftStep,
>(
  wizardId: string,
  step: S,
  payload: BacktestWizardDraftPayloadMap[S],
  options: { keepalive?: boolean } = {},
): Promise<void> {
  const requestPayload =
    step === "universe"
      ? (() => {
          const universePayload =
            payload as BacktestWizardDraftPayloadMap["universe"] & {
              lastPreview: {
                result: { preparationJobId?: string };
              } | null;
            };
          return {
            ...universePayload,
            lastPreview:
              universePayload.lastPreview?.result.preparationJobId === undefined
                ? null
                : {
                    preparationJobId:
                      universePayload.lastPreview.result.preparationJobId,
                  },
          };
        })()
      : payload;
  const write = () =>
    api(`/backtests/wizard-draft/${step}${contextQuery(wizardId)}`, {
      method: "PUT",
      body: JSON.stringify(requestPayload),
      // 유니버스 미리보기는 준비 작업 ID만 보내므로 keepalive body 상한을 넘지 않는다.
      keepalive: options.keepalive,
    });
  const key = JSON.stringify([wizardId, step]);
  // pagehide에서는 브라우저가 문서를 곧 폐기하므로 Promise queue 뒤에 두지 않고
  // keepalive 요청을 즉시 시작한다. SPA unmount와 평상시 자동 저장은 순서를 보장한다.
  await (options.keepalive
    ? trackDraftSave(wizardId, write())
    : enqueueDraftSave(wizardId, key, write));
}
