import { mkdir, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';

export type SupportedTool = 'claude' | 'codex' | 'gemini' | 'opencode';

const TOOL_WRAPPER_FILES: Record<SupportedTool, string> = {
  claude: 'CLAUDE.md',
  codex: 'AGENTS.md',
  gemini: 'GEMINI.md',
  opencode: 'OPENCODE.md',
};

const DEFAULT_TOML = `[project]
name = "My Project"
code_dir = "."

[backend]
default = "codex"

[run]
max_retries = 3

[verification]
min_changed_files = 1
validate_commands = []

[git]
auto_commit = true
`;

const DEFAULT_TASK_JSON = JSON.stringify({ tasks: [], learning_journal: [] }, null, 2);

const DEFAULT_AGENT_MD = `# Agent Execution Guide

## Instructions

1. Read \`TASK.md\` to understand the current task brief.
2. Implement the task according to the steps and acceptance criteria described.
3. Verify your implementation by running any validation commands listed in the task.
4. Confirm all completion criteria are met before finishing.

## Notes

- Do not modify \`task.json\` directly; let spec-monkey manage task state.
- Write clean, idiomatic code and include tests where appropriate.
- If you encounter blockers, document them clearly.
`;

const DEFAULT_TASK_MD = `# Task Brief

<!-- spec-monkey will populate this file before each task run -->

## Task ID
<!-- task id -->

## Title
<!-- task title -->

## Description
<!-- task description -->

## Steps
<!-- numbered implementation steps -->

## Completion Criteria
<!-- how to verify the task is done -->

## Notes
<!-- additional context, docs, implementation hints -->
`;

const DEFAULT_SKILL_MD = (skillName: string) => `# ${skillName}

A default skill for spec-monkey projects.

## Trigger Keywords

spec-monkey, automation, task

## Description

This skill provides guidance for ${skillName} workflows.
`;

const TOOL_WRAPPER_CONTENT: Record<SupportedTool, string> = {
  codex: `# Codex Agent Instructions

Read \`AGENT.md\` for the execution guide and \`TASK.md\` for the current task brief.

Follow the steps in TASK.md, implement the required changes, and verify completion criteria.
`,
  claude: `# Claude Agent Instructions

Read \`AGENT.md\` for the execution guide and \`TASK.md\` for the current task brief.

Follow the steps in TASK.md, implement the required changes, and verify completion criteria.
`,
  gemini: `# Gemini Agent Instructions

Read \`AGENT.md\` for the execution guide and \`TASK.md\` for the current task brief.

Follow the steps in TASK.md, implement the required changes, and verify completion criteria.
`,
  opencode: `# OpenCode Agent Instructions

Read \`AGENT.md\` for the execution guide and \`TASK.md\` for the current task brief.

Follow the steps in TASK.md, implement the required changes, and verify completion criteria.
`,
};

const DEFAULT_SKILLS = [
  'spec-monkey-runtime',
  'coca-spec',
  'spec-driven-develop',
  'find-skills',
  'skill-creator',
];

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function writeIfNotExists(
  filePath: string,
  content: string,
  opts?: { verbose?: boolean; notice?: string }
): Promise<void> {
  if (await fileExists(filePath)) {
    if (opts?.notice) {
      console.log(opts.notice);
    }
    return;
  }
  await writeFile(filePath, content, 'utf8');
  if (opts?.verbose) {
    console.log(`  created: ${filePath}`);
  }
}

export async function initProject(
  dir: string,
  tool: SupportedTool,
  opts?: { verbose?: boolean }
): Promise<void> {
  const verbose = opts?.verbose ?? false;

  // 1. Create target directory if it doesn't exist
  await mkdir(dir, { recursive: true });

  // 2. Create logs/ subdirectory
  await mkdir(join(dir, 'logs'), { recursive: true });

  // 3. Write spec-monkey.toml — skip if exists, print notice
  await writeIfNotExists(
    join(dir, 'spec-monkey.toml'),
    DEFAULT_TOML,
    {
      verbose,
      notice: `Notice: spec-monkey.toml already exists in ${dir} — skipping.`,
    }
  );

  // 4. Write task.json — skip if exists
  await writeIfNotExists(join(dir, 'task.json'), DEFAULT_TASK_JSON, { verbose });

  // 5. Write AGENT.md — skip if exists
  await writeIfNotExists(join(dir, 'AGENT.md'), DEFAULT_AGENT_MD, { verbose });

  // 6. Write TASK.md — skip if exists
  await writeIfNotExists(join(dir, 'TASK.md'), DEFAULT_TASK_MD, { verbose });

  // 7. Write progress.txt as empty file — skip if exists
  await writeIfNotExists(join(dir, 'progress.txt'), '', { verbose });

  // 8. Create .skills/ directory
  await mkdir(join(dir, '.skills'), { recursive: true });

  // 9 & 10. Create default skill directories and write minimal SKILL.md for each
  for (const skill of DEFAULT_SKILLS) {
    const skillDir = join(dir, '.skills', skill);
    await mkdir(skillDir, { recursive: true });
    await writeIfNotExists(
      join(skillDir, 'SKILL.md'),
      DEFAULT_SKILL_MD(skill),
      { verbose }
    );
  }

  // 11. Create tool-native wrapper file — skip if exists
  const wrapperFile = TOOL_WRAPPER_FILES[tool];
  await writeIfNotExists(
    join(dir, wrapperFile),
    TOOL_WRAPPER_CONTENT[tool],
    { verbose }
  );
}
