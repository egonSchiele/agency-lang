import { describe, expect, it } from "vitest";
import { decodeStructured, structuredLines } from "./structured.js";
describe("structured answers", () => {
  it("only decodes valid object and array JSON", () => {
    expect(decodeStructured(' {"ok":true} ')).toEqual({ ok: true });
    expect(decodeStructured("[1]")).toEqual([1]);
    for (const text of ['"hello"', "42", "{broken", "plain"]) {
      expect(decodeStructured(text)).toBeUndefined();
    }
  });
  it("puts a flat value on its key's line and nests the rest beneath", () => {
    expect(
      structuredLines({
        response: { code: "def f(): number {\n  return 1\n}", values: [null, "a\nb"], n: 3 },
      }),
    ).toEqual([
      { indent: 0, role: "key", text: "response" },
      { indent: 2, role: "key", text: "code" },
      { indent: 4, role: "text", text: "def f(): number {" },
      { indent: 4, role: "text", text: "  return 1" },
      { indent: 4, role: "text", text: "}" },
      { indent: 2, role: "key", text: "values" },
      { indent: 4, role: "pair", key: "[0]", text: "null" },
      { indent: 4, role: "index", text: "[1]" },
      { indent: 6, role: "text", text: "a" },
      { indent: 6, role: "text", text: "b" },
      { indent: 2, role: "pair", key: "n", text: "3" },
    ]);
    expect(structuredLines({ name: "", tags: [], meta: {}, ids: ["a", 2, null] })).toEqual([
      { indent: 0, role: "pair", key: "name", text: '""' },
      { indent: 0, role: "pair", key: "tags", text: "[]" },
      { indent: 0, role: "pair", key: "meta", text: "{}" },
      { indent: 0, role: "pair", key: "ids", text: '["a",2,null]' },
    ]);
    const long = structuredLines({ paths: Array.from({ length: 12 }, (_, n) => `file-${n}.md`) });
    expect(long[0]).toEqual({ indent: 0, role: "key", text: "paths" });
    expect(long[1]).toEqual({ indent: 2, role: "pair", key: "[0]", text: "file-0.md" });
    expect(structuredLines([])).toEqual([{ indent: 0, role: "scalar", text: "[]" }]);
    expect(structuredLines({})).toEqual([{ indent: 0, role: "scalar", text: "{}" }]);
    expect(structuredLines("done")).toEqual([{ indent: 0, role: "text", text: "done" }]);
  });
  it("turns a list of same-shaped objects into a table", () => {
    const todos = [
      { id: 1, text: "Gather facts", status: "completed" },
      { status: "pending", id: 2, text: "Write it up" },
    ];
    expect(structuredLines({ todos })).toEqual([
      { indent: 0, role: "key", text: "todos" },
      {
        indent: 2,
        role: "table",
        columns: ["id", "text", "status"],
        rows: [
          ["1", "Gather facts", "completed"],
          ["2", "Write it up", "pending"],
        ],
      },
    ]);
  });
  it("keeps a list as items when its objects differ or hold nested values", () => {
    const mixed = structuredLines([{ id: 1 }, { id: 2, extra: true }]);
    expect(mixed.map((line) => line.role)).toEqual(["index", "pair", "index", "pair", "pair"]);
    const nested = structuredLines([
      { id: 1, meta: { a: 1 } },
      { id: 2, meta: { a: 2 } },
    ]);
    expect(nested[0]).toEqual({ indent: 0, role: "index", text: "[0]" });
    const multiline = structuredLines([{ text: "one\ntwo" }, { text: "three" }]);
    expect(multiline[0]).toEqual({ indent: 0, role: "index", text: "[0]" });
    expect(structuredLines([{ id: 1 }]).map((line) => line.role)).toEqual(["index", "pair"]);
  });
});
