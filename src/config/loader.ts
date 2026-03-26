import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, dirname, isAbsolute } from 'node:path';
import TOML from '@iarna/toml';
import { ConfigError } from '../errors.js';
import { SpecMonkeyConfigSchema, type SpecMonkeyConfig } from './schema.js';

const CONFIG_FILENAME = 'spec-monkey.toml';

/** Walk up from `startDir` looking for `spec-monkey.toml`. Returns the full path or null. */
function discoverConfig(startDir: string): string | null {
  let dir = startDir;
  while (true) {
    const candidate = resolve(dir, CONFIG_FILENAME);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null; // reached filesystem root
    dir = parent;
  }
}

/** Coerce a string env var value to the target zod type. */
function coerceEnvValue(raw: string, sample: unknown): unknown {
  if (typeof sample === 'boolean') {
    return raw === 'true' || raw === '1';
  }
  if (typeof sample === 'number') {
    const n = Number(raw);
    return isNaN(n) ? sample : n;
  }
  if (Array.isArray(sample)) {
    try { return JSON.parse(raw); } catch { return raw.split(',').map(s => s.trim()); }
  }
  return raw;
}

/**
 * Apply SPEC_MONKEY_<SECTION>_<KEY> environment variable overrides to the raw config object.
 * Only top-level section keys are supported (e.g. SPEC_MONKEY_BACKEND_DEFAULT).
 */
function applyEnvOverrides(raw: Record<string, unknown>): void {
  const defaults = SpecMonkeyConfigSchema.parse({});

  for (const [envKey, envVal] of Object.entries(process.env)) {
    if (!envKey.startsWith('SPEC_MONKEY_') || envVal === undefined) continue;
    const parts = envKey.slice('SPEC_MONKEY_'.length).toLowerCase().split('_');
    if (parts.length < 2) continue;

    // Try matching section + key by greedily consuming parts for the section name
    const sectionKeys = Object.keys(defaults) as Array<keyof typeof defaults>;
    for (const section of sectionKeys) {
      const sectionParts = section.split('_');
      if (parts.length <= sectionParts.length) continue;
      const candidateSection = parts.slice(0, sectionParts.length).join('_');
      if (candidateSection !== section) continue;

      const keyParts = parts.slice(sectionParts.length);
      const key = keyParts.join('_');

      const sectionDefaults = (defaults as Record<string, Record<string, unknown>>)[section];
      if (typeof sectionDefaults !== 'object' || sectionDefaults === null) continue;
      if (!(key in sectionDefaults)) continue;

      const sectionRaw = (raw[section] ?? {}) as Record<string, unknown>;
      const sample = sectionDefaults[key];
      sectionRaw[key] = coerceEnvValue(envVal, sample);
      raw[section] = sectionRaw;
      break;
    }
  }
}

/** Resolve relative path fields in [files] and [project] against the config directory. */
function resolveRelativePaths(config: SpecMonkeyConfig, configDir: string): SpecMonkeyConfig {
  const resolvePath = (p: string) => (isAbsolute(p) ? p : resolve(configDir, p));

  return {
    ...config,
    project: {
      ...config.project,
      code_dir: resolvePath(config.project.code_dir),
      config_dir: resolvePath(config.project.config_dir),
    },
    files: {
      ...config.files,
      task_json: resolvePath(config.files.task_json),
      progress: resolvePath(config.files.progress),
      execution_guide: resolvePath(config.files.execution_guide),
      task_brief: resolvePath(config.files.task_brief),
      log_dir: resolvePath(config.files.log_dir),
    },
  };
}

/**
 * Load and validate `spec-monkey.toml`.
 *
 * @param path - Explicit path to the TOML file. When omitted, walks up from cwd.
 * @throws {ConfigError} on missing file, TOML parse error, or zod validation failure.
 */
export async function loadConfig(path?: string): Promise<SpecMonkeyConfig> {
  let configPath: string;

  if (path) {
    configPath = resolve(path);
    if (!existsSync(configPath)) {
      throw new ConfigError(`Config file not found: ${configPath}`);
    }
  } else {
    const found = discoverConfig(process.cwd());
    if (!found) {
      throw new ConfigError(
        `Could not find ${CONFIG_FILENAME}. Run \`spec-monkey init\` to create one.`,
      );
    }
    configPath = found;
  }

  const configDir = dirname(configPath);
  let raw: Record<string, unknown>;

  try {
    const text = await readFile(configPath, 'utf8');
    raw = TOML.parse(text) as Record<string, unknown>;
  } catch (err) {
    if (err instanceof ConfigError) throw err;
    throw new ConfigError(
      `Failed to parse ${configPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Alias legacy [gate] section → [verification]
  if ('gate' in raw && !('verification' in raw)) {
    raw['verification'] = raw['gate'];
  }
  delete raw['gate'];

  // Apply SPEC_MONKEY_* env overrides
  applyEnvOverrides(raw);

  // Validate with zod
  const result = SpecMonkeyConfigSchema.safeParse(raw);
  if (!result.success) {
    const messages = result.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join('; ');
    throw new ConfigError(`Invalid config in ${configPath}: ${messages}`);
  }

  const config = result.data;

  // Validate backend.default (zod enum already handles this, but provide a friendlier message)
  const validBackends = ['claude', 'codex', 'gemini', 'opencode'] as const;
  if (!validBackends.includes(config.backend.default as (typeof validBackends)[number])) {
    throw new ConfigError(
      `Invalid backend.default "${config.backend.default}". Must be one of: ${validBackends.join(', ')}.`,
    );
  }

  return resolveRelativePaths(config, configDir);
}
