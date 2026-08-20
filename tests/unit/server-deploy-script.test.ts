import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash';

describe('deploy script failure workflow', () => {
  it('cleans the failed release and snapshot only after rollback readiness succeeds', () => {
    const shell = String.raw`
      source scripts/deploy-server.sh
      attempts=0
      current_release='/opt/quant-platform/releases/new-release'
      curl() {
        attempts=$((attempts + 1))
        echo 'curl unavailable' >&2
        [ "$attempts" -ge 2 ]
      }
      sleep() { :; }
      readlink() { printf '%s\n' "$current_release"; }
      sudo() {
        printf 'sudo:%s\n' "$*" >&2
        if [ "$1" = 'journalctl' ]; then
          echo 'audit_logs already exists' >&2
        fi
        if [ "$1" = 'test' ] && [ "$2" = '-f' ]; then
          return 0
        fi
        if [ "$1" = 'ln' ] && [ "$2" = '-sfn' ]; then
          current_release="$3"
        fi
        return 0
      }

      previous_release="$(mktemp -d)"
      status=0
      handle_deploy_failure \
        '2026-08-01T00:00:00+00:00' \
        "$previous_release" \
        '/opt/quant-platform/releases/new-release' \
        '/var/lib/quant-platform/backups/pre-deploy-new-release.sqlite' \
        '/var/lib/quant-platform/app.sqlite' || status=$?
      printf 'status=%s attempts=%s\n' "$status" "$attempts"
      rm -rf "$previous_release"
      [ "$status" -eq 1 ]
    `;

    const result = spawnSync(bash, ['-c', shell], {
      cwd: process.cwd(),
      encoding: 'utf8',
    });
    const output = `${result.stdout}${result.stderr}`;

    expect(result.status).toBe(0);
    expect(output).toContain('audit_logs already exists');
    expect(output.indexOf('audit_logs already exists')).toBeLessThan(
      output.indexOf('sudo:systemctl stop quant-platform'),
    );
    expect(output).toMatch(/sudo:cp .*pre-deploy-new-release\.sqlite .*app\.sqlite/);
    expect(output).toMatch(/sudo:rm -f .*app\.sqlite-wal .*app\.sqlite-shm/);
    expect(output).toContain('rolled back to');
    expect(output).toContain(
      'sudo:rm -f -- /var/lib/quant-platform/backups/pre-deploy-new-release.sqlite',
    );
    expect(output).toContain(
      'sudo:rm -rf -- /opt/quant-platform/releases/new-release',
    );
    expect(output).toContain('자동 롤백 검증 후 실패한 release와 DB snapshot을 정리했습니다');
    expect(output).toContain('status=1 attempts=2');
    expect(output).not.toContain('curl unavailable');
  });

  it('preserves recovery artifacts when rollback readiness fails', () => {
    const shell = String.raw`
      source scripts/deploy-server.sh
      current_release='/opt/quant-platform/releases/new-release'
      curl() { return 1; }
      sleep() { :; }
      readlink() { printf '%s\n' "$current_release"; }
      sudo() {
        printf 'sudo:%s\n' "$*" >&2
        if [ "$1" = 'test' ] && [ "$2" = '-f' ]; then
          return 0
        fi
        if [ "$1" = 'ln' ] && [ "$2" = '-sfn' ]; then
          current_release="$3"
        fi
        return 0
      }

      previous_release="$(mktemp -d)"
      status=0
      handle_deploy_failure \
        '2026-08-01T00:00:00+00:00' \
        "$previous_release" \
        '/opt/quant-platform/releases/new-release' \
        '/var/lib/quant-platform/backups/pre-deploy-new-release.sqlite' \
        '/var/lib/quant-platform/app.sqlite' || status=$?
      printf 'status=%s\n' "$status"
      rm -rf "$previous_release"
      [ "$status" -eq 1 ]
    `;

    const result = spawnSync(bash, ['-c', shell], {
      cwd: process.cwd(),
      encoding: 'utf8',
    });
    const output = `${result.stdout}${result.stderr}`;

    expect(result.status).toBe(0);
    expect(output).toContain('rollback failed for');
    expect(output).toContain('자동 롤백 검증에 실패해 release와 DB snapshot을 보존합니다');
    expect(output).toContain(
      'sudo:mv /opt/quant-platform/releases/new-release/.deploy-in-progress /opt/quant-platform/releases/new-release/.deploy-failed',
    );
    expect(output).toContain(
      'sudo:mv /var/lib/quant-platform/backups/pre-deploy-new-release.sqlite.deploy-in-progress /var/lib/quant-platform/backups/pre-deploy-new-release.sqlite.deploy-failed',
    );
    expect(output).not.toContain('sudo:rm -rf -- /opt/quant-platform/releases/new-release');
    expect(output).not.toContain(
      'sudo:rm -f -- /var/lib/quant-platform/backups/pre-deploy-new-release.sqlite',
    );
  });

  it('refuses to delete a release that is still the current target', () => {
    const shell = String.raw`
      source scripts/deploy-server.sh
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

  it('cleans attempt-owned staging and incomplete snapshot files before service switch', () => {
    const shell = String.raw`
      source scripts/deploy-server.sh
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

  it('treats a missing expected DB snapshot as rollback failure', () => {
    const shell = String.raw`
      source scripts/deploy-server.sh
      curl() { return 0; }
      readlink() { echo '/opt/quant-platform/releases/new-release'; }
      sudo() {
        printf 'sudo:%s\n' "$*" >&2
        if [ "$1" = 'test' ] && [ "$2" = '-f' ]; then
          return 1
        fi
        return 0
      }

      previous_release="$(mktemp -d)"
      status=0
      rollback_release \
        "$previous_release" \
        '/var/lib/quant-platform/backups/pre-deploy-new-release.sqlite' \
        '/var/lib/quant-platform/app.sqlite' || status=$?
      printf 'status=%s\n' "$status"
      rm -rf "$previous_release"
      [ "$status" -eq 1 ]
    `;

    const result = spawnSync(bash, ['-c', shell], {
      cwd: process.cwd(),
      encoding: 'utf8',
    });
    const output = `${result.stdout}${result.stderr}`;

    expect(result.status).toBe(0);
    expect(output).toContain('롤백에 필요한 DB snapshot이 없습니다');
    expect(output).not.toContain('sudo:ln -sfn');
    expect(output).toContain('status=1');
  });

  it('holds a non-blocking kernel lock for the whole remote deployment shell', () => {
    const shell = String.raw`
      source scripts/deploy-server.sh
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
    expect(output).toContain('다른 서버 배포가 진행 중입니다');
    expect(output).toContain('blocked=75 recovered=0');
  });

  it('publishes a fully installed staging release only after checksum verification', () => {
    const deploy = readFileSync('scripts/deploy-server.sh', 'utf8');
    expect(deploy).toContain('source "${REPO_ROOT}/scripts/build-release.sh"');
    expect(deploy).toContain('QP_DEPLOY_PREFLIGHT_ONLY');
    expect(deploy.indexOf('서버 배포 preflight 완료')).toBeLessThan(
      deploy.indexOf('build_release "${ARTIFACT_DIR}"'),
    );
    expect(deploy.indexOf('release archive checksum 불일치')).toBeLessThan(
      deploy.indexOf('sudo mkdir "\\${RELEASE_STAGING}"'),
    );
    expect(deploy.indexOf('sudo corepack pnpm install --prod --frozen-lockfile')).toBeLessThan(
      deploy.indexOf('sudo mv "\\${RELEASE_STAGING}" "\\${RELEASE_DIR}"'),
    );
    expect(deploy).toContain('trap cleanup_remote_deploy EXIT');
    expect(deploy).toContain(
      'trap cleanup_remote_deploy EXIT\nacquire_deploy_lock\nEXPECTED_SHA=',
    );
    expect(deploy).toContain('DB_SNAPSHOT_INCOMPLETE=');
    expect(deploy).toContain('REMOTE_UPLOADS_OWNED=1');
    expect(deploy).toContain('REMOTE_UPLOAD_ID=');
    expect(deploy).toContain('quant-platform-upload-${RELEASE}-${REMOTE_UPLOAD_ID}.tar.gz');
    expect(deploy).toContain('sudo touch "\\${RELEASE_STAGING}/.deploy-in-progress"');
  });

  it('renders a syntactically valid remote deployment script', () => {
    const deploy = readFileSync('scripts/deploy-server.sh', 'utf8');
    const heredocMarker = 'ssh "${SSH_OPTS[@]}" "${TARGET}" bash -s <<EOF\n';
    const heredocStart = deploy.indexOf(heredocMarker);
    const heredocEnd = deploy.indexOf('\nEOF', heredocStart + heredocMarker.length);

    expect(heredocStart).toBeGreaterThanOrEqual(0);
    expect(heredocEnd).toBeGreaterThan(heredocStart);

    const rendered = deploy
      .slice(heredocStart + heredocMarker.length, heredocEnd)
      .replace('${REMOTE_SERVICE_HELPERS}', '')
      .replaceAll('${REMOTE_ARCHIVE}', 'quant-platform-test-release.tar.gz')
      .replaceAll('${REMOTE_CHECKSUM}', 'quant-platform-test-release.tar.gz.sha256')
      .replaceAll('${RELEASE}', 'test-release')
      .replaceAll('\\$', '$');
    const result = spawnSync(bash, ['-n'], {
      input: rendered,
      encoding: 'utf8',
    });

    expect(result.status, result.stderr).toBe(0);
  });

  it('defaults successful release and DB snapshot retention to zero', () => {
    const deploy = readFileSync('scripts/deploy-server.sh', 'utf8');

    expect(deploy).toContain('KEEP_RELEASES="${QP_DEPLOY_KEEP_RELEASES:-0}"');
    expect(deploy).toContain('KEEP_DB_SNAPSHOTS="${QP_DEPLOY_KEEP_DB_SNAPSHOTS:-0}"');
    expect(deploy).toContain('KEEP_RELEASES=${KEEP_RELEASES}');
    expect(deploy).toContain('KEEP_DB_SNAPSHOTS=${KEEP_DB_SNAPSHOTS}');
    expect(deploy).toContain('tail -n +\\$((KEEP_DB_SNAPSHOTS + 1))');
    expect(deploy).toContain('tail -n +\\$((KEEP_RELEASES + 1))');
    expect(deploy).not.toContain('KEEP_SNAPSHOTS=5');
  });

  it('rejects invalid deployment retention counts before connecting to the server', () => {
    const result = spawnSync(bash, ['scripts/deploy-server.sh'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        ...process.env,
        QP_HOST: 'deploy.invalid',
        QP_DEPLOY_KEEP_RELEASES: '-1',
      },
    });
    const output = `${result.stdout}${result.stderr}`;

    expect(result.status).toBe(1);
    expect(output).toContain('QP_DEPLOY_KEEP_RELEASES 는 0 이상의 정수여야 합니다: -1');
    expect(output).not.toContain('SSH 접속 확인');
  });

  it('treats legacy unmarked artifacts as successful and excludes exceptional states', () => {
    const deploy = readFileSync('scripts/deploy-server.sh', 'utf8');

    expect(deploy).toContain("-name 'pre-deploy-*.sqlite' -printf '%T@ %p\\n'");
    expect(deploy).toContain('.deploy-in-progress');
    expect(deploy).toContain('.deploy-failed');
    expect(deploy).not.toContain('.deploy-success-markers-v1');
    expect(deploy).not.toContain("-name '.deploy-succeeded'");
    expect(deploy).not.toContain(
      'sudo ls -1 /opt/quant-platform/releases 2>/dev/null | sort -r',
    );
  });
});
