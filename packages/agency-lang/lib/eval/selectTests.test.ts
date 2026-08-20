import { describe, expect, it } from "vitest";

import type { Test } from "./runTypes.js";
import { describeEmptySelection, isEmptyFilter, selectTests, suiteTags } from "./selectTests.js";

const suite: Test[] = [
  { id: "sort-list", tags: ["easy", "coding"] },
  { id: "sort-files", tags: ["hard", "coding"] },
  { id: "find-source", tags: ["hard", "research"] },
  { id: "untagged" },
];

const ids = (tests: Test[]): string[] => tests.map((test) => test.id ?? "");

describe("selectTests", () => {
  it("an empty filter selects every test", () => {
    expect(selectTests(suite, {})).toEqual(suite);
    expect(isEmptyFilter({})).toBe(true);
    expect(isEmptyFilter({ ids: [], tags: [] })).toBe(true);
    expect(isEmptyFilter({ tags: ["easy"] })).toBe(false);
  });

  it("an id pattern is a glob; several patterns select any match", () => {
    expect(ids(selectTests(suite, { ids: ["sort-*"] }))).toEqual(["sort-list", "sort-files"]);
    expect(ids(selectTests(suite, { ids: ["untagged", "find-*"] }))).toEqual([
      "find-source",
      "untagged",
    ]);
  });

  it("a bare id is an exact match, not a substring", () => {
    expect(ids(selectTests(suite, { ids: ["sort"] }))).toEqual([]);
    expect(ids(selectTests(suite, { ids: ["sort-list"] }))).toEqual(["sort-list"]);
  });

  it("tags AND together: every listed tag must be on the test", () => {
    expect(ids(selectTests(suite, { tags: ["coding"] }))).toEqual(["sort-list", "sort-files"]);
    expect(ids(selectTests(suite, { tags: ["coding", "hard"] }))).toEqual(["sort-files"]);
    expect(ids(selectTests(suite, { tags: ["nope"] }))).toEqual([]);
  });

  it("ids and tags both apply", () => {
    expect(ids(selectTests(suite, { ids: ["sort-*"], tags: ["hard"] }))).toEqual(["sort-files"]);
  });

  it("suiteTags: first-appearance order, no duplicates", () => {
    expect(suiteTags(suite)).toEqual(["easy", "coding", "hard", "research"]);
    expect(suiteTags([{ id: "a" }])).toEqual([]);
  });

  it("the empty-selection message names the filter, the ids, and the suite's tags", () => {
    const message = describeEmptySelection(suite, { ids: ["nope-*"], tags: ["easy", "hard"] });
    expect(message).toContain("--test nope-*");
    expect(message).toContain("--tags easy,hard");
    expect(message).toContain("sort-list");
    expect(message).toContain("easy, coding, hard, research");
    expect(describeEmptySelection([{ id: "a" }], { tags: ["x"] })).toContain(
      "No test in this suite carries tags",
    );
  });
});
