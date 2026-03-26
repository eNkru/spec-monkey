export class ConfigError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'ConfigError';
  }
}

export class RuntimeError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'RuntimeError';
  }
}

export class TaskAuditError extends Error {
  readonly issues: string[];
  constructor(msg: string, issues: string[]) {
    super(msg);
    this.name = 'TaskAuditError';
    this.issues = issues;
  }
}

export class BackendNotFoundError extends Error {
  constructor(binary: string) {
    super(`Backend binary not found: ${binary}. Ensure it is installed and in PATH.`);
    this.name = 'BackendNotFoundError';
  }
}
