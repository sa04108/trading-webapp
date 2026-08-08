/** GET /symbols 의 한 행 — 화면이 그리는 데 필요한 것이 전부 여기 있다 */
export interface SymbolSummary {
  code: string;
  market: string;
  name: string | null;
  /** 재무 팩트 보유 — 응답을 런타임 검증하지 않으므로 없을 수 있다 (D-033) */
  hasFacts?: boolean;
}
