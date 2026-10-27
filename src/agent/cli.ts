import path from "node:path";
import {
  defaultStateDirectory,
  readEnvironmentSettings,
} from "./config.js";
import { readGitCommitSha } from "../runtime/shared/build-info.js";
import { readRuntimeVersions } from "../runtime/shared/runtime-versions.js";

export async function runAgentCli(
  args: string[] = process.argv.slice(2),
): Promise<void> {
  if (process.platform !== "linux")
    throw new Error("Windows Docker Desktop의 Linux 컨테이너에서 실행하세요");
  if (args[0] === "--check") {
    await import("./client.js");
    console.log(
      `quant-agent ${readRuntimeVersions().agentVersion} (commit ${readGitCommitSha()}) linux-${process.arch}`,
    );
    return;
  }
  if (process.getuid?.() === 0)
    throw new Error("에이전트는 root 대신 일반 사용자로 실행하세요");
  const index = args.indexOf("--state");
  const state = path.resolve(
    index >= 0
      ? (args[index + 1] ?? defaultStateDirectory())
      : defaultStateDirectory(),
  );
  const command = args[0] ?? "run";
  if (command !== "run")
    throw new Error(
      "Docker에서는 run 명령만 사용합니다. 최신 이미지 설치 파일을 다시 실행해 업데이트하세요",
    );
  const settings = readEnvironmentSettings();
  const { AgentClient } = await import("./client.js");
  const client = new AgentClient(settings, state, async () => {
    console.log(
      "서버에 맞는 최신 Docker 이미지가 필요합니다. Windows 설치 파일을 다시 실행하세요",
    );
  });
  client.start();
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    void client.stop().then(() => process.exit(0));
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}
