import { readdir, readFile, lstat, symlink, cp } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import type { SpecMonkeyConfig } from '../config/index.js';

export interface SkillInfo {
  name: string;
  description: string;
  dir: string;
}

export interface DoctorIssue {
  severity: 'error' | 'warning';
  message: string;
}

/** Backend wrapper file names used by doctorSkills */
const BACKEND_WRAPPER_FILES: Record<string, string> = {
  codex: 'AGENTS.md',
  claude: 'CLAUDE.md',
  gemini: 'GEMINI.md',
  opencode: 'OPENCODE.md',
};

/** Tool-native skill paths for installSkills */
const TOOL_SKILL_PATHS: Record<string, string> = {
  codex: join(homedir(), '.codex', 'skills'),
  claude: join(homedir(), '.claude', 'skills'),
  gemini: join(homedir(), '.gemini', 'skills'),
  opencode: join(homedir(), '.opencode', 'skills'),
};

/**
 * Parse the one-line description from a SKILL.md file.
 * Returns the first non-empty, non-heading line.
 */
function parseSkillDescription(content: string): string {
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#')) {
      return trimmed;
    }
  }
  return '';
}

/**
 * Scan dir/.skills/, parse one-line description from each SKILL.md.
 */
export async function listSkills(dir: string): Promise<SkillInfo[]> {
  const skillsDir = join(dir, '.skills');
  let entries: string[];
  try {
    entries = await readdir(skillsDir);
  } catch {
    return [];
  }

  const skills: SkillInfo[] = [];
  for (const entry of entries) {
    const skillDir = join(skillsDir, entry);
    try {
      const stat = await lstat(skillDir);
      if (!stat.isDirectory() && !stat.isSymbolicLink()) continue;

      const skillMdPath = join(skillDir, 'SKILL.md');
      let description = '';
      try {
        const content = await readFile(skillMdPath, 'utf8');
        description = parseSkillDescription(content);
      } catch {
        // No SKILL.md — skip description
      }

      skills.push({ name: entry, description, dir: skillDir });
    } catch {
      // Skip unreadable entries
    }
  }

  return skills;
}

/**
 * Match query against skill descriptions and trigger keywords, return up to limit results.
 * Scoring: +2 if query words appear in description, +1 if in name.
 */
export async function recommendSkills(query: string, limit: number, dir: string): Promise<SkillInfo[]> {
  const skills = await listSkills(dir);
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);

  const scored = skills.map((skill) => {
    let score = 0;
    const descLower = skill.description.toLowerCase();
    const nameLower = skill.name.toLowerCase();

    for (const word of words) {
      if (descLower.includes(word)) score += 2;
      if (nameLower.includes(word)) score += 1;
    }

    return { skill, score };
  });

  return scored
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ skill }) => skill);
}

/**
 * Verify .skills/ exists, backend wrapper dir present, symlinks resolve.
 * Returns array of issues found.
 */
export async function doctorSkills(config: SpecMonkeyConfig): Promise<DoctorIssue[]> {
  const issues: DoctorIssue[] = [];
  const cwd = process.cwd();
  const skillsDir = join(cwd, '.skills');

  // Check .skills/ exists
  try {
    const stat = await lstat(skillsDir);
    if (!stat.isDirectory()) {
      issues.push({ severity: 'error', message: '.skills/ exists but is not a directory' });
    }
  } catch {
    issues.push({ severity: 'error', message: '.skills/ directory does not exist' });
    return issues; // No point checking further
  }

  // Check backend wrapper file
  const backend = config.backend.default;
  const wrapperFile = BACKEND_WRAPPER_FILES[backend];
  if (wrapperFile) {
    const wrapperPath = join(cwd, wrapperFile);
    try {
      await lstat(wrapperPath);
    } catch {
      issues.push({
        severity: 'warning',
        message: `Backend wrapper file ${wrapperFile} not found for backend '${backend}'`,
      });
    }
  }

  // Check symlinks in .skills/ resolve correctly
  let entries: string[];
  try {
    entries = await readdir(skillsDir);
  } catch {
    issues.push({ severity: 'error', message: 'Cannot read .skills/ directory' });
    return issues;
  }

  for (const entry of entries) {
    const entryPath = join(skillsDir, entry);
    try {
      const stat = await lstat(entryPath);
      if (stat.isSymbolicLink()) {
        // Try to resolve the symlink target
        try {
          const { stat: realStat } = await import('node:fs/promises').then(async (fs) => ({
            stat: await fs.stat(entryPath),
          }));
          if (!realStat.isDirectory()) {
            issues.push({
              severity: 'warning',
              message: `Symlink .skills/${entry} resolves to a non-directory`,
            });
          }
        } catch {
          issues.push({
            severity: 'error',
            message: `Symlink .skills/${entry} is broken (target does not exist)`,
          });
        }
      }
    } catch {
      issues.push({ severity: 'warning', message: `Cannot stat .skills/${entry}` });
    }
  }

  return issues;
}

/**
 * Create symlinks (or copies) in the tool-native path for each skill in .skills/.
 */
export async function installSkills(config: SpecMonkeyConfig): Promise<void> {
  const cwd = process.cwd();
  const skillsDir = join(cwd, '.skills');
  const backend = config.backend.default;
  const targetBase = TOOL_SKILL_PATHS[backend];

  if (!targetBase) {
    throw new Error(`No tool-native skill path configured for backend '${backend}'`);
  }

  // Ensure target directory exists
  const { mkdir } = await import('node:fs/promises');
  await mkdir(targetBase, { recursive: true });

  let entries: string[];
  try {
    entries = await readdir(skillsDir);
  } catch {
    // No .skills/ directory — nothing to install
    return;
  }

  for (const entry of entries) {
    const sourcePath = resolve(skillsDir, entry);
    const targetPath = join(targetBase, entry);

    try {
      // Remove existing target if present
      try {
        const { rm } = await import('node:fs/promises');
        await rm(targetPath, { recursive: true, force: true });
      } catch {
        // Ignore removal errors
      }

      // Try symlink first
      try {
        await symlink(sourcePath, targetPath);
      } catch {
        // Fall back to copy
        await cp(sourcePath, targetPath, { recursive: true });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`Warning: failed to install skill '${entry}': ${message}`);
    }
  }
}
