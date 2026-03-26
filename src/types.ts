export interface GateCheck {
  name: string;
  ok: boolean;
  details: string;
}

export type MetricOutcome =
  | 'improved'
  | 'unchanged'
  | 'regressed'
  | 'measured'
  | 'invalid'
  | 'target_met'
  | 'baseline';

export interface GateMetricResult {
  name: string;
  value: number | null;
  baseline: number | null;
  bestBefore: number | null;
  outcome: MetricOutcome;
  details: string;
}

export interface GateResult {
  status: 'passed' | 'failed';
  taskId: string;
  checks: GateCheck[];
  errors: string[];
  warnings: string[];
  metric: GateMetricResult | null;
  completionResult: {
    kind: 'boolean' | 'numeric';
    passed: boolean;
    outcome: string;
    details: string;
  };
}

// Map of relative path -> [mtime_ns as bigint, size_bytes]
export type SnapshotEntry = [bigint, number];
export type Snapshot = Map<string, SnapshotEntry>;

export interface RuntimeStatus {
  status: 'idle' | 'running' | 'validating' | 'complete' | 'error';
  lastUpdated: string;
  currentTaskId: string;
  currentTaskTitle: string;
  currentAttempt: number;
  maxAttempts: number;
  taskCounts: {
    pending: number;
    completed: number;
    blocked: number;
    running: number;
  };
  heartbeatElapsedSeconds: number;
  attemptLog: string;
}

export interface ExperimentLogEntry {
  taskId: string;
  iteration: number;
  metricName: string;
  baselineValue: number | null;
  bestBefore: number | null;
  measuredValue: number | null;
  outcome: string;
  commitSha: string;
  revertedSha: string;
  timestamp: string;
  notes?: string;
}

export interface CommandSpec {
  cmd: string[];
  env?: Record<string, string>;
  cwd: string;
}

export interface BackendResult {
  exitCode: number;
  logFile: string;
  teeExit: number;
}
