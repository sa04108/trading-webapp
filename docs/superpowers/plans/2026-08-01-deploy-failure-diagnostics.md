# Deploy Failure Diagnostics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve the necessary active-job cancellation coverage without a startup-speed race, then make failed deployments print the service journal before rollback and verify rollback readiness.

**Architecture:** Extract the child worker's cancellation flag into a tiny event-driven module so IPC reception is covered deterministically while the existing process integration test remains responsible for the user-visible cancellation lifecycle. Keep deployment behavior in `scripts/deploy.sh`, but define sourceable Bash helpers that are injected into the existing SSH heredoc; one behavioral Vitest harness runs those real helpers with fake external system commands.

**Tech Stack:** TypeScript 5.9, Vitest 4, Node.js 24 `EventEmitter`/`child_process`, Bash, systemd, SQLite deployment snapshots.

## Global Constraints

- Work only in the existing `fix/deploy-failure-diagnostics` worktree.
- Keep the active-child integration test; only move its strict IPC-reception proof to a deterministic unit boundary.
- Keep `cancelPath` in the audit detail and accept only `IPC`, `SIGTERM`, or `SIGKILL` in the STARTING cancellation integration test.
- Do not add a remote deployment script, change the systemd unit, print `app.env`, or change migration behavior.
- Collect new-release diagnostics before rollback and query `journalctl` only from the current deployment attempt's timestamp.
- A rollback is successful only after the restored service passes `/api/v1/health/ready`.
- New tests must execute real production code and assert behavior; do not grep source text.
- Add the minimum regression coverage: one worker-cancellation test and one deployment workflow test.

---

### Task 1: Stabilize the active-child cancellation contract

**Files:**
- Create: `src/workers/cancellation.ts`
- Create: `tests/unit/worker-cancellation.test.ts`
- Modify: `src/workers/backtest-child.ts:39-46,276,405-406`
- Modify: `tests/integration/job-queue.test.ts:236-286`

**Interfaces:**
- Consumes: Node-compatible event sources exposing `on('message', listener)` and `on('SIGTERM', listener)`.
- Produces: `installCancellationHandlers(source?: CancellationEventSource): CancellationState`, where `CancellationState.isRequested(): boolean` reports whether a cancel IPC message or SIGTERM was received.

- [ ] **Step 1: Write the failing worker-cancellation test**

```ts
import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { installCancellationHandlers } from '../../src/workers/cancellation.js';

describe('worker cancellation', () => {
  it('records cancel IPC and SIGTERM requests but ignores unrelated IPC', () => {
    const ipcSource = new EventEmitter();
    const ipcCancellation = installCancellationHandlers(ipcSource);

    ipcSource.emit('message', { type: 'progress' });
    expect(ipcCancellation.isRequested()).toBe(false);
    ipcSource.emit('message', { type: 'cancel' });
    expect(ipcCancellation.isRequested()).toBe(true);

    const signalSource = new EventEmitter();
    const signalCancellation = installCancellationHandlers(signalSource);
    signalSource.emit('SIGTERM');
    expect(signalCancellation.isRequested()).toBe(true);
  });
});
```

This test catches removal of the IPC listener, accepting arbitrary IPC messages as cancellation, or removal of the SIGTERM fallback.

- [ ] **Step 2: Run the unit test and verify RED**

Run: `pnpm vitest run tests/unit/worker-cancellation.test.ts`

Expected: FAIL because `src/workers/cancellation.ts` does not exist.

- [ ] **Step 3: Implement the cancellation state and wire the worker to it**

Create `src/workers/cancellation.ts`:

```ts
export interface CancellationEventSource {
  on(event: 'message', listener: (message: unknown) => void): unknown;
  on(event: 'SIGTERM', listener: () => void): unknown;
}

export interface CancellationState {
  isRequested(): boolean;
}

export function installCancellationHandlers(
  source: CancellationEventSource = process,
): CancellationState {
  let requested = false;

  source.on('message', (message: unknown) => {
    if (
      typeof message === 'object' &&
      message !== null &&
      'type' in message &&
      message.type === 'cancel'
    ) {
      requested = true;
    }
  });
  source.on('SIGTERM', () => {
    requested = true;
  });

  return { isRequested: () => requested };
}
```

In `src/workers/backtest-child.ts`, import `installCancellationHandlers`, replace the module-level flag/listeners with:

```ts
const cancellation = installCancellationHandlers();
```

Then use `cancellation.isRequested()` in `shouldCancel`, terminal status selection, and `process.exitCode` selection.

- [ ] **Step 4: Run the unit test and verify GREEN**

Run: `pnpm vitest run tests/unit/worker-cancellation.test.ts`

Expected: PASS with 1 test.

- [ ] **Step 5: Update the integration test to assert the actual documented escalation contract**

Keep the existing route, `CANCELLING`, terminal `CANCELLED`, null error, and audit-row assertions. Replace only the strict terminal path assertion with:

```ts
await waitFor(() => finishedDetail() !== undefined, 15_000);
expect(['IPC', 'SIGTERM', 'SIGKILL']).toContain(finishedDetail()?.cancelPath);
```

Update the nearby comment to explain that STARTING cancellation races child module initialization against the documented five-second escalation grace period, so the integration contract allows any configured path while `tests/unit/worker-cancellation.test.ts` proves the IPC listener itself.

- [ ] **Step 6: Run the affected tests repeatedly**

Run:

```bash
pnpm vitest run tests/unit/worker-cancellation.test.ts
pnpm vitest run tests/integration/job-queue.test.ts
pnpm vitest run tests/integration/job-queue.test.ts
pnpm vitest run tests/integration/job-queue.test.ts
```

Expected: all four commands PASS; the integration test may record different allowed `cancelPath` values without becoming flaky.

- [ ] **Step 7: Commit the cancellation test redesign**

```bash
git add src/workers/cancellation.ts src/workers/backtest-child.ts tests/unit/worker-cancellation.test.ts tests/integration/job-queue.test.ts
git commit -m "test: stabilize active job cancellation contract"
```

---

### Task 2: Print deployment failure diagnostics before verified rollback

**Files:**
- Create: `tests/unit/deploy-script.test.ts`
- Modify: `scripts/deploy.sh`

**Interfaces:**
- Consumes: Bash commands `curl`, `sudo systemctl`, `sudo journalctl`, `readlink`, `date`, and the existing release/DB snapshot paths.
- Produces: sourceable Bash functions `wait_for_ready(attempts?, delay_seconds?)`, `print_service_diagnostics(phase, since)`, `rollback_release(previous_release, db_snapshot, db_path)`, and `handle_deploy_failure(deploy_started_at, previous_release, db_snapshot, db_path)`.

- [ ] **Step 1: Write one failing behavioral deployment workflow test**

Create `tests/unit/deploy-script.test.ts`:

```ts
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
    expect(output).toContain('rolled back to');
    expect(output).toContain('status=1 attempts=2');
    expect(output).not.toContain('curl unavailable');
  });
});
```

This test catches missing journal collection, diagnostics moved after rollback, rollback without readiness polling, repeated curl noise, or a failed deployment incorrectly returning success.

- [ ] **Step 2: Run the deployment test and verify RED**

Run: `pnpm vitest run tests/unit/deploy-script.test.ts`

Expected: FAIL because sourcing the current script runs its main flow and `handle_deploy_failure` does not exist.

- [ ] **Step 3: Add sourceable deployment helpers**

Before the current main flow in `scripts/deploy.sh`, define:

```bash
wait_for_ready() {
  local attempts="${1:-10}"
  local delay_seconds="${2:-2}"
  local attempt
  for ((attempt = 1; attempt <= attempts; attempt += 1)); do
    if curl -fsS http://127.0.0.1:3000/api/v1/health/ready >/dev/null 2>&1; then
      return 0
    fi
    if ((attempt < attempts)); then sleep "${delay_seconds}"; fi
  done
  return 1
}

print_service_diagnostics() {
  local phase="$1"
  local since="$2"
  echo "==> service diagnostics: ${phase} (since ${since})" >&2
  echo '-- current release --' >&2
  readlink -f /opt/quant-platform/current >&2 || true
  if [ -f /opt/quant-platform/current/dist/build-info.json ]; then
    sudo cat /opt/quant-platform/current/dist/build-info.json >&2 || true
  fi
  echo '-- systemd properties --' >&2
  sudo systemctl show quant-platform --no-pager \
    --property=ActiveState,SubState,Result,ExecMainCode,ExecMainStatus,NRestarts >&2 || true
  echo '-- systemd status --' >&2
  sudo systemctl status quant-platform --no-pager -l >&2 || true
  echo '-- service journal --' >&2
  sudo journalctl -u quant-platform --since "${since}" --no-pager -o short-iso >&2 || true
}
```

Add `rollback_release` with explicit operation tracking:

```bash
rollback_release() {
  local previous_release="$1"
  local db_snapshot="$2"
  local db_path="$3"
  local rollback_ok=1
  local rollback_started_at

  sudo systemctl stop quant-platform || rollback_ok=0
  if [ "${rollback_ok}" -eq 1 ] && [ -f "${db_snapshot}" ]; then
    if sudo cp "${db_snapshot}" "${db_path}" &&
      sudo rm -f "${db_path}-wal" "${db_path}-shm"; then
      echo 'DB를 배포 전 스냅샷으로 복원했습니다' >&2
    else
      rollback_ok=0
    fi
  fi
  if [ "${rollback_ok}" -eq 1 ]; then
    sudo ln -sfn "${previous_release}" /opt/quant-platform/current || rollback_ok=0
  fi

  rollback_started_at="$(date --iso-8601=seconds)"
  if [ "${rollback_ok}" -eq 1 ] &&
    sudo systemctl restart quant-platform &&
    wait_for_ready; then
    echo "rolled back to ${previous_release}" >&2
    return 0
  fi

  echo "rollback failed for ${previous_release}" >&2
  print_service_diagnostics 'rollback failed' "${rollback_started_at}"
  return 1
}
```

Add `handle_deploy_failure`:

```bash
handle_deploy_failure() {
  local deploy_started_at="$1"
  local previous_release="$2"
  local db_snapshot="$3"
  local db_path="$4"

  echo '기동 또는 readiness 실패 — 새 릴리스 진단을 수집한 뒤 롤백합니다' >&2
  print_service_diagnostics 'new release failed' "${deploy_started_at}"
  if [ -n "${previous_release}" ] && [ -d "${previous_release}" ]; then
    rollback_release "${previous_release}" "${db_snapshot}" "${db_path}" || true
  else
    echo '롤백할 이전 release가 없습니다 — 서비스 상태를 직접 확인하세요' >&2
  fi
  return 1
}
```

Make sourcing safe before the interactive/main body:

```bash
if [[ "${BASH_SOURCE[0]}" != "$0" ]]; then
  return 0
fi
```

Before opening the SSH heredoc, capture all four definitions:

```bash
REMOTE_SERVICE_HELPERS="$(
  declare -f wait_for_ready
  declare -f print_service_diagnostics
  declare -f rollback_release
  declare -f handle_deploy_failure
)"
```

Expand `${REMOTE_SERVICE_HELPERS}` immediately after remote `set -euo pipefail` so the remote shell executes the same functions tested locally.

- [ ] **Step 4: Replace the remote restart/readiness/rollback block**

Capture `DEPLOY_ATTEMPT_STARTED_AT="$(date --iso-8601=seconds)"` immediately before restarting the new release. Keep `DEPLOY_FAILED` explicit, call `wait_for_ready` only after a successful restart, and on failure call:

```bash
handle_deploy_failure \
  "${DEPLOY_ATTEMPT_STARTED_AT}" \
  "${PREVIOUS_RELEASE}" \
  "${DB_SNAPSHOT}" \
  "${DB_PATH}" || exit 1
```

Remove the old inline curl loop and unverified rollback block. Keep the successful-release cleanup and manual rollback guidance unchanged.

- [ ] **Step 5: Run the deployment test and shell syntax checks**

Run:

```bash
pnpm vitest run tests/unit/deploy-script.test.ts
"C:/Program Files/Git/bin/bash.exe" -n scripts/deploy.sh
```

Expected: 1 Vitest test PASS and Bash exits 0 with no syntax output.

- [ ] **Step 6: Run focused regression checks**

Run:

```bash
pnpm vitest run tests/unit/worker-cancellation.test.ts tests/unit/deploy-script.test.ts
pnpm vitest run tests/integration/job-queue.test.ts
pnpm lint
pnpm typecheck
```

Expected: all commands PASS without errors or warnings introduced by this change.

- [ ] **Step 7: Commit deployment diagnostics**

```bash
git add scripts/deploy.sh tests/unit/deploy-script.test.ts
git commit -m "fix: expose deployment service failures"
```

---

### Task 3: Verify the complete branch

**Files:**
- Modify only files required to fix defects found by verification.

**Interfaces:**
- Consumes: the cancellation and deployment contracts from Tasks 1 and 2.
- Produces: a branch whose complete validation gate passes.

- [ ] **Step 1: Run all validation gates from a clean status**

Run:

```bash
pnpm test
pnpm lint
pnpm typecheck
pnpm build
"C:/Program Files/Git/bin/bash.exe" -n scripts/deploy.sh
git status --short
```

Expected: 75 test files and 702 tests pass (the prior baseline was 73 files/700 tests with one known cancellation race); lint, typecheck, build, and Bash syntax all exit 0; only intentionally uncommitted plan/spec documentation may remain.

- [ ] **Step 2: Review the final diff for scope and secrets**

Run:

```bash
git diff --check
git diff --stat HEAD~2..HEAD
git log --oneline -5
```

Expected: no whitespace errors, only the planned worker/test/deployment files plus planning documentation, and no environment values or credentials in the diff.

- [ ] **Step 3: Commit plan documentation if still uncommitted**

```bash
git add docs/superpowers/plans/2026-08-01-deploy-failure-diagnostics.md
git commit -m "docs: plan deploy failure diagnostics"
```
