import { stringParser } from "@/parsers/parsers.js";
import type { PromptSegment } from "@/types.js";
import { expressionToString } from "@/utils/node.js";

import type { ValidationResult } from "./types.js";

/**
 * Wraps decoded prompt text (the `OptimizeTarget.value` representation, see
 * `promptSegmentsToString`) in a `"..."` Agency string literal. The text
 * already carries `\${` and `\"""` as escapes: `\${` stays an escape,
 * `\"""` becomes three escaped quotes, and every other backslash, quote,
 * and newline is escaped so the literal parses back to the same text.
 * JSON escaping is not the same thing: it doubles the backslash in `\${`,
 * which the Agency parser then reads as a backslash followed by a live
 * interpolation.
 */
export function decodedValueToStringLiteral(value: string): string {
  const escaped = value
    .split('\\"""')
    .join('"""')
    .replace(/\\(?!\$\{)/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n");
  return `"${escaped}"`;
}

/** Parses decoded prompt text (no surrounding quotes) into prompt segments. */
export function parsePromptToSegments(prompt: string): PromptSegment[] {
  const parsed = stringParser(decodedValueToStringLiteral(prompt));
  if (!parsed.success || parsed.rest.length > 0) {
    throw new Error("Failed to parse prompt as an Agency string literal");
  }
  return parsed.result.segments;
}

export function validateMutationPrompt(
  currentPrompt: string,
  proposedPrompt: string,
): ValidationResult {
  return validateOptimizedStringValue(currentPrompt, proposedPrompt);
}

/**
 * Validates a replacement value for an optimized string declaration: the
 * replacement must be non-empty and preserve the multiset of `${...}`
 * interpolation placeholders, compared by canonical rendered expression.
 */
export function validateOptimizedStringValue(
  currentValue: string,
  proposedValue: string,
): ValidationResult {
  if (proposedValue.length === 0) {
    return { ok: false, reason: "prompt is empty" };
  }

  try {
    const current = interpolationMultiset(currentValue);
    const proposed = interpolationMultiset(proposedValue);
    if (current.length !== proposed.length) {
      return { ok: false, reason: interpolationCountReason(current, proposed) };
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
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

function interpolationMultiset(prompt: string): string[] {
  return parsePromptToSegments(prompt)
    .filter((segment) => segment.type === "interpolation")
    .map((segment) => expressionToString(segment.expression))
    .sort();
}

function interpolationCountReason(current: string[], proposed: string[]): string {
  if (proposed.length < current.length) {
    return `you removed ${removedExpression(current, proposed)} from the prompt`;
  }
  return "you added an interpolation to the prompt";
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
