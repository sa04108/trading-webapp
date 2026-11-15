import { useCallback, useEffect, useLayoutEffect, useRef } from "react";

type Anchor = { element: HTMLElement; top: number; fromPage: string | number; abort: AbortController };

/** 기본 앵커링 뒤 남은 차이만 보정한다. 사용자 스크롤·다른 조작은 우선한다. */
export function usePaginationPosition(page: string | number, pending = false) {
  const anchor = useRef<Anchor | null>(null);
  const clear = useCallback(() => {
    anchor.current?.abort.abort();
    anchor.current = null;
  }, []);
  useEffect(() => clear, [clear]);

  const preserve = useCallback((element: HTMLElement) => {
    clear();
    const abort = new AbortController();
    anchor.current = { element, top: element.getBoundingClientRect().top, fromPage: page, abort };
    const options = { signal: abort.signal, passive: true };
    window.addEventListener("wheel", clear, options);
    window.addEventListener("touchmove", clear, options);
    window.addEventListener("resize", clear, options);
    window.addEventListener("keydown", (event) => {
      if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " ", "Tab"].includes(event.key)) clear();
    }, { signal: abort.signal });
    const controls = element.closest("[data-pagination-controls]");
    document.addEventListener("pointerdown", (event) => {
      if (!(event.target instanceof Node) || !controls?.contains(event.target)) clear();
    }, { signal: abort.signal });
  }, [clear, page]);

  useLayoutEffect(() => {
    const current = anchor.current;
    if (!current || pending || current.fromPage === page) return;
    let secondFrame = 0;
    // 네이티브 스크롤 앵커링과 레이아웃 반영을 먼저 완료한다.
    const firstFrame = requestAnimationFrame(() => {
      secondFrame = requestAnimationFrame(() => {
        if (anchor.current !== current) return;
        if (!current.element.isConnected) {
          clear();
          return;
        }
        const difference = () => current.element.getBoundingClientRect().top - current.top;
        // 내부 스크롤 구획이 있는 경우 그 구획부터 이동하고, 경계에서 남은 차이를 바깥에 전달한다.
        for (let parent = current.element.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
          if (Math.abs(difference()) <= 1) break;
          if (/(auto|scroll)/.test(getComputedStyle(parent).overflowY) && parent.scrollHeight > parent.clientHeight) {
            parent.scrollBy({ top: difference(), behavior: "instant" });
          }
        }
        if (Math.abs(difference()) > 1) window.scrollBy({ top: difference(), behavior: "instant" });
        clear();
      });
    });
    return () => {
      cancelAnimationFrame(firstFrame);
      cancelAnimationFrame(secondFrame);
    };
  }, [page, pending, clear]);

  return preserve;
}
