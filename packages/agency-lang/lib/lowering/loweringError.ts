import { SourceLocation } from "../types/base.js";

/** Thrown by the pattern-lowering pass when a `match` used in expression
 *  position violates a lowering rule (all-paths yield, bare return,
 *  concurrency-boundary return, module-level match expression, `is`-form in
 *  expression position). Caught in `parseAgency` and surfaced as a normal
 *  failed parse so the CLI / LSP show a diagnostic instead of a stack trace. */
export class LoweringError extends Error {
  loc?: SourceLocation;
  constructor(message: string, loc?: SourceLocation) {
    super(message);
    this.name = "LoweringError";
    this.loc = loc;
  }
}
