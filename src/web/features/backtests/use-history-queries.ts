import { useEffect, useRef } from "react";
import { useQueries, type UseQueryOptions } from "@tanstack/react-query";

type HistoryQuery<T> = UseQueryOptions<T> & {
  placeholderKey: string;
  placeholderScope: string;
};

/** useQueries는 직전 데이터를 전달하지 않으므로 같은 전략·조회 조건의 성공 결과만 연결한다. */
export function useHistoryQueries<T>({ queries }: { queries: HistoryQuery<T>[] }) {
  const previous = useRef(new Map<string, { scope: string; data: T }>());
  const results = useQueries({
    queries: queries.map(({ placeholderKey, placeholderScope, ...query }) => ({
      ...query,
      placeholderData: () => {
        const cached = previous.current.get(placeholderKey);
        return cached?.scope === placeholderScope ? cached.data : undefined;
      },
    })),
  });
  useEffect(() => {
    const next = new Map<string, { scope: string; data: T }>();
    queries.forEach((query, index) => {
      const result = results[index];
      const cached = previous.current.get(query.placeholderKey);
      if (result?.isSuccess && !result.isPlaceholderData) {
        next.set(query.placeholderKey, { scope: query.placeholderScope, data: result.data });
      } else if (cached?.scope === query.placeholderScope) {
        next.set(query.placeholderKey, cached);
      }
    });
    previous.current = next;
  }, [queries, results]);
  return results;
}
