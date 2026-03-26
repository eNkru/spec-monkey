import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { dirname } from 'node:path';
import type { BackendResult } from '../types.js';

export interface SpawnBackendOpts {
  cmd: string[];
  env?: Record<string, string>;
  cwd: string;
  attemptLogFile: string;
  mainLogFile: string;
}

export async function spawnBackend(opts: SpawnBackendOpts): Promise<BackendResult> {
  const { cmd, env, cwd, attemptLogFile, mainLogFile } = opts;

  // Ensure parent directories exist
  await mkdir(dirname(attemptLogFile), { recursive: true });
  await mkdir(dirname(mainLogFile), { recursive: true });

  const attemptStream = createWriteStream(attemptLogFile, { flags: 'a' });
  const mainStream = createWriteStream(mainLogFile, { flags: 'a' });

  const [bin, ...args] = cmd;
  const child = spawn(bin, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let teeExit = 0;

  function writeChunk(chunk: Buffer): void {
    try {
      process.stdout.write(chunk);
    } catch {
      teeExit = 1;
    }
    if (!attemptStream.write(chunk)) {
      // backpressure — drain handled automatically
    }
    if (!mainStream.write(chunk)) {
      // backpressure — drain handled automatically
    }
  }

  child.stdout.on('data', (chunk: Buffer) => writeChunk(chunk));
  child.stderr.on('data', (chunk: Buffer) => writeChunk(chunk));

  const exitCode = await new Promise<number>((resolve) => {
    child.on('close', (code) => {
      resolve(code ?? 1);
    });
  });

  // Close log streams
  await new Promise<void>((resolve) => attemptStream.end(resolve));
  await new Promise<void>((resolve) => mainStream.end(resolve));

  return {
    exitCode,
    logFile: attemptLogFile,
    teeExit,
  };
}
