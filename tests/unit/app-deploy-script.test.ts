import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash';

describe('deploy script failure workflow', () => {
  it('restores app release and DB, then cleans transaction artifacts after rollback readiness', () => {
    const shell = String.raw`
      source scripts/deploy-app.sh
      mock_current_target='/opt/quant-platform/releases/new-release'
      curl() { return 0; }
      sleep() { :; }
      readlink() { printf '%s\n' "$mock_current_target"; }
      sudo() {
        printf 'sudo:%s\n' "$*" >&2
        if [ "$1" = 'cat' ] && [ "$2" = '/var/lib/quant-platform/deploy-transactions/new-release.state' ]; then
          printf '/opt/quant-platform/releases/old-release\n/var/lib/quant-platform/backups/pre-deploy-new-release.sqlite\n1\n'
          return 0
        fi
        if [ "$1" = 'test' ] && [ "$2" = '-f' ]; then
          return 0
        fi
        if [ "$1" = 'ln' ] && [ "$2" = '-sfn' ]; then
          mock_current_target='/opt/quant-platform/releases/old-release'
        fi
        return 0
      }

      status=0
      rollback_app_transaction new-release || status=$?
      printf 'status=%s\n' "$status"
      [ "$status" -eq 0 ]
    `;

    const result = spawnSync(bash, ['-c', shell], {
      cwd: process.cwd(),
      encoding: 'utf8',
    });
    const output = `${result.stdout}${result.stderr}`;

    expect(result.status).toBe(0);
    expect(output).toMatch(/sudo:cp .*pre-deploy-new-release\.sqlite .*app\.sqlite/);
    expect(output).toMatch(
      /sudo:rm -f .*app\.sqlite-journal .*app\.sqlite-wal .*app\.sqlite-shm/,
    );
    expect(output).toContain('sudo:ln -sfn /opt/quant-platform/releases/old-release');
    expect(output).toContain('sudo:systemctl restart quant-platform');
    expect(output).toContain(
      'sudo:rm -f -- /var/lib/quant-platform/backups/pre-deploy-new-release.sqlite',
    );
    expect(output).toContain(
      'sudo:rm -rf -- /opt/quant-platform/releases/new-release',
    );
    expect(output).toContain('sudo:rm -f -- /var/lib/quant-platform/deploy-transactions/new-release.state');
    expect(output).toContain('app rollback completed for new-release');
    expect(output).toContain('status=0');
  });

  it('preserves recovery artifacts when rollback readiness fails', () => {
    const shell = String.raw`
      source scripts/deploy-app.sh
      mock_current_target='/opt/quant-platform/releases/new-release'
      curl() { return 1; }
      sleep() { :; }
      readlink() { printf '%s\n' "$mock_current_target"; }
      sudo() {
        printf 'sudo:%s\n' "$*" >&2
        if [ "$1" = 'cat' ] && [ "$2" = '/var/lib/quant-platform/deploy-transactions/new-release.state' ]; then
          printf '/opt/quant-platform/releases/old-release\n/var/lib/quant-platform/backups/pre-deploy-new-release.sqlite\n1\n'
          return 0
        fi
        if [ "$1" = 'test' ] && [ "$2" = '-f' ]; then
          return 0
        fi
        if [ "$1" = 'ln' ] && [ "$2" = '-sfn' ]; then
          mock_current_target='/opt/quant-platform/releases/old-release'
        fi
        return 0
      }

      status=0
      rollback_app_transaction new-release || status=$?
      printf 'status=%s\n' "$status"
      [ "$status" -eq 1 ]
    `;

    const result = spawnSync(bash, ['-c', shell], {
      cwd: process.cwd(),
      encoding: 'utf8',
    });
    const output = `${result.stdout}${result.stderr}`;

    expect(result.status).toBe(0);
    expect(output).toContain('app rollback failed for new-release');
    expect(output).toContain(
      'sudo:touch /opt/quant-platform/releases/new-release/.deploy-failed',
    );
    expect(output).toContain(
      'sudo:rm -f -- /opt/quant-platform/releases/new-release/.deploy-in-progress',
    );
    expect(output).toContain(
      'sudo:touch /var/lib/quant-platform/backups/pre-deploy-new-release.sqlite.deploy-failed',
    );
    expect(output).toContain(
      'sudo:rm -f -- /var/lib/quant-platform/backups/pre-deploy-new-release.sqlite.deploy-in-progress',
    );
    expect(output).not.toContain('sudo:rm -rf -- /opt/quant-platform/releases/new-release');
    expect(output).not.toContain(
      'sudo:rm -f -- /var/lib/quant-platform/backups/pre-deploy-new-release.sqlite /var/lib/quant-platform/backups/pre-deploy-new-release.sqlite-journal',
    );
  });

  it('refuses to delete a release that is still the current target', () => {
    const shell = String.raw`
      source scripts/deploy-app.sh
      readlink() { echo '/opt/quant-platform/releases/new-release'; }
      sudo() { printf 'sudo:%s\n' "$*" >&2; }
      status=0
      cleanup_failed_deploy_artifacts \
        '/opt/quant-platform/releases/new-release' \
        '/var/lib/quant-platform/backups/pre-deploy-new-release.sqlite' || status=$?
      printf 'status=%s\n' "$status"
      [ "$status" -eq 1 ]
    `;

    const result = spawnSync(bash, ['-c', shell], {
      cwd: process.cwd(),
      encoding: 'utf8',
    });
    const output = `${result.stdout}${result.stderr}`;

    expect(result.status).toBe(0);
    expect(output).toContain('현재 release는 실패 산출물로 삭제하지 않습니다');
    expect(output).not.toContain('sudo:rm');
  });

  it('fails closed when the current release symlink cannot be resolved', () => {
    const shell = String.raw`
      source scripts/deploy-app.sh
      link_root="$(mktemp -d)"
      ln -s "$link_root/missing/release" "$link_root/current"
      status=0
      resolved="$(resolve_current_release "$link_root/current")" || status=$?
      printf 'status=%s resolved=%s\n' "$status" "$resolved"
      rm -rf "$link_root"
      [ "$status" -eq 1 ] && [ -z "$resolved" ]
    `;

    const result = spawnSync(bash, ['-c', shell], {
      cwd: process.cwd(),
      encoding: 'utf8',
    });
    const output = `${result.stdout}${result.stderr}`;

    expect(result.status, output).toBe(0);
    expect(output).toContain('current release 경로를 안전하게 해석할 수 없습니다');
    expect(output).toContain('status=1 resolved=');
  });

  it('does not report cleanup success or delete the release when snapshot deletion fails', () => {
    const shell = String.raw`
      source scripts/deploy-app.sh
      readlink() { echo '/opt/quant-platform/releases/old-release'; }
      sudo() {
        printf 'sudo:%s\n' "$*" >&2
        if [ "$1" = 'rm' ] && [ "$2" = '-f' ]; then return 1; fi
        return 0
      }
      status=0
      cleanup_failed_deploy_artifacts \
        '/opt/quant-platform/releases/new-release' \
        '/var/lib/quant-platform/backups/pre-deploy-new-release.sqlite' || status=$?
      printf 'status=%s\n' "$status"
      [ "$status" -eq 1 ]
    `;

    const result = spawnSync(bash, ['-c', shell], {
      cwd: process.cwd(),
      encoding: 'utf8',
    });
    const output = `${result.stdout}${result.stderr}`;

    expect(result.status, output).toBe(0);
    expect(output).toContain('status=1');
    expect(output).not.toContain('sudo:rm -rf -- /opt/quant-platform/releases/new-release');
  });

  it('refuses successful cleanup when current no longer points to the committed release', () => {
    const shell = String.raw`
      source scripts/deploy-app.sh
      readlink() { echo '/opt/quant-platform/releases/other-release'; }
      sudo() { printf 'sudo:%s\n' "$*" >&2; return 0; }
      KEEP_SUCCESSFUL_DEPLOYS=0
      status=0
      cleanup_successful_app_artifacts \
        '/opt/quant-platform/releases/new-release' || status=$?
      printf 'status=%s\n' "$status"
      [ "$status" -eq 1 ]
    `;

    const result = spawnSync(bash, ['-c', shell], {
      cwd: process.cwd(),
      encoding: 'utf8',
    });
    const output = `${result.stdout}${result.stderr}`;

    expect(result.status, output).toBe(0);
    expect(output).toContain('current release가 commit된 release와 다릅니다');
    expect(output).toContain('status=1');
    expect(output).not.toContain('sudo:find');
    expect(output).not.toContain('sudo:rm');
  });

  it('cleans attempt-owned staging and incomplete snapshot files before service switch', () => {
    const shell = String.raw`
      source scripts/deploy-app.sh
      readlink() { echo '/opt/quant-platform/releases/old-release'; }
      sudo() { printf 'sudo:%s\n' "$*" >&2; return 0; }

      REMOTE_ARCHIVE_PATH='/tmp/quant-platform-cleanup-test.tar.gz'
      REMOTE_CHECKSUM_PATH='/tmp/quant-platform-cleanup-test.tar.gz.sha256'
      RELEASE_STAGING='/opt/quant-platform/releases/.incomplete-new-release'
      RELEASE_STAGING_CREATED=1
      RELEASE_PUBLISHED=0
      SNAPSHOT_INCOMPLETE_OWNED=1
      DB_SNAPSHOT_INCOMPLETE='/var/lib/quant-platform/backups/.pre-deploy-new-release.sqlite.incomplete'
      SNAPSHOT_CREATED=0
      DEPLOY_PHASE=pre-switch

      set +e
      (
        false
        cleanup_remote_deploy
      )
      status=$?
      set -e
      printf 'status=%s\n' "$status"
      [ "$status" -eq 1 ]
    `;

    const result = spawnSync(bash, ['-c', shell], {
      cwd: process.cwd(),
      encoding: 'utf8',
    });
    const output = `${result.stdout}${result.stderr}`;

    expect(result.status).toBe(0);
    expect(output).toContain(
      'sudo:rm -rf -- /opt/quant-platform/releases/.incomplete-new-release',
    );
    expect(output).toContain(
      'sudo:rm -f -- /var/lib/quant-platform/backups/.pre-deploy-new-release.sqlite.incomplete',
    );
    expect(output).toContain('status=1');
  });

  it('treats a missing transaction DB snapshot as rollback failure', () => {
    const shell = String.raw`
      source scripts/deploy-app.sh
      curl() { return 0; }
      mock_current_target='/opt/quant-platform/releases/new-release'
      readlink() { echo "$mock_current_target"; }
      sudo() {
        printf 'sudo:%s\n' "$*" >&2
        if [ "$1" = 'cat' ] && [ "$2" = '/var/lib/quant-platform/deploy-transactions/new-release.state' ]; then
          printf '/opt/quant-platform/releases/old-release\n/var/lib/quant-platform/backups/pre-deploy-new-release.sqlite\n1\n'
          return 0
        fi
        if [ "$1" = 'test' ] && [ "$2" = '-f' ]; then
          [ "$3" = '/var/lib/quant-platform/deploy-transactions/new-release.state' ] && return 0
          return 1
        fi
        return 0
      }

      status=0
      rollback_app_transaction new-release || status=$?
      printf 'status=%s\n' "$status"
      [ "$status" -eq 1 ]
    `;

    const result = spawnSync(bash, ['-c', shell], {
      cwd: process.cwd(),
      encoding: 'utf8',
    });
    const output = `${result.stdout}${result.stderr}`;

    expect(result.status).toBe(0);
    expect(output).not.toContain('sudo:ln -sfn');
    expect(output).toContain('app rollback failed for new-release');
    expect(output).toContain('status=1');
  });

  it('holds a non-blocking kernel lock for the whole remote deployment shell', () => {
    const shell = String.raw`
      source scripts/deploy-app.sh
      sudo() { "$@"; }
      lock_root="$(mktemp -d)"
      lock_file="$lock_root/deploy.lock"
      ready_file="$lock_root/ready"

      touch "$lock_file"
      flock -n -F "$lock_file" bash -c 'touch "$1"; exec sleep 30' _ "$ready_file" &
      holder_pid=$!
      for ((attempt = 0; attempt < 100; attempt += 1)); do
        [ -f "$ready_file" ] && break
        sleep 0.01
      done
      [ -f "$ready_file" ]

      set +e
      (
        acquire_deploy_lock "$lock_file"
      )
      blocked_status=$?
      kill -KILL "$holder_pid"
      wait "$holder_pid" 2>/dev/null
      (
        acquire_deploy_lock "$lock_file"
      )
      recovered_status=$?
      set -e
      printf 'blocked=%s recovered=%s\n' "$blocked_status" "$recovered_status"
      rm -rf "$lock_root"
      [ "$blocked_status" -eq 75 ] && [ "$recovered_status" -eq 0 ]
    `;

    const result = spawnSync(bash, ['-c', shell], {
      cwd: process.cwd(),
      encoding: 'utf8',
    });
    const output = `${result.stdout}${result.stderr}`;

    expect(result.status, output).toBe(0);
    expect(output).toContain('다른 app 배포가 진행 중입니다');
    expect(output).toContain('blocked=75 recovered=0');
  });

  it('publishes a fully installed staging release only after checksum verification', () => {
    const deploy = readFileSync('scripts/deploy-app.sh', 'utf8');
    const orchestrator = readFileSync('scripts/deploy.mjs', 'utf8');

    expect(deploy.indexOf('release archive checksum 불일치')).toBeLessThan(
      deploy.indexOf('sudo mkdir "${RELEASE_STAGING}"'),
    );
    expect(deploy.indexOf('sudo corepack pnpm install --prod --frozen-lockfile')).toBeLessThan(
      deploy.indexOf('sudo mv "${RELEASE_STAGING}" "${RELEASE_DIR}"'),
    );
    expect(deploy).toContain('trap cleanup_remote_deploy EXIT');
    expect(deploy).toMatch(/trap cleanup_remote_deploy EXIT\s+acquire_deploy_lock/);
    expect(deploy).toContain('DB_SNAPSHOT_INCOMPLETE=');
    expect(deploy).toContain('sudo touch "${RELEASE_STAGING}/.deploy-in-progress"');
    expect(deploy).toContain('SWITCHED_RELEASE="$(resolve_current_release)"');
    expect(deploy).toContain('[ "${SWITCHED_RELEASE}" = "${RELEASE_DIR}" ]');
    expect(deploy).toContain('PREVIOUS_RELEASE="$(resolve_current_release)"');
    expect(deploy).not.toContain('ssh ');
    expect(orchestrator).toContain("'/tmp/quant-app-deploy.XXXXXX'");
    expect(orchestrator).toContain("path.join(SCRIPT_DIR, 'deploy-app.sh')");
    expect(deploy).toContain('write_transaction_state');
    expect(deploy).toContain('verify_prepared_app');
    expect(deploy).toContain('rollback_app_transaction');
    expect(deploy).toMatch(/finalize\)\s+read_transaction_state[\s\S]*verify_current_app_release/);
    expect(orchestrator).toContain('stageAppDeployment(');
    expect(orchestrator).toContain("runAppPhase(appDeployment, 'prepare')");
    expect(orchestrator).toContain("runAppPhase(appDeployment, 'verify')");
    expect(orchestrator).toContain("runAppPhase(appDeployment, 'commit')");
    expect(orchestrator).toContain("runAppPhase(appDeployment, 'finalize')");
    expect(orchestrator).toContain("runAppPhase(appDeployment, 'rollback')");
  });

  it('is a syntactically valid node-local transaction script', () => {
    const result = spawnSync(bash, ['-n', 'scripts/deploy-app.sh'], {
      cwd: process.cwd(),
      encoding: 'utf8',
    });
    expect(result.status, result.stderr).toBe(0);
  });

  it('hard-codes one shared successful release and DB snapshot retention count to zero', () => {
    const deploy = readFileSync('scripts/deploy-app.sh', 'utf8');
    expect(deploy).toContain('KEEP_SUCCESSFUL_DEPLOYS=0');
    expect(deploy.match(/awk -v keep="\$\{KEEP_SUCCESSFUL_DEPLOYS\}" 'NR > keep'/g)).toHaveLength(2);
    expect(deploy).not.toContain('QP_DEPLOY_KEEP_RELEASES');
    expect(deploy).not.toContain('QP_DEPLOY_KEEP_DB_SNAPSHOTS');
    expect(deploy).not.toContain('KEEP_RELEASES=');
    expect(deploy).not.toContain('KEEP_DB_SNAPSHOTS=');
    expect(deploy).not.toContain('KEEP_SNAPSHOTS=5');
  });

  it('treats legacy unmarked artifacts as successful and excludes exceptional states', () => {
    const deploy = readFileSync('scripts/deploy-app.sh', 'utf8');

    expect(deploy).toContain("-name 'pre-deploy-*.sqlite' -printf '%T@ %p\\n'");
    expect(deploy).toContain("! -name '.incomplete-*' -printf '%T@ %p\\n'");
    expect(deploy).toContain('.deploy-in-progress');
    expect(deploy).toContain('.deploy-failed');
    expect(deploy).toContain('sudo test ! -e "${in_progress_marker}"');
    expect(deploy).not.toContain('.deploy-success-markers-v1');
    expect(deploy).not.toContain("-name '.deploy-succeeded'");
    expect(deploy).not.toContain(
      'sudo ls -1 /opt/quant-platform/releases 2>/dev/null | sort -r',
    );
  });
});
