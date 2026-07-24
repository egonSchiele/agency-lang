import { parseCodeLiteralBody } from "../../parsers/parsers.js";
// Side-effect import, load-bearing: program-kind bodies parse through
// the grammar entry point that lib/parser.ts REGISTERS into parsers.ts
// at its module init (the cycle-avoiding injection). Nothing else in
// this file's import graph reaches parser.ts — a generated program with
// a program-kind literal and no std::agency import would otherwise hit
// "program parser not registered" at runtime (review finding).
import "../../parser.js";
import { deepCopy } from "../../utils.js";
import { Code } from "./code.js";

// Literal bodies are compile-time constants, so each (source, kind)
// pair parses once per process — a literal inside a loop must not
// re-parse per iteration. Cached CLONES are returned: fill() mutates
// Code values downstream, and a shared cached object would leak one
// call's renames into the next. Null-prototype: the key embeds user
// source text.
const codeLiteralCache: Record<string, Code> = Object.create(null);

/** Reconstructs a code literal's value at runtime from its canonical
 *  printed body, through the SAME per-kind parse (parseCodeLiteralBody)
 *  the compiler used — the program grammar alone would reject an
 *  expr-kind body, and sharing the entry point is what makes
 *  compile-time and runtime agree by construction. The body was already
 *  validated at compile time; a failure or kind mismatch here means the
 *  two stages parsed differently, which is a bug worth a loud error. */
export function __codeLiteral(source: string, kind: Code["kind"]): Code {
  const cacheKey = `${kind}\u0000${source}`;
  const cached = codeLiteralCache[cacheKey];
  if (cached !== undefined) {
    return deepCopy(cached);
  }
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
  const value: Code = { type: "agencyProgram", kind, nodes: parsed.nodes };
  codeLiteralCache[cacheKey] = value;
  return deepCopy(value);
}
