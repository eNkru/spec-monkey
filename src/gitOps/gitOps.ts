import { execFile as execFileCb } from 'node:child_process';
import { access, constants } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { SpecMonkeyConfig } from '../config/index.js';

const execFile = promisify(execFileCb);

export interface GitCommitResult {
  committed: boolean;
  commitSha: string;
  message: string;
}

export interface GitHistoryEntry {
  commitSha: string;
  subject: string;
  body: string;
  committedAt: string;
}

const NO_OP: GitCommitResult = { committed: false, commitSha: '', message: 'no-op' };

export async function isGitRepo(dir: string): Promise<boolean> {
  try {
    await access(join(dir, '.git'), constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function hasIndexLock(dir: string): Promise<boolean> {
  try {
    await access(join(dir, '.git', 'index.lock'), constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function getHeadSha(cwd: string): Promise<string> {
  const { stdout } = await execFile('git', ['rev-parse', 'HEAD'], { cwd });
  return stdout.trim();
}

export async function autoCommit(
  changedFiles: string[],
  config: SpecMonkeyConfig,
  taskId: string,
  taskName: string,
  cwd: string,
): Promise<GitCommitResult> {
  if (!(await isGitRepo(cwd))) {
    return NO_OP;
  }

  if (await hasIndexLock(cwd)) {
    console.warn('[gitOps] .git/index.lock detected — skipping commit');
    return { ...NO_OP, message: 'index.lock detected' };
  }

  const message = config.git.commit_message_template
    .replace('{task_id}', taskId)
    .replace('{task_name}', taskName);

  try {
    await execFile('git', ['add', '--', ...changedFiles], { cwd });
  } catch (err: unknown) {
    const stderr = (err as { stderr?: string }).stderr ?? String(err);
    console.warn('[gitOps] git add failed:', stderr);
    return { ...NO_OP, message: 'git operation failed' };
  }

  try {
    await execFile('git', ['commit', '-m', message], { cwd });
  } catch (err: unknown) {
    const stderr = (err as { stderr?: string }).stderr ?? String(err);
    console.warn('[gitOps] git commit failed:', stderr);
    return { ...NO_OP, message: 'git operation failed' };
  }

  const commitSha = await getHeadSha(cwd);
  return { committed: true, commitSha, message };
}

export async function createExperimentCommit(
  changedFiles: string[],
  _config: SpecMonkeyConfig,
  taskId: string,
  taskName: string,
  iteration: number,
  cwd: string,
  commitPrefix = 'experiment',
): Promise<GitCommitResult> {
  if (!(await isGitRepo(cwd))) {
    return NO_OP;
  }

  if (await hasIndexLock(cwd)) {
    console.warn('[gitOps] .git/index.lock detected — skipping experiment commit');
    return { ...NO_OP, message: 'index.lock detected' };
  }

  // commitPrefix comes from task.execution.commit_prefix; default is 'experiment'
  const message = `${commitPrefix}: task ${taskId} (${taskName}) iteration ${iteration}`;

  try {
    await execFile('git', ['add', '--', ...changedFiles], { cwd });
  } catch (err: unknown) {
    const stderr = (err as { stderr?: string }).stderr ?? String(err);
    console.warn('[gitOps] git add failed:', stderr);
    return { ...NO_OP, message: 'git operation failed' };
  }

  try {
    await execFile('git', ['commit', '-m', message], { cwd });
  } catch (err: unknown) {
    const stderr = (err as { stderr?: string }).stderr ?? String(err);
    console.warn('[gitOps] git commit failed:', stderr);
    return { ...NO_OP, message: 'git operation failed' };
  }

  const commitSha = await getHeadSha(cwd);
  return { committed: true, commitSha, message };
}

export async function revertCommit(
  commitSha: string,
  cwd: string,
): Promise<GitCommitResult> {
  if (!(await isGitRepo(cwd))) {
    return NO_OP;
  }

  if (await hasIndexLock(cwd)) {
    console.warn('[gitOps] .git/index.lock detected — skipping revert');
    return { ...NO_OP, message: 'index.lock detected' };
  }

  try {
    await execFile('git', ['revert', '--no-edit', commitSha], { cwd });
  } catch (err: unknown) {
    const stderr = (err as { stderr?: string }).stderr ?? String(err);
    console.warn('[gitOps] git revert failed:', stderr);
    return { ...NO_OP, message: 'git operation failed' };
  }

  const newSha = await getHeadSha(cwd);
  return { committed: true, commitSha: newSha, message: `reverted ${commitSha}` };
}

const COMMIT_SEPARATOR = '---COMMIT---';
// Format: SHA, ISO date, subject, body, separator — each on its own line
const LOG_FORMAT = `%H%n%aI%n%s%n%b%n${COMMIT_SEPARATOR}`;

export async function readRecentGitHistory(
  n: number,
  cwd: string,
): Promise<GitHistoryEntry[]> {
  if (!(await isGitRepo(cwd))) {
    return [];
  }

  let stdout: string;
  try {
    const result = await execFile(
      'git',
      ['log', `-n`, String(n), `--format=${LOG_FORMAT}`],
      { cwd },
    );
    stdout = result.stdout;
  } catch (err: unknown) {
    const stderr = (err as { stderr?: string }).stderr ?? String(err);
    console.warn('[gitOps] git log failed:', stderr);
    return [];
  }

  const entries: GitHistoryEntry[] = [];
  const blocks = stdout.split(`${COMMIT_SEPARATOR}\n`).filter((b) => b.trim().length > 0);

  for (const block of blocks) {
    const lines = block.split('\n');
    const commitSha = lines[0]?.trim() ?? '';
    const committedAt = lines[1]?.trim() ?? '';
    const subject = lines[2]?.trim() ?? '';
    // body is everything after subject line, trimmed
    const body = lines.slice(3).join('\n').trim();

    if (!commitSha) continue;

    entries.push({ commitSha, subject, body, committedAt });
  }

  return entries;
}
