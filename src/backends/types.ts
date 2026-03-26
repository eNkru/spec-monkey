import type { SpecMonkeyConfig } from '../config/index.js';
import type { CommandSpec } from '../types.js';

export interface BuildCommandOpts {
  // optional overrides for command building
  backend?: string;
}

export interface BackendAdapter {
  readonly name: string;
  buildCommand(prompt: string, config: SpecMonkeyConfig, opts?: BuildCommandOpts): CommandSpec;
  buildPlanCommand(prompt: string, config: SpecMonkeyConfig): CommandSpec;
}
