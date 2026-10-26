import { describe, it, expect } from "vitest";
import { parseAgency } from "../parser.js";
import { generateTypeScript } from "./typescriptGenerator.js";

// Whole-pipeline checks for the destructive flips (#1278). Each program puts
// a destructive call in a body that is compiled some way other than a plain
// stepped statement list, and must still compile with a flip for that call.

const FLIP = "__activation.__destructiveRan = true";

const PRELUDE = `destructive def burn(): number {
  return 1
}

def run(block: () -> any): any {
  return block()
}
`;

function gen(src: string): string {
  const r = parseAgency(PRELUDE + src, {}, false);
  if (!r.success) throw new Error("parse failed: " + r.message);
  return generateTypeScript(r.result, undefined, undefined, "test.agency");
}

describe("destructive flips in unusual bodies", () => {
  it("a destructive call in a finalize inside a block argument", () => {
    const out = gen(`
def f(): number {
  run() {
    const n = 1
    return n

    finalize {
      burn()
    }
  }
  return 1
}

node main() {
  return f()
}
`);
    expect(out).toContain(FLIP);
  });

  it("an if inside a handle inside an inline handler body", () => {
    // The handler body compiles to plain JS, and so does the if inside the
    // nested handle: the if's statements need flips of their own.
    const out = gen(`
def g(c: boolean): number {
  handle {
    return interrupt("go?")
  } with (intr) {
    handle {
      if (c) {
        const r = burn()
      }
    } with approve
    return approve()
  }
  return 2
}

node main() {
  return g(true)
}
`);
    expect(out).toContain(FLIP);
  });

  it("a destructive call on the right of && in an else-if condition", () => {
    // Hoisting leaves a short-circuit right side in place, and codegen
    // flattens the else-if into its parent, so the parent owns the call.
    const out = gen(`
def h(a: boolean): number {
  if (a) {
    return 1
  } else if (a == false && burn() > 0) {
    return 2
  }
  return 3
}

node main() {
  return h(false)
}
`);
    expect(out).toContain(FLIP);
  });
});
