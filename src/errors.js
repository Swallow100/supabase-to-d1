export class CliError extends Error {
  constructor(message, { exitCode = 1, cause } = {}) {
    super(message, { cause });
    this.name = "CliError";
    this.exitCode = exitCode;
  }
}

export class PlanError extends CliError {
  constructor(message, options = {}) {
    super(message, { exitCode: 2, ...options });
    this.name = "PlanError";
  }
}
