# spec-monkey Demo — Quick Start with Codex

This guide walks you through building a small demo project from scratch using spec-monkey and Codex.

## Prerequisites

- `codex` CLI installed and authenticated
- spec-monkey installed globally:
  ```bash
  npm run build && npm pack && npm install -g spec-monkey-0.1.0.tgz
  ```

---

## Step 1 — Create and initialize the project

```bash
mkdir ~/demo-todo-api
spec-monkey init ~/demo-todo-api --use codex
cd ~/demo-todo-api
```

You'll see:
```
created: spec-monkey.toml
created: task.json
created: AGENT.md
created: TASK.md
created: progress.txt
created: AGENTS.md
...
Initialized spec-monkey project in ~/demo-todo-api
```

---

## Step 2 — Set up a Node.js project for Codex to work in

```bash
npm init -y
npm install express
```

---

## Step 3 — Generate tasks from intent

```bash
spec-monkey plan --intent "Build a simple REST API for a todo list using Express. It should support creating, listing, completing, and deleting todos. Store todos in memory. Include a GET /health endpoint."
```

spec-monkey will invoke Codex to generate a `task.json`. When done:
```
[plan] Generated 4 task(s) → task.json
```

Check what was generated:
```bash
spec-monkey task list
```

You should see something like:
```
[PENDING] task-1: Set up Express server with health endpoint
[PENDING] task-2: Implement todo data model and in-memory store
[PENDING] task-3: Add CRUD endpoints for todos
[PENDING] task-4: Write integration tests
```

---

## Step 4 — Review the first task

```bash
spec-monkey task next
```

---

## Step 5 — Run the automation loop

```bash
spec-monkey run
```

spec-monkey will:
1. Pick the first pending task
2. Build a prompt from the task steps + AGENT.md guide
3. Invoke `codex exec --yolo` with the prompt
4. Stream Codex output to your terminal
5. Check if files changed and the gate passes
6. Commit the changes and move to the next task

Watch the heartbeat ticker — it shows elapsed time while Codex is working.

---

## Step 6 — Check progress

In another terminal while it's running (or after):

```bash
spec-monkey status
```

```
Pending:   2
Completed: 2
Blocked:   0
```

View the human-readable log:
```bash
cat progress.txt
```

---

## Step 7 — Run the web dashboard (optional)

```bash
spec-monkey web
```

Open `http://127.0.0.1:8080` in your browser to see task counts and live status.

---

## Step 8 — Test the result

Once all tasks complete:

```bash
node index.js &
curl http://localhost:3000/health
curl -X POST http://localhost:3000/todos -H "Content-Type: application/json" -d '{"title":"Buy milk"}'
curl http://localhost:3000/todos
```

---

## Useful commands during a run

```bash
# See what task is up next
spec-monkey task next

# Manually block a task that can't be done
spec-monkey task block task-4 "No test framework installed"

# Retry all blocked tasks after fixing the environment
spec-monkey task retry

# Reset a specific task to re-run it
spec-monkey task reset --ids task-3

# Run only 1 task at a time (useful for reviewing)
spec-monkey run --max-tasks 1

# Dry-run to preview the prompt without invoking Codex
spec-monkey run --dry-run
```

---

## Run overnight with tmux detach

```bash
spec-monkey run --detach

# Check sessions
spec-monkey list

# Attach to watch output
spec-monkey attach spec-monkey-demo-todo-api

# Detach from tmux without stopping: Ctrl-B then D

# Stop the session
spec-monkey stop spec-monkey-demo-todo-api
```

---

## Tweaking the config

Edit `spec-monkey.toml` in your project to adjust behavior:

```toml
[run]
max_retries = 5          # more retries before blocking a task

[verification]
validate_commands = ["node --check index.js"]   # basic syntax check as gate

[git]
auto_commit = true       # commit after each completed task
```

Then re-run:
```bash
spec-monkey run
```
