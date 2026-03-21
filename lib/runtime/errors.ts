export class ConcurrentInterruptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConcurrentInterruptError";
  }
}

export class ToolCallError extends Error {
  retryable: boolean;
  originalError: unknown;

  constructor(error: unknown, opts: { retryable: boolean }) {
    super(error instanceof Error ? error.message : String(error));
    this.originalError = error;
    this.retryable = opts.retryable;
    if (error instanceof Error && error.stack) {
      this.stack = error.stack;
    }
  }
}
