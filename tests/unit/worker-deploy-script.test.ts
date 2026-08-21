import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash';
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('Docker worker deployment', () => {
  it('takes an exclusive kernel lock and releases it after SIGKILL', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-flock-'));
    roots.push(root);
    const first = spawn('sh', [path.resolve('infra/docker/worker-entrypoint.sh'), 'sleep', '30'], {
      env: { ...process.env, BACKTEST_WORK_ROOT: root },
      stdio: 'ignore',
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const blocked = spawnSync('sh', [
      path.resolve('infra/docker/worker-entrypoint.sh'), 'sh', '-c', 'exit 0',
    ], { env: { ...process.env, BACKTEST_WORK_ROOT: root }, encoding: 'utf8' });
    expect(blocked.status).not.toBe(0);
    expect(blocked.stderr).toContain('다른 supervisor');

    first.kill('SIGKILL');
    await new Promise<void>((resolve) => first.once('exit', () => resolve()));
    const recovered = spawnSync('sh', [
      path.resolve('infra/docker/worker-entrypoint.sh'), 'sh', '-c', 'exit 0',
    ], { env: { ...process.env, BACKTEST_WORK_ROOT: root }, encoding: 'utf8' });
    expect(recovered.status).toBe(0);
  });

  it('declares a hardened, portless singleton with enough shutdown grace', () => {
    const compose = fs.readFileSync('infra/docker/compose.worker.yaml', 'utf8');
    expect(compose).toContain('restart: unless-stopped');
    expect(compose).toContain('read_only: true');
    expect(compose).toContain('no-new-privileges:true');
    expect(compose).toContain('cap_drop:');
    expect(compose).toContain('stop_grace_period: 30s');
    expect(compose).not.toMatch(/^\s+ports:/m);
    expect(compose).not.toContain('systemd');
  });

  it('keeps checksum, manifest, probe, locks, and rollback in the node-local transaction', () => {
    const deploy = fs.readFileSync('scripts/deploy-worker.sh', 'utf8');
    const builder = fs.readFileSync('scripts/build-worker-image.sh', 'utf8');
    const orchestrator = fs.readFileSync('scripts/deploy.mjs', 'utf8');

    expect(deploy.indexOf('Worker image checksum 불일치')).toBeLessThan(
      deploy.indexOf('docker image load'),
    );
    expect(deploy).not.toContain('CURRENT_SHA=');
    expect(deploy).not.toContain('FORCE=');
    expect(deploy).not.toContain('no-op');
    expect(deploy).toContain('remote-backtest-supervisor.js --check');
    expect(deploy).toContain('rollback_transaction()');
    expect(deploy).toContain('flock -n "${DEPLOY_LOCK_FD}"');
    expect(deploy).toContain('PROJECT_DIR=/opt/quant-backtest-worker');
    expect(deploy).toContain('MANIFEST_FILE="${PROJECT_DIR}/managed-paths.json"');
    expect(deploy).toContain('actual_manifest_sha');
    expect(deploy).toContain('bootstrap-worker.sh를 다시 실행하세요');
    expect(deploy).toContain('UPLOAD_INPUTS_VALIDATED=1');
    expect(deploy).toContain(
      'rm -f -- "${IMAGE_ARCHIVE:-}" "${CHECKSUM_FILE:-}" "${NEW_COMPOSE:-}"',
    );
    expect(deploy).toContain('cp -p "${COMPOSE_FILE}" "${transaction_dir}/compose.yaml"');
    expect(deploy).not.toContain('[ ! -f "${COMPOSE_FILE}" ] || cp');
    expect(deploy).toContain('quant-backtest-worker-${RELEASE}.tar.sha256');
    expect(orchestrator).toContain("'/tmp/quant-worker-deploy.XXXXXX'");
    expect(orchestrator).toContain("path.join(SCRIPT_DIR, 'deploy-worker.sh')");
    expect(orchestrator).toMatch(/'sudo',\s+'-n',\s+'\/bin\/bash'/);
    expect(orchestrator).toContain("runWorkerPhase(workerDeployment, 'prepare')");
    expect(orchestrator).toContain("runWorkerPhase(workerDeployment, 'verify')");
    expect(orchestrator).toContain("runWorkerPhase(workerDeployment, 'commit')");
    expect(orchestrator).toContain("runWorkerPhase(workerDeployment, 'finalize')");
    expect(orchestrator).toContain("runWorkerPhase(workerDeployment, 'rollback')");
    expect(orchestrator).not.toContain('worker_force_deploy');
    expect(builder).toContain('quant-backtest-worker-${release_name}.tar');
    expect(orchestrator).toContain('quant-backtest-worker-${releaseName}.tar');
    expect(deploy).not.toContain('systemctl');
  });

  it('removes only the failed candidate after a verified rollback and keeps only current on success', () => {
    const deploy = fs.readFileSync('scripts/deploy-worker.sh', 'utf8');

    expect(deploy).toMatch(
      /restore_previous_config .*compose up -d --no-build --force-recreate worker && probe_worker/s,
    );
    expect(deploy).toContain('remove_candidate_image "${candidate_image}" "${previous_image}"');
    expect(deploy).toContain(
      "echo 'Worker 롤백 검증에 실패해 이전 image와 신규 image를 모두 보존합니다'",
    );
    expect(deploy).toContain('cleanup_old_images "quant-platform-backtest-worker:${RELEASE}"');
    expect(deploy).not.toContain('tail -n +4');
    expect(deploy).not.toContain('docker system prune');
  });

  it('restores the stored worker image and Compose files during rollback', () => {
    const shell = String.raw`
      source scripts/deploy-worker.sh
      root="$(mktemp -d)"
      PROJECT_DIR="$root/project"
      COMPOSE_FILE="$PROJECT_DIR/compose.yaml"
      COMPOSE_ENV="$PROJECT_DIR/compose.env"
      TRANSACTION_ROOT="$PROJECT_DIR/deploy-transactions"
      transaction_dir="$TRANSACTION_ROOT/new-release"
      command_log="$root/commands.log"
      mkdir -p "$transaction_dir"
      printf 'old-image\n' > "$transaction_dir/previous-image"
      printf 'old-compose\n' > "$transaction_dir/compose.yaml"
      printf 'old-env\n' > "$transaction_dir/compose.env"
      printf 'new-compose\n' > "$COMPOSE_FILE"
      printf 'new-env\n' > "$COMPOSE_ENV"
      compose() { printf 'compose:%s\n' "$*" >> "$command_log"; return 0; }
      probe_worker() { printf 'probe\n' >> "$command_log"; return 0; }
      docker() { printf 'docker:%s\n' "$*" >> "$command_log"; return 0; }

      rollback_transaction new-release
      printf 'compose-file=%s\n' "$(cat "$COMPOSE_FILE")"
      printf 'compose-env=%s\n' "$(cat "$COMPOSE_ENV")"
      cat "$command_log"
      [ ! -e "$transaction_dir" ]
      rm -rf "$root"
    `;
    const result = spawnSync(bash, ['-c', shell], {
      cwd: process.cwd(),
      encoding: 'utf8',
    });
    const output = `${result.stdout}${result.stderr}`;

    expect(result.status, output).toBe(0);
    expect(output).toContain('compose-file=old-compose');
    expect(output).toContain('compose-env=old-env');
    expect(output).toContain('compose:up -d --no-build --force-recreate worker');
    expect(output).toContain('probe');
    expect(output).toContain('docker:image rm quant-platform-backtest-worker:new-release');
  });

  it('is a syntactically valid node-local transaction script', () => {
    const result = spawnSync(bash, ['-n', 'scripts/deploy-worker.sh'], {
      cwd: process.cwd(),
      encoding: 'utf8',
    });
    expect(result.status, result.stderr).toBe(0);
  });
});
