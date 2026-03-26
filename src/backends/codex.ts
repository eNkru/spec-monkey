import { execSync } from 'child_process';
import type { BackendAdapter, BuildCommandOpts } from './types.js';
import { BackendNotFoundError } from '../errors.js';
import type { SpecMonkeyConfig } from '../config/index.js';
import type { CommandSpec } from '../types.js';

function checkBinary(binary: string): void {
  try {
    execSync(`which ${binary}`, { stdio: 'ignore' });
  } catch {
    throw new BackendNotFoundError(binary);
  }
}

export const codexAdapter: BackendAdapter = {
  name: 'codex',

  buildCommand(prompt: string, config: SpecMonkeyConfig, _opts?: BuildCommandOpts): CommandSpec {
    checkBinary('codex');
    let cmd: string[];
    if (config.backend.codex.yolo) {
      cmd = ['codex', 'exec', '--yolo', prompt];
    } else {
      cmd = ['codex', '--full-auto', '--dangerously-bypass-approvals-and-sandbox', prompt];
    }
    return {
      cmd,
      cwd: config.project.code_dir || process.cwd(),
    };
  },

  buildPlanCommand(prompt: string, config: SpecMonkeyConfig): CommandSpec {
    checkBinary('codex');
    let cmd: string[];
    if (config.backend.codex.yolo) {
      cmd = ['codex', 'exec', '--yolo', prompt];
    } else {
      cmd = ['codex', '--full-auto', '--dangerously-bypass-approvals-and-sandbox', prompt];
    }
    return {
      cmd,
      cwd: config.project.code_dir || process.cwd(),
    };
  },
};
