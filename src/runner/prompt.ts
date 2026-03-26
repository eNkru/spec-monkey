import type { Task } from '../taskStore/index.js';
import type { SpecMonkeyConfig } from '../config/index.js';

/**
 * Builds the full prompt string for an AI agent to execute a task.
 *
 * Includes task details, steps, docs, implementation notes, verification
 * contract, and the most recent learning notes / journal entries up to
 * `config.reflection.prompt_learning_limit`.
 */
export function buildPrompt(
  task: Task,
  config: SpecMonkeyConfig,
  learningNotes: string[],
  journalEntries: unknown[],
): string {
  const limit = config.reflection.prompt_learning_limit;
  const recentNotes = learningNotes.slice(-limit);
  const recentJournal = journalEntries.slice(-limit);

  const lines: string[] = [];

  // ── Task identity ──────────────────────────────────────────────────────────
  lines.push(`# Task: ${task.id} — ${task.title}`);
  lines.push('');
  lines.push(task.description);
  lines.push('');

  // ── Steps ──────────────────────────────────────────────────────────────────
  lines.push('## Steps');
  task.steps.forEach((step, i) => {
    lines.push(`${i + 1}. ${step}`);
  });
  lines.push('');

  // ── Docs ───────────────────────────────────────────────────────────────────
  if (task.docs && task.docs.length > 0) {
    lines.push('## Reference Docs');
    task.docs.forEach((doc) => lines.push(`- ${doc}`));
    lines.push('');
  }

  // ── Implementation notes ───────────────────────────────────────────────────
  if (task.implementation_notes) {
    lines.push('## Implementation Notes');
    lines.push(task.implementation_notes);
    lines.push('');
  }

  // ── Completion contract ────────────────────────────────────────────────────
  lines.push('## Completion Contract');
  lines.push(`Kind: ${task.completion.kind}`);
  if (task.completion.kind === 'numeric') {
    if (task.completion.name) lines.push(`Metric: ${task.completion.name}`);
    if (task.completion.source) lines.push(`Source: ${task.completion.source}`);
    if (task.completion.json_path) lines.push(`JSON path: ${task.completion.json_path}`);
    if (task.completion.direction) lines.push(`Direction: ${task.completion.direction}`);
    if (task.completion.target !== undefined) lines.push(`Target: ${task.completion.target}`);
  }
  if (task.verification) {
    if (task.verification.validate_commands && task.verification.validate_commands.length > 0) {
      lines.push('Validation commands:');
      task.verification.validate_commands.forEach((cmd) => lines.push(`  $ ${cmd}`));
    }
    if (task.verification.path_patterns && task.verification.path_patterns.length > 0) {
      lines.push(`Required path patterns: ${task.verification.path_patterns.join(', ')}`);
    }
  }
  lines.push('');

  // ── Learning notes (task-level) ────────────────────────────────────────────
  if (recentNotes.length > 0) {
    lines.push('## Learning Notes (from previous attempts on this task)');
    recentNotes.forEach((note, i) => lines.push(`${i + 1}. ${note}`));
    lines.push('');
  }

  // ── Project learning journal ───────────────────────────────────────────────
  if (recentJournal.length > 0) {
    lines.push('## Project Learning Journal (recent entries)');
    recentJournal.forEach((entry, i) => {
      const text = typeof entry === 'string' ? entry : JSON.stringify(entry);
      lines.push(`${i + 1}. ${text}`);
    });
    lines.push('');
  }

  // ── Execution guide reference ──────────────────────────────────────────────
  lines.push('## Execution Guide');
  lines.push(
    `Follow the instructions in \`${config.files.execution_guide}\` for the full execution protocol.`,
  );
  lines.push('Complete all steps, then verify the completion contract is satisfied before finishing.');

  return lines.join('\n');
}
