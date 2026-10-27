import path from "node:path";
import os from "node:os";
import { z } from "zod";

export const agentSettingsSchema = z
  .object({
    serverUrl: z
      .string()
      .url()
      .transform((value) => value.replace(/\/$/, ""))
      .refine((value) => {
        const url = new URL(value);
        return (
          !url.username &&
          !url.password &&
          !url.search &&
          !url.hash &&
          url.pathname === "/" &&
          (url.protocol === "https:" ||
            (url.protocol === "http:" &&
              ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
        );
      }, "서버 주소는 HTTPS여야 합니다. 로컬 테스트 주소만 HTTP를 허용합니다."),
    token: z.string().min(32).max(256),
  })
  .strict();
export type AgentSettings = z.infer<typeof agentSettingsSchema>;
/** 컨테이너의 자격 증명은 볼륨에 저장하지 않고 매 실행 시 주입받는다. */
export function readEnvironmentSettings(
  environment: NodeJS.ProcessEnv = process.env,
): AgentSettings {
  const parsed = agentSettingsSchema.safeParse({
    serverUrl: environment.QUANT_AGENT_SERVER_URL,
    token: environment.QUANT_AGENT_TOKEN,
  });
  if (!parsed.success)
    throw new Error(
      "QUANT_AGENT_SERVER_URL에 HTTPS 서버 주소와 QUANT_AGENT_TOKEN에 발급한 Agent 토큰을 지정하세요",
    );
  return parsed.data;
}
export function defaultStateDirectory(): string {
  return path.join(
    process.env.XDG_STATE_HOME ?? path.join(os.homedir(), ".local/state"),
    "quant-agent",
  );
}
