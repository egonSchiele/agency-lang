import type { SourceLocation } from "./types/base.js";

/**
 * An import that cannot be resolved: an unknown or non-exported symbol, a
 * misused marker, a re-export of a name the source does not define, or a
 * `pkg::` package that is not installed. Carries the offending statement's
 * `loc` so a caller can anchor a diagnostic to it.
 *
 * The CLI entry points catch this class specifically and print only the
 * message. A blanket catch would hide the stack of a genuine internal bug,
 * which is exactly the case where the stack is wanted.
 */
export class ImportResolutionError extends Error {
  loc?: SourceLocation;
  /** The file holding the offending statement, when the thrower knows it. */
  file?: string;
  /** The type checker's AG#### code for the same mistake, when it has one,
   *  so `agency explain` works on either report. */
  code?: string;
  constructor(message: string, loc?: SourceLocation, file?: string) {
    super(message);
    this.name = "ImportResolutionError";
    this.loc = loc;
    this.file = file;
  }
}

/** One line for the terminal: `file:line:col - error: message`. The error's
 *  own file wins over the caller's guess; the position is omitted when the
 *  error carries none. */
export function formatImportResolutionError(err: ImportResolutionError, file?: string): string {
  const at = err.file ?? file;
  const label = err.code === undefined ? "error" : `error ${err.code}`;
  if (at === undefined) return `${label}: ${err.message}`;
  if (err.loc === undefined) return `${at} - ${label}: ${err.message}`;
  return `${at}:${err.loc.line + 1}:${err.loc.col + 1} - ${label}: ${err.message}`;
}
