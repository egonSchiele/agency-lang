/**
 * Integration-style tests for the `@jsonSchema(...)` annotation.
 *
 * Strategy: compile a small Agency program with the type-validation
 * annotations, then load the generated TS module dynamically and inspect
 * the Zod schema attached to the alias (`Foo.meta()` / `z.toJSONSchema(Foo)`).
 * This is the closest thing we have to an end-to-end test, since Zod's
 * `.meta(...)` semantics matter only at runtime.
 *
 * If the generated module can't be loaded for whatever reason, we still
 * check the textual form of the emitted code so future regressions show
 * up either way.
 */
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { generateWithBuilder } from "../typescriptBuilder.integration.test.js";
import { pathToFileURL } from "node:url";
import { z } from "zod";

/**
 * Compile `agencySource`, write the generated TS to a temporary `.ts`
 * file inside the agency-lang package (so vite can transform it and the
 * relative `agency-lang/...` imports resolve), and dynamically import
 * it. Returns the resolved module namespace plus a cleanup function.
 */
async function compileAndImport(
  agencySource: string,
): Promise<{ mod: any; cleanup: () => void }> {
  const generated = generateWithBuilder(agencySource);
  const dir = path.resolve(__dirname, "../../../.agency-tmp");
  fs.mkdirSync(dir, { recursive: true });
  const id = `jsonschema-test-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const file = path.join(dir, `${id}.ts`);
  fs.writeFileSync(file, generated);
  // Use the file:// URL so the vite-node loader picks it up correctly.
  const mod = await import(pathToFileURL(file).href);
  return {
    mod,
    cleanup: () => {
      try {
        fs.unlinkSync(file);
      } catch {
        /* best-effort */
      }
    },
  };
}

describe("@jsonSchema annotation", () => {
  it("attaches metadata to a simple type alias", async () => {
    const src = `
@jsonSchema({ description: "User-facing email address.", format: "email" })
export type Email = string
`;
    const ts = generateWithBuilder(src);
    // Textual check first — cheap and stable.
    expect(ts).toContain(".meta(");
    expect(ts).toMatch(/description:\s*"User-facing email address\."/);
    expect(ts).toMatch(/format:\s*"email"/);
  });

  it("emits .meta(...) at runtime on the generated Zod schema", async () => {
    const src = `
@jsonSchema({ description: "Friendly email.", format: "email" })
export type Email = string
`;
    const { mod, cleanup } = await compileAndImport(src);
    try {
      const Email = mod.Email as z.ZodType;
      expect(Email).toBeDefined();
      // Zod v4 stores metadata on the schema via .meta(); retrieve it via the
      // public `meta()` accessor or by calling toJSONSchema.
      const meta = (Email as any).meta?.() ?? {};
      expect(meta).toMatchObject({
        description: "Friendly email.",
        format: "email",
      });
      // toJSONSchema picks up .meta() and merges it into the schema output.
      const jsonSchema = z.toJSONSchema(Email) as Record<string, unknown>;
      expect(jsonSchema.description).toBe("Friendly email.");
      expect(jsonSchema.format).toBe("email");
    } finally {
      cleanup();
    }
  });

  it("merges alias-level and use-site @jsonSchema with use-site keys winning", async () => {
    const src = `
@jsonSchema({ description: "Alias-level description.", format: "email" })
type Email = string

type User = {
  @jsonSchema({ description: "Use-site description." })
  email: Email
}
`;
    const ts = generateWithBuilder(src);
    // The use-site description should win for the property's schema.
    expect(ts).toMatch(/description:\s*"Use-site description\."/);
    // The alias-level format must still propagate since the use-site did not
    // override it.
    expect(ts).toMatch(/format:\s*"email"/);
  });
});
