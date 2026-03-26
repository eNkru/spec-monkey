# spec-monkey

A Node.js/TypeScript CLI for unattended AI-driven development automation. A ground-up rewrite of the Python `autodev` project — same feature set, zero Python dependency, idiomatic TypeScript throughout.

```
spec-monkey run --backend claude --max-tasks 5
```

---

## Table of Contents

- [Requirements](#requirements)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [Configuration](#configuration)
- [CLI Reference](#cli-reference)
- [Architecture](#architecture)
- [Modules](#modules)
- [Backends](#backends)
- [Task Format](#task-format)
- [Verification Gate](#verification-gate)
- [Experiment Mode](#experiment-mode)
- [Reflection](#reflection)
- [Skills](#skills)
- [Detached Sessions](#detached-sessions)
- [Web Dashboard](#web-dashboard)
- [Error Handling](#error-handling)
- [Development](#development)

---

## Requirements

- Node.js 20+
- TypeScript 5+ (dev dependency)
- One of: `claude`, `codex`, `gemini`, or `opencode` CLI installed and in PATH
- `tmux` (optional, for detached sessions)

---

## Installation

```bash
npm install -g spec-monkey
```

Or run from source:

```bash
git clone <repo>
cd spec-monkey
npm install
npm run build
node dist/cli.js --help
```

---

## Quick Start

```bash
# 1. Initialize a project
spec-monkey init ./my-project --use codex

# 2. Generate tasks from intent
spec-monkey plan --intent "Build a REST API with CRUD endpoints for a todo list"

# 3. Run the automation loop
spec-monkey run

# 4. Check progress
spec-monkey status
```

---

## Configuration

spec-monkey reads `spec-monkey.toml` from the current directory (or walks up to find it). Override with `-c <path>`.

### Full config reference

```toml
[project]
name = "My Project"
code_dir = "."          # directory where code lives
config_dir = "."        # directory for docs/specs output

[backend]
default = "codex"       # claude | codex | gemini | opencode

[backend.claude]
skip_permissions = true
permission_mode = "bypassPermissions"
output_format = "stream-json"
model = ""

[backend.codex]
yolo = true
full_auto = false
dangerously_bypass_approvals_and_sandbox = true
model = ""

[backend.gemini]
yolo = true
output_format = "text"
model = ""

[backend.opencode]
permissions = '{"read":"allow","edit":"allow","bash":"allow","glob":"allow","grep":"allow"}'
model = ""

[run]
max_retries = 3
max_tasks = 999
max_epochs = 1
heartbeat_interval = 20   # seconds between heartbeat ticks
keep_attempt_logs = true
reset_tasks_on_start = false
delay_between_tasks = 2   # seconds

[files]
task_json = "task.json"
progress = "progress.txt"
execution_guide = "AGENT.md"
task_brief = "TASK.md"
log_dir = "logs"
attempt_log_subdir = "attempts"

[verification]
min_changed_files = 1
validate_commands = []
validate_timeout_seconds = 1800
validate_working_directory = ""
validate_environment = {}

[reflection]
enabled = true
max_refinements_per_task = 3
prompt_timeout_seconds = 180
log_tail_lines = 80
max_attempt_history_entries = 12
max_learning_notes = 20
max_project_learning_entries = 50
prompt_learning_limit = 6

[snapshot]
watch_dirs = ["."]
ignore_dirs = [".git", "node_modules", "logs", "__pycache__", "build", "venv"]
ignore_path_globs = ["build-*", "cmake-build-*", "*.o", "*.obj", "task.json", "progress.txt"]
include_path_globs = []   # if non-empty, only include matching paths

[circuit_breaker]
no_progress_threshold = 3
repeated_error_threshold = 3
rate_limit_cooldown = 300   # seconds
rate_limit_patterns = ["rate_limit", "rate limit", "overloaded", "too many requests", "usage cap", "throttl"]

[git]
auto_commit = true
commit_message_template = "spec-monkey: {task_id} - {task_name}"

[detach]
tmux_session_prefix = "spec-monkey"
```

### Environment variable overrides

Any config field can be overridden with `SPEC_MONKEY_<SECTION>_<KEY>`:

```bash
SPEC_MONKEY_BACKEND_DEFAULT=claude spec-monkey run
SPEC_MONKEY_RUN_MAX_RETRIES=5 spec-monkey run
```

---

## CLI Reference

### Global flags

| Flag | Description |
|------|-------------|
| `-c, --config <path>` | Path to `spec-monkey.toml` |
| `-V, --version` | Print version |
| `-h, --help` | Show help |

---

### `spec-monkey init <directory>`

Initialize a new project with all scaffolding files.

```bash
spec-monkey init ./my-project
spec-monkey init ./my-project --use claude
```

**Options:**

| Flag | Default | Description |
|------|---------|-------------|
| `--use <tool>` | `codex` | AI tool to scaffold wrapper files for |

**Creates:**
- `spec-monkey.toml` — project config (skipped if exists)
- `task.json` — empty task queue
- `AGENT.md` — agent execution guide
- `TASK.md` — task brief template
- `progress.txt` — append-only progress log
- `logs/` — runtime log directory
- `.skills/` — default shared skills
- Tool wrapper file (`AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, or `OPENCODE.md`)

Re-running `init` with a different `--use` adds the new wrapper without overwriting anything.

---

### `spec-monkey run`

Run the automation loop — selects pending tasks, invokes the AI backend, verifies completion, and commits.

```bash
spec-monkey run
spec-monkey run --dry-run
spec-monkey run --backend claude --max-tasks 3
spec-monkey run --detach
```

**Options:**

| Flag | Description |
|------|-------------|
| `--dry-run` | Print prompts without invoking any backend |
| `--backend <name>` | Override configured backend for this run |
| `--max-tasks <n>` | Stop after processing N tasks |
| `--epochs <n>` | Number of plan→execute cycles |
| `--detach` | Launch in a background tmux session |

**Loop behavior:**
1. Select next pending task
2. Build prompt (task steps + learning notes + journal)
3. Invoke backend subprocess, stream output to logs
4. Diff filesystem snapshot to detect changed files
5. Run verification gate
6. On pass: mark complete, auto-commit, log progress
7. On fail: invoke reflection, retry up to `max_retries`
8. On retries exhausted: block task, move to next

Exit code 130 (Ctrl-C) stops cleanly without blocking the current task.

---

### `spec-monkey plan`

Generate `task.json` from free-form intent or a spec file.

```bash
spec-monkey plan --intent "Add user authentication with JWT"
spec-monkey plan -f docs/specs/my-feature-coca-spec.md
```

**Options:**

| Flag | Description |
|------|-------------|
| `--intent <text>` | Free-form intent text |
| `-f <file>` | Path to a spec or PRD file |
| `--backend <name>` | Override backend |

If the file already contains all four COCA headings (`## Context`, `## Outcome`, `## Constraints`, `## Assertions`), spec generation is skipped and tasks are generated directly.

---

### `spec-monkey spec`

Generate only a COCASpec document (no task.json).

```bash
spec-monkey spec --intent "Migrate database from SQLite to PostgreSQL"
```

Saves to `docs/specs/<name>-coca-spec.md`.

---

### `spec-monkey task`

Manage the task queue.

```bash
spec-monkey task list
spec-monkey task next
spec-monkey task reset
spec-monkey task reset --ids task-1,task-3
spec-monkey task retry
spec-monkey task block task-2 "Blocked on external API access"
```

| Subcommand | Description |
|------------|-------------|
| `list` | List all tasks with color-coded status badges |
| `next` | Print the next pending task |
| `reset [--ids <ids>]` | Reset tasks to pending (all non-completed, or specific IDs) |
| `retry` | Reset only blocked tasks to pending |
| `block <id> <reason>` | Block a task with a reason |

---

### `spec-monkey verify <task-id>`

Run the verification gate for a specific task and print the result.

```bash
spec-monkey verify task-1
```

---

### `spec-monkey status`

Show task queue summary.

```bash
spec-monkey status
spec-monkey status --json
```

Includes `last_updated` and `current_task_id` from `logs/runtime-status.json` when available.

---

### `spec-monkey skills`

Manage agent skills stored in `.skills/`.

```bash
spec-monkey skills list
spec-monkey skills recommend "testing typescript"
spec-monkey skills recommend "database migration" --limit 3
spec-monkey skills doctor
```

| Subcommand | Description |
|------------|-------------|
| `list` | List all skills with descriptions |
| `recommend <query>` | Find skills matching a query |
| `doctor` | Diagnose skill configuration issues |

---

### `spec-monkey install-skills`

Register project-local skills in the tool-native path (symlinks or copies).

```bash
spec-monkey install-skills
```

---

### `spec-monkey list`

List running tmux sessions managed by spec-monkey.

```bash
spec-monkey list
```

---

### `spec-monkey attach <session>`

Attach to a running tmux session.

```bash
spec-monkey attach spec-monkey-my-project
```

---

### `spec-monkey stop`

Stop a tmux session or all sessions.

```bash
spec-monkey stop spec-monkey-my-project
spec-monkey stop --all
```

---

### `spec-monkey web`

Start the web dashboard.

```bash
spec-monkey web
spec-monkey web --port 3000 --host 0.0.0.0
```

Opens an HTTP server (default `127.0.0.1:8080`) serving a self-contained dashboard that auto-refreshes every 5 seconds.

---

## Architecture

```
CLI (src/cli.ts)
  ├── Config       — TOML loading, env overrides, zod validation
  ├── TaskStore    — task.json CRUD, audit, state transitions
  ├── Runner       — main automation loop
  │   ├── Prompt       — prompt rendering
  │   ├── Experiment   — iterative metric optimization loop
  │   └── Plan         — intent → COCASpec → task.json
  ├── Backends     — claude / codex / gemini / opencode adapters + executor
  ├── Gate         — verification gate (boolean + numeric)
  ├── Reflection   — failed-attempt analysis and task refinement
  ├── Snapshot     — filesystem diff for changed-file detection
  ├── GitOps       — auto-commit, experiment commits, revert, history
  ├── CircuitBreaker — halt on repeated failures or rate limits
  ├── Heartbeat    — periodic terminal status during backend runs
  ├── Progress     — append-only progress.txt logging
  ├── RuntimeStatus — runtime-status.json + dashboard.html writer
  ├── Skills       — .skills/ management
  ├── Detach       — tmux session management
  ├── Dashboard    — HTTP server for multi-project monitoring
  └── Init         — project scaffolding
```

All modules are independently testable. No module imports from another module's internal files — only from its `index.ts` barrel.

---

## Modules

### Config (`src/config/`)

Loads `spec-monkey.toml` by walking up from cwd. Applies `SPEC_MONKEY_*` env overrides with type coercion. Validates with zod. Resolves relative paths against the config directory. Aliases legacy `[gate]` section to `[verification]`.

### TaskStore (`src/taskStore/`)

Manages `task.json`. All mutation functions are pure (return new store objects). Key functions:

- `loadTaskStore(path)` — parse and validate with zod
- `saveTaskStore(store, path)` — write JSON
- `getNextPendingTask(store)` — first task where `passes=false` and `blocked=false`
- `markTaskPassed(store, id)` — sets `passes=true` and `completed_at`
- `blockTask(store, id, reason)` — sets `blocked=true`, `block_reason`, `blocked_at`
- `resetTasks(store, ids?)` — reset to pending
- `retryBlockedTasks(store)` — reset only blocked tasks
- `auditTask(task)` — throws `TaskAuditError` if task is missing required fields

### Backends (`src/backends/`)

Four adapters implementing `BackendAdapter`:

```typescript
interface BackendAdapter {
  readonly name: string;
  buildCommand(prompt, config, opts?): CommandSpec;
  buildPlanCommand(prompt, config): CommandSpec;
}
```

`spawnBackend(opts)` spawns the process, merges stdout/stderr, tees to attempt log + main log + process.stdout, and returns `BackendResult`.

### Gate (`src/gate/`)

`runGate(task, changedFiles, config, opts)` evaluates the task's completion contract:

- **Boolean gate**: all `validate_commands` exit 0 AND changed file count ≥ `min_changed_files`
- **Numeric gate**: extract metric from last successful command's JSON stdout via `json_path`, classify as `improved` / `unchanged` / `regressed` / `target_met`

Shell control tokens (`&&`, `||`, `|`, `;`, `<`, `>`, `$(`, backtick) in validate commands are rejected before execution.

### Reflection (`src/reflection/`)

When a task fails, `reflect(task, logTail, config, backend, opts)` invokes the backend to analyze the attempt log and produce refined `steps`, `docs`, `verification`, and `implementation_notes`. Immutable fields (`id`, `title`, `description`, `completion`, `execution`) are never changed. Appends to `attempt_history`, `learning_notes`, and the top-level `learning_journal`.

### Snapshot (`src/snapshot/`)

`takeSnapshot(dirs, config)` walks directories and records `path → [mtime_ns, size]`. `diffSnapshots(before, after)` returns changed paths, filtering out spec-monkey runtime artifacts (`task.json`, `progress.txt`, `logs/`).

### GitOps (`src/gitOps/`)

- `autoCommit` — stage changed files, commit with template message
- `createExperimentCommit` — commit with experiment prefix
- `revertCommit` — `git revert --no-edit <sha>`
- `readRecentGitHistory(n)` — last N commits as structured objects
- `isGitRepo` — check for `.git` directory

All operations return a no-op result when not in a git repo or when `.git/index.lock` is detected.

### CircuitBreaker (`src/circuitBreaker/`)

Trips after N consecutive no-progress attempts or N consecutive identical-error attempts. Detects rate-limit patterns in attempt logs and pauses for `rate_limit_cooldown` seconds.

### Progress (`src/progress/`)

`appendProgress(entry, filePath)` appends a human-readable line to `progress.txt`. Append-only — never modifies existing content.

### RuntimeStatus (`src/runtimeStatus/`)

`writeRuntimeStatus(status, config)` writes `logs/runtime-status.json` and `logs/dashboard.html` (self-contained HTML, no external deps). `readRuntimeStatus(config)` reads the JSON back.

---

## Backends

### Claude

```toml
[backend]
default = "claude"

[backend.claude]
skip_permissions = true   # adds --dangerously-skip-permissions
```

Requires `claude` CLI in PATH.

### Codex

```toml
[backend]
default = "codex"

[backend.codex]
yolo = true   # uses codex exec --yolo
```

Requires `codex` CLI in PATH.

### Gemini

```toml
[backend]
default = "gemini"

[backend.gemini]
yolo = true   # adds --yolo flag
```

Requires `gemini` CLI in PATH.

### OpenCode

```toml
[backend]
default = "opencode"

[backend.opencode]
permissions = '{"read":"allow","edit":"allow","bash":"allow"}'
```

Requires `opencode` CLI in PATH. Permissions are injected via `OPENCODE_PERMISSION` env var.

---

## Task Format

`task.json` is a JSON file with a `tasks` array:

```json
{
  "tasks": [
    {
      "id": "task-1",
      "title": "Add user authentication",
      "description": "Implement JWT-based authentication with login and logout endpoints.",
      "steps": [
        "Create auth middleware that validates JWT tokens",
        "Add POST /login endpoint that returns a signed JWT",
        "Add POST /logout endpoint that invalidates the token",
        "Write tests for all auth endpoints"
      ],
      "completion": {
        "kind": "boolean",
        "success_when": "all tests pass"
      },
      "verification": {
        "validate_commands": ["npm test"],
        "path_patterns": ["src/auth/**"]
      },
      "docs": ["docs/auth-spec.md"]
    }
  ],
  "learning_journal": []
}
```

### Required fields

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Unique identifier |
| `title` | string | Short descriptive title |
| `description` | string | Detailed description |
| `steps` | string[] | Implementation steps (non-empty) |
| `completion` | object | Completion contract |

### Completion contract

**Boolean** (default):
```json
{
  "kind": "boolean"
}
```

**Numeric** (for experiment mode):
```json
{
  "kind": "numeric",
  "name": "test coverage",
  "source": "coverage report",
  "json_path": "coverage.lines",
  "direction": "higher_is_better",
  "min_improvement": 0.5,
  "unchanged_tolerance": 0.1,
  "target": 90.0
}
```

### Execution strategy

```json
{
  "execution": {
    "strategy": "iterative",
    "max_iterations": 10,
    "rollback_on_failure": true,
    "keep_on_equal": false,
    "stop_after_no_improvement": 3,
    "commit_prefix": "experiment"
  }
}
```

---

## Verification Gate

The gate evaluates whether a task's completion contract is met after each backend run.

### Boolean gate

Passes when:
1. All `validate_commands` exit with code 0
2. Changed file count ≥ `min_changed_files` (skipped with `enforceChangeRequirements=false`)

```toml
[verification]
min_changed_files = 1
validate_commands = ["npm test", "npm run lint"]
validate_timeout_seconds = 300
```

Per-task overrides in `task.verification` take precedence over global config.

### Numeric gate

Extracts a metric from the last successful validate command's JSON stdout:

```json
{ "coverage": { "lines": 87.3 } }
```

With `json_path = "coverage.lines"`, the gate reads `87.3` and classifies the outcome:

| Outcome | Condition |
|---------|-----------|
| `improved` | value better than best-so-far by ≥ `min_improvement` |
| `unchanged` | value within `unchanged_tolerance` of best-so-far |
| `regressed` | value worse than best-so-far beyond tolerance |
| `target_met` | value meets or exceeds `target` |

### Shell injection protection

Validate commands containing `&&`, `||`, `|`, `;`, `<`, `>`, `$(`, or backtick are rejected before execution. Commands are always passed as `string[]` to `child_process.spawn` — never to a shell.

---

## Experiment Mode

When `execution.strategy = "iterative"` and `completion.kind = "numeric"`, the runner enters experiment mode:

1. **Baseline** — measure the metric before any changes (`enforceChangeRequirements=false`)
2. **Iterate** — for each iteration up to `max_iterations`:
   - Invoke backend
   - Snapshot diff
   - Create experiment git commit
   - Run gate, compare metric
   - `improved` → retain commit, update best-so-far
   - `regressed` + `rollback_on_failure=true` → revert commit
   - `unchanged` + `keep_on_equal=false` → revert commit
   - `target_met` → retain commit, mark task complete
3. **Stop** when `stop_after_no_improvement` streak is reached or `max_iterations` exhausted

Each iteration is logged to `logs/experiments.jsonl`:

```json
{"taskId":"task-1","iteration":3,"metricName":"coverage","baselineValue":72.1,"bestBefore":74.5,"measuredValue":76.2,"outcome":"improved","commitSha":"abc123","revertedSha":"","timestamp":"2024-01-15T10:30:00.000Z"}
```

Requires a git repository. Blocks immediately if not in a git repo.

---

## Reflection

When a task fails the gate and retries remain, reflection analyzes the attempt log and refines the task:

- Invokes the backend with the last N lines of the attempt log
- Produces refined `steps`, `docs`, `verification`, `implementation_notes`
- Preserves immutable fields: `id`, `title`, `description`, `completion`, `execution`
- Appends a learning note to `task.attempt_history` and `task.learning_notes`
- Appends to the top-level `learning_journal`
- Skips when `max_refinements_per_task` is reached

Learning notes from previous attempts are included in subsequent prompts (up to `prompt_learning_limit` entries).

---

## Skills

Skills are reusable agent instruction sets stored under `.skills/`. Each skill is a directory with a `SKILL.md` file.

```
.skills/
  spec-monkey-runtime/
    SKILL.md
  coca-spec/
    SKILL.md
  my-custom-skill/
    SKILL.md
```

`SKILL.md` format:
```markdown
# My Custom Skill

One-line description used for listing and recommendations.

## Trigger Keywords

testing, coverage, jest

## Description

Detailed instructions for the agent...
```

`spec-monkey install-skills` creates symlinks (or copies) in the tool-native path so the backend can discover them automatically.

---

## Detached Sessions

Run spec-monkey overnight without keeping a terminal open:

```bash
# Start a detached run
spec-monkey run --detach

# List running sessions
spec-monkey list

# Attach to watch output
spec-monkey attach spec-monkey-my-project

# Stop a session
spec-monkey stop spec-monkey-my-project

# Stop all sessions
spec-monkey stop --all
```

Requires `tmux` installed and in PATH. Session names follow the pattern `<tmux_session_prefix>-<project-name>`.

---

## Web Dashboard

Monitor multiple projects from a browser:

```bash
spec-monkey web
# or
spec-monkey web --port 3000 --host 0.0.0.0
```

The dashboard:
- Scans for `logs/runtime-status.json` in configured project directories
- Shows task counts, current task, attempt progress, and recent log tail per project
- Auto-refreshes every 5 seconds
- Serves a fully self-contained HTML page (no external dependencies)
- Also exposes `GET /status` as a JSON API

---

## Error Handling

| Error | When | Exit Code |
|-------|------|-----------|
| `ConfigError` | Invalid TOML, bad enum value | 1 |
| `RuntimeError` | Backend failure, bad JSON from planner | 1 |
| `TaskAuditError` | Task missing required fields | 1 |
| `BackendNotFoundError` | Binary not in PATH | 1 |
| SIGINT / Ctrl-C | User interrupt | 130 |
| Blocked tasks present | Run completed with blocked tasks | 2 |

**Environment error detection**: the runner scans each attempt log for patterns like `"permission denied"`, `"invalid api key"`, `"authentication failed"`, `"unauthorized"`, `"quota exceeded"`. When found, the run stops immediately without blocking the current task, and remediation guidance is printed.

**Circuit breaker**: halts the run after N consecutive no-progress attempts or N consecutive identical-error attempts. Detects rate-limit patterns and pauses automatically.

---

## Development

```bash
# Install dependencies
npm install

# Type-check
npx tsc --noEmit

# Build
npm run build

# Run tests
npm test

# Watch tests
npm run test:watch
```

### Project structure

```
spec-monkey/
├── src/
│   ├── cli.ts              # commander entry point
│   ├── types.ts            # shared type definitions
│   ├── errors.ts           # typed error classes
│   ├── config/             # TOML loading + validation
│   ├── taskStore/          # task.json CRUD
│   ├── backends/           # AI backend adapters + executor
│   ├── gate/               # verification gate
│   ├── runner/             # main loop, prompt, plan, experiment
│   ├── reflection/         # failed-attempt analysis
│   ├── snapshot/           # filesystem diff
│   ├── gitOps/             # git operations
│   ├── circuitBreaker/     # halt-on-failure safety
│   ├── heartbeat/          # terminal status ticker
│   ├── progress/           # progress.txt writer
│   ├── runtimeStatus/      # runtime-status.json + dashboard.html
│   ├── skills/             # .skills/ management
│   ├── detach/             # tmux session management
│   ├── dashboard/          # HTTP dashboard server
│   └── init/               # project scaffolding
├── test/                   # test files (vitest)
├── package.json
├── tsconfig.json
└── vitest.config.ts
```

### Adding a new backend

1. Create `src/backends/mybackend.ts` implementing `BackendAdapter`
2. Add it to `REGISTRY` in `src/backends/index.ts`
3. Add the backend name to the `backend.default` enum in `src/config/schema.ts`

No other files need to change.
