import { expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import type { AgentClientStatus } from "@shared/agent-status";
import { SettingsPage } from "@/features/settings/settings-page";

it("설정은 화면·API·Agent·서버 설정을 제공하고 별도 수집 카드나 조회를 만들지 않는다", () => {
  const client = new QueryClient();
  try {
    const html = renderToStaticMarkup(<MemoryRouter><QueryClientProvider client={client}><SettingsPage /></QueryClientProvider></MemoryRouter>);
    for (const label of ["설정", "화면", "API 명세", "OpenAPI 토큰", "Agent", "서버 상태"]) expect(html).toContain(label);
    expect(html).toContain('href="/settings/api-reference"');
    expect(html).toContain("Windows CMD 받기");
    expect(html).not.toContain("Linux x64 다운로드");
    for (const label of ["외부 데이터", "수집 승인", "수집 현황", "미확인 공시"]) expect(html).not.toContain(label);
    expect(client.getQueryCache().getAll().map((query) => query.queryKey)).toEqual([["system", "info"], ["openapi-tokens"], ["agents"]]);
  } finally { client.clear(); }
});

it("Agent 실행 상태와 사유를 표시하고 해제된 연결은 숨긴다", () => {
  const client = new QueryClient();
  const base: AgentClientStatus = {
    id: "ready", name: "준비된 PC", createdAtMs: 1, lastSeenAtMs: 1, revokedAtMs: null,
    runnerVersion: "old", protocolVersion: 1,
    execution: { state: "READY", detail: "작업을 받을 수 있습니다.", connected: true, canAcceptJobs: true,
      activeJobs: 0, availableSlots: 2, requiredRunnerVersion: "new", requiredProtocolVersion: 1 },
  };
  client.setQueryData(["agents"], { clients: [
    base,
    { ...base, id: "busy", name: "사용 중 PC", execution: { ...base.execution, state: "BUSY", detail: "작업을 실행 중입니다.", activeJobs: 1, availableSlots: 0 } },
    { ...base, id: "offline", name: "오프라인 PC", execution: { ...base.execution, state: "OFFLINE", detail: "연결이 끊어졌습니다.", connected: false } },
    { ...base, id: "mismatch", name: "이전 버전 PC", execution: { ...base.execution, state: "VERSION_MISMATCH", detail: "서버와 Agent 버전이 다릅니다." } },
    { ...base, id: "revoked", name: "숨겨진 PC", revokedAtMs: 2, execution: { ...base.execution, state: "REVOKED" } },
  ] });
  try {
    const html = renderToStaticMarkup(<MemoryRouter><QueryClientProvider client={client}><SettingsPage /></QueryClientProvider></MemoryRouter>);
    for (const label of ["실행 가능", "작업 중", "연결 끊김", "업데이트 필요", "서버와 Agent 버전이 다릅니다.", "최근 통신", "사용 가능한 슬롯 2개"]) expect(html).toContain(label);
    expect(html).toContain("이전 버전 PC 설치·업데이트 CMD 받기");
    expect(html).not.toContain("저장한 기존 연결 토큰");
    expect(html).not.toContain("토큰 복사");
    expect(html).not.toContain("숨겨진 PC");
  } finally { client.clear(); }
});
