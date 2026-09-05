# Working Principles

These instructions apply to the entire repository.

## Request Handling

- Understand the user's goal and relevant code flow before acting.
- Write all code comments and docstrings in Korean.
- For investigation, review, or design alone, stay read-only; if implementation intent is unclear, ask the user and wait before editing; when changes are clearly requested, proceed without reconfirmation, using reasonable defaults for minor details within the authorized scope.

### Subagents

- Assign repetitive code generation, document formatting, test-case expansion, lint fixes, comment cleanup, simple renames, mechanical migrations, and preliminary log summaries to smaller-model subagents within a defined scope. Escalate design, contract, or risk decisions to the main agent.
- Subagents are opt-in: deliberately choose them per task, never spawn by default. Use them only for independent work with summarizable results, when isolating intermediate output protects the main context or parallel execution materially reduces elapsed time.
- Prefer read-only subagents. For editing tasks, assign exclusive module ownership; never let multiple agents edit the same module concurrently.

### Reporting

- Summarize tool output and intermediate exploration; final reports contain only outcomes or changes, verification, and risks, including material assumptions or limitations.

## Git Workflow

- Before editing, inspect `git status --short --branch`, the current branch, and `git worktree list`. Treat existing changes as belonging to the user or another worker; never overwrite them or include them in your commit.
- If the current branch is `main`, create a descriptive task branch before the first edit.
- Before committing, compare the current branch or worktree name and recent commit history with the task. If they are unrelated, switch to a dedicated task branch; if the existing checkout must be preserved or is shared with another task, create a separate worktree as well.
- Start every new branch or worktree from the latest `main`.
- If another Codex task is active in the same repository, work in a separate branch and worktree to avoid conflicts.
- Commit after each complete, verified unit of work. Include related tests and documentation in the same commit, stage only your changes by explicit path, and inspect the staged diff before committing.
- A change that fails verification is incomplete. If the failure cannot be resolved, do not commit; report the failure and its cause.
- After committing, push the current branch when the remote and authentication are available, setting the upstream for a new branch. If the push fails, keep the commit and report the reason.
- Explicit user instructions about branches, commits, or pushes override this workflow.
