import { readRuntimeVersions } from "../../../shared/runtime-versions.js";
import { AGENT_PROTOCOL_VERSION } from "../../../../shared/agent-protocol.js";

/** 준비 작업의 생성 시점과 현재 실행 의미가 같은지 판정한다. 배포 SHA와 포장 버전은 제외한다. */
export function preparationRuntimeVersions() {
  const { previewVersion, executionVersion } = readRuntimeVersions();
  return { protocolVersion: AGENT_PROTOCOL_VERSION, previewVersion, executionVersion };
}

export function preparationRuntimeVersionsJson(): string {
  return JSON.stringify(preparationRuntimeVersions());
}
