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

  it('keeps checksum, manifest, probe, lock, and rollback inside one remote transaction', () => {
    const deploy = fs.readFileSync('scripts/deploy-worker.sh', 'utf8');
    const role = fs.readFileSync('ansible/roles/worker/tasks/main.yml', 'utf8');
    const builder = fs.readFileSync('scripts/build-worker-image.sh', 'utf8');
    const orchestrator = fs.readFileSync('scripts/deploy.mjs', 'utf8');

    expect(deploy.indexOf('Worker image checksum 불일치')).toBeLessThan(
      deploy.indexOf('docker image load'),
    );
    expect(deploy).not.toContain('CURRENT_SHA=');
    expect(deploy).not.toContain('FORCE=');
    expect(deploy).not.toContain('no-op');
    expect(deploy).toContain('remote-backtest-supervisor.js --check');
    expect(deploy).toContain('rollback()');
    expect(deploy).toContain('flock -n "${DEPLOY_LOCK_FD}"');
    expect(deploy).toContain('PROJECT_DIR=/opt/quant-backtest-worker');
    expect(deploy).toContain('MANIFEST_FILE="${PROJECT_DIR}/managed-paths.json"');
    expect(deploy).toContain('ACTUAL_MANIFEST_SHA');
    expect(deploy).toContain('bootstrap-worker.sh를 다시 실행하세요');
    expect(deploy).toContain('UPLOAD_INPUTS_VALIDATED=1');
    expect(deploy).toContain('rm -f -- "${IMAGE_ARCHIVE}" "${CHECKSUM_FILE}" "${NEW_COMPOSE}"');
    expect(deploy).toContain('quant-backtest-worker-${NEW_IMAGE_TAG}.tar.sha256');
    expect(role).toContain('become: true');
    expect(role).toContain('deploy-worker.sh');
    expect(role).toContain('prefix: quant-worker-deploy.');
    expect(role).not.toContain('worker_force_deploy');
    expect(builder).toContain('quant-backtest-worker-${release_name}.tar');
    expect(orchestrator).toContain('quant-backtest-worker-${releaseName}.tar');
    expect(deploy).not.toContain('systemctl');
  });

  it('removes only the failed candidate after a verified rollback and keeps only current on success', () => {
    const deploy = fs.readFileSync('scripts/deploy-worker.sh', 'utf8');

    expect(deploy).toMatch(
      /if compose up -d --no-build --force-recreate worker && probe_worker; then\s+remove_failed_candidate \|\| .*\s+echo .*\s+return 0/s,
    );
    expect(deploy).toContain(
      "echo 'Worker 롤백 검증에 실패해 이전 image와 신규 image를 모두 보존합니다'",
    );
    expect(deploy).toContain('cleanup_old_images "${NEW_IMAGE}"');
    expect(deploy).not.toContain('tail -n +4');
    expect(deploy).not.toContain('docker system prune');
  });

  it('is a syntactically valid node-local transaction script', () => {
    const result = spawnSync(bash, ['-n', 'scripts/deploy-worker.sh'], {
      cwd: process.cwd(),
      encoding: 'utf8',
    });
    expect(result.status, result.stderr).toBe(0);
  });
});
