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

export const claudeAdapter: BackendAdapter = {
  name: 'claude',

  buildCommand(prompt: string, config: SpecMonkeyConfig, _opts?: BuildCommandOpts): CommandSpec {
    checkBinary('claude');
    const cmd: string[] = ['claude', '-p', prompt];
    if (config.backend.claude.skip_permissions) {
      cmd.push('--dangerously-skip-permissions');
    }
    return {
      cmd,
      cwd: config.project.code_dir || process.cwd(),
    };
  },

  buildPlanCommand(prompt: string, config: SpecMonkeyConfig): CommandSpec {
    checkBinary('claude');
    const cmd: string[] = ['claude', '-p', prompt, '--output-format', 'text'];
    if (config.backend.claude.skip_permissions) {
      cmd.push('--dangerously-skip-permissions');
    }
    return {
      cmd,
      cwd: config.project.code_dir || process.cwd(),
    };
  },
};
