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
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
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

function writeJson(file, value) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
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

function capture(command, args, environment = process.env) {
  const result = spawnSync(command, args, {
    cwd: REPO_ROOT,
    env: environment,
    encoding: 'utf8',
  });
  if (result.error) throw new DeployError(`${command} 실행 실패: ${result.error.message}`);
  if (result.status !== 0) {
    throw new DeployError(`${command}가 종료 코드 ${result.status ?? 1}로 실패했습니다`, result.status ?? 1);
  }
  return result.stdout.trim();
}

function ansibleEnvironment() {
  return {
    ...process.env,
    ANSIBLE_CONFIG: path.join(ANSIBLE_DIR, 'ansible.cfg'),
    ANSIBLE_INVENTORY: process.env.ANSIBLE_INVENTORY?.trim()
      || path.join(ANSIBLE_DIR, 'inventory.yml'),
  };
}

function readInventory(environment) {
  const output = capture('ansible-inventory', ['--list'], environment);
  try {
    const inventory = JSON.parse(output);
    if (inventory === null || typeof inventory !== 'object' || Array.isArray(inventory)) {
      throw new Error('inventory root가 object가 아닙니다');
    }
    return inventory;
  } catch (error) {
    throw new DeployError('Ansible inventory JSON을 읽을 수 없습니다: ' + error.message);
  }
}

function groupHosts(inventory, groupName, visiting = new Set()) {
  if (visiting.has(groupName)) return [];
  const group = inventory[groupName];
  if (group === null || typeof group !== 'object' || Array.isArray(group)) return [];

  visiting.add(groupName);
  const hosts = new Set(Array.isArray(group.hosts) ? group.hosts : []);
  const children = Array.isArray(group.children) ? group.children : [];
  for (const child of children) {
    for (const host of groupHosts(inventory, child, visiting)) hosts.add(host);
  }
  visiting.delete(groupName);
  return [...hosts];
}

function resolveTargets(requestedTarget, inventory) {
  const appHosts = groupHosts(inventory, 'app');
  const workerHosts = groupHosts(inventory, 'worker');

  if (requestedTarget === null) {
    if (appHosts.length === 0) {
      throw new DeployError('Ansible inventory의 app 그룹에 호스트가 없습니다');
    }
    return workerHosts.length > 0
      ? { target: 'all', targets: ['app', 'worker'] }
      : { target: 'app', targets: ['app'] };
  }

  const targets = requestedTarget === 'all' ? ['app', 'worker'] : [requestedTarget];
  for (const target of targets) {
    const hosts = target === 'app' ? appHosts : workerHosts;
    if (hosts.length === 0) {
      throw new DeployError('Ansible inventory의 ' + target + ' 그룹에 호스트가 없습니다');
    }
  }
  return { target: requestedTarget, targets };
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

function runAnsible(target, mode, variables, artifactDirectory, environment) {
  const variablesFile = path.join(artifactDirectory, `vars-${target}-${mode}.json`);
  writeJson(variablesFile, { deploy_mode: mode, ...variables });
  run('ansible-playbook', [
    '--limit', target,
    '--extra-vars', `@${variablesFile}`,
    DEPLOY_PLAYBOOK,
  ], environment);
}

function main() {
  if (process.platform !== 'linux') {
    throw new DeployError(`통합 배포는 Linux에서만 지원합니다: ${process.platform}`);
  }
  const requestedTarget = parseArguments(process.argv.slice(2));
  const environment = ansibleEnvironment();
  run('ansible-playbook', ['--version'], environment, { quiet: true });
  const inventory = readInventory(environment);
  const { target, targets } = resolveTargets(requestedTarget, inventory);

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
    log(`==> Ansible inventory: ${environment.ANSIBLE_INVENTORY}`);
    log(`==> 배포 대상: ${target}`);

    for (const selectedTarget of targets) {
      log(`==> ${selectedTarget} preflight`);
      const preflightVariables = selectedTarget === 'worker'
        ? { worker_manifest_sha: workerSettings.manifestSha }
        : {};
      runAnsible(selectedTarget, 'preflight', preflightVariables, artifactDirectory, environment);
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
      runAnsible('app', 'apply', {
        ...sharedVariables,
        app_release_archive: releaseArchive,
        app_release_checksum: releaseChecksum,
      }, artifactDirectory, environment);
      appIsLive = true;
    }

    if (targets.includes('worker')) {
      log('==> worker 배포');
      runAnsible('worker', 'apply', {
        ...sharedVariables,
        worker_image_archive: workerImageArchive,
        worker_image_checksum: workerImageChecksum,
        worker_compose_file: workerSettings.composeFile,
        worker_manifest_sha: workerSettings.manifestSha,
      }, artifactDirectory, environment);
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
