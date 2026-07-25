import { diagnostic } from "../../typeChecker/diagnostics.js";
import { formatErrors } from "../../typeChecker/index.js";
import type { TypeCheckError } from "../../typeChecker/types.js";
import type { SpliceDiagnostic } from "./types.js";

/**
 * Turn a splice failure into the shape the rest of the compiler already
 * reports.
 *
 * Splice failures cannot travel through the type checker the way other
 * AG-coded diagnostics do: expansion happens before checking, and by the
 * time the checker runs the splices are gone. So they arrive here instead,
 * and this is where they rejoin the ordinary path — same codes, same
 * formatting, same `agency explain` prose.
 */

export function toTypeCheckError(
  found: SpliceDiagnostic,
  file?: string,
): TypeCheckError {
  const error = diagnostic(
    found.diagnostic,
    // SpliceDiagnostic carries plain string params because it crosses
    // module boundaries where the diagnostic name is not statically known.
    found.params as never,
    found.loc,
  );
  return file === undefined ? error : { ...error, file };
}

export function formatSpliceDiagnostic(
  found: SpliceDiagnostic,
  file?: string,
): string {
  return formatErrors([toTypeCheckError(found, file)]);
}
