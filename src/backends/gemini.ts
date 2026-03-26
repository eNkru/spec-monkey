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

export const geminiAdapter: BackendAdapter = {
  name: 'gemini',

  buildCommand(prompt: string, config: SpecMonkeyConfig, _opts?: BuildCommandOpts): CommandSpec {
    checkBinary('gemini');
    const cmd: string[] = ['gemini', '-p', prompt];
    if (config.backend.gemini.yolo) {
      cmd.push('--yolo');
    }
    return {
      cmd,
      cwd: config.project.code_dir || process.cwd(),
    };
  },

  buildPlanCommand(prompt: string, config: SpecMonkeyConfig): CommandSpec {
    checkBinary('gemini');
    const cmd: string[] = ['gemini', '-p', prompt];
    if (config.backend.gemini.yolo) {
      cmd.push('--yolo');
    }
    return {
      cmd,
      cwd: config.project.code_dir || process.cwd(),
    };
  },
};
