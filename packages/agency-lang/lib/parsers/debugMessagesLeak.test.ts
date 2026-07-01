import { describe, it, expect } from "vitest";
import { getDebugMessages } from "tarsec";
import { parseAgency } from "../parser.js";

/**
 * Regression test for the `agency test` OOM (parent process grew to ~4GB).
 *
 * Root cause: `_bodyNodeParser` wrapped `typeAliasParser` in tarsec's
 * `debug(...)`, which appends a source-capturing record to tarsec's
 * module-global `debugMessages` array on every FAILED parse. That array is
 * never cleared, and `typeAliasParser` fails constantly during normal
 * backtracking, so a long-lived compiling process (the `agency test`
 * runner compiles every fixture in one process) accumulated the array
 * without bound until it exhausted the heap.
 *
 * The parser must not append to that global buffer during normal parsing.
 */
describe("parser does not accumulate tarsec debugMessages (OOM regression)", () => {
  it("repeated parses do not grow the global debugMessages buffer", () => {
    // A program that exercises the body-node alternatives (so the removed
    // `debug(typeAliasParser)` alternative would have fired on failure).
    const src = `node main() {\n  const x = 1\n  print(x)\n}\n`;

    // Prime once so any one-time module setup is already accounted for.
    parseAgency(src, {}, false);
    const before = getDebugMessages().length;

    for (let i = 0; i < 25; i++) {
      parseAgency(src, {}, false);
    }

    const after = getDebugMessages().length;
    expect(after).toBe(before);
  });
});
