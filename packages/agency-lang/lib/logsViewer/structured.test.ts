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
  it("prints fields, indices, real lines and scalar values", () => {
    expect(
      structuredLines({
        response: { code: "def f(): number {\n  return 1\n}", values: [null, true] },
      }),
    ).toEqual([
      { indent: 0, role: "key", text: "response" },
      { indent: 2, role: "key", text: "code" },
      { indent: 4, role: "text", text: "def f(): number {" },
      { indent: 4, role: "text", text: "  return 1" },
      { indent: 4, role: "text", text: "}" },
      { indent: 2, role: "key", text: "values" },
      { indent: 4, role: "index", text: "[0]" },
      { indent: 6, role: "scalar", text: "null" },
      { indent: 4, role: "index", text: "[1]" },
      { indent: 6, role: "scalar", text: "true" },
    ]);
    expect(structuredLines([])).toEqual([{ indent: 0, role: "scalar", text: "[]" }]);
    expect(structuredLines({})).toEqual([{ indent: 0, role: "scalar", text: "{}" }]);
  });
});
