import { describe, it, expect } from "vitest";
import { z } from "zod";

// Pins that the exact schema shape our codegen emits for recursive aliases
// (z.lazy self-reference, per tests/typescriptGenerator/recursiveTypes.mjs)
// survives the JSON-schema conversion the LLM structured-output path uses
// (`z.toJSONSchema` — see lib/runtime/schema.ts and the responseFormat
// conversion in lib/runtime/simpleOpenAIClient.ts), producing a $ref
// instead of throwing or inlining forever. zod is caret-pinned (^4.x); an
// upgrade that changes cycle handling must fail THIS test, not a user
// request.
describe("recursive zod schema to JSON schema", () => {
  it("z.lazy self-reference converts with a $ref and does not throw", () => {
    const Tree: z.ZodType = z.object({
      value: z.number(),
      children: z.array(z.lazy(() => Tree)),
    });
    const json = JSON.stringify(z.toJSONSchema(Tree));
    expect(json).toContain("$ref");
  });

  it("mutual z.lazy cycle converts too (Employee/Manager shape)", () => {
    const Employee: z.ZodType = z.object({
      name: z.string(),
      manager: z.union([z.lazy(() => Manager), z.null()]),
    });
    const Manager: z.ZodType = z.object({
      reports: z.array(Employee),
    });
    // Manager references Employee bare (backward edge) exactly as emitted.
    const json = JSON.stringify(z.toJSONSchema(Manager));
    expect(json).toContain("$ref");
  });
});
