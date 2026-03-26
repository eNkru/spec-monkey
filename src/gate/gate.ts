import { spawn } from 'node:child_process';
import * as path from 'node:path';
import type { Task } from '../taskStore/index.js';
import type { SpecMonkeyConfig } from '../config/index.js';
import type { GateResult, GateCheck, GateMetricResult, MetricOutcome } from '../types.js';
import { RuntimeError } from '../errors.js';

export interface RunGateOpts {
  enforceChangeRequirements?: boolean; // default true
  bestMetricSoFar?: number | null;
  baselineMetric?: number | null;
}

// Shell control tokens that must be rejected before execution
const SHELL_TOKENS = ['&&', '||', '|', ';', '<', '>', '$(', '`'];

function checkShellInjection(cmd: string): void {
  for (const token of SHELL_TOKENS) {
    if (cmd.includes(token)) {
      throw new RuntimeError(
        `Validate command contains shell control token "${token}": ${cmd}`
      );
    }
  }
}

function splitArgv(cmd: string): string[] {
  return cmd.trim().split(/\s+/).filter(Boolean);
}

interface RunCommandResult {
  exitCode: number;
  stdout: string;
  timedOut: boolean;
}

function runCommand(
  argv: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number
): Promise<RunCommandResult> {
  return new Promise((resolve) => {
    const [bin, ...args] = argv;
    const child = spawn(bin, args, {
      cwd,
      env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let timedOut = false;

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code ?? 1, stdout, timedOut });
    });

    child.on('error', () => {
      clearTimeout(timer);
      resolve({ exitCode: 1, stdout, timedOut });
    });
  });
}

function getNestedValue(obj: unknown, dotPath: string): unknown {
  const parts = dotPath.split('.');
  let current: unknown = obj;
  for (const part of parts) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function classifyOutcome(
  value: number,
  bestBefore: number | null | undefined,
  direction: 'higher_is_better' | 'lower_is_better' | undefined,
  minImprovement: number | undefined,
  unchangedTolerance: number | undefined,
  target: number | undefined
): MetricOutcome {
  const dir = direction ?? 'higher_is_better';
  const minImp = minImprovement ?? 0;
  const tolerance = unchangedTolerance ?? 0;

  // Check target first
  if (target !== undefined) {
    const targetMet =
      dir === 'higher_is_better' ? value >= target : value <= target;
    if (targetMet) return 'target_met';
  }

  if (bestBefore === null || bestBefore === undefined) {
    return 'baseline';
  }

  const diff = dir === 'higher_is_better' ? value - bestBefore : bestBefore - value;

  if (diff >= minImp && diff > tolerance) return 'improved';
  if (Math.abs(diff) <= tolerance) return 'unchanged';
  return 'regressed';
}

export async function runGate(
  task: Task,
  changedFiles: string[],
  config: SpecMonkeyConfig,
  opts?: RunGateOpts
): Promise<GateResult> {
  const enforceChange = opts?.enforceChangeRequirements !== false;
  const bestBefore = opts?.bestMetricSoFar ?? null;
  const baselineMetric = opts?.baselineMetric ?? null;

  const checks: GateCheck[] = [];
  const errors: string[] = [];
  const warnings: string[] = [];

  // Resolve validate commands: task overrides take precedence over config
  const validateCommands: string[] =
    task.verification?.validate_commands ?? config.verification.validate_commands;

  // Resolve timeout
  const timeoutSeconds: number =
    task.verification?.validate_timeout_seconds ??
    config.verification.validate_timeout_seconds;
  const timeoutMs = timeoutSeconds * 1000;

  // Resolve working directory
  const rawCwd =
    task.verification?.validate_working_directory ||
    config.verification.validate_working_directory ||
    config.project.code_dir ||
    '.';
  const resolvedCwd = path.resolve(rawCwd);

  // Resolve environment
  const baseEnv: Record<string, string> = { ...process.env } as Record<string, string>;
  const configEnv = config.verification.validate_environment ?? {};
  const taskEnv = task.verification?.validate_environment ?? {};
  const mergedEnv: NodeJS.ProcessEnv = { ...baseEnv, ...configEnv, ...taskEnv };

  const kind = task.completion.kind;

  // ── Boolean gate ──────────────────────────────────────────────────────────
  if (kind === 'boolean') {
    // File count check
    if (enforceChange) {
      const minFiles = config.verification.min_changed_files;
      const fileCountOk = changedFiles.length >= minFiles;
      checks.push({
        name: 'changed_files',
        ok: fileCountOk,
        details: `${changedFiles.length} changed file(s), minimum ${minFiles}`,
      });
      if (!fileCountOk) {
        errors.push(
          `Insufficient changed files: ${changedFiles.length} < ${minFiles}`
        );
      }
    }

    // Run each validate command
    for (const cmd of validateCommands) {
      checkShellInjection(cmd);
      const argv = splitArgv(cmd);
      const result = await runCommand(argv, resolvedCwd, mergedEnv, timeoutMs);

      if (result.timedOut) {
        const msg = `Command timed out after ${timeoutSeconds}s: ${cmd}`;
        checks.push({ name: cmd, ok: false, details: msg });
        errors.push(msg);
      } else {
        const ok = result.exitCode === 0;
        checks.push({
          name: cmd,
          ok,
          details: ok ? `Exited 0` : `Exited ${result.exitCode}`,
        });
        if (!ok) {
          errors.push(`Validate command failed (exit ${result.exitCode}): ${cmd}`);
        }
      }
    }

    const passed = errors.length === 0;
    return {
      status: passed ? 'passed' : 'failed',
      taskId: task.id,
      checks,
      errors,
      warnings,
      metric: null,
      completionResult: {
        kind: 'boolean',
        passed,
        outcome: passed ? 'passed' : 'failed',
        details: passed
          ? 'All checks passed'
          : errors.join('; '),
      },
    };
  }

  // ── Numeric gate ──────────────────────────────────────────────────────────
  let lastSuccessfulStdout = '';
  let commandsAllPassed = true;

  for (const cmd of validateCommands) {
    checkShellInjection(cmd);
    const argv = splitArgv(cmd);
    const result = await runCommand(argv, resolvedCwd, mergedEnv, timeoutMs);

    if (result.timedOut) {
      const msg = `Command timed out after ${timeoutSeconds}s: ${cmd}`;
      checks.push({ name: cmd, ok: false, details: msg });
      errors.push(msg);
      commandsAllPassed = false;
    } else if (result.exitCode !== 0) {
      checks.push({
        name: cmd,
        ok: false,
        details: `Exited ${result.exitCode}`,
      });
      errors.push(`Validate command failed (exit ${result.exitCode}): ${cmd}`);
      commandsAllPassed = false;
    } else {
      checks.push({ name: cmd, ok: true, details: 'Exited 0' });
      lastSuccessfulStdout = result.stdout;
    }
  }

  // Extract metric from last successful command's JSON stdout
  const jsonPath = task.completion.json_path;
  const metricName = task.completion.name ?? jsonPath ?? 'metric';

  let metricValue: number | null = null;
  let metricOutcome: MetricOutcome = 'invalid';
  let metricDetails = '';

  if (!commandsAllPassed && lastSuccessfulStdout === '') {
    metricDetails = 'No successful validate command produced output';
    metricOutcome = 'invalid';
  } else if (jsonPath) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(lastSuccessfulStdout);
    } catch {
      metricDetails = 'Failed to parse JSON from validate command stdout';
      metricOutcome = 'invalid';
      errors.push(metricDetails);
    }

    if (parsed !== undefined) {
      const raw = getNestedValue(parsed, jsonPath);
      if (typeof raw === 'number') {
        metricValue = raw;
        metricOutcome = classifyOutcome(
          metricValue,
          bestBefore,
          task.completion.direction,
          task.completion.min_improvement,
          task.completion.unchanged_tolerance,
          task.completion.target
        );
        metricDetails = `${metricName} = ${metricValue} (outcome: ${metricOutcome})`;
      } else {
        metricDetails = `json_path "${jsonPath}" did not resolve to a number (got ${typeof raw})`;
        metricOutcome = 'invalid';
        errors.push(metricDetails);
      }
    }
  } else {
    metricDetails = 'No json_path configured for numeric gate';
    metricOutcome = 'invalid';
    errors.push(metricDetails);
  }

  const metric: GateMetricResult = {
    name: metricName,
    value: metricValue,
    baseline: baselineMetric,
    bestBefore,
    outcome: metricOutcome,
    details: metricDetails,
  };

  const passed =
    commandsAllPassed &&
    metricValue !== null &&
    (metricOutcome === 'improved' ||
      metricOutcome === 'unchanged' ||
      metricOutcome === 'target_met' ||
      metricOutcome === 'baseline');

  return {
    status: passed ? 'passed' : 'failed',
    taskId: task.id,
    checks,
    errors,
    warnings,
    metric,
    completionResult: {
      kind: 'numeric',
      passed,
      outcome: metricOutcome,
      details: metricDetails,
    },
  };
}
