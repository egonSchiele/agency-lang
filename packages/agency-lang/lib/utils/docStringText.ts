import { AgencyGenerator } from "@/backends/agencyGenerator.js";
import { MultiLineStringLiteral } from "@/types/literals.js";

/**
 * Render a doc string (a `MultiLineStringLiteral`) back to plain text,
 * reconstructing `${expr}` source form for interpolation segments using
 * the agency generator's expression printer.
 *
 * Used by the doc CLI and LSP for human-readable doc output.
 */
export function docStringText(
  docString: MultiLineStringLiteral,
  gen: AgencyGenerator = new AgencyGenerator(),
): string {
  return docString.segments
    .map((s) =>
      s.type === "text"
        ? s.value
        : `\${${gen.processNode(s.expression).trim()}}`,
    )
    .join("");
}
