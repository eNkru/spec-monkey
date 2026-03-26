import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import type { SpecMonkeyConfig } from '../config/index.js';
import { RuntimeError } from '../errors.js';

const execFile = promisify(execFileCb);

export interface SessionInfo {
  name: string;
  startTime: string;
}

async function checkTmux(): Promise<void> {
  try {
    await execFile('which', ['tmux']);
  } catch {
    throw new RuntimeError(
      'tmux is not installed or not in PATH. Install tmux to use detached session support.'
    );
  }
}

function sessionName(config: SpecMonkeyConfig): string {
  const slug = config.project.name.replace(/\s+/g, '-').toLowerCase();
  return `${config.detach.tmux_session_prefix}-${slug}`;
}

export async function detachRun(config: SpecMonkeyConfig, extraArgs?: string[]): Promise<void> {
  await checkTmux();
  const name = sessionName(config);
  const baseCmd = 'spec-monkey run';
  const cmd = extraArgs && extraArgs.length > 0
    ? `${baseCmd} ${extraArgs.join(' ')}`
    : baseCmd;
  await execFile('tmux', ['new-session', '-d', '-s', name, cmd]);
}

export async function listSessions(config: SpecMonkeyConfig): Promise<SessionInfo[]> {
  await checkTmux();
  const prefix = config.detach.tmux_session_prefix;
  let stdout: string;
  try {
    ({ stdout } = await execFile('tmux', [
      'list-sessions',
      '-F',
      '#{session_name} #{session_created}',
    ]));
  } catch {
    // No sessions running — tmux exits non-zero when there are no sessions
    return [];
  }

  const sessions: SessionInfo[] = [];
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const spaceIdx = trimmed.indexOf(' ');
    if (spaceIdx === -1) continue;
    const name = trimmed.slice(0, spaceIdx);
    const unixStr = trimmed.slice(spaceIdx + 1).trim();
    if (!name.startsWith(prefix)) continue;
    const unixMs = parseInt(unixStr, 10) * 1000;
    const startTime = isNaN(unixMs) ? unixStr : new Date(unixMs).toISOString();
    sessions.push({ name, startTime });
  }
  return sessions;
}

export async function attachSession(sessionName: string): Promise<void> {
  await checkTmux();
  await execFile('tmux', ['attach-session', '-t', sessionName]);
}

export async function stopSession(sessionName: string): Promise<void> {
  await checkTmux();
  await execFile('tmux', ['kill-session', '-t', sessionName]);
}

export async function stopAllSessions(config: SpecMonkeyConfig): Promise<void> {
  await checkTmux();
  const sessions = await listSessions(config);
  await Promise.all(sessions.map((s) => execFile('tmux', ['kill-session', '-t', s.name])));
}
