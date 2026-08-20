import type { AgencyConfig } from "@/config.js";
import { isEmptyFilter, selectTests, suiteTags, type TestFilter } from "@/eval/selectTests.js";
import type { Test } from "@/eval/runTypes.js";
import { ttyColor } from "@/utils/termcolors.js";

import { loadSuite } from "./run.js";

export type EvalLsOptions = {
  /** The test suite, same forms as `eval run --suite`. */
  suite?: string;
  /** `--test` id patterns. */
  test?: string[];
  /** `--tags` values. */
  tags?: string[];
  config?: AgencyConfig;
};

/**
 * `agency eval ls`: list a suite's tests — and with `--test`/`--tags`,
 * exactly the tests `eval run` with the same flags would run, because both
 * commands select through `selectTests`.
 */
export function evalLs(opts: EvalLsOptions): string[] {
  if (opts.suite === undefined || opts.suite === "") {
    throw new Error("eval ls needs --suite: the suite whose tests to list");
  }
  const suite = loadSuite({
    selection: "suite",
    source: opts.suite,
    cacheRoot: opts.config?.eval?.sourceCacheRoot,
  });
  const filter: TestFilter = { ids: opts.test, tags: opts.tags };
  const selected = selectTests(suite.tests, filter);
  return [...selected.flatMap(formatTest), summaryLine(selected, suite.tests, filter)];
}

function formatTest(test: Test): string[] {
  const tags = (test.tags ?? []).length === 0 ? "" : `  [${(test.tags ?? []).join(", ")}]`;
  return [
    `${ttyColor.green(test.id ?? "(no id)")}${tags}`,
    ...(test.description === undefined ? [] : [`  ${ttyColor.dim(test.description)}`]),
  ];
}

function summaryLine(selected: Test[], all: Test[], filter: TestFilter): string {
  if (isEmptyFilter(filter)) {
    return `${all.length} test${all.length === 1 ? "" : "s"}`;
  }
  const head = `${selected.length} of ${all.length} tests selected`;
  if (selected.length > 0) {
    return head;
  }
  // Nothing matched: name what the suite offers, so the fix is one glance away.
  const tags = suiteTags(all);
  const tagLine = tags.length === 0 ? "no test carries tags" : `suite tags: ${tags.join(", ")}`;
  return `${head} (${tagLine})`;
}
