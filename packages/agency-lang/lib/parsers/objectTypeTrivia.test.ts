import { describe, expect, it } from "vitest";
import { objectTypeParser } from "./parsers.js";

describe("objectTypeParser — trivia (comments + blank lines)", () => {
  it("captures a leading // comment before the first property", () => {
    const src = `{
      // a comment
      name: string,
      age: number
    }`;
    const r = objectTypeParser(src);
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.result.properties).toHaveLength(2);
    expect(r.result.trivia).toEqual([
      {
        anchorIndex: 0,
        comments: [{ type: "comment", content: " a comment" }],
      },
    ]);
  });

  it("captures a comment between two properties", () => {
    const src = `{
      name: string,
      // between
      age: number
    }`;
    const r = objectTypeParser(src);
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.result.trivia).toEqual([
      {
        anchorIndex: 1,
        comments: [{ type: "comment", content: " between" }],
      },
    ]);
  });

  it("captures a trailing comment after the last property", () => {
    const src = `{
      name: string,
      age: number,
      // trailing
    }`;
    const r = objectTypeParser(src);
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.result.trivia).toEqual([
      {
        anchorIndex: 2,
        comments: [{ type: "comment", content: " trailing" }],
      },
    ]);
  });

  it("captures a block comment", () => {
    const src = `{
      /* block leading */
      name: string
    }`;
    const r = objectTypeParser(src);
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.result.trivia).toHaveLength(1);
    expect(r.result.trivia?.[0].anchorIndex).toBe(0);
    expect(r.result.trivia?.[0].comments[0].type).toBe("multiLineComment");
  });

  it("groups consecutive comments under the same anchor in source order", () => {
    const src = `{
      // first
      /* second */
      // third
      name: string
    }`;
    const r = objectTypeParser(src);
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.result.trivia).toHaveLength(1);
    expect(r.result.trivia?.[0].anchorIndex).toBe(0);
    expect(r.result.trivia?.[0].comments).toHaveLength(3);
    expect(r.result.trivia?.[0].comments[0]).toEqual({
      type: "comment",
      content: " first",
    });
    expect(r.result.trivia?.[0].comments[1].type).toBe("multiLineComment");
    expect(r.result.trivia?.[0].comments[2]).toEqual({
      type: "comment",
      content: " third",
    });
  });

  it("preserves consecutive comment kinds without converting syntax", () => {
    const src = `{
      // line
      /* block */
      name: string
    }`;
    const r = objectTypeParser(src);
    expect(r.success).toBe(true);
    if (!r.success) return;
    const cs = r.result.trivia?.[0].comments ?? [];
    expect(cs.map((c) => c.type)).toEqual(["comment", "multiLineComment"]);
  });

  it("omits trivia field entirely when there are no comments or blanks", () => {
    const src = `{ name: string, age: number }`;
    const r = objectTypeParser(src);
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.result.trivia).toBeUndefined();
  });

  it("captures a blank line between properties as NewLine trivia", () => {
    // The blank-line sentinel U+E000 is inserted by the preprocessor that
    // wraps `objectTypeParser` in real use. Inject it directly here so we
    // can test the parser in isolation.
    const SENTINEL = "\uE000";
    const src = `{\n      name: string,\n${SENTINEL}      age: number\n    }`;
    const r = objectTypeParser(src);
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.result.trivia).toHaveLength(1);
    expect(r.result.trivia?.[0].anchorIndex).toBe(1);
    expect(r.result.trivia?.[0].comments[0].type).toBe("newLine");
  });

  it("comments do NOT appear as phantom properties", () => {
    const src = `{
      // c1
      name: string,
      // c2
      age: number,
      // c3
    }`;
    const r = objectTypeParser(src);
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.result.properties).toHaveLength(2);
    expect(r.result.properties.map((p) => p.key)).toEqual(["name", "age"]);
  });

  it("preserves the existing error message when delimiter is missing", () => {
    const src = `{ name: string age: number }`;
    expect(() => objectTypeParser(src)).toThrow(
      /Expected `\}`\. Did you forget to add a comma between object properties\?/,
    );
  });

  it("a comment before a @tag block lives on its own anchor, not the tag", () => {
    const src = `{
      // c
      @validate(isEmail)
      email: string
    }`;
    const r = objectTypeParser(src);
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.result.properties).toHaveLength(1);
    expect(r.result.properties[0].tags).toHaveLength(1);
    expect(r.result.trivia).toEqual([
      { anchorIndex: 0, comments: [{ type: "comment", content: " c" }] },
    ]);
  });
});
