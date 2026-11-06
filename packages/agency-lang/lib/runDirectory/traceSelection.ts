// Which traces of a log a command reads, from `--trace`, `--last`,
// `--since`, and `--all`. One function, so `agency logs traces`, `outline`,
// `search`, and the `std::statelog` readers cannot disagree about what
// `--last 2` means.
import { matchTraceId } from "./traces.js";

/** A field set to `null` counts as left out: a model calling a reader as a
 *  tool sends `null` for each field of `select` it does not use. */
export type TraceSelectionFlags = {
  trace?: string | null;
  last?: number | null;
  since?: string | null;
  all?: boolean | null;
};

export type OptionName =
  "trace" | "last" | "since" | "all" | "limit" | "context" | "kind" | "maxChars";

/** How the caller spells each option in a message: the CLI's flags, or the
 *  fields of a `std::statelog` call. One set of rules and messages, two
 *  spellings. */
export type OptionNames = Record<OptionName, string>;

export const FLAG_NAMES_CLI: OptionNames = {
  trace: "--trace",
  last: "--last",
  since: "--since",
  all: "--all",
  limit: "--limit",
  context: "--context",
  kind: "--kind",
  maxChars: "--max-chars",
};

export const FIELD_NAMES: OptionNames = {
  trace: "trace",
  last: "last",
  since: "since",
  all: "all",
  limit: "limit",
  context: "context",
  kind: "kinds",
  maxChars: "maxChars",
};

/** What the picker needs to know about a trace. `TraceSummary` has both
 *  fields, so the commands pass their summaries straight in; start time
 *  is computed in one place, `traceSummaries`, and never again. */
export type Pickable = { traceId: string; startedAt: number | undefined };

export type TraceSelection<T extends Pickable> =
  | { kind: "selected"; picked: T[]; total: number; older: number }
  | { kind: "refused"; reason: string };

type FlagName = keyof TraceSelectionFlags;

/** The flags that pick traces. A command's other options can ride on the
 *  same object; only these are read. */
const FLAG_NAMES: FlagName[] = ["trace", "last", "since", "all"];

type Refusal = "traceAlone" | "allAndLast" | "allAndSince";

const REFUSALS: Record<Refusal, (names: OptionNames) => string> = {
  traceAlone: (names) =>
    `${names.trace} names one trace; drop ${names.last}, ${names.since}, and ${names.all}`,
  allAndLast: (names) => `${names.all} and ${names.last} disagree about how many`,
  allAndSince: (names) =>
    `${names.all} and ${names.since} disagree: ${names.since} alone already means every trace that matches`,
};

type Rule = "default" | "trace" | "last" | "since" | "lastSince" | "all";

/** The spec's combinations table, one row for each set of the four flags.
 *  `given` lists a row's flags in `FLAG_NAMES` order, and a row matches
 *  when exactly those flags are given. */
const COMBINATIONS: { given: FlagName[]; outcome: { rule: Rule } | { refused: Refusal } }[] = [
  { given: [], outcome: { rule: "default" } },
  { given: ["trace"], outcome: { rule: "trace" } },
  { given: ["last"], outcome: { rule: "last" } },
  { given: ["since"], outcome: { rule: "since" } },
  { given: ["last", "since"], outcome: { rule: "lastSince" } },
  { given: ["all"], outcome: { rule: "all" } },
  { given: ["trace", "last"], outcome: { refused: "traceAlone" } },
  { given: ["trace", "since"], outcome: { refused: "traceAlone" } },
  { given: ["trace", "all"], outcome: { refused: "traceAlone" } },
  { given: ["trace", "last", "since"], outcome: { refused: "traceAlone" } },
  { given: ["trace", "last", "all"], outcome: { refused: "traceAlone" } },
  { given: ["trace", "since", "all"], outcome: { refused: "traceAlone" } },
  { given: ["trace", "last", "since", "all"], outcome: { refused: "traceAlone" } },
  { given: ["last", "all"], outcome: { refused: "allAndLast" } },
  { given: ["last", "since", "all"], outcome: { refused: "allAndLast" } },
  { given: ["since", "all"], outcome: { refused: "allAndSince" } },
];

const SINCE_UNITS: Record<string, number> = {
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

/** `30m`, `2h`, `3d`, or an ISO date, as a time in ms, or a refusal. */
export function parseSince(text: string, now: number): { at: number } | { error: string } {
  const relative = /^(\d+)([mhd])$/.exec(text.trim());
  if (relative !== null) {
    return { at: now - Number(relative[1]) * SINCE_UNITS[relative[2]] };
  }
  const at = Date.parse(text);
  if (Number.isNaN(at)) {
    return { error: `cannot read "${text}" as a time: use 30m, 2h, 3d, or an ISO date` };
  }
  return { at };
}

/** Why `value` is not a count (a positive whole number), naming the
 *  option as the caller spells it; undefined when it is one. This is the
 *  only place the rule lives: the CLI turns flag text that is not digits
 *  into `NaN`, which is refused here. */
export function countProblem(name: string, value: number): string | undefined {
  if (Number.isInteger(value) && value >= 1) {
    return undefined;
  }
  const shown = Number.isNaN(value) ? "" : `, not ${value}`;
  return `${name} needs a positive whole number${shown}`;
}

/**
 * The traces the flags pick, newest first by start time, by the
 * combinations table above. `defaultLast` applies only when none of the
 * four flags is given. A trace with no timestamp sorts oldest and `since`
 * never picks it. `older` counts the traces `last` (or the default) left
 * out.
 */
export function selectTraces<T extends Pickable>(
  traces: readonly T[],
  flags: TraceSelectionFlags,
  options: { defaultLast: number; now: number; names: OptionNames },
): TraceSelection<T> {
  const given = FLAG_NAMES.filter(
    (name) => flags[name] !== undefined && flags[name] !== null && flags[name] !== false,
  );
  const row = COMBINATIONS.find((candidate) => candidate.given.join() === given.join());
  if (row === undefined) {
    // The table has a row for each of the sixteen sets of flags.
    throw new Error(`no selection rule for flags: ${given.join(", ")}`);
  }
  if ("refused" in row.outcome) {
    return { kind: "refused", reason: REFUSALS[row.outcome.refused](options.names) };
  }
  if (typeof flags.last === "number") {
    const problem = countProblem(options.names.last, flags.last);
    if (problem !== undefined) {
      return { kind: "refused", reason: problem };
    }
  }
  const newestFirst = byStartTime(traces);
  const total = traces.length;
  switch (row.outcome.rule) {
    case "default":
      return lastOf(newestFirst, options.defaultLast, total);
    case "all":
      return { kind: "selected", picked: newestFirst, total, older: 0 };
    case "last":
      return lastOf(newestFirst, flags.last!, total);
    case "trace":
      return oneTrace(newestFirst, flags.trace!, total);
    case "since":
    case "lastSince": {
      const since = parseSince(flags.since!, options.now);
      if ("error" in since) {
        return { kind: "refused", reason: since.error };
      }
      const recent = newestFirst.filter(
        (trace) => trace.startedAt !== undefined && trace.startedAt >= since.at,
      );
      return row.outcome.rule === "since"
        ? { kind: "selected", picked: recent, total, older: 0 }
        : lastOf(recent, flags.last!, total);
    }
  }
}

/** Newest first. A trace with no start time sorts oldest; ties keep the
 *  order they came in, since `Array.prototype.sort` is stable. */
function byStartTime<T extends Pickable>(traces: readonly T[]): T[] {
  const startOf = (trace: T): number => trace.startedAt ?? Number.NEGATIVE_INFINITY;
  return [...traces].sort((left, right) => startOf(right) - startOf(left));
}

function lastOf<T extends Pickable>(
  newestFirst: T[],
  count: number,
  total: number,
): TraceSelection<T> {
  return {
    kind: "selected",
    picked: newestFirst.slice(0, count),
    total,
    older: Math.max(0, newestFirst.length - count),
  };
}

function oneTrace<T extends Pickable>(
  traces: T[],
  idOrPrefix: string,
  total: number,
): TraceSelection<T> {
  const match = matchTraceId(
    traces.map((trace) => trace.traceId),
    idOrPrefix,
  );
  if (match.kind === "none") {
    return { kind: "refused", reason: `no trace in the log matches "${idOrPrefix}"` };
  }
  if (match.kind === "ambiguous") {
    return {
      kind: "refused",
      reason:
        `trace id "${idOrPrefix}" matches ${match.ids.length} traces; use more characters:\n` +
        match.ids.map((id) => `  ${id}`).join("\n"),
    };
  }
  return {
    kind: "selected",
    picked: traces.filter((trace) => trace.traceId === match.id),
    total,
    older: 0,
  };
}
