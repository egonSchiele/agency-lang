import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_TOOL_SCHEMA_CHARS,
  findOversizedTools,
  oversizedToolMessage,
  toolSchemaChars,
} from "./toolSchemaSize.js";

/** A tool whose schema serializes to roughly `chars` characters. */
function toolOfSize(name: string, chars: number) {
  const filler = "x".repeat(Math.max(chars - 20, 1));
  return { name, schema: { toJSONSchema: () => ({ filler }) } };
}

describe("toolSchemaChars", () => {
  it("measures the serialized JSON Schema", () => {
    const tool = { name: "t", schema: { toJSONSchema: () => ({ a: 1 }) } };
    expect(toolSchemaChars(tool)).toBe(JSON.stringify({ a: 1 }).length);
  });

  it("returns null when the tool has no schema", () => {
    expect(toolSchemaChars({ name: "t" })).toBeNull();
    expect(toolSchemaChars({ name: "t", schema: null })).toBeNull();
  });

  it("returns null instead of throwing when the schema cannot serialize", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const tool = { name: "t", schema: { toJSONSchema: () => cyclic } };
    expect(toolSchemaChars(tool)).toBeNull();
  });

  it("returns null instead of throwing when toJSONSchema throws", () => {
    const tool = {
      name: "t",
      schema: {
        toJSONSchema: () => {
          throw new Error("nope");
        },
      },
    };
    expect(toolSchemaChars(tool)).toBeNull();
  });
});

describe("findOversizedTools", () => {
  it("flags only tools over the threshold", () => {
    const tools = [toolOfSize("small", 100), toolOfSize("big", 5000)];
    const found = findOversizedTools(tools, 2000);
    expect(found.map((t) => t.name)).toEqual(["big"]);
  });

  it("is exclusive at the threshold", () => {
    // A tool exactly at the limit is within budget, so it must not warn.
    const exact = { name: "exact", schema: { toJSONSchema: () => "ab" } };
    const chars = toolSchemaChars(exact)!;
    expect(findOversizedTools([exact], chars)).toEqual([]);
    expect(findOversizedTools([exact], chars - 1)).toHaveLength(1);
  });

  it("sorts the worst offender first", () => {
    const tools = [toolOfSize("medium", 3000), toolOfSize("worst", 20000), toolOfSize("fine", 50)];
    expect(findOversizedTools(tools, 2000).map((t) => t.name)).toEqual(["worst", "medium"]);
  });

  it("treats a threshold of 0 as disabled", () => {
    expect(findOversizedTools([toolOfSize("big", 50000)], 0)).toEqual([]);
    expect(findOversizedTools([toolOfSize("big", 50000)], -1)).toEqual([]);
  });

  it("skips unmeasurable tools rather than flagging them", () => {
    expect(findOversizedTools([{ name: "opaque" }], 10)).toEqual([]);
  });

  it("names a tool that has no name", () => {
    const found = findOversizedTools([toolOfSize(undefined as never, 5000)], 100);
    expect(found[0].name).toBe("(unnamed)");
  });
});

describe("oversizedToolMessage", () => {
  it("names the tool, its size, the threshold, and the config key", () => {
    const msg = oversizedToolMessage({ name: "highlight", chars: 17775 }, 2000);
    expect(msg).toContain("highlight");
    expect(msg).toContain("17775");
    expect(msg).toContain("2000");
    expect(msg).toContain("maxToolSchemaChars");
  });
});

describe("the default threshold", () => {
  it("leaves room above a normal tool but catches a bloated one", () => {
    // Measured against the stdlib at the time this was written: the largest
    // well-formed tool schema was ~1,100 chars, and `syntax::highlight` with
    // an open theme object was ~17,800.
    expect(findOversizedTools([toolOfSize("normal", 1100)], DEFAULT_MAX_TOOL_SCHEMA_CHARS)).toEqual(
      [],
    );
    expect(
      findOversizedTools([toolOfSize("bloated", 17800)], DEFAULT_MAX_TOOL_SCHEMA_CHARS),
    ).toHaveLength(1);
  });
});
