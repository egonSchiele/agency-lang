import { expect } from "vitest";

function stripLoc(obj: unknown): unknown {
  if (obj === null || obj === undefined || typeof obj !== "object") {
    return obj;
  }
  if (Array.isArray(obj)) {
    return obj.map(stripLoc);
  }
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (key === "loc") continue;
    result[key] = stripLoc(value);
  }
  return result;
}

expect.extend({
  toEqualWithoutLoc(received: unknown, expected: unknown) {
    const strippedReceived = stripLoc(received);
    // Don't strip expected — it may be an asymmetric matcher (e.g., expect.objectContaining)
    // and the test author controls expected values (they won't include loc)
    const pass = this.equals(strippedReceived, expected);
    return {
      pass,
      message: () => {
        if (pass) {
          return `expected values not to be equal (ignoring loc fields)`;
        }
        return `expected values to be equal (ignoring loc fields)\n\nReceived: ${JSON.stringify(strippedReceived, null, 2)}\n\nExpected: ${JSON.stringify(expected, null, 2)}`;
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
