import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import type { SpecMonkeyConfig } from '../config/index.js';
import type { BackendAdapter } from '../backends/index.js';
import { spawnBackend } from '../backends/index.js';
import { auditTask } from '../taskStore/index.js';
import { RuntimeError, TaskAuditError } from '../errors.js';

export interface PlanSource {
  type: 'intent' | 'file';
  content: string; // intent text or file path
}

const COCA_HEADINGS = ['## Context', '## Outcome', '## Constraints', '## Assertions'];

function hasCocaHeadings(text: string): boolean {
  return COCA_HEADINGS.every((h) => text.includes(h));
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .split(/\s+/)
    .slice(0, 5)
    .join('-');
}

async function readBackendOutput(logFile: string): Promise<string> {
  try {
    return await readFile(logFile, 'utf-8');
  } catch {
    return '';
  }
}

export async function generateSpec(
  intent: string,
  config: SpecMonkeyConfig,
  backend: BackendAdapter,
): Promise<string> {
  const prompt = `You are a technical specification writer. Given the following intent or description, generate a structured COCASpec document with exactly these four sections:

## Context
(Describe the background, current state, and why this work is needed)

## Outcome
(Describe the desired end state and success criteria)

## Constraints
(List technical, time, resource, or other constraints)

## Assertions
(List verifiable assertions that must be true when the work is complete)

Intent:
${intent}

Generate only the COCASpec document with the four sections above. Do not include any preamble or explanation outside the document.`;

  const cmdSpec = backend.buildPlanCommand(prompt, config);
  const logDir = config.files.log_dir;
  const attemptLogFile = join(logDir, 'plan', `spec-gen-${Date.now()}.log`);
  const mainLogFile = join(logDir, 'plan', 'spec-gen.log');

  await mkdir(dirname(attemptLogFile), { recursive: true });

  await spawnBackend({
    cmd: cmdSpec.cmd,
    env: cmdSpec.env,
    cwd: cmdSpec.cwd,
    attemptLogFile,
    mainLogFile,
  });

  const specContent = await readBackendOutput(attemptLogFile);

  // Save to docs/specs/<name>-coca-spec.md
  const name = slugify(intent);
  const specsDir = join(config.project.config_dir, 'docs', 'specs');
  await mkdir(specsDir, { recursive: true });
  const specPath = join(specsDir, `${name}-coca-spec.md`);
  await writeFile(specPath, specContent, 'utf-8');

  console.log(`[plan] COCASpec saved to ${specPath}`);
  return specContent;
}

export async function planTasks(
  source: PlanSource,
  config: SpecMonkeyConfig,
  backend: BackendAdapter,
): Promise<void> {
  let spec: string;

  if (source.type === 'file') {
    const fileContent = await readFile(source.content, 'utf-8');
    if (hasCocaHeadings(fileContent)) {
      // File already has all COCA headings — use directly
      console.log('[plan] File contains COCA headings — skipping spec generation.');
      spec = fileContent;
    } else {
      // Generate a COCASpec from the file content
      console.log('[plan] File does not contain COCA headings — generating COCASpec...');
      spec = await generateSpec(fileContent, config, backend);
    }
  } else {
    // Intent: generate COCASpec first
    console.log('[plan] Generating COCASpec from intent...');
    spec = await generateSpec(source.content, config, backend);
  }

  // Build planning prompt
  const planPrompt = `You are a task planning assistant. Given the following specification document, generate a structured JSON task list for an AI coding agent to implement.

The output must be a valid JSON object with a "tasks" array. Each task must have:
- "id": a unique string identifier (e.g. "task-1")
- "title": a short descriptive title
- "description": a detailed description of what needs to be done
- "steps": an array of strings describing the implementation steps
- "completion": an object with at minimum { "kind": "boolean" }

Output ONLY the JSON object, no markdown fences, no explanation.

Specification:
${spec}`;

  const logDir = config.files.log_dir;
  const attemptLogFile = join(logDir, 'plan', `task-gen-${Date.now()}.log`);
  const mainLogFile = join(logDir, 'plan', 'task-gen.log');

  await mkdir(dirname(attemptLogFile), { recursive: true });

  const cmdSpec = backend.buildPlanCommand(planPrompt, config);
  await spawnBackend({
    cmd: cmdSpec.cmd,
    env: cmdSpec.env,
    cwd: cmdSpec.cwd,
    attemptLogFile,
    mainLogFile,
  });

  const rawOutput = await readBackendOutput(attemptLogFile);

  // Parse as JSON
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawOutput);
  } catch {
    throw new RuntimeError(
      `Backend returned non-JSON output. First 500 chars: ${rawOutput.slice(0, 500)}`,
    );
  }

  // Check for tasks array
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !Array.isArray((parsed as Record<string, unknown>)['tasks'])
  ) {
    const keys = typeof parsed === 'object' && parsed !== null ? Object.keys(parsed) : [];
    throw new RuntimeError(
      `Generated JSON is missing a "tasks" array. Present keys: ${keys.join(', ') || '(none)'}`,
    );
  }

  const store = parsed as { tasks: unknown[] };
  const tasks = store.tasks;

  // Inject source file path into docs field when planning from a file
  if (source.type === 'file') {
    for (const task of tasks) {
      if (typeof task === 'object' && task !== null) {
        const t = task as Record<string, unknown>;
        const existingDocs = Array.isArray(t['docs']) ? (t['docs'] as string[]) : [];
        if (!existingDocs.includes(source.content)) {
          t['docs'] = [source.content, ...existingDocs];
        }
      }
    }
  }

  // Run auditTask on all tasks
  const auditErrors: string[] = [];
  for (let i = 0; i < tasks.length; i++) {
    try {
      auditTask(tasks[i]);
    } catch (err) {
      if (err instanceof TaskAuditError) {
        auditErrors.push(`Task[${i}]: ${err.message}`);
      } else {
        auditErrors.push(`Task[${i}]: ${String(err)}`);
      }
    }
  }

  if (auditErrors.length > 0) {
    console.error('[plan] Task audit failed:');
    for (const e of auditErrors) {
      console.error(`  ${e}`);
    }
    throw new TaskAuditError(
      `Task audit failed for ${auditErrors.length} task(s)`,
      auditErrors,
    );
  }

  // Write result to files.task_json
  const taskJsonPath = config.files.task_json;
  await writeFile(taskJsonPath, JSON.stringify(parsed, null, 2), 'utf-8');

  console.log(`[plan] Generated ${tasks.length} task(s) → ${taskJsonPath}`);
}
