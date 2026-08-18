#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { error as logError, log } from 'node:console';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process, { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');

class DeployError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.exitCode = exitCode;
  }
}

function readEnvFileArgument(argv) {
  let envFile = path.join(REPO_ROOT, 'deploy.env');
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--env-file') {
      const value = argv[index + 1];
      if (!value) throw new DeployError('--env-file 뒤에 파일 경로가 필요합니다');
      envFile = value;
      index += 1;
      continue;
    }
    if (argument.startsWith('--env-file=')) {
      envFile = argument.slice('--env-file='.length);
      if (!envFile) throw new DeployError('--env-file에 파일 경로가 필요합니다');
      continue;
    }
    throw new DeployError(`알 수 없는 배포 인자입니다: ${argument}`);
  }
  return path.resolve(process.cwd(), envFile);
}

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new DeployError(`${name}이 필요합니다`);
  return value;
}

function readToggle(name, fallback) {
  const value = process.env[name] ?? fallback;
  if (value !== '0' && value !== '1') {
    throw new DeployError(`${name}은 0 또는 1이어야 합니다`);
  }
  return value === '1';
}

function targetEnvironment(prefix, hostVariable, lowLevelHostVariable) {
  const environment = { ...process.env };
  for (const name of [
    'QP_HOST',
    'QP_SSH_USER',
    'QP_SSH_PORT',
    'SSH_KEY',
    'QP_SSH_JUMP',
    'QP_SSH_HOST_KEY',
    'QP_SSH_OPTS',
  ]) {
    delete environment[name];
  }

  environment[lowLevelHostVariable] = required(hostVariable);
  const mappings = [
    [`${prefix}_SSH_USER`, 'QP_SSH_USER'],
    [`${prefix}_SSH_PORT`, 'QP_SSH_PORT'],
    [`${prefix}_SSH_KEY`, 'SSH_KEY'],
    [`${prefix}_SSH_JUMP`, 'QP_SSH_JUMP'],
    [`${prefix}_SSH_HOST_KEY`, 'QP_SSH_HOST_KEY'],
    [`${prefix}_SSH_OPTS`, 'QP_SSH_OPTS'],
  ];
  for (const [source, target] of mappings) {
    const value = process.env[source]?.trim();
    if (value) environment[target] = value;
  }
  return environment;
}

function run(command, args, environment = process.env, options = {}) {
  const result = spawnSync(command, args, {
    cwd: REPO_ROOT,
    env: environment,
    stdio: options.quiet ? ['ignore', 'ignore', 'inherit'] : 'inherit',
  });
  if (result.error) throw new DeployError(`${command} 실행 실패: ${result.error.message}`);
  if (result.status !== 0) {
    const suffix = result.signal ? ` (${result.signal})` : '';
    throw new DeployError(`${command}가 종료 코드 ${result.status ?? 1}${suffix}로 실패했습니다`, result.status ?? 1);
  }
}

function onlyFile(directory, matcher, description) {
  const files = readdirSync(directory).filter((file) => matcher.test(file));
  if (files.length !== 1) {
    throw new DeployError(`${description}를 하나만 찾을 수 있어야 합니다: ${directory}`);
  }
  return path.join(directory, files[0]);
}

function main() {
  if (process.platform !== 'linux') {
    throw new DeployError(`통합 배포는 Linux에서만 지원합니다: ${process.platform}`);
  }
  const envFile = readEnvFileArgument(process.argv.slice(2));
  if (!existsSync(envFile)) {
    throw new DeployError(
      `배포 환경 파일이 없습니다: ${envFile}\n` +
      '프로젝트 루트에서 cp deploy.env.example deploy.env 후 값을 채우세요.',
    );
  }
  loadEnvFile(envFile);

  const deployWorker = readToggle('QP_DEPLOY_WORKER', '0');
  const serverEnv = targetEnvironment('QP_SERVER', 'QP_SERVER_HOST', 'QP_HOST');
  const workerEnv = deployWorker
    ? targetEnvironment('QP_WORKER', 'QP_WORKER_HOST', 'QP_WORKER_HOST')
    : null;
  if (deployWorker) readToggle('QP_FORCE_WORKER_DEPLOY', '0');

  const artifactDirectory = mkdtempSync(path.join(tmpdir(), 'quant-deploy-'));
  let serverIsLive = false;
  try {
    log(`==> 배포 설정: ${envFile}`);
    log(`==> Worker 배포: ${deployWorker ? '활성' : '비활성'}`);

    run('bash', [path.join(SCRIPT_DIR, 'deploy-server.sh')], {
      ...serverEnv,
      QP_DEPLOY_PREFLIGHT_ONLY: '1',
    });
    if (workerEnv) {
      run('bash', [path.join(SCRIPT_DIR, 'deploy-worker.sh')], {
        ...workerEnv,
        QP_DEPLOY_PREFLIGHT_ONLY: '1',
      });
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
    if (!existsSync(releaseChecksum)) throw new DeployError(`release checksum이 없습니다: ${releaseChecksum}`);
    const releaseName = path.basename(releaseArchive).slice('quant-platform-'.length, -'.tar.gz'.length);

    let workerImageArchive;
    let workerImageChecksum;
    if (workerEnv) {
      log('==> Worker image 사전 생성');
      run('bash', [
        path.join(SCRIPT_DIR, 'build-worker-image.sh'),
        releaseArchive,
        releaseChecksum,
        releaseName,
        artifactDirectory,
      ]);
      workerImageArchive = path.join(
        artifactDirectory,
        `quant-backtest-worker-${releaseName}.tar`,
      );
      workerImageChecksum = `${workerImageArchive}.sha256`;
      if (!existsSync(workerImageArchive) || !existsSync(workerImageChecksum)) {
        throw new DeployError('Worker image archive 또는 checksum이 생성되지 않았습니다');
      }
    }

    log('==> 운영 서버 배포');
    run('bash', [path.join(SCRIPT_DIR, 'deploy-server.sh')], {
      ...serverEnv,
      QP_RELEASE_ARCHIVE: releaseArchive,
      QP_RELEASE_CHECKSUM: releaseChecksum,
    });
    serverIsLive = true;

    if (workerEnv) {
      log('==> Worker 배포');
      run('bash', [path.join(SCRIPT_DIR, 'deploy-worker.sh')], {
        ...workerEnv,
        QP_RELEASE_ARCHIVE: releaseArchive,
        QP_RELEASE_CHECKSUM: releaseChecksum,
        QP_WORKER_IMAGE_ARCHIVE: workerImageArchive,
        QP_WORKER_IMAGE_CHECKSUM: workerImageChecksum,
      });
    }

    log(`==> 통합 배포 완료: ${releaseName}`);
  } catch (error) {
    if (serverIsLive && deployWorker) {
      logError('운영 서버 배포는 완료됐지만 Worker 배포가 실패했습니다. 문제를 해결한 뒤 pnpm run deploy를 다시 실행하세요.');
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
