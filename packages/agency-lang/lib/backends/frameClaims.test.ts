import { describe, it, expect } from "vitest";
import { parseAgency } from "../parser.js";
import { generateTypeScript } from "./typescriptGenerator.js";

/** The tripwire only works if generated code actually claims frames. A
 *  no-op wiring would pass every claimFrameForScope unit test (they call
 *  the function directly), so this pins the emission itself: function
 *  and node preambles, and lifted-block setup, each claim their frame
 *  under their own scope name. */
describe("generated code claims frames for the resume tripwire", () => {
  function compile(src: string): string {
    const parsed = parseAgency(src, {}, false);
    if (!parsed.success) throw new Error(parsed.message);
    return generateTypeScript(parsed.result, undefined, undefined, "claims.agency");
  }

  it("function and node preambles claim their frames", () => {
    const out = compile(`
def helper(): string {
  return "h"
}

node main() {
  const h = helper()
  return h
}
`);
    expect(out).toContain('claimFrameForScope(__stack, "helper")');
    expect(out).toContain('claimFrameForScope(__stack, "main")');
  });

  it("lifted block bodies claim their frames under the block name", () => {
    const out = compile(`
def scale(x: number): number {
  return x + 1
}

def f(xs: number[]): number[] {
  return [scale(x) for x in xs]
}
`);
    expect(out).toMatch(/claimFrameForScope\(__bstack, "__block_\d+"\)/);
  });

  it("finalize closures do NOT claim (they run on the container frame)", () => {
    const out = compile(`
def work(): string {
  return "done"

  finalize {
    return "salvaged"
  }
}
`);
    // Exactly one claim: work's own preamble. The finalize closure runs
    // on work's frame and must not stamp a second name onto it.
    const claims = out.match(/claimFrameForScope\(/g) ?? [];
    expect(claims).toHaveLength(1);
    expect(out).toContain('claimFrameForScope(__stack, "work")');
  });
});
