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

export const openCodeAdapter: BackendAdapter = {
  name: 'opencode',

  buildCommand(prompt: string, config: SpecMonkeyConfig, _opts?: BuildCommandOpts): CommandSpec {
    checkBinary('opencode');
    return {
      cmd: ['opencode', 'run', prompt],
      env: { OPENCODE_PERMISSION: config.backend.opencode.permissions },
      cwd: config.project.code_dir || process.cwd(),
    };
  },

  buildPlanCommand(prompt: string, config: SpecMonkeyConfig): CommandSpec {
    checkBinary('opencode');
    return {
      cmd: ['opencode', 'run', prompt],
      env: { OPENCODE_PERMISSION: config.backend.opencode.permissions },
      cwd: config.project.code_dir || process.cwd(),
    };
  },
};
