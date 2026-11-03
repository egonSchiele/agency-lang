import { describe, it, expect } from "vitest";
import { parseAgency } from "../parser.js";
import { generateTypeScript } from "./typescriptGenerator.js";

function gen(src: string): string {
  const r = parseAgency(src, {}, false);
  if (!r.success) throw new Error("parse failed: " + r.message);
  return generateTypeScript(r.result, undefined, undefined, "test.agency");
}

// A workflow LLM step declares its reply through an alias
// (`type Step_x_output = string`), so an alias of `string` must compile
// the way `string` does: no response format, so the reply is the model's
// text and not the JSON text `{"response": "..."}`.
describe("llm() response format for a type alias", () => {
  it("gives a plain string reply no response format", () => {
    const out = gen('node main() {\n  const reply: string = llm("hi")\n  return reply\n}\n');
    expect(out).not.toContain("responseFormat");
  });

  it("gives an alias of string no response format", () => {
    const out = gen(
      'type Reply = string\nnode main() {\n  const reply: Reply = llm("hi")\n  return reply\n}\n',
    );
    expect(out).not.toContain("responseFormat");
  });

  it("follows an alias of an alias of string", () => {
    const out = gen(
      'type Text = string\ntype Reply = Text\nnode main() {\n  const reply: Reply = llm("hi")\n  return reply\n}\n',
    );
    expect(out).not.toContain("responseFormat");
  });

  it("keeps the response format for an alias of an object type", () => {
    const out = gen(
      'type Reply = { title: string }\nnode main() {\n  const reply: Reply = llm("hi")\n  return reply\n}\n',
    );
    expect(out).toMatch(/responseFormat: z\.object\(\{\s*response: Reply/);
  });

  it("keeps the response format for an alias of number", () => {
    const out = gen(
      'type Count = number\nnode main() {\n  const reply: Count = llm("hi")\n  return reply\n}\n',
    );
    expect(out).toMatch(/responseFormat: z\.object\(\{\s*response: Count/);
  });
});
