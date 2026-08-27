import { exprParser, stringParser } from "@/parsers/parsers.js";
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

/**
 * Escapes every `${...}` in a free-text candidate that is not one of the
 * current value's placeholders. The mutator model is told to send plain
 * text with no escaping, so when the current value contains the literal
 * text `\${...}` (a prompt that describes Agency syntax, say) the model
 * sends it back as a bare `${...}`. A candidate may not add placeholders,
 * so a `${...}` that is not already a placeholder can only be literal text.
 */
export function escapeForeignInterpolations(candidate: string, currentValue: string): string {
  const known = interpolationMultiset(currentValue);
  let out = "";
  let index = 0;
  while (index < candidate.length) {
    const start = candidate.indexOf("${", index);
    if (start === -1) break;
    const end = closingBrace(candidate, start + 2);
    const escaped = start > 0 && candidate[start - 1] === "\\";
    if (end === -1 || escaped) {
      out += candidate.slice(index, start + 2);
      index = start + 2;
      continue;
    }
    const inner = candidate.slice(start + 2, end);
    out +=
      candidate.slice(index, start) +
      (isKnown(inner, known) ? "" : "\\") +
      candidate.slice(start, end + 1);
    index = end + 1;
  }
  return out + candidate.slice(index);
}

/** Index of the `}` that closes an interpolation opened just before `from`, or -1. */
function closingBrace(text: string, from: number): number {
  let depth = 1;
  for (let index = from; index < text.length; index += 1) {
    if (text[index] === "{") depth += 1;
    if (text[index] === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function isKnown(inner: string, known: string[]): boolean {
  if (known.includes(inner.trim())) return true;
  const parsed = exprParser(inner.trim());
  return (
    parsed.success && parsed.rest.trim() === "" && known.includes(expressionToString(parsed.result))
  );
}
