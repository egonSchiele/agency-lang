import { describe, expect, it } from "vitest";

import {
  countProblem,
  FIELD_NAMES,
  FLAG_NAMES_CLI,
  parseSince,
  selectTraces,
  type Pickable,
  type TraceSelection,
} from "./traceSelection.js";

const NOW = Date.parse("2026-10-31T12:00:00Z");
const HOUR = 3_600_000;

/** Listed oldest first, the way lines from interleaved traces can arrive:
 *  the first trace in the file is not the first to start. */
const traces: Pickable[] = [
  { traceId: "aaa-old", startedAt: NOW - 5 * HOUR },
  { traceId: "bbb-newest", startedAt: NOW - 10_000 },
  { traceId: "ccc-undated", startedAt: undefined },
  { traceId: "ddd-middle", startedAt: NOW - 30 * 60_000 },
  { traceId: "aab-older", startedAt: NOW - 9 * HOUR },
];
const options = { defaultLast: 2, now: NOW, names: FLAG_NAMES_CLI };

function ids(selection: TraceSelection<Pickable>): string[] {
  if (selection.kind === "refused") {
    throw new Error(selection.reason);
  }
  return selection.picked.map((trace) => trace.traceId);
}

describe("selectTraces", () => {
  it("orders by start time, not by position in the log", () => {
    expect(ids(selectTraces(traces, { all: true }, options))).toEqual([
      "bbb-newest",
      "ddd-middle",
      "aaa-old",
      "aab-older",
      "ccc-undated",
    ]);
  });

  it("with no flag, picks the default count and counts the rest as older", () => {
    expect(selectTraces(traces, {}, options)).toMatchObject({
      picked: [{ traceId: "bbb-newest" }, { traceId: "ddd-middle" }],
      total: 5,
      older: 3,
    });
  });

  it("--last n picks the n newest", () => {
    expect(selectTraces(traces, { last: 1 }, options)).toMatchObject({
      picked: [{ traceId: "bbb-newest" }],
      older: 4,
    });
  });

  it("--trace picks one trace by prefix", () => {
    expect(ids(selectTraces(traces, { trace: "ddd" }, options))).toEqual(["ddd-middle"]);
  });

  it("--since alone picks every match, uncapped, and never an undated trace", () => {
    expect(ids(selectTraces(traces, { since: "6h" }, options))).toEqual([
      "bbb-newest",
      "ddd-middle",
      "aaa-old",
    ]);
  });

  it("--last with --since keeps both conditions", () => {
    expect(selectTraces(traces, { last: 2, since: "6h" }, options)).toMatchObject({
      picked: [{ traceId: "bbb-newest" }, { traceId: "ddd-middle" }],
      older: 1,
    });
  });

  it.each([
    [{ trace: "ddd", last: 1 }, "--trace names one trace"],
    [{ trace: "ddd", since: "1h" }, "--trace names one trace"],
    [{ trace: "ddd", all: true }, "--trace names one trace"],
    [{ trace: "ddd", last: 1, since: "1h" }, "--trace names one trace"],
    [{ all: true, last: 3 }, "--all and --last disagree"],
    [{ all: true, since: "1h" }, "--all and --since disagree"],
    [{ all: true, last: 3, since: "1h" }, "--all and --last disagree"],
    [{ trace: "ddd", last: 1, since: "1h", all: true }, "--trace names one trace"],
  ])("refuses %o", (flags, reason) => {
    const selection = selectTraces(traces, flags, options);
    expect(selection.kind).toBe("refused");
    expect(selection.kind === "refused" && selection.reason).toContain(reason);
  });

  it("an ambiguous prefix lists the matching ids", () => {
    const selection = selectTraces(traces, { trace: "aa" }, options);
    expect(selection).toMatchObject({ kind: "refused" });
    expect(selection.kind === "refused" && selection.reason).toContain("  aaa-old\n  aab-older");
  });

  it("a prefix that matches nothing is refused", () => {
    expect(selectTraces(traces, { trace: "zzz" }, options)).toEqual({
      kind: "refused",
      reason: 'no trace in the log matches "zzz"',
    });
  });

  it("a --since it cannot read is refused", () => {
    expect(selectTraces(traces, { since: "2x" }, options)).toMatchObject({ kind: "refused" });
  });

  it("--all false counts as not given", () => {
    expect(ids(selectTraces(traces, { all: false }, options))).toEqual([
      "bbb-newest",
      "ddd-middle",
    ]);
  });
});

describe("parseSince", () => {
  it.each([
    ["30m", NOW - 30 * 60_000],
    ["2h", NOW - 2 * HOUR],
    ["3d", NOW - 72 * HOUR],
    ["2026-10-30T00:00:00Z", Date.parse("2026-10-30T00:00:00Z")],
  ])("reads %s", (text, at) => {
    expect(parseSince(text, NOW)).toEqual({ at });
  });

  it("refuses 2x with the forms it takes", () => {
    expect(parseSince("2x", NOW)).toEqual({
      error: 'cannot read "2x" as a time: use 30m, 2h, 3d, or an ISO date',
    });
  });
});

describe("countProblem", () => {
  it("takes a positive whole number", () => {
    expect(countProblem("--last", 3)).toBeUndefined();
  });

  it.each([
    [0, "--limit needs a positive whole number, not 0"],
    [-1, "--limit needs a positive whole number, not -1"],
    [2.5, "--limit needs a positive whole number, not 2.5"],
    [Number.NaN, "--limit needs a positive whole number"],
  ])("refuses %d, naming the option", (value, message) => {
    expect(countProblem("--limit", value)).toBe(message);
  });
});

describe("option names", () => {
  it.each([
    [{ trace: "ddd", last: 1 }, "trace names one trace; drop last, since, and all"],
    [{ last: 1, all: true }, "all and last disagree about how many"],
    [
      { since: "1h", all: true },
      "all and since disagree: since alone already means every trace that matches",
    ],
  ])("spells the refusal for %o with the library's field names", (flags, reason) => {
    expect(selectTraces(traces, flags, { ...options, names: FIELD_NAMES })).toEqual({
      kind: "refused",
      reason,
    });
  });

  it("spells it with the CLI's flags", () => {
    expect(selectTraces(traces, { trace: "ddd", last: 1 }, options)).toEqual({
      kind: "refused",
      reason: "--trace names one trace; drop --last, --since, and --all",
    });
  });

  it.each([0, -1, 2.5, Number.NaN])("refuses last of %d", (last) => {
    expect(selectTraces(traces, { last }, { ...options, names: FIELD_NAMES })).toMatchObject({
      kind: "refused",
      reason: expect.stringMatching(/^last needs a positive whole number/),
    });
  });
});

describe("null fields", () => {
  it("count as left out, the way a model sends unused fields", () => {
    const flags = { trace: null, last: 2, since: null, all: null };
    expect(ids(selectTraces(traces, flags, options))).toEqual(["bbb-newest", "ddd-middle"]);
  });

  it("an empty string counts as left out too", () => {
    const flags = { trace: "", last: 2, since: "" };
    expect(ids(selectTraces(traces, flags, options))).toEqual(["bbb-newest", "ddd-middle"]);
  });
});

describe("the combinations table", () => {
  it("has a row for each of the sixteen sets of flags", () => {
    const names = ["trace", "last", "since", "all"] as const;
    const values = { trace: "ddd", last: 1, since: "1h", all: true };
    for (let mask = 0; mask < 16; mask++) {
      const flags = Object.fromEntries(
        names.filter((_, bit) => (mask & (1 << bit)) !== 0).map((name) => [name, values[name]]),
      );
      expect(() => selectTraces(traces, flags, options)).not.toThrow();
    }
  });
});
