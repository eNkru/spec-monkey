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

/** Strip ANSI escape codes from a string. */
function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');
}

/**
 * Extract the first JSON object or array from raw backend output.
 * Handles:
 * - ANSI escape codes
 * - Markdown fences (```json ... ```)
 * - `codex exec --json` JSONL stream (extracts last assistant message content)
 * - Surrounding prose
 */
function extractJson(raw: string): string {
  const clean = stripAnsi(raw);

  // Handle `codex exec --json` JSONL output — find the agent_message item
  const lines = clean.split('\n').filter(Boolean);
  const jsonlLines = lines.filter(l => l.trimStart().startsWith('{'));
  if (jsonlLines.length > 0) {
    for (let i = jsonlLines.length - 1; i >= 0; i--) {
      try {
        const obj = JSON.parse(jsonlLines[i]) as Record<string, unknown>;
        // codex exec --json emits {type:"item.completed", item:{type:"agent_message", text:"..."}}
        if (obj['type'] === 'item.completed') {
          const item = obj['item'] as Record<string, unknown> | undefined;
          if (item && item['type'] === 'agent_message' && typeof item['text'] === 'string') {
            return extractJson(item['text'] as string);
          }
        }
        // fallback: generic content/message/text fields
        const content = obj['content'] ?? obj['message'] ?? obj['text'];
        if (typeof content === 'string' && content.trim().length > 0) {
          return extractJson(content);
        }
        if (Array.isArray(content)) {
          for (const part of content as Array<Record<string, unknown>>) {
            if (typeof part['text'] === 'string' && part['text'].trim().length > 0) {
              return extractJson(part['text'] as string);
            }
          }
        }
      } catch {
        // not valid JSON line, skip
      }
    }
  }

  // Try stripping markdown fences: ```json ... ``` or ``` ... ```
  const fenceMatch = clean.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) {
    return fenceMatch[1].trim();
  }

  // Find the first { or [ and extract the balanced block
  const start = Math.min(
    clean.indexOf('{') === -1 ? Infinity : clean.indexOf('{'),
    clean.indexOf('[') === -1 ? Infinity : clean.indexOf('['),
  );
  if (start === Infinity) return clean.trim();

  const opener = clean[start];
  const closer = opener === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = start; i < clean.length; i++) {
    const ch = clean[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\' && inString) { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === opener) depth++;
    else if (ch === closer) {
      depth--;
      if (depth === 0) return clean.slice(start, i + 1);
    }
  }

  return clean.slice(start).trim();
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

  // Parse as JSON — strip ANSI/prose and extract the JSON block
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJson(rawOutput));
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
