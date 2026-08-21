#!/usr/bin/env node
// 수동 배포 진입점: build는 로컬에서, 전송은 SSH/SCP로, 전환은 노드 로컬 transaction으로 수행한다.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { error as logError, log } from 'node:console';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
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
const DEPLOY_TARGETS = new Set(['app', 'worker', 'all']);
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

function rejectNodeEnvFileArguments() {
  const argument = process.execArgv.find((value) =>
    value === '--env-file' ||
    value.startsWith('--env-file=') ||
    value === '--env-file-if-exists' ||
    value.startsWith('--env-file-if-exists='));
  if (argument) {
    throw new DeployError(`--env-file은 지원하지 않습니다. 프로젝트 루트의 deploy.env를 사용하세요: ${argument}`);
  }
}

function parseArguments(argv) {
  let target = null;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--target') {
      const value = argv[index + 1];
      if (!value) throw new DeployError(argument + ' 뒤에 값이 필요합니다');
      target = value;
      index += 1;
      continue;
    }
    if (argument.startsWith('--target=')) {
      target = argument.slice('--target='.length);
      continue;
    }
    throw new DeployError('알 수 없는 배포 인자입니다: ' + argument);
  }
  if (target !== null && !DEPLOY_TARGETS.has(target)) {
    throw new DeployError('--target은 app | worker | all 중 하나여야 합니다: ' + target);
  }
  return target;
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

function targetPrefix(target) {
  return target === 'app' ? 'QP_APP' : 'QP_WORKER';
}

function hasTarget(settings, target) {
  return setting(settings, `${targetPrefix(target)}_HOST`) !== '';
}

function resolveTargets(requestedTarget, settings) {
  const appConfigured = hasTarget(settings, 'app');
  const workerConfigured = hasTarget(settings, 'worker');

  if (requestedTarget === null) {
    if (!appConfigured) throw new DeployError('deploy.env의 QP_APP_HOST가 필요합니다');
    return workerConfigured
      ? { target: 'all', targets: ['app', 'worker'] }
      : { target: 'app', targets: ['app'] };
  }

  const targets = requestedTarget === 'all' ? ['app', 'worker'] : [requestedTarget];
  for (const target of targets) {
    if (!hasTarget(settings, target)) {
      throw new DeployError(`deploy.env의 ${targetPrefix(target)}_HOST가 필요합니다`);
    }
  }
  return { target: requestedTarget, targets };
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

function readConnection(target, settings) {
  const prefix = targetPrefix(target);
  const rawHost = setting(settings, `${prefix}_HOST`);
  if (!rawHost || rawHost.startsWith('-') || /\s/.test(rawHost)) {
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

  return { target, remoteTarget, sshOptions };
}

function commandFailure(command, result) {
  const suffix = result.signal ? ` (${result.signal})` : '';
  const stderr = typeof result.stderr === 'string' ? result.stderr.trim() : '';
  return `${command}가 종료 코드 ${result.status ?? 1}${suffix}로 실패했습니다` +
    (stderr ? `\n${stderr}` : '');
}

function run(command, args, environment = process.env, options = {}) {
  const result = spawnSync(command, args, {
    cwd: REPO_ROOT,
    env: environment,
    stdio: options.quiet ? ['ignore', 'ignore', 'inherit'] : 'inherit',
  });
  if (result.error) throw new DeployError(`${command} 실행 실패: ${result.error.message}`);
  if (result.status !== 0) {
    throw new DeployError(commandFailure(command, result), result.status ?? 1);
  }
}

function capture(command, args, environment = process.env) {
  const result = spawnSync(command, args, {
    cwd: REPO_ROOT,
    env: environment,
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
  run('ssh', [...sshArguments(connection, options), remoteCommand], process.env, options);
}

function preflight(connection, workerManifestSha) {
  if (connection.target === 'app') {
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

function validateRemoteDirectory(remoteDirectory, target) {
  const pattern = target === 'app'
    ? /^\/tmp\/quant-app-deploy\.[a-zA-Z0-9]+$/
    : /^\/tmp\/quant-worker-deploy\.[a-zA-Z0-9]+$/;
  if (!pattern.test(remoteDirectory)) {
    throw new DeployError(`${target} 원격 임시 경로가 올바르지 않습니다: ${remoteDirectory}`);
  }
}

function createRemoteDirectory(connection) {
  const template = connection.target === 'app'
    ? '/tmp/quant-app-deploy.XXXXXX'
    : '/tmp/quant-worker-deploy.XXXXXX';
  const remoteDirectory = capture('ssh', [
    ...sshArguments(connection),
    `mktemp -d ${template}`,
  ]);
  validateRemoteDirectory(remoteDirectory, connection.target);
  return remoteDirectory;
}

function removeRemoteDirectory(connection, remoteDirectory) {
  validateRemoteDirectory(remoteDirectory, connection.target);
  run('ssh', [
    ...sshArguments(connection),
    `/bin/rm -rf -- ${shellQuote(remoteDirectory)}`,
  ], process.env, { quiet: true });
}

function withRemoteDirectory(connection, action) {
  let remoteDirectory = '';
  let actionError = null;
  let actionResult;
  try {
    remoteDirectory = createRemoteDirectory(connection);
    actionResult = action(remoteDirectory);
  } catch (error) {
    actionError = error;
  }

  let cleanupError = null;
  if (remoteDirectory) {
    try {
      removeRemoteDirectory(connection, remoteDirectory);
    } catch (error) {
      cleanupError = error;
    }
  }

  if (actionError) {
    if (cleanupError) {
      const message = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
      logError(`${connection.target} 원격 임시 디렉터리 정리도 실패했습니다: ${message}`);
    }
    throw actionError;
  }
  if (cleanupError) throw cleanupError;
  return actionResult;
}

function upload(connection, files, remoteDirectory) {
  run('scp', [
    ...connection.sshOptions,
    ...files,
    `${connection.remoteTarget}:${remoteDirectory}/`,
  ]);
}

function deployApp(connection, releaseArchive, releaseChecksum, releaseName, onLive) {
  withRemoteDirectory(connection, (remoteDirectory) => {
    upload(connection, [
      releaseArchive,
      releaseChecksum,
      path.join(SCRIPT_DIR, 'deploy-app.sh'),
    ], remoteDirectory);
    const remoteArchive = path.posix.join(remoteDirectory, path.basename(releaseArchive));
    const remoteChecksum = path.posix.join(remoteDirectory, path.basename(releaseChecksum));
    const remoteScript = path.posix.join(remoteDirectory, 'deploy-app.sh');
    const command = [
      '/bin/bash',
      shellQuote(remoteScript),
      shellQuote(remoteArchive),
      shellQuote(remoteChecksum),
      shellQuote(releaseName),
    ].join(' ');
    run('ssh', [...sshArguments(connection), command]);
    onLive();
  });
}

function deployWorker(
  connection,
  imageArchive,
  imageChecksum,
  composeFile,
  releaseName,
  deployGitSha,
  manifestSha,
) {
  withRemoteDirectory(connection, (remoteDirectory) => {
    upload(connection, [
      imageArchive,
      imageChecksum,
      composeFile,
      path.join(SCRIPT_DIR, 'deploy-worker.sh'),
    ], remoteDirectory);
    const remoteArchive = path.posix.join(remoteDirectory, path.basename(imageArchive));
    const remoteChecksum = path.posix.join(remoteDirectory, path.basename(imageChecksum));
    const remoteCompose = path.posix.join(remoteDirectory, 'compose.worker.yaml');
    const remoteScript = path.posix.join(remoteDirectory, 'deploy-worker.sh');
    const command = [
      'sudo',
      '-n',
      '/bin/bash',
      shellQuote(remoteScript),
      shellQuote(remoteArchive),
      shellQuote(remoteChecksum),
      shellQuote(remoteCompose),
      shellQuote(`quant-platform-backtest-worker:${releaseName}`),
      shellQuote(deployGitSha),
      shellQuote(manifestSha),
    ].join(' ');
    run('ssh', [...sshArguments(connection), command]);
  });
}

function onlyFile(directory, matcher, description) {
  const files = readdirSync(directory).filter((file) => matcher.test(file));
  if (files.length !== 1) {
    throw new DeployError(`${description}를 하나만 찾을 수 있어야 합니다: ${directory}`);
  }
  return path.join(directory, files[0]);
}

function sha256File(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function main() {
  if (process.platform !== 'linux') {
    throw new DeployError(`통합 배포는 Linux에서만 지원합니다: ${process.platform}`);
  }
  rejectNodeEnvFileArguments();
  const requestedTarget = parseArguments(process.argv.slice(2));
  const settings = readDeploySettings();
  const { target, targets } = resolveTargets(requestedTarget, settings);
  const connections = new Map(targets.map((selectedTarget) => [
    selectedTarget,
    readConnection(selectedTarget, settings),
  ]));

  let workerSettings = null;
  if (targets.includes('worker')) {
    const composeFile = path.join(REPO_ROOT, 'infra', 'docker', 'compose.worker.yaml');
    const manifestFile = path.join(REPO_ROOT, 'infra', 'worker-host-manifest.json');
    if (!existsSync(composeFile)) {
      throw new DeployError(`worker Compose 파일이 없습니다: ${composeFile}`);
    }
    if (!existsSync(manifestFile)) {
      throw new DeployError(`worker manifest 파일이 없습니다: ${manifestFile}`);
    }
    workerSettings = {
      composeFile,
      manifestSha: sha256File(manifestFile),
    };
  }

  const artifactDirectory = mkdtempSync(path.join(tmpdir(), 'quant-deploy-'));
  let appIsLive = false;
  try {
    log(`==> 배포 설정: ${DEPLOY_ENV_FILE}`);
    log(`==> 배포 대상: ${target}`);

    for (const selectedTarget of targets) {
      log(`==> ${selectedTarget} preflight`);
      preflight(
        connections.get(selectedTarget),
        selectedTarget === 'worker' ? workerSettings.manifestSha : '',
      );
    }
    if (targets.includes('worker')) {
      run('docker', ['info'], process.env, { quiet: true });
      run('docker', ['buildx', 'version'], process.env, { quiet: true });
    }

    log('==> 공통 release 검증·생성');
    run('bash', [path.join(SCRIPT_DIR, 'build-release.sh'), artifactDirectory]);
    const releaseArchive = onlyFile(
      artifactDirectory,
      /^quant-platform-[a-zA-Z0-9._-]+\.tar\.gz$/,
      'release archive',
    );
    const releaseChecksum = `${releaseArchive}.sha256`;
    if (!existsSync(releaseChecksum)) {
      throw new DeployError(`release checksum이 없습니다: ${releaseChecksum}`);
    }
    const releaseName = path.basename(releaseArchive).slice('quant-platform-'.length, -'.tar.gz'.length);
    const deployGitSha = capture('git', ['rev-parse', 'HEAD']);
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(deployGitSha)) {
      throw new DeployError('배포 Git SHA가 올바르지 않습니다');
    }

    let workerImageArchive;
    let workerImageChecksum;
    if (targets.includes('worker')) {
      log('==> worker image 사전 생성');
      run('bash', [
        path.join(SCRIPT_DIR, 'build-worker-image.sh'),
        releaseArchive,
        releaseChecksum,
        releaseName,
        artifactDirectory,
      ]);
      workerImageArchive = path.join(artifactDirectory, `quant-backtest-worker-${releaseName}.tar`);
      workerImageChecksum = `${workerImageArchive}.sha256`;
      if (!existsSync(workerImageArchive) || !existsSync(workerImageChecksum)) {
        throw new DeployError('worker image archive 또는 checksum이 생성되지 않았습니다');
      }
    }

    if (targets.includes('app')) {
      log('==> app 배포');
      deployApp(
        connections.get('app'),
        releaseArchive,
        releaseChecksum,
        releaseName,
        () => {
          appIsLive = true;
        },
      );
    }

    if (targets.includes('worker')) {
      log('==> worker 배포');
      deployWorker(
        connections.get('worker'),
        workerImageArchive,
        workerImageChecksum,
        workerSettings.composeFile,
        releaseName,
        deployGitSha,
        workerSettings.manifestSha,
      );
    }

    log(`==> ${target} 배포 완료: ${releaseName}`);
  } catch (error) {
    if (appIsLive && targets.includes('worker')) {
      logError('app 배포는 완료됐지만 worker 배포가 실패했습니다. 같은 commit에서 --target worker로 다시 실행하세요.');
    }
    throw error;
  } finally {
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
