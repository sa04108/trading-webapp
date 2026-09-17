#!/usr/bin/env node
// 수동 배포 진입점: build는 로컬에서, 전송은 SSH/SCP로, 전환은 운영 서버 로컬 transaction으로 수행한다.

import { spawnSync } from "node:child_process";
import { error as logError, log } from "node:console";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { parseEnv } from "node:util";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");
const DEPLOY_ENV_FILE = path.join(REPO_ROOT, "deploy.env");
const SERVER_PREFLIGHT = [
  "set -eu",
  "for command_name in bash flock sqlite3 corepack systemctl systemd-run curl; do",
  '  command -v "${command_name}" >/dev/null',
  "done",
  "sudo -n true",
  "sudo -n test -f /etc/quant-platform/app.env",
  "sudo -n test -f /etc/systemd/system/quant-platform.service",
].join("\n");

class DeployError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.exitCode = exitCode;
  }
}

function readDeploySettings() {
  if (!existsSync(DEPLOY_ENV_FILE)) {
    throw new DeployError(
      `배포 환경 파일이 없습니다: ${DEPLOY_ENV_FILE}\n` +
        "프로젝트 루트에서 cp deploy.env.example deploy.env 후 값을 채우세요.",
    );
  }
  try {
    return parseEnv(readFileSync(DEPLOY_ENV_FILE, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new DeployError(`deploy.env를 읽을 수 없습니다: ${message}`);
  }
}

function setting(settings, name) {
  return settings[name]?.trim() ?? "";
}

function connectionPrefix(settings) {
  if (setting(settings, "SERVER_HOST")) return "SERVER";
  if (setting(settings, "APP_HOST")) {
    logError("경고: deploy.env의 APP_* 설정은 deprecated입니다. SERVER_*로 변경하세요.");
    return "APP";
  }
  return "SERVER";
}

function expandHome(value) {
  return value.startsWith("~/") ? path.join(homedir(), value.slice(2)) : value;
}

function splitSshOptions(value, variableName) {
  const options = [];
  let option = "";
  let quote = null;
  let escaped = false;
  let started = false;

  for (const character of value) {
    if (escaped) {
      option += character;
      escaped = false;
      started = true;
      continue;
    }
    if (quote === "'") {
      if (character === "'") quote = null;
      else option += character;
      started = true;
      continue;
    }
    if (quote === '"') {
      if (character === '"') quote = null;
      else if (character === "\\") escaped = true;
      else option += character;
      started = true;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      started = true;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      started = true;
      continue;
    }
    if (/\s/.test(character)) {
      if (started) {
        options.push(option);
        option = "";
        started = false;
      }
      continue;
    }
    option += character;
    started = true;
  }

  if (escaped || quote !== null) {
    throw new DeployError(
      `${variableName}의 따옴표 또는 escape가 닫히지 않았습니다`,
    );
  }
  if (started) options.push(option);
  return options;
}

function readConnection(settings) {
  const prefix = connectionPrefix(settings);
  const rawHost = setting(settings, `${prefix}_HOST`);
  if (!rawHost) {
    throw new DeployError("deploy.env의 SERVER_HOST가 필요합니다 (legacy APP_HOST도 임시 지원)");
  }
  if (rawHost.startsWith("-") || /\s/.test(rawHost)) {
    throw new DeployError(
      `${prefix}_HOST 형식이 올바르지 않습니다: ${rawHost}`,
    );
  }

  const at = rawHost.lastIndexOf("@");
  const embeddedUser = at > 0 ? rawHost.slice(0, at) : "";
  const host = at > 0 ? rawHost.slice(at + 1) : rawHost;
  const configuredUser = setting(settings, `${prefix}_SSH_USER`);
  if (!host || host.startsWith("-") || /\s/.test(host)) {
    throw new DeployError(
      `${prefix}_HOST 형식이 올바르지 않습니다: ${rawHost}`,
    );
  }
  if (
    configuredUser &&
    (configuredUser.startsWith("-") || /[@\s]/.test(configuredUser))
  ) {
    throw new DeployError(
      `${prefix}_SSH_USER 형식이 올바르지 않습니다: ${configuredUser}`,
    );
  }
  if (embeddedUser && configuredUser && embeddedUser !== configuredUser) {
    throw new DeployError(
      `${prefix}_HOST 사용자와 ${prefix}_SSH_USER가 다릅니다`,
    );
  }
  const remoteTarget =
    embeddedUser || !configuredUser ? rawHost : `${configuredUser}@${rawHost}`;

  const extraOptions = setting(settings, `${prefix}_SSH_OPTS`);
  const sshOptions = extraOptions
    ? splitSshOptions(extraOptions, `${prefix}_SSH_OPTS`)
    : [];
  const key = setting(settings, `${prefix}_SSH_KEY`);
  if (key) {
    const expandedKey = expandHome(key);
    if (!existsSync(expandedKey)) {
      throw new DeployError(
        `${prefix}_SSH_KEY 파일이 없습니다: ${expandedKey}`,
      );
    }
    sshOptions.push("-i", expandedKey, "-o", "IdentitiesOnly=yes");
  }

  const port = setting(settings, `${prefix}_SSH_PORT`);
  if (port) {
    if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65_535) {
      throw new DeployError(`${prefix}_SSH_PORT가 올바르지 않습니다: ${port}`);
    }
    sshOptions.push("-o", `Port=${port}`);
  }

  const jump = setting(settings, `${prefix}_SSH_JUMP`);
  if (jump) {
    if (jump.startsWith("-") || /\s/.test(jump)) {
      throw new DeployError(
        `${prefix}_SSH_JUMP 형식이 올바르지 않습니다: ${jump}`,
      );
    }
    sshOptions.push("-o", `ProxyJump=${jump}`);
  }

  const hostKey = setting(settings, `${prefix}_SSH_HOST_KEY`) || "accept-new";
  if (!["accept-new", "yes", "no"].includes(hostKey)) {
    throw new DeployError(
      `${prefix}_SSH_HOST_KEY는 accept-new | yes | no 중 하나여야 합니다`,
    );
  }
  sshOptions.push("-o", `StrictHostKeyChecking=${hostKey}`);
  sshOptions.push(
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=3",
  );

  return { component: "server", remoteTarget, sshOptions };
}

function commandFailure(command, result) {
  const suffix = result.signal ? ` (${result.signal})` : "";
  const stderr = typeof result.stderr === "string" ? result.stderr.trim() : "";
  return (
    `${command}가 종료 코드 ${result.status ?? 1}${suffix}로 실패했습니다` +
    (stderr ? `\n${stderr}` : "")
  );
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: REPO_ROOT,
    env: process.env,
    stdio: options.quiet ? ["ignore", "ignore", "inherit"] : "inherit",
  });
  if (result.error)
    throw new DeployError(`${command} 실행 실패: ${result.error.message}`);
  if (result.status !== 0) {
    throw new DeployError(commandFailure(command, result), result.status ?? 1);
  }
}

function capture(command, args) {
  const result = spawnSync(command, args, {
    cwd: REPO_ROOT,
    env: process.env,
    encoding: "utf8",
  });
  if (result.error)
    throw new DeployError(`${command} 실행 실패: ${result.error.message}`);
  if (result.status !== 0) {
    throw new DeployError(commandFailure(command, result), result.status ?? 1);
  }
  return result.stdout.trim();
}

function sshArguments(connection, options = {}) {
  return [
    ...connection.sshOptions,
    ...(options.batch
      ? ["-o", "ConnectTimeout=15", "-o", "BatchMode=yes"]
      : []),
    connection.remoteTarget,
  ];
}

function shellQuote(value) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function runRemoteBash(connection, script, args = [], options = {}) {
  const remoteCommand = [
    "/bin/bash",
    "-c",
    shellQuote(script),
    "deploy-remote",
    ...args.map(shellQuote),
  ].join(" ");
  run("ssh", [...sshArguments(connection, options), remoteCommand], options);
}

function preflight(connection) {
  runRemoteBash(connection, SERVER_PREFLIGHT, [], { batch: true, quiet: true });
}

function validateRemoteDirectory(remoteDirectory, component) {
  const pattern = /^\/tmp\/quant-app-deploy\.[a-zA-Z0-9]+$/;
  if (!pattern.test(remoteDirectory)) {
    throw new DeployError(
      `${component} 원격 임시 경로가 올바르지 않습니다: ${remoteDirectory}`,
    );
  }
}

function createRemoteDirectory(connection) {
  const template = "/tmp/quant-app-deploy.XXXXXX";
  const remoteDirectory = capture("ssh", [
    ...sshArguments(connection),
    `mktemp -d ${template}`,
  ]);
  validateRemoteDirectory(remoteDirectory, connection.component);
  return remoteDirectory;
}

function removeRemoteDirectory(connection, remoteDirectory) {
  validateRemoteDirectory(remoteDirectory, connection.component);
  run(
    "ssh",
    [
      ...sshArguments(connection),
      `/bin/rm -rf -- ${shellQuote(remoteDirectory)}`,
    ],
    { quiet: true },
  );
}

function upload(connection, files, remoteDirectory) {
  run("scp", [
    ...connection.sshOptions,
    ...files,
    `${connection.remoteTarget}:${remoteDirectory}/`,
  ]);
}

function stageFiles(connection, files) {
  const remoteDirectory = createRemoteDirectory(connection);
  try {
    upload(connection, files, remoteDirectory);
  } catch (error) {
    try {
      removeRemoteDirectory(connection, remoteDirectory);
    } catch (cleanupError) {
      const message =
        cleanupError instanceof Error
          ? cleanupError.message
          : String(cleanupError);
      logError(
        `${connection.component} 업로드 실패 후 임시 디렉터리 정리도 실패했습니다: ${message}`,
      );
    }
    throw error;
  }
  return remoteDirectory;
}

function stageServerDeployment(
  connection,
  releaseArchive,
  releaseChecksum,
  releaseName,
) {
  const remoteDirectory = stageFiles(connection, [
    releaseArchive,
    releaseChecksum,
    path.join(SCRIPT_DIR, "deploy-app.sh"),
  ]);
  return {
    connection,
    releaseName,
    remoteDirectory,
    remoteArchive: path.posix.join(
      remoteDirectory,
      path.basename(releaseArchive),
    ),
    remoteChecksum: path.posix.join(
      remoteDirectory,
      path.basename(releaseChecksum),
    ),
    remoteScript: path.posix.join(remoteDirectory, "deploy-app.sh"),
  };
}

function runServerPhase(deployment, phase) {
  const args =
    phase === "prepare"
      ? [
          phase,
          deployment.remoteArchive,
          deployment.remoteChecksum,
          deployment.releaseName,
        ]
      : [phase, deployment.releaseName];
  const command = [
    "/bin/bash",
    shellQuote(deployment.remoteScript),
    ...args.map(shellQuote),
  ].join(" ");
  run("ssh", [...sshArguments(deployment.connection), command]);
}

function readReleaseMetadata(metadataFile, artifactDirectory) {
  let metadata;
  try {
    metadata = JSON.parse(readFileSync(metadataFile, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new DeployError(`release metadata를 읽을 수 없습니다: ${message}`);
  }
  if (
    metadata === null ||
    typeof metadata !== "object" ||
    Array.isArray(metadata)
  ) {
    throw new DeployError("release metadata 형식이 올바르지 않습니다");
  }
  const { releaseName, gitSha } = metadata;
  if (
    typeof releaseName !== "string" ||
    !/^\d{8}-\d{6}-[a-f0-9]{7}$/.test(releaseName)
  ) {
    throw new DeployError("release metadata의 releaseName이 올바르지 않습니다");
  }
  if (
    typeof gitSha !== "string" ||
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(gitSha)
  ) {
    throw new DeployError("release metadata의 gitSha가 올바르지 않습니다");
  }
  const releaseArchive = path.join(
    artifactDirectory,
    `quant-platform-${releaseName}.tar.gz`,
  );
  const releaseChecksum = `${releaseArchive}.sha256`;
  if (!existsSync(releaseArchive) || !existsSync(releaseChecksum)) {
    throw new DeployError(
      "release metadata가 가리키는 archive 또는 checksum이 없습니다",
    );
  }
  return { releaseArchive, releaseChecksum, releaseName, gitSha };
}

function main() {
  if (process.platform !== "linux")
    throw new DeployError("배포는 Linux에서 실행하세요");
  const settings = readDeploySettings();
  const connection = readConnection(settings);
  const artifactDirectory = mkdtempSync(path.join(tmpdir(), "quant-deploy-"));
  let deployment = null;
  let attempted = false;
  let committed = false;
  try {
    preflight(connection);
    const metadataFile = path.join(artifactDirectory, "release-metadata.json");
    log("==> 운영 서버와 Linux 클라이언트 검증·패키징");
    run("bash", [
      path.join(SCRIPT_DIR, "build-release.sh"),
      artifactDirectory,
      metadataFile,
    ]);
    const release = readReleaseMetadata(metadataFile, artifactDirectory);
    deployment = stageServerDeployment(
      connection,
      release.releaseArchive,
      release.releaseChecksum,
      release.releaseName,
    );
    attempted = true;
    runServerPhase(deployment, "prepare");
    runServerPhase(deployment, "verify");
    runServerPhase(deployment, "commit");
    committed = true;
    runServerPhase(deployment, "finalize");
    log(`==> 운영 서버와 다운로드 클라이언트 게시 완료: ${release.releaseName}`);
  } catch (error) {
    if (attempted && !committed && deployment) {
      try {
        runServerPhase(deployment, "rollback");
      } catch (rollbackError) {
        throw new DeployError(
          `${error.message}\n서버·DB 복원 실패: ${rollbackError.message}`,
        );
      }
    }
    throw error;
  } finally {
    if (deployment) {
      try {
        removeRemoteDirectory(connection, deployment.remoteDirectory);
      } catch (error) {
        logError(`배포 임시 파일 정리 실패: ${error.message}`);
      }
    }
    rmSync(artifactDirectory, { recursive: true, force: true });
  }
}

try {
  main();
} catch (error) {
  const deployError =
    error instanceof DeployError
      ? error
      : new DeployError(error instanceof Error ? error.message : String(error));
  logError(deployError.message);
  process.exitCode = deployError.exitCode;
}
