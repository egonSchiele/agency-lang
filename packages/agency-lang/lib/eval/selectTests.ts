import picomatch from "picomatch";

import type { Test } from "./runTypes.js";

/**
 * Which tests of a suite to run. Both `eval run` and `eval ls` apply a
 * filter through `selectTests`, so `eval ls` with the same flags shows
 * exactly what a run would run.
 */
export type TestFilter = {
  /** `--test` patterns. A test is selected when its id matches ANY pattern
   *  (picomatch glob, so `agent-*` works and a bare id is an exact match). */
  ids?: string[];
  /** `--tags` values. A test is selected only when it carries EVERY one —
   *  `--tags coding,hard` means hard coding tests, not hard-or-coding. */
  tags?: string[];
};

export function isEmptyFilter(filter: TestFilter): boolean {
  return (filter.ids ?? []).length === 0 && (filter.tags ?? []).length === 0;
}

export function selectTests(tests: Test[], filter: TestFilter): Test[] {
  const ids = filter.ids ?? [];
  const tags = filter.tags ?? [];
  return tests.filter(
    (test) =>
      (ids.length === 0 || ids.some((pattern) => picomatch(pattern)(test.id ?? ""))) &&
      tags.every((tag) => (test.tags ?? []).includes(tag)),
  );
}

/** The suite's tag vocabulary: every tag any test carries, first appearance
 *  order, duplicates removed. */
export function suiteTags(tests: Test[]): string[] {
  const all = tests.flatMap((test) => test.tags ?? []);
  return all.filter((tag, index) => all.indexOf(tag) === index);
}

/** A filter that selects nothing is a mistake worth a specific message: name
 *  what the suite actually offers, so the fix is one glance away. */
export function describeEmptySelection(tests: Test[], filter: TestFilter): string {
  const ids = tests.map((test) => test.id ?? "(no id)").join(", ");
  const tags = suiteTags(tests);
  const tagLine =
    tags.length === 0 ? "No test in this suite carries tags." : `Suite tags: ${tags.join(", ")}.`;
  const wanted = [
    ...((filter.ids ?? []).length > 0 ? [`--test ${(filter.ids ?? []).join(", ")}`] : []),
    ...((filter.tags ?? []).length > 0 ? [`--tags ${(filter.tags ?? []).join(",")}`] : []),
  ].join(" ");
  return `${wanted} matches none of the ${tests.length} tests. Test ids: ${ids}. ${tagLine}`;
}
