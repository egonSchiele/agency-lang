import { describe, expect, it } from "vitest";
import { PromptSegment } from "@/types/literals.js";
import { liftParamDocs } from "./docStringParams.js";

const text = (value: string): PromptSegment => ({ type: "text", value });
const hole = { type: "interpolation", expression: { type: "variableName", value: "X" } };

describe("liftParamDocs", () => {
  it("moves each named @param entry out of the text, continuation lines included", () => {
    const doc = [
      "Read a file.",
      "",
      "  @param filename - Path inside dir.",
      "  @param limit - Lines to return,",
      "    0 for the default.",
      "  @param ghost - Not a parameter.",
      "  @returns the text",
    ].join("\n");
    const lifted = liftParamDocs([text(doc)], ["filename", "limit", "dir"]);
    expect(lifted.params).toEqual({
      filename: "Path inside dir.",
      limit: "Lines to return, 0 for the default.",
    });
    expect((lifted.segments[0] as { value: string }).value).toBe(
      "Read a file.\n\n  @param ghost - Not a parameter.\n  @returns the text",
    );
  });

  it("leaves an entry that touches an interpolation where it is", () => {
    const segments = [
      text("Run it.\n  @param a - plain\n  @param b - up to "),
      hole as unknown as PromptSegment,
      text(" seconds\n  @param c - after"),
    ];
    const lifted = liftParamDocs(segments, ["a", "b", "c"]);
    expect(lifted.params).toEqual({ a: "plain", c: "after" });
    expect((lifted.segments[0] as { value: string }).value).toBe("Run it.\n  @param b - up to ");
    expect((lifted.segments[2] as { value: string }).value).toBe(" seconds");
  });

  it("keeps the first entry when a name is documented twice", () => {
    const lifted = liftParamDocs([text("@param a - one\n@param a - two")], ["a"]);
    expect(lifted.params).toEqual({ a: "one" });
    expect((lifted.segments[0] as { value: string }).value).toBe("@param a - two");
  });
});
