import { generateExpression } from "@/backends/agencyGenerator.js";
import { interpolationSegmentParser } from "@/parsers/parsers.js";
import type { PromptSegment } from "@/types.js";

import type { ValidationResult } from "./types.js";

/**
 * The interpolations in a string literal's segments, as source text
 * (`generateExpression` keeps string quotes, so `format("x")` and
 * `format(x)` stay distinct), sorted so two lists compare as multisets.
 */
export function interpolationsOf(segments: PromptSegment[]): string[] {
  return segments
    .filter((segment) => segment.type === "interpolation")
    .map((segment) => generateExpression(segment.expression))
    .sort();
}

/**
 * Reads the plain text a mutator model returns for a free-text target.
 * Every `${...}` in the text is an interpolation; there is no way to write
 * a literal `${` in a replacement, and discovery warns when a target's
 * text contains one. Everything else, including quotes, backslashes, and
 * newlines, is text.
 */
export function parseReplacementText(
  text: string,
): { ok: true; segments: PromptSegment[] } | { ok: false; reason: string } {
  if (text.length === 0) {
    return { ok: false, reason: "the replacement is empty" };
  }
  const segments: PromptSegment[] = [];
  let rest = text;
  while (rest.length > 0) {
    const start = rest.indexOf("${");
    if (start === -1) {
      segments.push({ type: "text", value: rest });
      break;
    }
    if (start > 0) {
      segments.push({ type: "text", value: rest.slice(0, start) });
    }
    const parsed = interpolationSegmentParser(rest.slice(start));
    if (!parsed.success) {
      return {
        ok: false,
        reason:
          "a ${...} in the text does not hold an Agency expression. Every ${...} is an interpolation placeholder; if you meant the placeholder, copy it exactly as the current value has it.",
      };
    }
    segments.push(parsed.result);
    rest = parsed.rest;
  }
  return { ok: true, segments };
}

/**
 * A replacement must keep the target's interpolations: the same
 * placeholders, the same number of times, and no new ones.
 */
export function compareInterpolations(current: string[], proposed: string[]): ValidationResult {
  if (proposed.length > current.length) {
    return { ok: false, reason: "you added an interpolation to the prompt" };
  }
  if (proposed.length < current.length) {
    return {
      ok: false,
      reason: `you removed ${removedExpression(current, proposed)} from the prompt`,
    };
  }
  for (let index = 0; index < current.length; index += 1) {
    if (current[index] !== proposed[index]) {
      return {
        ok: false,
        reason: `interpolations changed: expected ${current.join(", ")}, got ${proposed.join(", ")}`,
      };
    }
  }
  return { ok: true };
}

function removedExpression(current: string[], proposed: string[]): string {
  const remaining = [...proposed];
  for (const expression of current) {
    const index = remaining.indexOf(expression);
    if (index === -1) return `\${${expression}}`;
    remaining.splice(index, 1);
  }
  return "an interpolation";
}
