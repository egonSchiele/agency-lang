import { diagnostic } from "../../typeChecker/diagnostics.js";
import { formatErrors } from "../../typeChecker/index.js";
import type { TypeCheckError } from "../../typeChecker/types.js";
import type { SpliceDiagnostic } from "./types.js";

/**
 * Turn a splice failure into the shape the rest of the compiler reports.
 *
 * Splice failures cannot travel through the type checker: expansion runs
 * before checking, and the splices are gone by the time the checker sees
 * the program. They rejoin the ordinary path here, keeping the same codes,
 * formatting, and `agency explain` prose.
 */

export function toTypeCheckError(found: SpliceDiagnostic, file?: string): TypeCheckError {
  const error = diagnostic(
    found.diagnostic,
    // SpliceDiagnostic carries plain string params, because the diagnostic
    // name is not statically known where these are built.
    found.params as never,
    found.loc,
  );
  return file === undefined ? error : { ...error, file };
}

export function formatSpliceDiagnostic(found: SpliceDiagnostic, file?: string): string {
  return formatErrors([toTypeCheckError(found, file)]);
}
