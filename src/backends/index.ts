import { claudeAdapter } from './claude.js';
import { codexAdapter } from './codex.js';
import { geminiAdapter } from './gemini.js';
import { openCodeAdapter } from './opencode.js';
import { RuntimeError } from '../errors.js';
import type { BackendAdapter } from './types.js';

export type { BackendAdapter, BuildCommandOpts } from './types.js';
export { spawnBackend } from './executor.js';
export type { SpawnBackendOpts } from './executor.js';

const REGISTRY: Record<string, BackendAdapter> = {
  claude: claudeAdapter,
  codex: codexAdapter,
  gemini: geminiAdapter,
  opencode: openCodeAdapter,
};

export { REGISTRY };

export function getBackend(name: string): BackendAdapter {
  const adapter = REGISTRY[name];
  if (!adapter) throw new RuntimeError(`Unknown backend: ${name}`);
  return adapter;
}
