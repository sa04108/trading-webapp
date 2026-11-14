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
- Consult relevant sections of `docs/AGENT_RUNTIME_BOUNDARY.md` for product runtime/version changes, `docs/AGENT_OPERATIONS.md` for agent operation and recovery, `docs/DOCKER_SERVER.md` for server deployment, and `docs/SPEC.md` for requirements and compatibility contracts. These are lookup routes, not a mandatory reading list.

## Subagents

- These instructions explicitly request delegation when either routing condition below applies. Apply them once after initial scoping, before detailed investigation or implementation; reassess only when scope or dependencies change. Do not perform an open-ended cost comparison.
- If there are multiple independent investigation questions and useful work remains for the root, spawn one worker for a bounded question before investigating it yourself.
- If an implementation part has agreed contracts, owned paths, and acceptance checks, and the root can progress independently, assign that part to a worker before implementing it yourself.
- Otherwise work directly, especially for small, sequential, or tightly coupled tasks. Use deterministic tools for mechanical work. Do not delegate work already completed by the root.
- Use the worker preset `model: gpt-6.1-terra`, `reasoning_effort: medium`, and `fork_turns: none` through supported runtime controls. Do not reselect settings for every task or assume prose changes the active model. If the preset is unavailable, report the limitation and continue directly where safe; never silently substitute a model or weaken required review.
- Send a compact task packet: objective, exact snapshot including relevant uncommitted changes, owned paths/symbols, contracts and evidence, exclusions, acceptance criteria, and validation commands. Reuse workers for related follow-ups and do not repeat reliable exploration.
- The root owns architecture, data integrity, security, compatibility, concurrency, cross-cutting decisions, and integration. Workers implement approved bounded parts and escalate decision changes, contract conflicts, or repeated failures without new evidence instead of guessing or looping.
- Avoid parallel edits to shared files or coupled code. Give shared contracts, migrations, dependency locks, and generated outputs one owner. Start with one worker; allow at most two concurrent subagents unless the user requests more. Subagents must not spawn further agents unless explicitly authorized by the root.
- Use an independent, focused review for high-risk changes with model and reasoning settings appropriate to the risk; the routine worker preset does not govern that review. Do not require another agent for every edit.
- When a routing condition applies, report the worker assignment or one concrete blocker in a single sentence. Keep a short checkpoint only when needed for handoff, interruption, or compaction; record the snapshot, decisions, changed paths, verification, and next action, not a running transcript.

## Verification and Reporting

- Reuse existing tests by default. A code change, new function, or desired coverage percentage alone does not justify adding tests.
- Before adding or extending a permanent test, identify the concrete failure it must catch, the existing tests considered and why they miss that failure, and the smallest sufficient case. Keep this rationale concise in the work summary or PR; do not create a separate document for each test.
- Assert observable behavior and independently justified expectations. Avoid mirroring the implementation, incidental call order, serialized HTML attribute order, or styling details unless they are the actual contract. Keep distinct financial, data-integrity, authorization, and lifecycle boundaries even when their fixtures look similar.
- Choose the smallest adequate test boundary and dataset. Do not repeat the same conditions across unit, integration, and E2E tests unless each layer protects a distinct failure. Synchronize asynchronous tests on observable completion or controlled events instead of arbitrary sleeps.
- Treat one-off debugging, benchmarks, and acceptance experiments as temporary verification by default. Keep their code and generated data outside the repository. Adopt a permanent resource or performance test only for an identified recurring requirement, with a reproducible environment, meaningful bounds, and an explicit command and execution point.
- Distinguish routine regression, integration/E2E, and large-data/resource or packaging checks. Before adding an expensive check, record its measured runtime/resource cost when available and where it will run. Moving an existing check out of the default suite must preserve an explicit required, release, or scheduled execution path; moving it alone is not an optimization.
- Consider replacing or consolidating existing cases and fixtures before increasing their number. Remove coverage only when its contract is obsolete or demonstrably protected elsewhere. Manage runtime, instability, maintenance cost, and failures detected rather than test counts or coverage targets.
- Define required checks before implementation. Run focused checks while iterating, then required integration/regression gates on the final integrated snapshot. Do not weaken tests, assertions, fixtures, or resource limits merely to obtain a pass.
- The root reviews the integrated diff and critical evidence, not just worker summaries. Reuse passing checks only while their tested inputs and relevant environment remain valid; rerun invalidated checks. Record the command, tested snapshot, exit status, and limitations concisely. Serialize builds and package checks that share output directories.
- Keep tool output and intermediate updates concise. Completion reports contain only changes/findings, affected files, material decisions, actual verification, and unresolved risks. Never report unrun checks as passed. When evaluating delegation, distinguish requested from observed model/effort and include usage across the root, workers, and retries when available; otherwise mark it unknown. Do not infer savings from diff size or a successful spawn.

## Git Workflow

- Explicit user instructions about branches, commits, or pushes override these workflow defaults. The root agent manages branch/worktree setup, staging, commits, and pushes; subagents perform these operations only when explicitly delegated.
- Before editing, inspect `git status --short --branch`, `git worktree list`, and recent commits. Preserve pre-existing changes, including staged changes; never overwrite them or include them in your commits.
- Before the first edit, create a descriptive task branch if on `main`, an unrelated branch, or a detached HEAD. Use a separate branch and worktree for concurrent editing tasks or when the existing checkout must be preserved.
- Base new independent tasks on freshly fetched remote `devel`. If it cannot be fetched, report the limitation before claiming the branch is current. Related subagent work must use the root's agreed task snapshot, including required parent changes.
- Commit each complete unit with related tests only after required verification passes. If verification fails or is blocked, do not commit; report the cause.
- Stage only task-owned changes by explicit path or hunk, and inspect the entire staged diff before committing.
- Exclude temporary verification code and generated data from commits; permanent test admission follows the criteria above.
- Complete authorized implementation work through integration into `devel`, not just a task-branch push. Push the verified task branch, review the final diff, satisfy required checks and branch protections, and merge into `devel`. Do not bypass review requirements or failed checks. If no CI covers a required check, run it locally and report the evidence and limitation.
- Integrate task branches into `devel` with squash merge by default, or rebase when preserving individual commits is necessary. Do not create merge commits on `devel` or rewrite already-published history to remove existing ones.
- Before merging, refresh `devel` and check for intervening changes. If integration changes tested inputs, resolve conflicts and rerun affected checks. If pushing or merging is blocked, preserve the work and report the concrete blocker.
- After a confirmed merge, update the primary checkout to `devel` and remove this task's merged local/remote branches and clean dedicated worktrees. Verify merged commits and clean status before removal; preserve unrelated branches, worktrees, and uncommitted work, and never remove the primary workspace. Do not finish with an abandoned task branch when cleanup is possible.
- Merging into `devel` does not itself authorize pushing to `main` or deploying production.
