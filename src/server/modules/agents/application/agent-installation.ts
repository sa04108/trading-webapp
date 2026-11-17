import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { newId } from "../../../../runtime/shared/ids.js";
import { AgentRegistry, agentTokenHash } from "./agent-registry.js";

const installationSchema = z.object({
  id: z.string().min(1).max(80),
  name: z.string().min(1).max(80),
  token: z.string().regex(/^[A-Za-z0-9_-]{64}$/),
  serverUrl: z.string().url(),
  expiresAtMs: z.number().int(),
  target: z.object({
    id: z.string(), tokenHash: z.string(), revokedAtMs: z.number().nullable(),
  }).optional(),
});
const INSTALLATION_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;

function invalidInstallation(): Error {
  return Object.assign(new Error("설치 권한이 만료되었거나 유효하지 않습니다. 설정에서 설치 파일을 다시 받으세요."), { statusCode: 401 });
}

/** 로그인한 브라우저가 승인한 설치 권한만 장치 연결 정보로 교환한다. */
export class AgentInstallationService {
  constructor(private readonly registry: AgentRegistry, private readonly secret: string) {}

  private signature(payload: string): Buffer {
    return createHmac("sha256", this.secret).update("quant-agent-installation-v1\0").update(payload).digest();
  }

  create(input: { serverUrl: string; name?: string; clientId?: string }) {
    const target = input.clientId ? this.registry.installationTarget(input.clientId) : null;
    if (input.clientId && !target)
      throw Object.assign(new Error("장치가 없습니다"), { statusCode: 404 });
    const credential = {
      id: newId("agent"), name: target?.name ?? input.name ?? "Windows PC",
      token: randomBytes(48).toString("base64url"),
    };
    const payload = Buffer.from(JSON.stringify({
      ...credential, serverUrl: input.serverUrl, expiresAtMs: Date.now() + INSTALLATION_LIFETIME_MS,
      ...(target ? { target: { id: target.id, tokenHash: target.tokenHash, revokedAtMs: target.revokedAtMs } } : {}),
    })).toString("base64url");
    return {
      installation: `${payload}.${this.signature(payload).toString("base64url")}`,
      installationId: credential.id,
      containerName: `quant-agent-${agentTokenHash(credential.token).slice(0, 12)}`,
      ...(target ? { targetClientId: target.id, targetTokenHash: target.tokenHash } : {}),
    };
  }

  resolve(installation: string, serverHost: string, previousToken?: string): { id: string; token: string } {
    const parts = installation.split(".");
    if (parts.length !== 2 || !/^[A-Za-z0-9_-]+$/.test(parts[0]!) || !/^[A-Za-z0-9_-]{43}$/.test(parts[1]!))
      throw invalidInstallation();
    const signature = Buffer.from(parts[1]!, "base64url");
    if (signature.length !== 32 || !timingSafeEqual(signature, this.signature(parts[0]!)))
      throw invalidInstallation();
    let parsed: unknown;
    try { parsed = JSON.parse(Buffer.from(parts[0]!, "base64url").toString("utf8")); }
    catch { throw invalidInstallation(); }
    const decoded = installationSchema.safeParse(parsed);
    if (!decoded.success || decoded.data.expiresAtMs <= Date.now()) throw invalidInstallation();
    const grant = decoded.data;
    if (new URL(grant.serverUrl).host !== serverHost.toLowerCase()) throw invalidInstallation();
    // 다운로드 이후 연결 해제는 이미 발급된 설치 권한에도 적용한다.
    if (grant.target) {
      const current = this.registry.installationTarget(grant.target.id);
      if (!current || current.tokenHash !== grant.target.tokenHash || current.revokedAtMs !== grant.target.revokedAtMs)
        throw invalidInstallation();
    }
    const previousId = previousToken ? this.registry.authenticate(previousToken) : null;
    if (previousId) {
      if (grant.target && previousId !== grant.target.id && previousId !== grant.id)
        throw Object.assign(new Error("선택한 장치와 기존 연결 정보가 다릅니다."), { statusCode: 409 });
      return { id: previousId, token: previousToken! };
    }
    this.registry.registerInstallation(grant);
    return { id: grant.id, token: grant.token };
  }
}
