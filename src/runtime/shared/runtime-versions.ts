import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export interface RuntimeVersions {
  schemaVersion: 1;
  agentVersion: string;
  collectionVersion: string;
  previewVersion: string;
  executionVersion: string;
  validationVersion: string;
}

export function parseRuntimeVersions(value: unknown): RuntimeVersions {
  const versions = value as Partial<RuntimeVersions> | null;
  if (
    !versions ||
    versions.schemaVersion !== 1 ||
    ![
      "agentVersion",
      "collectionVersion",
      "previewVersion",
      "executionVersion",
      "validationVersion",
    ].every(
      (key) =>
        typeof versions[key as keyof RuntimeVersions] === "string" &&
        /^[a-f0-9]{64}$/.test(String(versions[key as keyof RuntimeVersions])),
    )
  ) {
    throw new Error(
      "실행 버전 메타데이터가 없거나 올바르지 않습니다. 클라이언트 또는 서버를 다시 빌드하세요.",
    );
  }
  return versions as RuntimeVersions;
}

let cached: RuntimeVersions | undefined;
/** 배포 코드는 자기 산출물의 버전만 읽고, 소스 실행은 같은 생성기로 계산한다. */
export function readRuntimeVersions(): RuntimeVersions {
  if (cached) return cached;
  if (import.meta.url.endsWith(".ts")) {
    // 소스 worker도 부모와 동일한 소스 스냅샷을 사용한다. 배포 JS에서는 환경값을 읽지 않는다.
    let sourceVersions = process.env.QUANT_SOURCE_RUNTIME_VERSIONS;
    if (!sourceVersions) {
      const result = spawnSync(
        process.execPath,
        [
          fileURLToPath(
            new URL(
              "../../../scripts/build-runtime-versions.mjs",
              import.meta.url,
            ),
          ),
          "--print",
        ],
        { encoding: "utf8" },
      );
      if (result.status !== 0)
        throw new Error(`실행 버전 계산 실패: ${result.stderr}`);
      sourceVersions = result.stdout;
      process.env.QUANT_SOURCE_RUNTIME_VERSIONS = sourceVersions;
    }
    cached = parseRuntimeVersions(JSON.parse(sourceVersions));
  } else {
    cached = parseRuntimeVersions(
      JSON.parse(
        fs.readFileSync(
          new URL("../../runtime-versions.json", import.meta.url),
          "utf8",
        ),
      ),
    );
  }
  return cached;
}
