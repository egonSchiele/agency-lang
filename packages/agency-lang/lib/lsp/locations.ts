import type { SourceLocation } from "../types/base.js";
import { AGENCY_TEMPLATE_OFFSET } from "../parsers/parsers.js";

// withLoc subtracts this to account for the parser template wrapper when
// parsing with applyTemplate=false. Add it back for editor-facing locations.
export const TEMPLATE_OFFSET = AGENCY_TEMPLATE_OFFSET;

export function toUserSourceLocation(loc?: SourceLocation): SourceLocation | undefined {
  if (!loc) return undefined;
  return {
    ...loc,
    line: loc.line + TEMPLATE_OFFSET,
  };
}
