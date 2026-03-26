# Requirements Document

## Introduction

`spec-monkey` is a Node.js/TypeScript CLI tool for unattended AI-driven development automation. It is a ground-up rewrite of the Python-based `autodev` project, created as a sibling directory alongside it. `spec-monkey` replicates all core functionality — CLI commands, backend integrations, task lifecycle management, verification gate, experiment mode, git operations, detached session support, and a web dashboard — while being idiomatic TypeScript with no Python runtime dependency.

The implementation targets Node.js 20+ with TypeScript 5+, uses `commander` for CLI parsing, and ships as a standalone `spec-monkey` binary via the `package.json` `bin` entry.

## Glossary

- **CLI**: The `spec-monkey` command-line interface binary.
- **Backend**: An external AI coding agent CLI (`claude`, `codex`, `gemini`, `opencode`) invoked as a child process.
- **Task**: A single unit of work described in `task.json` with an observable completion contract.
- **TaskStore**: The runtime queue of tasks persisted in `task.json`.
- **Gate**: The verification subsystem that evaluates whether a task's completion contract is met.
- **Runner**: The main automation loop that selects, executes, verifies, and commits tasks.
- **Config**: The TOML-based project configuration loaded from `spec-monkey.toml`.
- **Snapshot**: A point-in-time directory file listing used to detect changed files between task attempts.
- **CircuitBreaker**: A safety mechanism that halts the Runner after repeated failures or rate-limit events.
- **Heartbeat**: A background timer that emits periodic status updates while a backend subprocess is running.
- **Reflection**: The subsystem that refines a failed task's steps and verification guidance before the next retry.
- **Epoch**: One full plan → execute → verify cycle; multiple epochs are supported via `--epochs N`.
- **ExperimentMode**: An iterative optimization loop for metric-driven tasks that commits, measures, and reverts automatically.
- **Skill**: A reusable agent instruction set stored under `.skills/` and optionally installed into tool-native paths.
- **COCASpec**: A structured specification document with Context, Outcome, Constraints, and Assertions sections.
- **ProgressFile**: The human-readable append-only log written to `progress.txt`.
- **Dashboard**: The optional web UI served by `spec-monkey web` for multi-project monitoring.
- **Detach**: Running the Runner inside a background `tmux` session for overnight unattended work.

---

## Requirements

### Requirement 1: Project Initialization

**User Story:** As a developer, I want to initialize a new project with `spec-monkey init`, so that all required config files, scaffolding, and agent wrappers are created automatically without manual setup.

#### Acceptance Criteria

1. WHEN `spec-monkey init <directory>` is executed, THE CLI SHALL create `spec-monkey.toml`, `task.json`, `AGENT.md`, `TASK.md`, `progress.txt`, and a `logs/` directory inside the target directory.
2. WHEN `--use <tool>` is provided to `spec-monkey init`, THE CLI SHALL scaffold tool-native wrapper files for exactly one of `claude`, `codex`, `gemini`, or `opencode`.
3. WHEN `--use` is omitted, THE CLI SHALL default to scaffolding `codex` wrapper files.
4. WHEN `spec-monkey init` is run a second time with a different `--use` value on an existing project, THE CLI SHALL add the new tool wrapper without overwriting any existing files.
5. THE CLI SHALL copy the default shared skills (`spec-monkey-runtime`, `coca-spec`, `spec-driven-develop`, `find-skills`, `skill-creator`) into `.skills/` during init.
6. WHEN the target directory does not exist, THE CLI SHALL create it before writing any files.
7. WHEN `spec-monkey.toml` already exists in the target directory, THE CLI SHALL skip writing it and print a notice rather than overwriting it.

---

### Requirement 2: Configuration Loading

**User Story:** As a developer, I want `spec-monkey` to load project settings from `spec-monkey.toml`, so that backend selection, file paths, and runtime parameters are configurable without repeating CLI flags on every invocation.

#### Acceptance Criteria

1. THE Config SHALL parse `spec-monkey.toml` using a TOML library and populate a typed configuration object covering all sections: `[project]`, `[backend]`, `[backend.claude]`, `[backend.codex]`, `[backend.gemini]`, `[backend.opencode]`, `[run]`, `[files]`, `[verification]`, `[reflection]`, `[snapshot]`, `[circuit_breaker]`, `[git]`, `[detach]`.
2. WHEN a config key is absent from `spec-monkey.toml`, THE Config SHALL use the documented default value for that key.
3. WHEN an environment variable of the form `SPEC_MONKEY_<SECTION>_<KEY>` is set, THE Config SHALL override the corresponding config field with the environment variable value, coercing the string to the field's declared type.
4. WHEN `backend.default` is not one of `claude`, `codex`, `gemini`, `opencode`, THE Config SHALL throw a `ConfigError` with a message listing the valid values.
5. WHEN relative paths appear in `[files]` or `[project]`, THE Config SHALL resolve them against the directory containing `spec-monkey.toml`.
6. THE Config SHALL accept the legacy `[gate]` section as an alias for `[verification]` for backward compatibility with projects migrated from `autodev`.
7. FOR ALL valid `spec-monkey.toml` files, parsing then re-serializing then parsing SHALL produce an equivalent configuration object (round-trip correctness property).

---

### Requirement 3: Backend Command Building

**User Story:** As a developer, I want `spec-monkey` to invoke the correct AI backend CLI with the right flags, so that tasks execute in fully-automatic non-interactive mode without prompting for permissions.

#### Acceptance Criteria

1. WHEN `backend.default = "claude"`, THE Backend SHALL build a command using `claude -p` and append `--dangerously-skip-permissions` when `skip_permissions = true`.
2. WHEN `backend.default = "codex"`, THE Backend SHALL build a command using `codex exec --yolo` when `yolo = true`, falling back to `--full-auto --dangerously-bypass-approvals-and-sandbox` when `yolo = false`.
3. WHEN `backend.default = "gemini"`, THE Backend SHALL build a command using `gemini -p` and append `--yolo` when `yolo = true`.
4. WHEN `backend.default = "opencode"`, THE Backend SHALL build a command using `opencode run` and inject the configured permission JSON via the `OPENCODE_PERMISSION` environment variable.
5. WHEN a backend CLI binary is not found in PATH, THE Backend SHALL throw a descriptive error naming the missing binary and linking to its install instructions.
6. WHEN `forPlan = true`, THE Backend SHALL build a one-shot prompt command that captures stdout as text without starting an interactive session.
7. THE Backend registry SHALL support all four backends (`claude`, `codex`, `gemini`, `opencode`) and be extensible so new backends can be added without modifying existing backend modules.
8. WHEN the backend subprocess exits with a non-zero code during a plan command, THE Backend SHALL throw a `RuntimeError` including the exit code and stderr excerpt.

---

### Requirement 4: Task Store Management

**User Story:** As a developer, I want `spec-monkey` to manage the task queue in `task.json`, so that task state is persisted, inspectable, and recoverable across runs.

#### Acceptance Criteria

1. THE TaskStore SHALL load `task.json` and return a typed task array with all required fields defaulted when absent (`passes = false`, `blocked = false`, `block_reason = ""`).
2. WHEN `spec-monkey task list` is executed, THE CLI SHALL display all tasks with color-coded status badges: `PENDING`, `RUNNING`, `COMPLETED`, `BLOCKED`, `RETRY`.
3. WHEN `spec-monkey task next` is executed, THE CLI SHALL display the next pending task's `id`, `title`, and `description`.
4. WHEN `spec-monkey task reset --ids <id,...>` is executed, THE CLI SHALL reset only the specified tasks to pending state.
5. WHEN `spec-monkey task reset` is executed without `--ids`, THE CLI SHALL reset all non-completed tasks to pending state.
6. WHEN `spec-monkey task retry` is executed, THE CLI SHALL reset only blocked tasks to pending state.
7. WHEN `spec-monkey task block <id> "<reason>"` is executed, THE CLI SHALL mark the specified task as blocked with the given reason and a `blocked_at` timestamp.
8. WHEN a task is marked completed, THE TaskStore SHALL set `passes = true` and record a `completed_at` ISO timestamp.
9. THE TaskStore SHALL enforce that each task has `id`, `title`, `description`, non-empty `steps`, and a valid `completion` contract before accepting it into the queue; tasks failing this check SHALL be rejected with a descriptive audit error.
10. WHEN `task.json` cannot be read or parsed, THE CLI SHALL print a clear error and exit with a non-zero status code rather than silently using an empty task list.

---

### Requirement 5: Planning (Intent → task.json)

**User Story:** As a developer, I want `spec-monkey plan` to convert free-form intent or a PRD file into a structured `task.json`, so that I can start automated execution without hand-writing tasks.

#### Acceptance Criteria

1. WHEN `spec-monkey plan --intent "<text>"` is executed, THE CLI SHALL generate a COCASpec first, save it under `docs/specs/`, and then generate `task.json` from that spec using the configured backend.
2. WHEN `spec-monkey plan -f <file>` is executed and the file already contains all four COCA headings (`## Context`, `## Outcome`, `## Constraints`, `## Assertions`), THE CLI SHALL skip spec generation and generate `task.json` directly from the file.
3. WHEN `spec-monkey plan -f <file>` is executed and the file is plain intent text, THE CLI SHALL generate an intermediate COCASpec, save it under `docs/specs/`, and then generate `task.json`.
4. WHEN the backend returns output that is not valid JSON, THE CLI SHALL throw a `RuntimeError` including the first 500 characters of the raw output.
5. WHEN the generated JSON is missing a `tasks` array, THE CLI SHALL throw a `RuntimeError` listing the keys that were present.
6. WHEN planning succeeds, THE CLI SHALL write the result to the path specified by `files.task_json` in config and print the number of tasks generated.
7. WHEN `spec-monkey spec --intent "<text>"` is executed, THE CLI SHALL generate only the COCASpec and save it to `docs/specs/<name>-coca-spec.md` without generating `task.json`.
8. THE CLI SHALL inject the source document path into each generated task's `docs` field when planning from a file.
9. THE CLI SHALL run a task audit on the generated task store and reject the output if any task fails the audit, printing the audit errors before exiting.

---

### Requirement 6: Main Automation Runner

**User Story:** As a developer, I want `spec-monkey run` to execute pending tasks autonomously, so that the AI backend completes work without manual intervention.

#### Acceptance Criteria

1. WHEN `spec-monkey run` is executed, THE Runner SHALL select the next pending task, build a prompt, invoke the backend subprocess, stream output to a per-attempt log file, and evaluate the Gate.
2. WHEN a task passes the Gate, THE Runner SHALL mark it completed, optionally commit changed files to git, and proceed to the next task.
3. WHEN a task fails the Gate and retries remain, THE Runner SHALL invoke Reflection to refine the task, then retry with the refined guidance.
4. WHEN a task exhausts all retries, THE Runner SHALL mark it blocked and continue to the next task.
5. WHEN `--dry-run` is provided, THE Runner SHALL print the rendered prompt and task details without invoking any backend subprocess.
6. WHEN `--backend <name>` is provided, THE Runner SHALL use that backend for the current run only, overriding the config value.
7. WHEN `--max-tasks N` is provided, THE Runner SHALL stop after processing at most N tasks in the current run.
8. WHEN `--epochs N` is provided and the current queue is exhausted, THE Runner SHALL replan a new task queue using the stored `planning_source` and continue until N epochs are complete or no new tasks are generated.
9. WHEN the backend subprocess exits with code 130, THE Runner SHALL treat it as a SIGINT user interrupt, stop cleanly, and exit with code 130.
10. WHEN an environment or permission error pattern is detected in the attempt log, THE Runner SHALL stop the run without marking the current task blocked and print remediation guidance.
11. WHILE a backend subprocess is running, THE Heartbeat SHALL emit a status update to the terminal every `run.heartbeat_interval` seconds showing elapsed time and whether output is streaming.
12. THE Runner SHALL write `logs/runtime-status.json` and `logs/dashboard.html` after each significant state change (task start, task complete, task blocked, epoch boundary).

---

### Requirement 7: Verification Gate

**User Story:** As a developer, I want the Gate to evaluate whether a task's completion contract is met, so that only genuinely complete tasks are marked as passed.

#### Acceptance Criteria

1. WHEN `completion.kind = "boolean"`, THE Gate SHALL pass only when all configured `validate_commands` exit with code 0 and the minimum changed-file count is met.
2. WHEN `completion.kind = "numeric"`, THE Gate SHALL extract the metric value from the last successful validation command's JSON stdout using `completion.json_path`.
3. WHEN a numeric metric is greater than the best-so-far by at least `min_improvement`, THE Gate SHALL set `outcome = "improved"`.
4. WHEN a numeric metric differs from the best-so-far by less than `unchanged_tolerance`, THE Gate SHALL set `outcome = "unchanged"`.
5. WHEN a numeric metric is worse than the best-so-far beyond `unchanged_tolerance`, THE Gate SHALL set `outcome = "regressed"`.
6. WHEN `completion.target` is set and the metric meets or exceeds the target (per `direction`), THE Gate SHALL set `outcome = "target_met"`.
7. WHEN `enforceChangeRequirements = false`, THE Gate SHALL skip the min-changed-files and path-pattern checks (used for baseline measurement).
8. WHEN a `validate_command` string contains shell control tokens (`&&`, `||`, `|`, `;`), THE Gate SHALL reject it with a descriptive error before execution.
9. WHEN `spec-monkey verify <task_id>` is executed, THE CLI SHALL run the Gate for the specified task and print a human-readable result including pass/fail, changed files, and any validation errors.
10. THE Gate SHALL support `validate_working_directory` and `validate_environment` overrides per task, applying them to every validation command for that task.
11. WHEN a `validate_command` exceeds `verification.validate_timeout_seconds`, THE Gate SHALL kill the process and record a timeout error.

---

### Requirement 8: Reflection and Task Refinement

**User Story:** As a developer, I want failed task attempts to be analyzed and the task refined automatically, so that subsequent retries have better guidance without changing the task's goal.

#### Acceptance Criteria

1. WHEN a task attempt fails and `reflection.enabled = true`, THE Reflection SHALL invoke the backend with the attempt log tail to produce refined `steps`, `docs`, `verification`, and `implementation_notes`.
2. WHEN Reflection produces a refined task, THE Reflection SHALL preserve `id`, `title`, `description`, `completion`, and `execution` fields exactly as they were; any attempt to change these fields SHALL be rejected.
3. WHEN the number of refinements for a task reaches `reflection.max_refinements_per_task`, THE Reflection SHALL skip further refinement and proceed directly to retry with the last refined version.
4. THE Reflection SHALL append each failed attempt's summary to `task.attempt_history` (capped at `reflection.max_attempt_history_entries`) and to `task.learning_notes` (capped at `reflection.max_learning_notes`).
5. THE Reflection SHALL append a learning entry to the top-level `learning_journal` in `task.json` (capped at `reflection.max_project_learning_entries`).
6. WHEN building the next attempt prompt, THE Runner SHALL include the most recent `reflection.prompt_learning_limit` entries from `task.learning_notes` and from `learning_journal`.

---

### Requirement 9: Experiment Mode

**User Story:** As a developer, I want metric-driven tasks to run in experiment mode, so that the system autonomously iterates, measures, commits, and reverts until the metric improves or the iteration budget is exhausted.

#### Acceptance Criteria

1. WHEN `execution.strategy = "iterative"` and `completion.kind = "numeric"`, THE Runner SHALL execute the task in ExperimentMode.
2. WHEN ExperimentMode starts, THE Runner SHALL run the Gate with `enforceChangeRequirements = false` to establish a baseline metric before any code changes (iteration 0).
3. IF the baseline Gate fails or returns no metric value, THEN THE Runner SHALL mark the task blocked and skip all iterations.
4. FOR each iteration from 1 to `execution.max_iterations`, THE Runner SHALL invoke the backend, create an experiment git commit of the changed files, run the Gate, and compare the metric against the best-so-far.
5. WHEN the metric outcome is `improved`, THE Runner SHALL retain the commit and update the best-so-far metric.
6. WHEN the metric outcome is `regressed` and `execution.rollback_on_failure = true`, THE Runner SHALL revert the experiment commit using `git revert --no-edit`.
7. WHEN the metric outcome is `unchanged` and `execution.keep_on_equal = false`, THE Runner SHALL revert the experiment commit.
8. WHEN ExperimentMode is active and the project directory is not a git repository, THE Runner SHALL mark the task blocked immediately with a clear message.
9. THE Runner SHALL append a structured JSONL entry to `logs/experiments.jsonl` after each iteration containing at minimum: `task_id`, `iteration`, `metric_name`, `baseline_value`, `best_before`, `measured_value`, `outcome`, `commit_sha`, `reverted_sha`, and `timestamp`.
10. WHEN the consecutive no-improvement streak reaches `execution.stop_after_no_improvement`, THE Runner SHALL stop iterating and mark the task blocked with the streak count in the reason.
11. WHEN an experiment commit cannot be created (e.g. nothing changed), THE Runner SHALL skip the Gate for that iteration and count it as an invalid result.

---

### Requirement 10: Git Operations

**User Story:** As a developer, I want `spec-monkey` to commit completed task work to git automatically, so that every task is independently revertable and the project history is traceable.

#### Acceptance Criteria

1. WHEN a task completes successfully and `git.auto_commit = true`, THE GitOps module SHALL stage the changed files and create a commit using the `git.commit_message_template` with `{task_id}` and `{task_name}` substituted.
2. WHEN `createExperimentCommit` is called, THE GitOps module SHALL stage the provided changed files and create a commit with the configured `commit_prefix` and task identity in the message.
3. WHEN `revertCommit` is called with a commit SHA, THE GitOps module SHALL run `git revert --no-edit <sha>` and return the new HEAD SHA on success.
4. WHEN the project directory is not a git repository, THE GitOps module SHALL skip all git operations silently and return a no-op result.
5. WHEN a `.git/index.lock` file is detected, THE GitOps module SHALL log a warning and return a no-op result rather than crashing.
6. WHEN `git add` or `git commit` fails for any other reason, THE GitOps module SHALL log the stderr output and return a no-op result without throwing.
7. THE GitOps module SHALL provide a `readRecentGitHistory(n)` function that returns the last N commits as structured objects with `commitSha`, `subject`, `body`, and `committedAt`.

---

### Requirement 11: Snapshot and Changed-File Tracking

**User Story:** As a developer, I want `spec-monkey` to detect which files changed during a task attempt, so that the Gate can verify the right files were modified and git commits include only relevant changes.

#### Acceptance Criteria

1. THE Snapshot module SHALL record a file listing (path + mtime + size) of all watched directories before and after each task attempt.
2. WHEN `snapshot.ignore_dirs` contains a directory name, THE Snapshot SHALL exclude that directory and all its descendants from the listing.
3. WHEN `snapshot.ignore_path_globs` contains a glob pattern, THE Snapshot SHALL exclude all paths matching that pattern from the listing.
4. WHEN `snapshot.include_path_globs` is non-empty, THE Snapshot SHALL include only paths that match at least one of those globs.
5. THE Runner SHALL filter `spec-monkey` runtime artifacts (`task.json`, `progress.txt`, `logs/`) from the changed-file diff before passing it to the Gate or git operations.
6. FOR ALL directory states, taking a snapshot before and after a no-op operation (no files written or modified) SHALL produce an empty diff (idempotence property).

---

### Requirement 12: Circuit Breaker

**User Story:** As a developer, I want the Runner to stop automatically when it detects repeated failures or rate-limit events, so that unattended runs do not waste API quota or loop indefinitely on a broken environment.

#### Acceptance Criteria

1. WHEN the number of consecutive tasks with no progress (no files changed, no gate pass) reaches `circuit_breaker.no_progress_threshold`, THE CircuitBreaker SHALL open and halt the Runner with a descriptive message.
2. WHEN the number of consecutive tasks ending in the same error pattern reaches `circuit_breaker.repeated_error_threshold`, THE CircuitBreaker SHALL open and halt the Runner.
3. WHEN a rate-limit pattern from `circuit_breaker.rate_limit_patterns` is found in an attempt log, THE CircuitBreaker SHALL pause the Runner for `circuit_breaker.rate_limit_cooldown` seconds before resuming.
4. WHEN the CircuitBreaker opens, THE Runner SHALL log the reason, write a final `runtime-status.json` snapshot, and exit with a non-zero status code.

---

### Requirement 13: Detached Session Support

**User Story:** As a developer, I want `spec-monkey run --detach` to launch the run in a background tmux session, so that I can start overnight work and safely disconnect from the terminal.

#### Acceptance Criteria

1. WHEN `spec-monkey run --detach` is executed, THE CLI SHALL create a new tmux session named `<detach.tmux_session_prefix>-<project-name>` and run `spec-monkey run` (without `--detach`) inside it.
2. WHEN `spec-monkey list` is executed, THE CLI SHALL list all running tmux sessions whose names start with `detach.tmux_session_prefix`, showing session name and start time.
3. WHEN `spec-monkey attach <session>` is executed, THE CLI SHALL attach the current terminal to the named tmux session.
4. WHEN `spec-monkey stop <session>` is executed, THE CLI SHALL kill the named tmux session.
5. WHEN `spec-monkey stop --all` is executed, THE CLI SHALL kill all sessions whose names start with `detach.tmux_session_prefix`.
6. WHEN `tmux` is not installed or not in PATH, THE CLI SHALL print a clear error message and exit with a non-zero status code.

---

### Requirement 14: Progress Logging

**User Story:** As a developer, I want `spec-monkey` to append structured progress entries to `progress.txt`, so that I can review the full execution history after an unattended run without parsing binary logs.

#### Acceptance Criteria

1. WHEN a task completes, THE Runner SHALL append a progress entry to `progress.txt` containing `task_id`, `task_name`, `status = "completed"`, `changed_files` count, and a UTC timestamp.
2. WHEN a task is blocked, THE Runner SHALL append a progress entry with `status = "blocked"` and the `block_reason`.
3. WHEN a task attempt fails and will be retried, THE Runner SHALL append a progress entry with `status = "retry"` and the attempt number.
4. THE ProgressFile entries SHALL be human-readable plain text and append-only; no existing entry SHALL ever be modified or deleted.

---

### Requirement 15: Status Command

**User Story:** As a developer, I want `spec-monkey status` to show a summary of the current run state, so that I can quickly assess progress without reading raw log files.

#### Acceptance Criteria

1. WHEN `spec-monkey status` is executed, THE CLI SHALL display task counts for `pending`, `completed`, `blocked`, and `running` states.
2. WHEN `--json` is provided, THE CLI SHALL output the status as a valid JSON object to stdout.
3. WHEN `logs/runtime-status.json` exists, THE CLI SHALL include the `last_updated` timestamp and `current_task_id` from that file in the output.
4. WHEN `task.json` does not exist, THE CLI SHALL print a message indicating the project has not been planned yet and exit with code 0.

---

### Requirement 16: Skill Management

**User Story:** As a developer, I want `spec-monkey skills` commands to list, recommend, and diagnose skills, so that I can discover and install the right agent instruction sets for my project.

#### Acceptance Criteria

1. WHEN `spec-monkey skills list` is executed, THE CLI SHALL list all skills found in `.skills/` with their directory names and one-line descriptions parsed from each skill's `SKILL.md`.
2. WHEN `spec-monkey skills recommend "<query>"` is executed, THE CLI SHALL return up to `--limit` (default 5) skill names whose descriptions or trigger keywords match the query.
3. WHEN `spec-monkey skills doctor` is executed, THE CLI SHALL verify that `.skills/` exists, the configured backend wrapper directory is present, and any skill symlinks resolve correctly, then report each issue found.
4. WHEN `spec-monkey install-skills` is executed, THE CLI SHALL register the project-local skills for the configured `backend.default` tool by creating the appropriate symlinks or copies in the tool-native path.

---

### Requirement 17: Web Dashboard

**User Story:** As a developer, I want `spec-monkey web` to serve a web dashboard, so that I can monitor multiple projects from a browser during long unattended runs.

#### Acceptance Criteria

1. WHEN `spec-monkey web` is executed, THE Dashboard SHALL start an HTTP server on the configured host and port (default `127.0.0.1:8080`).
2. WHEN the dashboard is open in a browser, THE Dashboard SHALL display all projects that have a `logs/runtime-status.json` file, showing task queue counts, current task title, and a recent log tail.
3. WHEN a project's `logs/runtime-status.json` is updated, THE Dashboard SHALL reflect the new state within the next auto-refresh cycle of at most 5 seconds.
4. WHEN the `web` optional dependency group is not installed, THE CLI SHALL print an install hint (`npm install spec-monkey --include=optional` or equivalent) and exit with a non-zero status code.
5. THE Dashboard SHALL serve a self-contained HTML page that auto-refreshes via a `<meta http-equiv="refresh">` tag or `fetch` polling without requiring a JavaScript framework or build step.

---

### Requirement 18: CLI Entry Point and Command Structure

**User Story:** As a developer, I want a single `spec-monkey` binary with all subcommands, so that I have one consistent tool for the entire AI-driven development workflow.

#### Acceptance Criteria

1. THE CLI SHALL expose the following top-level commands: `init`, `run`, `plan`, `spec`, `task`, `verify`, `status`, `install-skills`, `skills`, `list`, `attach`, `stop`, `web`.
2. THE CLI SHALL accept a global `-c / --config` flag to specify a custom `spec-monkey.toml` path, overriding the default discovery.
3. WHEN no subcommand is provided, THE CLI SHALL print the help text and exit with code 0.
4. WHEN an unknown subcommand is provided, THE CLI SHALL print an error message and exit with a non-zero status code.
5. THE CLI SHALL expose a `--version` flag that prints the current package version from `package.json`.
6. THE CLI SHALL be installable globally via `npm install -g spec-monkey` and invocable as `spec-monkey` from any directory.
7. WHEN a required config file (`spec-monkey.toml`) is not found and the command requires it, THE CLI SHALL print a clear error suggesting `spec-monkey init` and exit with a non-zero status code.

---

### Requirement 19: TypeScript Project Structure

**User Story:** As a developer, I want the `spec-monkey` project to follow TypeScript best practices, so that the codebase is maintainable, type-safe, and easy to extend or contribute to.

#### Acceptance Criteria

1. THE project SHALL use TypeScript 5+ with `strict: true` and `noImplicitAny: true` enabled in `tsconfig.json`.
2. THE project SHALL compile to ESM targeting Node.js 20+ (`"target": "ES2022"`, `"module": "NodeNext"`).
3. THE project SHALL use `zod` for runtime validation of `task.json` task objects and parsed `spec-monkey.toml` config, so that schema violations surface as typed errors rather than runtime crashes.
4. THE project SHALL include a `package.json` with a `bin.spec-monkey` entry pointing to the compiled CLI entry point.
5. THE project SHALL use `vitest` for unit tests with at least one test file per core module (`config`, `taskStore`, `gate`, `snapshot`, `gitOps`, `circuitBreaker`, `runner`).
6. THE project SHALL have zero runtime dependency on the Python `autodev` package or any Python runtime.
7. THE project root SHALL be a sibling directory to the existing Python `autodev` project, named `spec-monkey`.
