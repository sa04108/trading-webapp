import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash';

describe('deploy script failure workflow', () => {
  it('prints the failed release journal before rollback and verifies restored readiness quietly', () => {
    const shell = String.raw`
      source scripts/deploy.sh
      attempts=0
      curl() {
        attempts=$((attempts + 1))
        echo 'curl unavailable' >&2
        [ "$attempts" -ge 2 ]
      }
      sleep() { :; }
      readlink() { echo '/opt/quant-platform/releases/new-release'; }
      sudo() {
        printf 'sudo:%s\n' "$*" >&2
        if [ "$1" = 'journalctl' ]; then
          echo 'audit_logs already exists' >&2
        fi
        if [ "$1" = 'test' ] && [ "$2" = '-f' ]; then
          return 0
        fi
        return 0
      }

      previous_release="$(mktemp -d)"
      status=0
      handle_deploy_failure \
        '2026-08-01T00:00:00+00:00' \
        "$previous_release" \
        "$previous_release/missing-snapshot.sqlite" \
        "$previous_release/app.sqlite" || status=$?
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
    expect(output).toMatch(/sudo:cp .*missing-snapshot\.sqlite .*app\.sqlite/);
    expect(output).toMatch(/sudo:rm -f .*app\.sqlite-wal .*app\.sqlite-shm/);
    expect(output).toContain('rolled back to');
    expect(output).toContain('status=1 attempts=2');
    expect(output).not.toContain('curl unavailable');
  });
});
