import { describe, it, expect } from "vitest";
import { parseAgency } from "../parser.js";
import { generateTypeScript } from "./typescriptGenerator.js";

function gen(src: string): string {
  const r = parseAgency(src, {}, false);
  if (!r.success) throw new Error("parse failed: " + r.message);
  return generateTypeScript(r.result, undefined, undefined, "test.agency");
}

describe("finalize binder codegen", () => {
  it("the closure takes the binder as a bare parameter", () => {
    const out = gen(
      'def f(): string {\n  return "x"\n  finalize as draft {\n    if (draft != null) { return draft }\n    return "none"\n  }\n}\nnode main() { return f() }\n',
    );
    expect(out).toContain("const __finalize = async (draft: any): Promise<any>");
    // The body must reference the parameter BARE, not a frame local —
    // that is the whole trick (handler-param precedent).
    expect(out).not.toContain("__stack.locals.draft");
  });

  it("an annotated binder carries its TS annotation (handler-param convention)", () => {
    const out = gen(
      'def f(): string {\n  return "x"\n  finalize as draft: string {\n    return "none"\n  }\n}\nnode main() { return f() }\n',
    );
    expect(out).toContain(
      "const __finalize = async (draft: string | null): Promise<any>",
    );
  });

  it("binder-less output is byte-identical to the old form", () => {
    const out = gen(
      'def f(): string {\n  return "x"\n  finalize {\n    return "y"\n  }\n}\nnode main() { return f() }\n',
    );
    expect(out).toContain("const __finalize = async (): Promise<any>");
  });
});
