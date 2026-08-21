#!/usr/bin/env node
// 수동 배포 진입점: build는 로컬에서, 전송은 SSH/SCP로, 전환은 노드 로컬 transaction으로 수행한다.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { error as logError, log } from 'node:console';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { parseEnv } from 'node:util';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');
const DEPLOY_ENV_FILE = path.join(REPO_ROOT, 'deploy.env');
const DEPLOY_COMPONENTS = ['app', 'worker'];
const APP_PREFLIGHT = [
  'set -eu',
  'for command_name in bash flock sqlite3 corepack systemctl systemd-run curl; do',
  '  command -v "${command_name}" >/dev/null',
  'done',
  'sudo -n true',
  'sudo -n test -f /etc/quant-platform/app.env',
  'sudo -n test -f /etc/systemd/system/quant-platform.service',
].join('\n');
const WORKER_PREFLIGHT = [
  'set -eu',
  'expected_manifest_sha="$1"',
  'for command_name in bash flock docker sha256sum; do',
  '  command -v "${command_name}" >/dev/null',
  'done',
  'sudo -n docker version >/dev/null',
  'sudo -n docker compose version >/dev/null',
  'sudo -n test -f /etc/quant-platform/worker.env',
  'sudo -n test -f /opt/quant-backtest-worker/compose.yaml',
  'sudo -n test -f /opt/quant-backtest-worker/managed-paths.json',
  'actual_manifest_sha="$(sudo -n sha256sum /opt/quant-backtest-worker/managed-paths.json)"',
  'actual_manifest_sha="${actual_manifest_sha%% *}"',
  '[ "${actual_manifest_sha}" = "${expected_manifest_sha}" ] || {',
  '  echo "Worker 관리 manifest가 현재 저장소와 다릅니다. bootstrap-worker.sh를 다시 실행하세요." >&2',
  '  exit 1',
  '}',
].join('\n');

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
      '프로젝트 루트에서 cp deploy.env.example deploy.env 후 값을 채우세요.',
    );
  }
  try {
    return parseEnv(readFileSync(DEPLOY_ENV_FILE, 'utf8'));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new DeployError(`deploy.env를 읽을 수 없습니다: ${message}`);
  }
}

function setting(settings, name) {
  return settings[name]?.trim() ?? '';
}

function componentPrefix(component) {
  return component === 'app' ? 'QP_APP' : 'QP_WORKER';
}

function expandHome(value) {
  return value.startsWith('~/') ? path.join(homedir(), value.slice(2)) : value;
}

function splitSshOptions(value, variableName) {
  const options = [];
  let option = '';
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
      else if (character === '\\') escaped = true;
      else option += character;
      started = true;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      started = true;
      continue;
    }
    if (character === '\\') {
      escaped = true;
      started = true;
      continue;
    }
    if (/\s/.test(character)) {
      if (started) {
        options.push(option);
        option = '';
        started = false;
      }
      continue;
    }
    option += character;
    started = true;
  }

  if (escaped || quote !== null) {
    throw new DeployError(`${variableName}의 따옴표 또는 escape가 닫히지 않았습니다`);
  }
  if (started) options.push(option);
  return options;
}

function readConnection(component, settings) {
  const prefix = componentPrefix(component);
  const rawHost = setting(settings, `${prefix}_HOST`);
  if (!rawHost) {
    throw new DeployError(`deploy.env의 ${prefix}_HOST가 필요합니다`);
  }
  if (rawHost.startsWith('-') || /\s/.test(rawHost)) {
    throw new DeployError(`${prefix}_HOST 형식이 올바르지 않습니다: ${rawHost}`);
  }

  const at = rawHost.lastIndexOf('@');
  const embeddedUser = at > 0 ? rawHost.slice(0, at) : '';
  const host = at > 0 ? rawHost.slice(at + 1) : rawHost;
  const configuredUser = setting(settings, `${prefix}_SSH_USER`);
  if (!host || host.startsWith('-') || /\s/.test(host)) {
    throw new DeployError(`${prefix}_HOST 형식이 올바르지 않습니다: ${rawHost}`);
  }
  if (configuredUser && (configuredUser.startsWith('-') || /[@\s]/.test(configuredUser))) {
    throw new DeployError(`${prefix}_SSH_USER 형식이 올바르지 않습니다: ${configuredUser}`);
  }
  if (embeddedUser && configuredUser && embeddedUser !== configuredUser) {
    throw new DeployError(`${prefix}_HOST 사용자와 ${prefix}_SSH_USER가 다릅니다`);
  }
  const remoteTarget = embeddedUser || !configuredUser
    ? rawHost
    : `${configuredUser}@${rawHost}`;

  const extraOptions = setting(settings, `${prefix}_SSH_OPTS`);
  const sshOptions = extraOptions
    ? splitSshOptions(extraOptions, `${prefix}_SSH_OPTS`)
    : [];
  const key = setting(settings, `${prefix}_SSH_KEY`);
  if (key) {
    const expandedKey = expandHome(key);
    if (!existsSync(expandedKey)) {
      throw new DeployError(`${prefix}_SSH_KEY 파일이 없습니다: ${expandedKey}`);
    }
    sshOptions.push('-i', expandedKey, '-o', 'IdentitiesOnly=yes');
  }

  const port = setting(settings, `${prefix}_SSH_PORT`);
  if (port) {
    if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65_535) {
      throw new DeployError(`${prefix}_SSH_PORT가 올바르지 않습니다: ${port}`);
    }
    sshOptions.push('-o', `Port=${port}`);
  }

  const jump = setting(settings, `${prefix}_SSH_JUMP`);
  if (jump) {
    if (jump.startsWith('-') || /\s/.test(jump)) {
      throw new DeployError(`${prefix}_SSH_JUMP 형식이 올바르지 않습니다: ${jump}`);
    }
    sshOptions.push('-o', `ProxyJump=${jump}`);
  }

  const hostKey = setting(settings, `${prefix}_SSH_HOST_KEY`) || 'accept-new';
  if (!['accept-new', 'yes', 'no'].includes(hostKey)) {
    throw new DeployError(`${prefix}_SSH_HOST_KEY는 accept-new | yes | no 중 하나여야 합니다`);
  }
  sshOptions.push('-o', `StrictHostKeyChecking=${hostKey}`);

  return { component, remoteTarget, sshOptions };
}

function commandFailure(command, result) {
  const suffix = result.signal ? ` (${result.signal})` : '';
  const stderr = typeof result.stderr === 'string' ? result.stderr.trim() : '';
  return `${command}가 종료 코드 ${result.status ?? 1}${suffix}로 실패했습니다` +
    (stderr ? `\n${stderr}` : '');
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: REPO_ROOT,
    env: process.env,
    stdio: options.quiet ? ['ignore', 'ignore', 'inherit'] : 'inherit',
  });
  if (result.error) throw new DeployError(`${command} 실행 실패: ${result.error.message}`);
  if (result.status !== 0) {
    throw new DeployError(commandFailure(command, result), result.status ?? 1);
  }
}

function capture(command, args) {
  const result = spawnSync(command, args, {
    cwd: REPO_ROOT,
    env: process.env,
    encoding: 'utf8',
  });
  if (result.error) throw new DeployError(`${command} 실행 실패: ${result.error.message}`);
  if (result.status !== 0) {
    throw new DeployError(commandFailure(command, result), result.status ?? 1);
  }
  return result.stdout.trim();
}

function sshArguments(connection, options = {}) {
  return [
    ...connection.sshOptions,
    ...(options.batch ? ['-o', 'ConnectTimeout=15', '-o', 'BatchMode=yes'] : []),
    connection.remoteTarget,
  ];
}

function shellQuote(value) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function runRemoteBash(connection, script, args = [], options = {}) {
  const remoteCommand = [
    '/bin/bash',
    '-c',
    shellQuote(script),
    'deploy-remote',
    ...args.map(shellQuote),
  ].join(' ');
  run('ssh', [...sshArguments(connection, options), remoteCommand], options);
}

function preflight(connection, workerManifestSha) {
  if (connection.component === 'app') {
    runRemoteBash(connection, APP_PREFLIGHT, [], { batch: true, quiet: true });
    return;
  }
  runRemoteBash(
    connection,
    WORKER_PREFLIGHT,
    [workerManifestSha],
    { batch: true, quiet: true },
  );
}

function validateRemoteDirectory(remoteDirectory, component) {
  const pattern = component === 'app'
    ? /^\/tmp\/quant-app-deploy\.[a-zA-Z0-9]+$/
    : /^\/tmp\/quant-worker-deploy\.[a-zA-Z0-9]+$/;
  if (!pattern.test(remoteDirectory)) {
    throw new DeployError(`${component} 원격 임시 경로가 올바르지 않습니다: ${remoteDirectory}`);
  }
}

function createRemoteDirectory(connection) {
  const template = connection.component === 'app'
    ? '/tmp/quant-app-deploy.XXXXXX'
    : '/tmp/quant-worker-deploy.XXXXXX';
  const remoteDirectory = capture('ssh', [
    ...sshArguments(connection),
    `mktemp -d ${template}`,
  ]);
  validateRemoteDirectory(remoteDirectory, connection.component);
  return remoteDirectory;
}

function removeRemoteDirectory(connection, remoteDirectory) {
  validateRemoteDirectory(remoteDirectory, connection.component);
  run('ssh', [
    ...sshArguments(connection),
    `/bin/rm -rf -- ${shellQuote(remoteDirectory)}`,
  ], { quiet: true });
}

function upload(connection, files, remoteDirectory) {
  run('scp', [
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
      const message = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
      logError(`${connection.component} 업로드 실패 후 임시 디렉터리 정리도 실패했습니다: ${message}`);
    }
    throw error;
  }
  return remoteDirectory;
}

function stageAppDeployment(connection, releaseArchive, releaseChecksum, releaseName) {
  const remoteDirectory = stageFiles(connection, [
    releaseArchive,
    releaseChecksum,
    path.join(SCRIPT_DIR, 'deploy-app.sh'),
  ]);
  return {
    connection,
    releaseName,
    remoteDirectory,
    remoteArchive: path.posix.join(remoteDirectory, path.basename(releaseArchive)),
    remoteChecksum: path.posix.join(remoteDirectory, path.basename(releaseChecksum)),
    remoteScript: path.posix.join(remoteDirectory, 'deploy-app.sh'),
  };
}

function stageWorkerDeployment(
  connection,
  imageArchive,
  imageChecksum,
  composeFile,
  releaseName,
  releaseGitSha,
  manifestSha,
) {
  const remoteDirectory = stageFiles(connection, [
    imageArchive,
    imageChecksum,
    composeFile,
    path.join(SCRIPT_DIR, 'deploy-worker.sh'),
  ]);
  return {
    connection,
    releaseName,
    releaseGitSha,
    manifestSha,
    remoteDirectory,
    remoteArchive: path.posix.join(remoteDirectory, path.basename(imageArchive)),
    remoteChecksum: path.posix.join(remoteDirectory, path.basename(imageChecksum)),
    remoteCompose: path.posix.join(remoteDirectory, 'compose.worker.yaml'),
    remoteScript: path.posix.join(remoteDirectory, 'deploy-worker.sh'),
  };
}

function runAppPhase(deployment, phase) {
  const args = phase === 'prepare'
    ? [
        phase,
        deployment.remoteArchive,
        deployment.remoteChecksum,
        deployment.releaseName,
      ]
    : [phase, deployment.releaseName];
  const command = [
    '/bin/bash',
    shellQuote(deployment.remoteScript),
    ...args.map(shellQuote),
  ].join(' ');
  run('ssh', [...sshArguments(deployment.connection), command]);
}

function runWorkerPhase(deployment, phase) {
  const args = phase === 'prepare'
    ? [
        phase,
        deployment.remoteArchive,
        deployment.remoteChecksum,
        deployment.remoteCompose,
        `quant-platform-backtest-worker:${deployment.releaseName}`,
        deployment.releaseGitSha,
        deployment.manifestSha,
      ]
    : [phase, deployment.releaseName];
  const command = [
    'sudo',
    '-n',
    '/bin/bash',
    shellQuote(deployment.remoteScript),
    ...args.map(shellQuote),
  ].join(' ');
  run('ssh', [...sshArguments(deployment.connection), command]);
}

function sha256File(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function readReleaseMetadata(metadataFile, artifactDirectory) {
  let metadata;
  try {
    metadata = JSON.parse(readFileSync(metadataFile, 'utf8'));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new DeployError(`release metadata를 읽을 수 없습니다: ${message}`);
  }
  if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw new DeployError('release metadata 형식이 올바르지 않습니다');
  }
  const { releaseName, gitSha } = metadata;
  if (typeof releaseName !== 'string' || !/^\d{8}-\d{6}-[a-f0-9]{7}$/.test(releaseName)) {
    throw new DeployError('release metadata의 releaseName이 올바르지 않습니다');
  }
  if (typeof gitSha !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(gitSha)) {
    throw new DeployError('release metadata의 gitSha가 올바르지 않습니다');
  }
  const releaseArchive = path.join(artifactDirectory, `quant-platform-${releaseName}.tar.gz`);
  const releaseChecksum = `${releaseArchive}.sha256`;
  if (!existsSync(releaseArchive) || !existsSync(releaseChecksum)) {
    throw new DeployError('release metadata가 가리키는 archive 또는 checksum이 없습니다');
  }
  return { releaseArchive, releaseChecksum, releaseName, gitSha };
}

function main() {
  if (process.platform !== 'linux') {
    throw new DeployError(`통합 배포는 Linux에서만 지원합니다: ${process.platform}`);
  }
  const settings = readDeploySettings();
  const connections = new Map(DEPLOY_COMPONENTS.map((component) => [
    component,
    readConnection(component, settings),
  ]));

  const composeFile = path.join(REPO_ROOT, 'infra', 'docker', 'compose.worker.yaml');
  const manifestFile = path.join(REPO_ROOT, 'infra', 'worker-host-manifest.json');
  if (!existsSync(composeFile)) {
    throw new DeployError(`worker Compose 파일이 없습니다: ${composeFile}`);
  }
  if (!existsSync(manifestFile)) {
    throw new DeployError(`worker manifest 파일이 없습니다: ${manifestFile}`);
  }
  const workerSettings = {
    composeFile,
    manifestSha: sha256File(manifestFile),
  };

  const artifactDirectory = mkdtempSync(path.join(tmpdir(), 'quant-deploy-'));
  let appDeployment = null;
  let workerDeployment = null;
  let appAttempted = false;
  let workerAttempted = false;
  let transactionCommitted = false;
  try {
    log(`==> 배포 설정: ${DEPLOY_ENV_FILE}`);
    log('==> 배포 순서: app -> worker');

    for (const component of DEPLOY_COMPONENTS) {
      log(`==> ${component} preflight`);
      preflight(
        connections.get(component),
        component === 'worker' ? workerSettings.manifestSha : '',
      );
    }
    run('docker', ['info'], { quiet: true });
    run('docker', ['buildx', 'version'], { quiet: true });

    log('==> 공통 release 검증·생성');
    const releaseMetadataFile = path.join(artifactDirectory, 'release-metadata.json');
    run('bash', [
      path.join(SCRIPT_DIR, 'build-release.sh'),
      artifactDirectory,
      releaseMetadataFile,
    ]);
    const {
      releaseArchive,
      releaseChecksum,
      releaseName,
      gitSha: releaseGitSha,
    } = readReleaseMetadata(releaseMetadataFile, artifactDirectory);

    log('==> worker image 사전 생성');
    run('bash', [
      path.join(SCRIPT_DIR, 'build-worker-image.sh'),
      releaseArchive,
      releaseChecksum,
      releaseName,
      artifactDirectory,
    ]);
    const workerImageArchive = path.join(artifactDirectory, `quant-backtest-worker-${releaseName}.tar`);
    const workerImageChecksum = `${workerImageArchive}.sha256`;
    if (!existsSync(workerImageArchive) || !existsSync(workerImageChecksum)) {
      throw new DeployError('worker image archive 또는 checksum이 생성되지 않았습니다');
    }

    log('==> app 배포 파일 업로드');
    appDeployment = stageAppDeployment(
      connections.get('app'),
      releaseArchive,
      releaseChecksum,
      releaseName,
    );
    log('==> worker 배포 파일 업로드');
    workerDeployment = stageWorkerDeployment(
      connections.get('worker'),
      workerImageArchive,
      workerImageChecksum,
      workerSettings.composeFile,
      releaseName,
      releaseGitSha,
      workerSettings.manifestSha,
    );

    log('==> app 준비·readiness');
    appAttempted = true;
    runAppPhase(appDeployment, 'prepare');

    log('==> worker 준비·readiness');
    workerAttempted = true;
    runWorkerPhase(workerDeployment, 'prepare');

    log('==> app·worker commit 전 최종 readiness');
    runAppPhase(appDeployment, 'verify');
    runWorkerPhase(workerDeployment, 'verify');

    log('==> app·worker 배포 commit');
    runAppPhase(appDeployment, 'commit');
    runWorkerPhase(workerDeployment, 'commit');
    transactionCommitted = true;

    log('==> app·worker 이전 배포 산출물 정리');
    runAppPhase(appDeployment, 'finalize');
    runWorkerPhase(workerDeployment, 'finalize');

    log(`==> app, worker 배포 완료: ${releaseName}`);
  } catch (error) {
    if (!transactionCommitted) {
      const rollbackErrors = [];
      if (workerAttempted && workerDeployment) {
        try {
          logError('==> worker 통합 롤백');
          runWorkerPhase(workerDeployment, 'rollback');
        } catch (rollbackError) {
          rollbackErrors.push(`worker: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
        }
      }
      if (appAttempted && appDeployment) {
        try {
          logError('==> app 통합 롤백');
          runAppPhase(appDeployment, 'rollback');
        } catch (rollbackError) {
          rollbackErrors.push(`app: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
        }
      }
      if (rollbackErrors.length > 0) {
        const originalMessage = error instanceof Error ? error.message : String(error);
        const exitCode = error instanceof DeployError ? error.exitCode : 1;
        throw new DeployError(
          `${originalMessage}\n통합 롤백 실패:\n${rollbackErrors.join('\n')}`,
          exitCode,
        );
      }
    }
    throw error;
  } finally {
    for (const deployment of [workerDeployment, appDeployment]) {
      if (!deployment) continue;
      try {
        removeRemoteDirectory(deployment.connection, deployment.remoteDirectory);
      } catch (cleanupError) {
        const message = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
        logError(`${deployment.connection.component} 원격 임시 디렉터리 정리 실패: ${message}`);
      }
    }
    rmSync(artifactDirectory, { recursive: true, force: true });
  }
}

try {
  main();
} catch (error) {
  const deployError = error instanceof DeployError
    ? error
    : new DeployError(error instanceof Error ? error.message : String(error));
  logError(deployError.message);
  process.exitCode = deployError.exitCode;
}
