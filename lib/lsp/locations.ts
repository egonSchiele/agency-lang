import type { SourceLocation } from "../types/base.js";

// withLoc subtracts this to account for the parser template wrapper when
// parsing with applyTemplate=false. Add it back for editor-facing locations.
export const TEMPLATE_OFFSET = 3;

export function toUserSourceLocation(loc?: SourceLocation): SourceLocation | undefined {
  if (!loc) return undefined;
  return {
    ...loc,
    line: loc.line + TEMPLATE_OFFSET,
  };
}
