import { describe, expect, it } from "vitest";
import { z } from "zod";
import { __paramSchema } from "./paramSchema.js";

function tool(shape: Record<string, z.ZodType>) {
  return z.toJSONSchema(z.object(shape)) as {
    properties: Record<string, Record<string, unknown>>;
    required?: string[];
  };
}

describe("__paramSchema", () => {
  it("puts the @param text on a required argument and keeps it required", () => {
    const schema = tool({ path: __paramSchema(z.string(), "File to read", null, false) });
    expect(schema.properties.path).toEqual({ type: "string", description: "File to read" });
    expect(schema.required).toEqual(["path"]);
  });

  it("makes an argument with a default optional, and still accepts null", () => {
    const limit = __paramSchema(z.number(), "Lines to return", "0", true);
    const schema = tool({ path: z.string(), limit });
    expect(schema.required).toEqual(["path"]);
    expect(schema.properties.limit.description).toBe("Lines to return. Default: 0");
    const object = z.object({ path: z.string(), limit });
    expect(object.safeParse({ path: "a" }).success).toBe(true);
    expect(object.safeParse({ path: "a", limit: null }).success).toBe(true);
    expect(object.safeParse({ path: "a", limit: "x" }).success).toBe(false);
  });

  it("gives a default with no @param text only the default", () => {
    const schema = tool({ dir: __paramSchema(z.string(), null, '"."', true) });
    expect(schema.properties.dir.description).toBe('Default: "."');
  });

  it("writes a @jsonSchema description once when the argument has a default", () => {
    const tagged = z.number().meta({ description: "Whole seconds", minimum: 1 });
    const schema = tool({ wait: __paramSchema(tagged, "How long to wait.", "5", true) });
    const text = JSON.stringify(schema.properties.wait);
    expect(text.match(/Whole seconds/g)).toHaveLength(1);
    expect(schema.properties.wait.description).toBe("How long to wait.\nWhole seconds. Default: 5");
    expect(text).toContain('"minimum":1');
  });

  it("joins the @param text with a @jsonSchema description and keeps other metadata", () => {
    const tagged = z.number().meta({ description: "Whole seconds", minimum: 1 });
    const schema = tool({ wait: __paramSchema(tagged, "How long to wait.", null, false) });
    expect(schema.properties.wait).toMatchObject({
      description: "How long to wait.\nWhole seconds",
      minimum: 1,
    });
  });

  // A learned tool's schema is rebuilt from JSON Schema in the parent
  // process and compared with the original as text.
  it("writes a schema that reads the same after a JSON Schema round trip", () => {
    const object = z.object({
      path: __paramSchema(z.string(), "File to read", null, false),
      limit: __paramSchema(z.number(), "Lines to return", "0", true),
    });
    const first = z.toJSONSchema(object);
    const again = z.toJSONSchema(z.fromJSONSchema(first as Parameters<typeof z.fromJSONSchema>[0]));
    expect(JSON.stringify(again)).toBe(JSON.stringify(first));
  });

  it("does not add null to a type that already allows it", () => {
    const schema = tool({
      note: __paramSchema(z.union([z.string(), z.null()]), null, "null", false),
    });
    expect(JSON.stringify(schema.properties.note).match(/"null"/g)).toHaveLength(1);
    expect(schema.required ?? []).toEqual([]);
  });
});
