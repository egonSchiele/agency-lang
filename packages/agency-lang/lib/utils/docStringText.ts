import { AgencyGenerator } from "@/backends/agencyGenerator.js";
import { MultiLineStringLiteral, PromptSegment } from "@/types/literals.js";

/**
 * Apply doc-string trimming to a segment list: strip leading whitespace
 * from the first text segment and trailing whitespace from the last
 * text segment, then drop any empty text segments left behind. This
 * normalizes source like `"""\n  Hello\n  """` to `"Hello"` for the
 * audiences that want clean text (the LLM and human-readable docs),
 * while leaving the underlying AST unchanged so the formatter can
 * round-trip the original source.
 */
export function trimDocStringSegments(
  segments: PromptSegment[],
): PromptSegment[] {
  if (segments.length === 0) return segments;
  const result: PromptSegment[] = segments.map((s) => ({ ...s }));
  if (result[0].type === "text") {
    result[0] = {
      ...result[0],
      type: "text",
      value: result[0].value.replace(/^\s+/, ""),
    };
  }
  const lastIdx = result.length - 1;
  if (result[lastIdx].type === "text") {
    result[lastIdx] = {
      ...result[lastIdx],
      type: "text",
      value: result[lastIdx].value.replace(/\s+$/, ""),
    };
  }
  return result.filter((s) => s.type !== "text" || s.value !== "");
}

/**
 * Render a doc string (a `MultiLineStringLiteral`) back to plain text,
 * reconstructing `${expr}` source form for interpolation segments using
 * the agency generator's expression printer. Leading/trailing
 * indentation is trimmed so the rendered text matches what users
 * expect to see in human-facing doc output.
 *
 * Used by the doc CLI and LSP for human-readable doc output.
 */
export function docStringText(
  docString: MultiLineStringLiteral,
  gen: AgencyGenerator = new AgencyGenerator(),
): string {
  return trimDocStringSegments(docString.segments)
    .map((s) =>
      s.type === "text"
        ? s.value
        : `\${${gen.processNode(s.expression).trim()}}`,
    )
    .join("");
}
