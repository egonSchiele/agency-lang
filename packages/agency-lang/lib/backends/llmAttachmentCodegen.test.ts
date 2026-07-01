import { describe, it, expect } from "vitest";
import { parseAgency } from "../parser.js";
import { generateTypeScript } from "./typescriptGenerator.js";

function gen(src: string): string {
  const r = parseAgency(src, {}, false);
  if (!r.success) throw new Error("parse failed: " + r.message);
  return generateTypeScript(r.result, undefined, undefined, "test.agency");
}

describe("llm() multimodal codegen", () => {
  it("passes an array first-arg through to runPrompt as an array literal", () => {
    const out = gen(
      `import { image, file } from "std::thread"\n` +
        `node main() {\n const r = llm(["hi", image("x"), file("y")])\n print(r)\n}`,
    );
    // The prompt argument is compiled to an array literal, not a bare string.
    expect(out).toMatch(/prompt:\s*\[/);
    // The image()/file() builder calls survive inside the array.
    expect(out).toContain("__call(image");
    expect(out).toContain("__call(file");
  });

  it("still compiles a plain-string prompt unchanged", () => {
    const out = gen(`node main() {\n const r = llm("hi")\n print(r)\n}`);
    expect(out).toMatch(/prompt:\s*`hi`/);
  });
});
