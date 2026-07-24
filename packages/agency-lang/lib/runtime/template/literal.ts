import { parseCodeLiteralBody } from "../../parsers/parsers.js";
import { Code } from "./code.js";

/** Reconstructs a code literal's value at runtime from its canonical
 *  printed body, through the SAME per-kind parse (parseCodeLiteralBody)
 *  the compiler used — the program grammar alone would reject an
 *  expr-kind body, and sharing the entry point is what makes
 *  compile-time and runtime agree by construction. The body was already
 *  validated at compile time; a failure or kind mismatch here means the
 *  two stages parsed differently, which is a bug worth a loud error. */
export function __codeLiteral(source: string, kind: Code["kind"]): Code {
  const parsed = parseCodeLiteralBody(source);
  if (!parsed.ok) {
    throw new Error(
      `internal: a code literal that parsed at compile time failed to re-parse at runtime: ${parsed.error}`,
    );
  }
  if (parsed.kind !== kind) {
    throw new Error(
      `internal: a code literal's kind changed between compile time (${kind}) and runtime (${parsed.kind})`,
    );
  }
  return { type: "agencyProgram", kind, nodes: parsed.nodes };
}
