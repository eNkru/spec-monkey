import * as http from 'node:http';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { SpecMonkeyConfig } from '../config/index.js';
import type { RuntimeStatus } from '../types.js';

export interface DashboardConfig {
  host?: string;       // default '127.0.0.1'
  port?: number;       // default 8080
  projectDirs?: string[]; // directories to scan for runtime-status.json
}

interface ProjectStatus {
  name: string;
  dir: string;
  status: RuntimeStatus | null;
  error?: string;
}

// Optional web dependency check:
// If this module required an external web framework (e.g. express, fastify),
// we would check for it here and print an install hint + exit(1) if absent.
// Since we use the built-in `node:http` module, this check always succeeds.
function checkOptionalWebDependency(): void {
  // No optional dependency needed — using built-in http module.
  // If an optional dep were required, we'd do:
  //   try { await import('some-optional-dep'); }
  //   catch { console.error('Run: npm install spec-monkey --include=optional'); process.exit(1); }
}

async function readProjectStatus(dir: string): Promise<ProjectStatus> {
  const statusFile = path.join(dir, 'logs', 'runtime-status.json');
  const name = path.basename(dir);
  try {
    const raw = await fs.readFile(statusFile, 'utf-8');
    const status = JSON.parse(raw) as RuntimeStatus;
    return { name, dir, status };
  } catch {
    return { name, dir, status: null, error: 'No runtime-status.json found' };
  }
}

async function gatherAllStatuses(projectDirs: string[]): Promise<ProjectStatus[]> {
  return Promise.all(projectDirs.map(readProjectStatus));
}

function statusBadgeColor(status: RuntimeStatus['status'] | undefined): string {
  switch (status) {
    case 'running': return '#2196F3';
    case 'validating': return '#FF9800';
    case 'complete': return '#4CAF50';
    case 'error': return '#F44336';
    case 'idle': return '#9E9E9E';
    default: return '#9E9E9E';
  }
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderProjectCard(p: ProjectStatus): string {
  if (!p.status) {
    return `
      <div class="card offline">
        <div class="card-header">
          <span class="project-name">${escapeHtml(p.name)}</span>
          <span class="badge" style="background:#9E9E9E">offline</span>
        </div>
        <div class="card-body">
          <p class="muted">${escapeHtml(p.error ?? 'No status available')}</p>
        </div>
      </div>`;
  }

  const s = p.status;
  const color = statusBadgeColor(s.status);
  const counts = s.taskCounts ?? { pending: 0, completed: 0, blocked: 0, running: 0 };
  const logTail = s.attemptLog
    ? escapeHtml(s.attemptLog.split('\n').slice(-20).join('\n'))
    : '';

  return `
    <div class="card">
      <div class="card-header">
        <span class="project-name">${escapeHtml(p.name)}</span>
        <span class="badge" style="background:${color}">${escapeHtml(s.status)}</span>
      </div>
      <div class="card-body">
        <div class="counts">
          <span class="count-item pending">⏳ ${counts.pending} pending</span>
          <span class="count-item completed">✅ ${counts.completed} done</span>
          <span class="count-item blocked">🚫 ${counts.blocked} blocked</span>
          <span class="count-item running">▶ ${counts.running} running</span>
        </div>
        ${s.currentTaskTitle ? `<div class="current-task">Current: <strong>${escapeHtml(s.currentTaskTitle)}</strong></div>` : ''}
        ${s.currentAttempt > 0 ? `<div class="attempt-info">Attempt ${s.currentAttempt} / ${s.maxAttempts}</div>` : ''}
        <div class="updated">Last updated: ${escapeHtml(s.lastUpdated)}</div>
        ${logTail ? `<pre class="log-tail">${logTail}</pre>` : ''}
      </div>
    </div>`;
}

function buildHtmlPage(projects: ProjectStatus[]): string {
  const cards = projects.map(renderProjectCard).join('\n');
  const now = new Date().toISOString();

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="refresh" content="5">
  <title>spec-monkey dashboard</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, monospace;
      background: #1a1a2e;
      color: #e0e0e0;
      padding: 24px;
      min-height: 100vh;
    }
    h1 {
      font-size: 1.5rem;
      margin-bottom: 8px;
      color: #90caf9;
      letter-spacing: 0.05em;
    }
    .subtitle {
      font-size: 0.8rem;
      color: #666;
      margin-bottom: 24px;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(360px, 1fr));
      gap: 16px;
    }
    .card {
      background: #16213e;
      border: 1px solid #0f3460;
      border-radius: 8px;
      overflow: hidden;
    }
    .card.offline {
      opacity: 0.6;
    }
    .card-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 12px 16px;
      background: #0f3460;
    }
    .project-name {
      font-weight: 600;
      font-size: 1rem;
      color: #e0e0e0;
    }
    .badge {
      font-size: 0.7rem;
      font-weight: 700;
      padding: 3px 8px;
      border-radius: 12px;
      color: #fff;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    .card-body {
      padding: 12px 16px;
    }
    .counts {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-bottom: 10px;
    }
    .count-item {
      font-size: 0.8rem;
      padding: 2px 8px;
      border-radius: 4px;
      background: #0f3460;
    }
    .current-task {
      font-size: 0.85rem;
      margin-bottom: 6px;
      color: #90caf9;
    }
    .attempt-info {
      font-size: 0.75rem;
      color: #aaa;
      margin-bottom: 6px;
    }
    .updated {
      font-size: 0.7rem;
      color: #666;
      margin-bottom: 8px;
    }
    .log-tail {
      font-size: 0.7rem;
      background: #0a0a1a;
      border: 1px solid #0f3460;
      border-radius: 4px;
      padding: 8px;
      overflow-x: auto;
      white-space: pre-wrap;
      word-break: break-all;
      max-height: 160px;
      overflow-y: auto;
      color: #b0bec5;
      line-height: 1.4;
    }
    .muted { color: #666; font-size: 0.85rem; }
    .no-projects {
      text-align: center;
      padding: 48px;
      color: #666;
    }
  </style>
</head>
<body>
  <h1>🐒 spec-monkey dashboard</h1>
  <div class="subtitle">Auto-refreshes every 5 seconds &mdash; ${escapeHtml(now)}</div>
  ${projects.length === 0
    ? '<div class="no-projects">No projects found. Make sure your project directories contain <code>logs/runtime-status.json</code>.</div>'
    : `<div class="grid">${cards}</div>`
  }
</body>
</html>`;
}

export async function startDashboard(
  config: SpecMonkeyConfig,
  dashOpts?: DashboardConfig,
): Promise<void> {
  checkOptionalWebDependency();

  const host = dashOpts?.host ?? '127.0.0.1';
  const port = dashOpts?.port ?? 8080;
  const projectDirs = dashOpts?.projectDirs ?? [process.cwd()];

  const server = http.createServer(async (req, res) => {
    const url = req.url ?? '/';

    if (req.method !== 'GET') {
      res.writeHead(405, { 'Content-Type': 'text/plain' });
      res.end('Method Not Allowed');
      return;
    }

    if (url === '/status') {
      try {
        const projects = await gatherAllStatuses(projectDirs);
        const payload = JSON.stringify(projects, null, 2);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(payload);
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: String(err) }));
      }
      return;
    }

    if (url === '/') {
      try {
        const projects = await gatherAllStatuses(projectDirs);
        const html = buildHtmlPage(projects);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end(`Internal Server Error: ${String(err)}`);
      }
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  });

  await new Promise<void>((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, host, () => {
      console.log(`Listening on http://${host}:${port}`);
      resolve();
    });
  });
}
