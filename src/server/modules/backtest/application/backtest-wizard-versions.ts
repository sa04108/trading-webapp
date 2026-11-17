import { preparationRuntimeVersions } from "../../../../runtime/modules/backtest/application/preparation-runtime-versions.js";

/** 화면 배포·에이전트 포장 변경은 제외하고 준비와 계산의 의미를 바꾸는 버전만 고정한다. */
export const wizardRuntimeVersions = preparationRuntimeVersions;

export function wizardRuntimeVersionsJson(): string {
  return JSON.stringify(wizardRuntimeVersions());
}

export function wizardVersionChanges(stored: string | null): string[] {
  if (!stored) return ["이전 작업의 버전 정보 없음"];
  try {
    const previous = JSON.parse(stored) as Record<string, unknown>;
    const current = wizardRuntimeVersions();
    return (Object.keys(current) as Array<keyof typeof current>)
      .filter(key => previous?.[key] !== current[key])
      .map(key => ({ protocolVersion: "통신 프로토콜", previewVersion: "유니버스 준비", executionVersion: "백테스트 계산" })[key]);
  } catch { return ["이전 작업의 버전 정보 확인 불가"]; }
}
