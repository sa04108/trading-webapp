import { expect, it } from "vitest";
import { BoundedIntradayCache } from "../../src/server/modules/intraday/application/intraday-cache.js";

// 기존 저장소 왕복 검사는 작은 한도에서 캐시 퇴출·교체 후 메모리 예산을 검증하지 않는다.
it("봉 수와 항목 수 한도를 지키며 최근 조회한 결과를 유지한다", () => {
  const cache = new BoundedIntradayCache<string>(3, 2);
  cache.set("a", "first", 1);
  cache.set("b", "second", 2);
  expect(cache.get("a")).toBe("first");
  cache.set("c", "third", 2);
  expect(cache.get("b")).toBeUndefined();
  expect(cache.get("a")).toBe("first");
  cache.set("c", "smaller", 1);
  cache.set("d", "empty", 0);
  expect(cache.get("a")).toBeUndefined();
  expect(cache.get("c")).toBe("smaller");
  cache.set("c", "oversized", 4);
  expect(cache.get("c")).toBeUndefined();
  expect(cache.get("d")).toBe("empty");
  cache.clear();
  cache.set("e", "full", 3);
  expect(cache.get("d")).toBeUndefined();
  expect(cache.get("e")).toBe("full");
});
