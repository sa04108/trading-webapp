import fs from "node:fs";
import path from "node:path";

const DEFAULT_IMAGE = "ghcr.io/sa04108/quant-agent:latest";
const GHCR_LATEST_IMAGE = /^ghcr\.io\/[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*:latest$/;

export function agentContainerImage(value = process.env.AGENT_CONTAINER_IMAGE): string {
  const image = value?.trim() || DEFAULT_IMAGE;
  if (!GHCR_LATEST_IMAGE.test(image))
    throw Object.assign(new Error("AGENT_CONTAINER_IMAGE는 ghcr.io의 소문자 이미지 경로와 :latest 태그여야 합니다"), { statusCode: 500 });
  return image;
}

export function validateAgentServerOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw Object.assign(new Error("서버 주소는 HTTPS origin이어야 합니다"), { statusCode: 400 });
  }
  if (
    url.protocol !== "https:" ||
    url.username || url.password || url.search || url.hash ||
    url.pathname !== "/" || url.origin !== value
  )
    throw Object.assign(new Error("서버 주소는 경로·인증정보가 없는 HTTPS origin이어야 합니다"), { statusCode: 400 });
  return url.origin;
}

export function buildWindowsAgentInstaller(input: {
  serverUrl: string;
  token: string;
  image?: string;
}): string {
  const template = fs.readFileSync(path.resolve("scripts/install-agent-windows.ps1"), "utf8");
  const image = input.image ?? agentContainerImage();
  if (!GHCR_LATEST_IMAGE.test(image))
    throw Object.assign(new Error("컨테이너 이미지 설정이 올바르지 않습니다"), { statusCode: 500 });
  const config = Buffer.from(JSON.stringify({
    serverUrl: validateAgentServerOrigin(input.serverUrl),
    token: input.token,
    image,
  }), "utf8").toString("base64");
  const marker = "#__AGENT_POWERSHELL_PAYLOAD__";
  if (!template.startsWith(`${marker}\n`))
    throw new Error("Windows Agent 설치기 템플릿 형식이 올바르지 않습니다");
  return [
    "@echo off",
    "setlocal DisableDelayedExpansion",
    "set \"QUANT_AGENT_INSTALLER=%~f0\"",
    "\"%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe\" -NoLogo -NoProfile -ExecutionPolicy Bypass -Command \"$p=$env:QUANT_AGENT_INSTALLER;$s=[IO.File]::ReadAllText($p);$m=[Environment]::NewLine+'#__AGENT_POWERSHELL_PAYLOAD__';$i=$s.IndexOf($m,[StringComparison]::Ordinal);if($i -lt 0){exit 2};& ([scriptblock]::Create($s.Substring($i+$m.Length)))\"",
    "set \"RC=%ERRORLEVEL%\"",
    "echo.",
    "if not \"%RC%\"==\"0\" echo 설치를 완료하지 못했습니다. 위 오류를 확인하세요.",
    "pause",
    "exit /b %RC%",
    `${marker}`,
    `$ConfigJson = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${config}'))`,
    template.slice(marker.length + 1).trimEnd(),
    "",
  ].join("\r\n");
}
