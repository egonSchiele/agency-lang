import { describe, expect, it } from "vitest";

import {
  graderSourceForPath,
  graderSourceForRecord,
  JSON_SOURCE,
  MODULE_SOURCE,
} from "./graderSources.js";

describe("grader sources", () => {
  it("picks the source by the file's extension", () => {
    expect(graderSourceForPath("x/graders.json")).toBe(JSON_SOURCE);
    expect(graderSourceForPath("x/graders.ts")).toBe(MODULE_SOURCE);
    expect(() => graderSourceForPath("x/graders.yaml")).toThrow(
      "no grader source for x/graders.yaml",
    );
  });

  it("picks the source by which stored file the run row names", () => {
    expect(graderSourceForRecord({ source: "s", jsonFile: "a.json", judgeFiles: {} })).toBe(
      JSON_SOURCE,
    );
    expect(graderSourceForRecord({ source: "s", bundleFile: "a.mjs", judgeFiles: {} })).toBe(
      MODULE_SOURCE,
    );
    expect(() => graderSourceForRecord({ source: "s", judgeFiles: {} })).toThrow(
      "no grader source for s",
    );
  });
});
