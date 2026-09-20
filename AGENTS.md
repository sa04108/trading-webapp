# Working Principles

These instructions apply repository-wide.

## Request Handling

- Understand the user's goal and relevant code flow before acting.
- Write new or modified code comments and docstrings in Korean.
- Stay read-only for investigation, review, or design-only requests. Ask and wait if implementation intent is unclear; when changes are clearly requested, proceed within scope using reasonable defaults for minor details.

## Execution and Context

- Optimize total cost to a verified result, including delegation, retries, integration, and repair. Do not weaken correctness, security, compatibility, or required verification to reduce tokens.
- For nontrivial work, establish scope, invariants, acceptance checks, and dependency order before editing. Keep planning proportional to uncertainty and failure impact; small tasks do not require separate planning documents.
- Use deterministic tools for mechanical edits and generated files, and review their output. Read relevant code and documentation progressively. Save verbose logs and inspect summaries, failures, and necessary context without hiding errors.
- Consult relevant sections of `docs/AGENT_RUNTIME_BOUNDARY.md` for product runtime/version changes, `docs/AGENT_OPERATIONS.md` for packaging/deployment, and `docs/SPEC.md` / `docs/DECISIONS.md` for requirements or compatibility decisions. These are lookup routes, not a mandatory reading list.

## Subagents

- These instructions explicitly request delegation when either routing condition below applies. Apply them once after initial scoping, before detailed investigation or implementation; reassess only when scope or dependencies change. Do not perform an open-ended cost comparison.
- If there are multiple independent investigation questions and useful work remains for the root, spawn one worker for a bounded question before investigating it yourself.
- If an implementation part has agreed contracts, owned paths, and acceptance checks, and the root can progress independently, assign that part to a worker before implementing it yourself.
- Otherwise work directly, especially for small, sequential, or tightly coupled tasks. Use deterministic tools for mechanical work. Do not delegate work already completed by the root.
- Use the worker preset `model: gpt-5.6-terra`, `reasoning_effort: medium`, and `fork_turns: none` through supported runtime controls. Do not reselect settings for every task or assume prose changes the active model. If the preset is unavailable, report the limitation and continue directly where safe; never silently substitute a model or weaken required review.
- Send a compact task packet: objective, exact snapshot including relevant uncommitted changes, owned paths/symbols, contracts and evidence, exclusions, acceptance criteria, and validation commands. Reuse workers for related follow-ups and do not repeat reliable exploration.
- The root owns architecture, data integrity, security, compatibility, concurrency, cross-cutting decisions, and integration. Workers implement approved bounded parts and escalate decision changes, contract conflicts, or repeated failures without new evidence instead of guessing or looping.
- Avoid parallel edits to shared files or coupled code. Give shared contracts, migrations, dependency locks, and generated outputs one owner. Start with one worker; allow at most two concurrent subagents unless the user requests more. Subagents must not spawn further agents unless explicitly authorized by the root.
- Use an independent, focused review for high-risk changes with model and reasoning settings appropriate to the risk; the routine worker preset does not govern that review. Do not require another agent for every edit.
- When a routing condition applies, report the worker assignment or one concrete blocker in a single sentence. Keep a short checkpoint only when needed for handoff, interruption, or compaction; record the snapshot, decisions, changed paths, verification, and next action, not a running transcript.

## Verification and Reporting

- Define required checks before implementation. Run focused checks while iterating, then required integration/regression gates on the final integrated snapshot. Do not weaken tests, assertions, fixtures, or resource limits merely to obtain a pass.
- The root reviews the integrated diff and critical evidence, not just worker summaries. Reuse passing checks only while their tested inputs and relevant environment remain valid; rerun invalidated checks. Record the command, tested snapshot, exit status, and limitations concisely. Serialize builds and package checks that share output directories.
- Keep tool output and intermediate updates concise. Completion reports contain only changes/findings, affected files, material decisions, actual verification, and unresolved risks. Never report unrun checks as passed. When evaluating delegation, distinguish requested from observed model/effort and include usage across the root, workers, and retries when available; otherwise mark it unknown. Do not infer savings from diff size or a successful spawn.

## Git Workflow

- Explicit user instructions about branches, commits, or pushes override these workflow defaults. The root agent manages branch/worktree setup, staging, commits, and pushes; subagents perform these operations only when explicitly delegated.
- Before editing, inspect `git status --short --branch`, `git worktree list`, and recent commits. Preserve pre-existing changes, including staged changes; never overwrite them or include them in your commits.
- Before the first edit, create a descriptive task branch if on `main`, an unrelated branch, or a detached HEAD. Use a separate branch and worktree for concurrent editing tasks or when the existing checkout must be preserved.
- Base new independent tasks on freshly fetched remote `main`; if unavailable, use local `main` and report the limitation. Related subagent work must use the root's agreed task snapshot, including required parent changes.
- Commit each complete unit with related tests and documentation only after required verification passes. If verification fails or is blocked, do not commit; report the cause.
- Stage only task-owned changes by explicit path or hunk, and inspect the entire staged diff before committing.
- After committing, push when the remote and authentication are available, setting upstream for new branches. If pushing is unavailable or fails, preserve the commit and report why.
