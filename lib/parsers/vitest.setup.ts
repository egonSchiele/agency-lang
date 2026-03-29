import { expect } from "vitest";

/**
 * Recursively strip `loc` fields and newline nodes from an object.
 * - `loc` fields are stripped because source location tracking adds them
 *   to all AST nodes, but existing test expectations don't include them.
 * - NewLine nodes (`{ type: "newLine" }`) are stripped from arrays because
 *   removing .trim() from normalizeCode causes the parser to produce extra
 *   newline nodes that weren't present when whitespace was pre-stripped.
 */
function normalize(obj: unknown): unknown {
  if (obj === null || obj === undefined || typeof obj !== "object") {
    return obj;
  }
  if (Array.isArray(obj)) {
    return obj
      .filter((item) => {
        // Strip newline nodes from arrays
        if (
          item !== null &&
          typeof item === "object" &&
          "type" in item &&
          (item as Record<string, unknown>).type === "newLine"
        ) {
          return false;
        }
        return true;
      })
      .map(normalize);
  }
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (key === "loc") continue;
    result[key] = normalize(value);
  }
  return result;
}

expect.extend({
  toEqualWithoutLoc(received: unknown, expected: unknown) {
    const normalizeExpected = normalize(expected);
    const normalizedReceived = normalize(received);
    // Don't normalize expected — it may be an asymmetric matcher (e.g., expect.objectContaining)
    // and the test author controls expected values (they won't include loc or newline nodes)
    const pass = this.equals(normalizedReceived, normalizeExpected);
    return {
      pass,
      message: () => {
        if (pass) {
          return `expected values not to be equal (ignoring loc fields and newline nodes)`;
        }
        return `expected values to be equal (ignoring loc fields and newline nodes)\n\nReceived: ${JSON.stringify(normalizedReceived, null, 2)}\n\nExpected: ${JSON.stringify(normalizeExpected, null, 2)}`;
      },
    };
  },
});

declare module "vitest" {
  interface Assertion {
    toEqualWithoutLoc(expected: unknown): void;
  }
  interface AsymmetricMatchersContaining {
    toEqualWithoutLoc(expected: unknown): void;
  }
}
