import { expressionToString } from "@/utils/node.js";

import { parsePromptToSegments } from "./ast.js";
import type { ValidationResult } from "./types.js";

export function validateMutationPrompt(
  currentPrompt: string,
  proposedPrompt: string,
): ValidationResult {
  if (proposedPrompt.length === 0) {
    return { ok: false, reason: "prompt is empty" };
  }

  try {
    const current = interpolationMultiset(currentPrompt);
    const proposed = interpolationMultiset(proposedPrompt);
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
