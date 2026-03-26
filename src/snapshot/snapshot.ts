import { readdir, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import type { SpecMonkeyConfig } from '../config/index.js';

// Map of relative path -> [mtime_ns as bigint, size_bytes]
export type SnapshotEntry = [bigint, number];
export type Snapshot = Map<string, SnapshotEntry>;

/**
 * Simple glob matcher supporting `*` (any chars except `/`) and `**` (any chars including `/`).
 */
function matchGlob(pattern: string, filePath: string): boolean {
  // Normalize separators to forward slash
  const normalizedPath = filePath.split(sep).join('/');
  const normalizedPattern = pattern.split(sep).join('/');

  // Convert glob pattern to regex
  let regexStr = '';
  let i = 0;
  while (i < normalizedPattern.length) {
    const ch = normalizedPattern[i];
    if (ch === '*' && normalizedPattern[i + 1] === '*') {
      // `**` matches any sequence including path separators
      regexStr += '.*';
      i += 2;
      // Skip optional trailing slash after **
      if (normalizedPattern[i] === '/') i++;
    } else if (ch === '*') {
      // `*` matches any sequence except `/`
      regexStr += '[^/]*';
      i++;
    } else if (ch === '?') {
      regexStr += '[^/]';
      i++;
    } else {
      // Escape regex special chars
      regexStr += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
      i++;
    }
  }

  const regex = new RegExp(`^${regexStr}$`);
  return regex.test(normalizedPath);
}

/**
 * Check if any path component matches an ignored directory name.
 */
function hasIgnoredDirComponent(relPath: string, ignoreDirs: string[]): boolean {
  const parts = relPath.split(sep);
  // Check all components except the last (which is the file name)
  for (let i = 0; i < parts.length - 1; i++) {
    if (ignoreDirs.includes(parts[i])) return true;
  }
  return false;
}

/**
 * Walk a directory recursively and collect all file paths.
 */
async function walkDir(dir: string): Promise<string[]> {
  const results: string[] = [];
  let entries: string[];
  try {
    entries = await readdir(dir, { recursive: true }) as string[];
  } catch {
    return results;
  }
  for (const entry of entries) {
    const fullPath = join(dir, entry);
    try {
      const s = await stat(fullPath);
      if (s.isFile()) {
        results.push(fullPath);
      }
    } catch {
      // Skip files we can't stat
    }
  }
  return results;
}

/**
 * Take a snapshot of the given directories, applying config filters.
 */
export async function takeSnapshot(dirs: string[], config: SpecMonkeyConfig): Promise<Snapshot> {
  const snapshot: Snapshot = new Map();
  const { ignore_dirs, ignore_path_globs, include_path_globs } = config.snapshot;

  for (const dir of dirs) {
    const allFiles = await walkDir(dir);

    for (const fullPath of allFiles) {
      const relPath = relative(dir, fullPath);

      // Skip paths with ignored directory components
      if (hasIgnoredDirComponent(relPath, ignore_dirs)) continue;

      // Normalize to forward slashes for glob matching
      const normalizedRel = relPath.split(sep).join('/');

      // Skip paths matching ignore_path_globs
      if (ignore_path_globs.some(glob => matchGlob(glob, normalizedRel))) continue;

      // If include_path_globs is non-empty, only include matching paths
      if (include_path_globs.length > 0) {
        if (!include_path_globs.some(glob => matchGlob(glob, normalizedRel))) continue;
      }

      try {
        const s = await stat(fullPath);
        // Convert mtime milliseconds to nanoseconds as BigInt
        const mtimeNs = BigInt(Math.round(s.mtimeMs * 1_000_000));
        snapshot.set(normalizedRel, [mtimeNs, s.size]);
      } catch {
        // Skip files we can't stat
      }
    }
  }

  return snapshot;
}

// Runtime artifact patterns to filter from diffs
const RUNTIME_ARTIFACT_PATTERNS = ['task.json', 'progress.txt'];
const RUNTIME_ARTIFACT_PREFIXES = ['logs/'];

function isRuntimeArtifact(filePath: string): boolean {
  const normalized = filePath.split(sep).join('/');
  if (RUNTIME_ARTIFACT_PATTERNS.includes(normalized)) return true;
  if (RUNTIME_ARTIFACT_PREFIXES.some(prefix => normalized.startsWith(prefix))) return true;
  return false;
}

/**
 * Diff two snapshots and return the list of changed file paths (added, modified, deleted).
 * Filters out spec-monkey runtime artifacts.
 */
export function diffSnapshots(before: Snapshot, after: Snapshot): string[] {
  const changed: string[] = [];

  // Check for added or modified files
  for (const [path, [afterMtime, afterSize]] of after) {
    if (isRuntimeArtifact(path)) continue;
    const beforeEntry = before.get(path);
    if (!beforeEntry) {
      // Added
      changed.push(path);
    } else {
      const [beforeMtime, beforeSize] = beforeEntry;
      if (beforeMtime !== afterMtime || beforeSize !== afterSize) {
        // Modified
        changed.push(path);
      }
    }
  }

  // Check for deleted files
  for (const path of before.keys()) {
    if (isRuntimeArtifact(path)) continue;
    if (!after.has(path)) {
      changed.push(path);
    }
  }

  return changed;
}
