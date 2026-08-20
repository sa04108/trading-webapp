#!/usr/bin/env node
// 수동 배포 진입점: build는 로컬에서, node 전환은 Ansible app/worker role에서 수행한다.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { error as logError, log } from 'node:console';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import process, { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');
const ANSIBLE_DIR = path.join(REPO_ROOT, 'ansible');
const DEPLOY_PLAYBOOK = path.join(ANSIBLE_DIR, 'deploy.yml');
const DEPLOY_TARGETS = new Set(['app', 'worker', 'all']);

class DeployError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.exitCode = exitCode;
  }
}

function parseArguments(argv) {
  let envFile = path.join(REPO_ROOT, 'deploy.env');
  let target = 'app';
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--env-file' || argument === '--target') {
      const value = argv[index + 1];
      if (!value) throw new DeployError(`${argument} 뒤에 값이 필요합니다`);
      if (argument === '--env-file') envFile = value;
      else target = value;
      index += 1;
      continue;
    }
    if (argument.startsWith('--env-file=')) {
      envFile = argument.slice('--env-file='.length);
      if (!envFile) throw new DeployError('--env-file에 파일 경로가 필요합니다');
      continue;
    }
    if (argument.startsWith('--target=')) {
      target = argument.slice('--target='.length);
      continue;
    }
    throw new DeployError(`알 수 없는 배포 인자입니다: ${argument}`);
  }
  if (!DEPLOY_TARGETS.has(target)) {
    throw new DeployError(`--target은 app | worker | all 중 하나여야 합니다: ${target}`);
  }
  return {
    envFile: path.resolve(process.cwd(), envFile),
    target,
    targets: target === 'all' ? ['app', 'worker'] : [target],
  };
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

function expandHome(value) {
  return value.startsWith('~/') ? path.join(homedir(), value.slice(2)) : value;
}

function hostVariables(target) {
  const prefix = target === 'app' ? 'QP_APP' : 'QP_WORKER';
  const rawHost = required(`${prefix}_HOST`);
  const at = rawHost.lastIndexOf('@');
  const embeddedUser = at > 0 ? rawHost.slice(0, at) : '';
  const host = at > 0 ? rawHost.slice(at + 1) : rawHost;
  const configuredUser = process.env[`${prefix}_SSH_USER`]?.trim() ?? '';
  if (!host || /\s/.test(host) || host.startsWith('-')) {
    throw new DeployError(`${prefix}_HOST 형식이 올바르지 않습니다: ${rawHost}`);
  }
  if (embeddedUser && configuredUser && embeddedUser !== configuredUser) {
    throw new DeployError(`${prefix}_HOST 사용자와 ${prefix}_SSH_USER가 다릅니다`);
  }

  const variables = { ansible_host: host };
  const user = embeddedUser || configuredUser;
  if (user) variables.ansible_user = user;

  const port = process.env[`${prefix}_SSH_PORT`]?.trim();
  if (port) {
    if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
      throw new DeployError(`${prefix}_SSH_PORT가 올바르지 않습니다: ${port}`);
    }
    variables.ansible_port = Number(port);
  }

  const key = process.env[`${prefix}_SSH_KEY`]?.trim();
  if (key) {
    const expandedKey = expandHome(key);
    if (!existsSync(expandedKey)) throw new DeployError(`${prefix}_SSH_KEY 파일이 없습니다: ${expandedKey}`);
    variables.ansible_ssh_private_key_file = expandedKey;
  }

  const hostKey = process.env[`${prefix}_SSH_HOST_KEY`]?.trim() || 'accept-new';
  if (!['accept-new', 'yes', 'no'].includes(hostKey)) {
    throw new DeployError(`${prefix}_SSH_HOST_KEY는 accept-new | yes | no 중 하나여야 합니다`);
  }
  const sshArgs = [`-o StrictHostKeyChecking=${hostKey}`];
  if (key) sshArgs.push('-o IdentitiesOnly=yes');
  const jump = process.env[`${prefix}_SSH_JUMP`]?.trim();
  if (jump) sshArgs.push(`-o ProxyJump=${jump}`);
  const extra = process.env[`${prefix}_SSH_OPTS`]?.trim();
  if (extra) sshArgs.push(extra);
  variables.ansible_ssh_common_args = sshArgs.join(' ');
  return variables;
}

function writeJson(file, value) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function createInventory(targets, destination) {
  const inventory = {
    all: {
      children: {
        app: { hosts: {} },
        worker: { hosts: {} },
      },
    },
  };
  for (const target of targets) {
    inventory.all.children[target].hosts[target] = hostVariables(target);
  }
  writeJson(destination, inventory);
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

function capture(command, args) {
  const result = spawnSync(command, args, {
    cwd: REPO_ROOT,
    env: process.env,
    encoding: 'utf8',
  });
  if (result.error) throw new DeployError(`${command} 실행 실패: ${result.error.message}`);
  if (result.status !== 0) {
    throw new DeployError(`${command}가 종료 코드 ${result.status ?? 1}로 실패했습니다`, result.status ?? 1);
  }
  return result.stdout.trim();
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

function runAnsible(target, mode, inventory, variables, artifactDirectory) {
  const variablesFile = path.join(artifactDirectory, `vars-${target}-${mode}.json`);
  writeJson(variablesFile, { deploy_mode: mode, ...variables });
  const environment = {
    ...process.env,
    ANSIBLE_CONFIG: path.join(ANSIBLE_DIR, 'ansible.cfg'),
  };
  run('ansible-playbook', [
    '--inventory', inventory,
    '--limit', target,
    '--extra-vars', `@${variablesFile}`,
    DEPLOY_PLAYBOOK,
  ], environment);
}

function main() {
  if (process.platform !== 'linux') {
    throw new DeployError(`통합 배포는 Linux에서만 지원합니다: ${process.platform}`);
  }
  const { envFile, target, targets } = parseArguments(process.argv.slice(2));
  if (!existsSync(envFile)) {
    throw new DeployError(
      `배포 환경 파일이 없습니다: ${envFile}\n` +
      '프로젝트 루트에서 cp deploy.env.example deploy.env 후 값을 채우세요.',
    );
  }
  loadEnvFile(envFile);

  const artifactDirectory = mkdtempSync(path.join(tmpdir(), 'quant-deploy-'));
  const inventory = path.join(artifactDirectory, 'inventory.json');
  let appIsLive = false;
  try {
    createInventory(targets, inventory);
    log(`==> 배포 설정: ${envFile}`);
    log(`==> 배포 대상: ${target}`);

    run('ansible-playbook', ['--version'], {
      ...process.env,
      ANSIBLE_CONFIG: path.join(ANSIBLE_DIR, 'ansible.cfg'),
    }, { quiet: true });
    for (const selectedTarget of targets) {
      log(`==> ${selectedTarget} preflight`);
      runAnsible(selectedTarget, 'preflight', inventory, {}, artifactDirectory);
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
    if (!existsSync(releaseChecksum)) throw new DeployError(`release checksum이 없습니다: ${releaseChecksum}`);
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

    const sharedVariables = {
      deploy_release_name: releaseName,
      deploy_git_sha: deployGitSha,
    };
    if (targets.includes('app')) {
      log('==> app 배포');
      runAnsible('app', 'apply', inventory, {
        ...sharedVariables,
        app_release_archive: releaseArchive,
        app_release_checksum: releaseChecksum,
      }, artifactDirectory);
      appIsLive = true;
    }

    if (targets.includes('worker')) {
      log('==> worker 배포');
      runAnsible('worker', 'apply', inventory, {
        ...sharedVariables,
        worker_image_archive: workerImageArchive,
        worker_image_checksum: workerImageChecksum,
        worker_compose_file: path.join(REPO_ROOT, 'infra', 'docker', 'compose.worker.yaml'),
        worker_manifest_sha: sha256File(path.join(REPO_ROOT, 'infra', 'worker-host-manifest.json')),
        worker_force_deploy: readToggle('QP_FORCE_WORKER_DEPLOY', '0'),
      }, artifactDirectory);
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
