import { describe, expect, it } from "vitest";
import { mergeTagSets } from "./mergeTags.js";
import type { Tag } from "../types.js";

function ident(name: string): any {
  return { type: "variableName", value: name };
}

function stringLit(s: string): any {
  return { type: "string", segments: [{ type: "text", value: s }] };
}

function obj(entries: Record<string, any>): any {
  return {
    type: "agencyObject",
    entries: Object.entries(entries).map(([key, value]) => ({ key, value })),
  };
}

function tag(name: string, args: any[]): Tag {
  return { type: "tag", name, arguments: args } as Tag;
}

describe("mergeTagSets", () => {
  it("returns undefined when both sides empty", () => {
    expect(mergeTagSets(undefined, undefined)).toBeUndefined();
    expect(mergeTagSets([], [])).toBeUndefined();
  });

  it("returns alias tags verbatim when use-site is empty", () => {
    const aliasTags = [tag("validate", [ident("isEmail")])];
    const merged = mergeTagSets(aliasTags, undefined);
    expect(merged).toHaveLength(1);
    expect(merged?.[0].name).toBe("validate");
    expect(merged?.[0].arguments).toHaveLength(1);
  });

  it("concatenates @validate from alias and use-site", () => {
    const aliasTags = [tag("validate", [ident("isPositive")])];
    const useSiteTags = [tag("validate", [ident("max100")])];
    const merged = mergeTagSets(aliasTags, useSiteTags);
    expect(merged).toHaveLength(1);
    expect(merged?.[0].name).toBe("validate");
    expect(merged?.[0].arguments).toHaveLength(2);
    expect((merged?.[0].arguments[0] as any).value).toBe("isPositive");
    expect((merged?.[0].arguments[1] as any).value).toBe("max100");
  });

  it("merges @jsonSchema with use-site keys overriding alias keys (non-description)", () => {
    const aliasTags = [
      tag("jsonSchema", [
        obj({ minimum: { type: "number", value: "0" }, format: stringLit("alias-fmt") }),
      ]),
    ];
    const useSiteTags = [
      tag("jsonSchema", [obj({ format: stringLit("use-site-fmt") })]),
    ];
    const merged = mergeTagSets(aliasTags, useSiteTags);
    expect(merged).toHaveLength(1);
    const mergedObj = merged?.[0].arguments[0] as any;
    expect(mergedObj.type).toBe("agencyObject");
    const entries = mergedObj.entries as any[];
    const byKey = Object.fromEntries(entries.map((e) => [e.key, e.value]));
    expect(byKey.minimum).toMatchObject({ type: "number", value: "0" });
    expect(byKey.format.segments[0].value).toBe("use-site-fmt");
  });

  it("concatenates @jsonSchema literal `description` fields with newlines", () => {
    const aliasTags = [
      tag("jsonSchema", [
        obj({ description: stringLit("alias desc"), format: stringLit("email") }),
      ]),
    ];
    const useSiteTags = [
      tag("jsonSchema", [obj({ description: stringLit("use-site extra") })]),
    ];
    const merged = mergeTagSets(aliasTags, useSiteTags);
    const entries = (merged?.[0].arguments[0] as any).entries as any[];
    const byKey = Object.fromEntries(entries.map((e) => [e.key, e.value]));
    expect(byKey.description.segments[0].value).toBe(
      "alias desc\nuse-site extra",
    );
    // Other keys still merge with use-site-wins semantics.
    expect(byKey.format.segments[0].value).toBe("email");
    // The merged `description` keeps the first occurrence's slot, so it
    // appears before the format entry.
    expect(entries.map((e) => e.key)).toEqual(["description", "format"]);
  });

  it("falls back to last-write-wins when a description is not a plain literal", () => {
    const aliasTags = [
      tag("jsonSchema", [obj({ description: stringLit("alias desc") })]),
    ];
    // A non-literal description (here: an identifier reference) blocks
    // the concat path; the use-site override wins as before.
    const useSiteTags = [
      tag("jsonSchema", [obj({ description: ident("dynamicDesc") })]),
    ];
    const merged = mergeTagSets(aliasTags, useSiteTags);
    const entries = (merged?.[0].arguments[0] as any).entries as any[];
    const byKey = Object.fromEntries(entries.map((e) => [e.key, e.value]));
    expect(byKey.description).toMatchObject({ type: "variableName", value: "dynamicDesc" });
  });

  it("throws when the same side has multiple @jsonSchema tags", () => {
    const aliasTags = [
      tag("jsonSchema", [obj({ format: stringLit("email") })]),
      tag("jsonSchema", [obj({ description: stringLit("dup") })]),
    ];
    expect(() => mergeTagSets(aliasTags, undefined)).toThrow(
      /Multiple @jsonSchema/,
    );
  });

  it("throws on a malformed @jsonSchema whose argument is not an object literal", () => {
    const aliasTags = [tag("jsonSchema", [stringLit("not an object")])];
    expect(() => mergeTagSets(aliasTags, undefined)).toThrow(/object-literal argument/);
  });

  it("preserves other tag names verbatim", () => {
    const aliasTags = [tag("goal", [stringLit("alias goal")])];
    const useSiteTags = [tag("goal", [stringLit("use goal")])];
    const merged = mergeTagSets(aliasTags, useSiteTags);
    // Other tags are concatenated.
    expect(merged).toHaveLength(2);
    expect(merged?.[0].name).toBe("goal");
    expect(merged?.[1].name).toBe("goal");
  });
});
