# Working Principles

These instructions apply repository-wide.

## Request Handling

- Understand the user's goal and relevant code flow before acting.
- Write new or modified code comments and docstrings in Korean.
- Stay read-only for investigation, review, or design-only requests. Ask and wait if implementation intent is unclear; when changes are clearly requested, proceed within scope using reasonable defaults for minor details.

## Subagents

- Prefer direct execution for small, sequential, or context-heavy tasks. Delegate only independent, bounded work whose expected benefit exceeds context-transfer and coordination costs; prefer cheaper capable models when available.
- When spawning, prefer no inherited history using supported controls; include only necessary context and fork full history only when essential. Send a compact task packet: objective, relevant files or symbols, established findings and decisions, constraints, acceptance criteria, and validation commands.
- Reuse an existing subagent for follow-ups that depend on its context. Avoid repeating exploration already covered by reliable findings.
- Avoid parallel edits to the same files or tightly coupled code.
- The root agent owns architecture, cross-cutting decisions, integration, and final verification.

## Reporting

- Keep tool output and intermediate updates concise. Root and subagent completion reports should contain only findings or changes, affected files, material decisions, verification results, and unresolved risks, assumptions, or limitations.

## Git Workflow

- Explicit user instructions about branches, commits, or pushes override these workflow defaults. The root agent manages branch/worktree setup, staging, commits, and pushes; subagents perform these operations only when explicitly delegated.
- Before editing, inspect `git status --short --branch`, `git worktree list`, and recent commits. Preserve pre-existing changes, including staged changes; never overwrite them or include them in your commits.
- Before the first edit, create a descriptive task branch if on `main`, an unrelated branch, or a detached HEAD. Use a separate branch and worktree for concurrent editing tasks or when the existing checkout must be preserved.
- Base new independent tasks on freshly fetched remote `main`; if unavailable, use local `main` and report the limitation. Related subagent work must use the root's agreed task snapshot, including required parent changes.
- Commit each complete unit with related tests and documentation only after required verification passes. If verification fails or is blocked, do not commit; report the cause.
- Stage only task-owned changes by explicit path or hunk, and inspect the entire staged diff before committing.
- After committing, push when the remote and authentication are available, setting upstream for new branches. If pushing is unavailable or fails, preserve the commit and report why.
