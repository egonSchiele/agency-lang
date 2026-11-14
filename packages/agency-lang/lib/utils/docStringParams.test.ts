import { describe, expect, it } from "vitest";
import { PromptSegment } from "@/types/literals.js";
import { liftParamSegments } from "./docStringParams.js";
import { liftParamDocs } from "./paramDocs.js";

const text = (value: string): PromptSegment => ({ type: "text", value });
const hole = {
  type: "interpolation",
  expression: { type: "variableName", value: "X" },
} as unknown as PromptSegment;

describe("liftParamDocs", () => {
  it("moves each named @param entry out of the text, continuation lines included", () => {
    const doc = [
      "Read a file.",
      "",
      "  @param filename - Path inside dir.",
      "  @param limit - Lines to return,",
      "    0 for the default.",
      "  @param ghost - Not a parameter.",
    ].join("\n");
    const lifted = liftParamDocs(doc, ["filename", "limit", "dir"]);
    expect({ ...lifted.params }).toEqual({
      filename: "Path inside dir.",
      limit: "Lines to return, 0 for the default.",
    });
    expect(lifted.description).toBe("Read a file.\n\n  @param ghost - Not a parameter.");
  });

  it("keeps the first entry when a name is documented twice", () => {
    const lifted = liftParamDocs("@param a - one\n@param a - two", ["a"]);
    expect({ ...lifted.params }).toEqual({ a: "one" });
    expect(lifted.description).toBe("@param a - two");
  });

  it("finds a parameter named like an Object property only when it has an entry", () => {
    const names = ["constructor", "toString"];
    const lifted = liftParamDocs("Build it.\n@param constructor - The class to build.", names);
    expect(lifted.params.constructor).toBe("The class to build.");
    expect(lifted.params.toString).toBeUndefined();
    expect(lifted.description).toBe("Build it.");
  });

  it("leaves an @param line inside a fenced example alone", () => {
    const example = "```text\n@param input - Example only.\n```";
    const lifted = liftParamDocs(`Read text.\n\n${example}\n\n@param input - Actual input.`, [
      "input",
    ]);
    expect({ ...lifted.params }).toEqual({ input: "Actual input." });
    expect(lifted.description).toBe(`Read text.\n\n${example}\n`);
  });
});

describe("liftParamSegments", () => {
  it("leaves an entry that holds an interpolation where it is", () => {
    const segments = [
      text("Run it.\n  @param a - plain\n  @param b - up to "),
      hole,
      text(" seconds\n  @param c - after"),
    ];
    const lifted = liftParamSegments(segments, ["a", "b", "c"]);
    expect({ ...lifted.params }).toEqual({ a: "plain", c: "after" });
    expect(lifted.segments).toEqual([text("Run it.\n  @param b - up to "), hole, text(" seconds")]);
  });

  it("returns the segments unchanged when there is nothing to lift", () => {
    const segments = [text("Before "), hole, text(" after.")];
    expect(liftParamSegments(segments, ["a"]).segments).toEqual(segments);
  });
});
