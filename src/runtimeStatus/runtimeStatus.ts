import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SpecMonkeyConfig } from '../config/index.js';
import type { RuntimeStatus } from '../types.js';

function getLogDir(config: SpecMonkeyConfig): string {
  return config.files.log_dir;
}

function statusColor(status: RuntimeStatus['status']): string {
  switch (status) {
    case 'idle': return '#6c757d';
    case 'running': return '#0d6efd';
    case 'validating': return '#fd7e14';
    case 'complete': return '#198754';
    case 'error': return '#dc3545';
  }
}

function buildDashboardHtml(status: RuntimeStatus): string {
  const lastLines = status.attemptLog
    .split('\n')
    .filter(Boolean)
    .slice(-20)
    .join('\n');

  const color = statusColor(status.status);
  const { pending, completed, blocked, running } = status.taskCounts;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="refresh" content="5">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>spec-monkey dashboard</title>
<style>
  body { font-family: system-ui, sans-serif; background: #0d1117; color: #e6edf3; margin: 0; padding: 24px; }
  h1 { font-size: 1.4rem; margin: 0 0 20px; color: #58a6ff; }
  .badge { display: inline-block; padding: 4px 12px; border-radius: 12px; font-weight: 700;
           font-size: 0.85rem; color: #fff; background: ${color}; text-transform: uppercase; }
  .card { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 16px; margin-bottom: 16px; }
  .label { font-size: 0.75rem; color: #8b949e; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 4px; }
  .value { font-size: 1rem; color: #e6edf3; word-break: break-all; }
  .counts { display: flex; gap: 16px; flex-wrap: wrap; }
  .count-item { text-align: center; }
  .count-num { font-size: 1.8rem; font-weight: 700; }
  .count-pending { color: #e3b341; }
  .count-completed { color: #3fb950; }
  .count-blocked { color: #f85149; }
  .count-running { color: #58a6ff; }
  .progress-bar { background: #21262d; border-radius: 4px; height: 8px; margin-top: 8px; overflow: hidden; }
  .progress-fill { height: 100%; background: ${color}; border-radius: 4px;
                   width: ${status.maxAttempts > 0 ? Math.round((status.currentAttempt / status.maxAttempts) * 100) : 0}%; }
  pre { background: #0d1117; border: 1px solid #30363d; border-radius: 6px; padding: 12px;
        font-size: 0.78rem; overflow-x: auto; white-space: pre-wrap; word-break: break-word;
        color: #8b949e; max-height: 320px; overflow-y: auto; margin: 0; }
  .row { display: flex; gap: 16px; flex-wrap: wrap; }
  .row .card { flex: 1; min-width: 200px; }
</style>
</head>
<body>
<h1>spec-monkey dashboard</h1>
<div class="card">
  <div class="label">Status</div>
  <div style="margin-top:4px"><span class="badge">${status.status}</span></div>
</div>
<div class="row">
  <div class="card">
    <div class="label">Current Task</div>
    <div class="value">${escapeHtml(status.currentTaskId || '—')}</div>
    <div class="value" style="color:#8b949e;font-size:0.9rem;margin-top:4px">${escapeHtml(status.currentTaskTitle || '—')}</div>
  </div>
  <div class="card">
    <div class="label">Attempt Progress</div>
    <div class="value">${status.currentAttempt} / ${status.maxAttempts}</div>
    <div class="progress-bar"><div class="progress-fill"></div></div>
  </div>
</div>
<div class="card">
  <div class="label">Task Counts</div>
  <div class="counts" style="margin-top:8px">
    <div class="count-item"><div class="count-num count-pending">${pending}</div><div class="label">Pending</div></div>
    <div class="count-item"><div class="count-num count-running">${running}</div><div class="label">Running</div></div>
    <div class="count-item"><div class="count-num count-completed">${completed}</div><div class="label">Completed</div></div>
    <div class="count-item"><div class="count-num count-blocked">${blocked}</div><div class="label">Blocked</div></div>
  </div>
</div>
<div class="card">
  <div class="label">Last Updated</div>
  <div class="value">${escapeHtml(status.lastUpdated)}</div>
</div>
<div class="card">
  <div class="label">Recent Attempt Log (last 20 lines)</div>
  <pre>${escapeHtml(lastLines || '(no log yet)')}</pre>
</div>
</body>
</html>`;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export async function writeRuntimeStatus(status: RuntimeStatus, config: SpecMonkeyConfig): Promise<void> {
  const logDir = getLogDir(config);
  await mkdir(logDir, { recursive: true });

  const jsonPath = join(logDir, 'runtime-status.json');
  const htmlPath = join(logDir, 'dashboard.html');

  await writeFile(jsonPath, JSON.stringify(status, null, 2), 'utf8');
  await writeFile(htmlPath, buildDashboardHtml(status), 'utf8');
}

export async function readRuntimeStatus(config: SpecMonkeyConfig): Promise<RuntimeStatus | null> {
  const logDir = getLogDir(config);
  const jsonPath = join(logDir, 'runtime-status.json');

  try {
    const raw = await readFile(jsonPath, 'utf8');
    return JSON.parse(raw) as RuntimeStatus;
  } catch {
    return null;
  }
}
