import { typeCheckSource } from "../compiler/typecheck.js";
import type { AgencyConfig } from "../config/config.js";

/** The errors `source` reports under `code`. The cast test files build their
 *  own helpers from this one so neither keeps a second copy. */
export function errorsWithCode(source: string, code: string, config: AgencyConfig = {}) {
  return typeCheckSource(source, undefined, config).errors.filter(
    (error) => (error as { code?: string }).code === code,
  );
}

/** Every diagnostic code `source` reports, in order. */
export function allCodes(source: string, config: AgencyConfig = {}): string[] {
  return typeCheckSource(source, undefined, config).errors.map(
    (error) => (error as { code?: string }).code ?? "",
  );
}
