import { useSyncExternalStore } from 'react';

/**
 * 대상이 사라진 알림 링크 모음.
 *
 * 컴포넌트 state 로 두지 않는 이유 — 항목을 누르면 그 페이지로 이동하면서 알림 화면이
 * 언마운트된다. state 에 담으면 돌아왔을 때 「정보를 찾을 수 없음」 표시가 사라진다.
 */
let missing: ReadonlySet<string> = new Set<string>();
const listeners = new Set<() => void>();

function replace(next: ReadonlySet<string>): void {
  missing = next;
  for (const listener of listeners) listener();
}

export function markTargetMissing(link: string): void {
  if (missing.has(link)) return;
  replace(new Set([...missing, link]));
}

/** 다시 열렸다면 표시를 거둔다 — 잘못 붙은 표시가 세션 내내 남지 않게 한다 */
export function clearTargetMissing(link: string): void {
  if (!missing.has(link)) return;
  const next = new Set(missing);
  next.delete(link);
  replace(next);
}

export function useMissingTargets(): ReadonlySet<string> {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    () => missing,
  );
}
