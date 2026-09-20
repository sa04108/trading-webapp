import { expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SettingsPage } from "@/features/settings/settings-page";

it("설정은 기존 화면·Agent·서버 설정만 제공하고 별도 수집 카드나 조회를 만들지 않는다", () => {
  const client = new QueryClient();
  try {
    const html = renderToStaticMarkup(<QueryClientProvider client={client}><SettingsPage /></QueryClientProvider>);
    for (const label of ["설정", "화면", "Agent", "서버 상태"]) expect(html).toContain(label);
    for (const label of ["외부 데이터", "수집 승인", "수집 현황", "미확인 공시"]) expect(html).not.toContain(label);
    expect(client.getQueryCache().getAll().map((query) => query.queryKey)).toEqual([["system", "info"], ["agents"]]);
  } finally { client.clear(); }
});
