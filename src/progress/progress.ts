import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

export type ProgressStatus = 'completed' | 'blocked' | 'retry';

export interface ProgressEntry {
  task_id: string;
  task_name: string;
  status: ProgressStatus;
  changed_files?: number;   // for 'completed'
  block_reason?: string;    // for 'blocked'
  attempt?: number;         // for 'retry'
}

function formatLine(entry: ProgressEntry): string {
  const ts = new Date().toISOString();
  const base = `[${ts}] ${entry.status.toUpperCase()} ${entry.task_id} "${entry.task_name}"`;

  switch (entry.status) {
    case 'completed':
      return `${base} (${entry.changed_files ?? 0} files changed)`;
    case 'blocked':
      return `${base} reason: "${entry.block_reason ?? ''}"`;
    case 'retry':
      return `${base} attempt ${entry.attempt ?? 1}`;
  }
}

export async function appendProgress(entry: ProgressEntry, filePath: string): Promise<void> {
  const dir = dirname(filePath);
  await mkdir(dir, { recursive: true });
  await appendFile(filePath, formatLine(entry) + '\n');
}
