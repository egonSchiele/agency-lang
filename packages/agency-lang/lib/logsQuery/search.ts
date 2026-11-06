// `agency logs search <pattern>`: the rows whose own text matches, each
// with the address `agency logs session show` opens. A row's own text is
// what the transcript shows on it, so a word repeated in every later LLM
// call's history is found once, where it first appeared.
import { oneLine } from "@/runDirectory/table.js";
import { formatAddress } from "@/logsViewer/address.js";
import {
  matcherFor,
  searchTrace,
  SEARCH_KINDS,
  type Matcher,
  type SearchKind,
} from "@/logsViewer/rowSearch.js";
import {
  countProblem,
  type OptionNames,
  type TraceSelectionFlags,
} from "@/runDirectory/traceSelection.js";

import { HEADER_CHARS } from "./outline.js";
import {
  countOf,
  logLine,
  MOST_RECENT_ONLY,
  refusal,
  withPickedTraces,
  type QueryDeps,
  type QueryResult,
} from "./shared.js";

/** How many matching rows `search` prints when `--limit` is not given. */
export const DEFAULT_SEARCH_LIMIT = 30;
/** Characters of snippet on each side of a match when `--context` is not given. */
export const DEFAULT_SNIPPET_CONTEXT = 60;

export type SearchOptions = TraceSelectionFlags & {
  pattern: string;
  log?: string;
  json: boolean;
  /** Undefined searches every kind. */
  kinds?: string[];
  regex: boolean;
  caseSensitive: boolean;
  limit?: number;
  context?: number;
};

type PrintedHit = {
  address: string;
  traceId: string;
  rowId: string;
  kind: SearchKind;
  header: string;
  matches: number;
  snippet: string;
};

/** The search's own flags, parsed: how many rows, how wide a snippet,
 *  which kinds, and the matcher. */
type SearchFlags = {
  limit: number;
  context: number;
  kinds: SearchKind[] | undefined;
  matcher: Matcher;
};

function searchFlagsFrom(
  options: SearchOptions,
  names: OptionNames,
): SearchFlags | { error: string } {
  const limit = options.limit ?? DEFAULT_SEARCH_LIMIT;
  const context = options.context ?? DEFAULT_SNIPPET_CONTEXT;
  const problem =
    countProblem(names.limit, limit) ??
    countProblem(names.context, context) ??
    kindsProblem(options.kinds, names);
  if (problem !== undefined) {
    return { error: problem };
  }
  const matcher = matcherFor(options.pattern, options);
  if ("error" in matcher) {
    return matcher;
  }
  return { limit, context, kinds: options.kinds as SearchKind[] | undefined, matcher };
}

export async function logsSearch(options: SearchOptions, deps: QueryDeps): Promise<QueryResult> {
  const flags = searchFlagsFrom(options, deps.names);
  if ("error" in flags) {
    return refusal(flags.error);
  }
  return withPickedTraces(options, { defaultLast: MOST_RECENT_ONLY }, deps, ({ log, picked }) => {
    const hits: PrintedHit[] = picked.flatMap((trace) =>
      searchTrace(trace.root, flags.matcher, { context: flags.context, kinds: flags.kinds }).map(
        (hit) => ({
          address: formatAddress(trace.traceId, hit.rowId),
          traceId: trace.traceId,
          ...hit,
          header: oneLine(hit.header, HEADER_CHARS),
        }),
      ),
    );
    const shown = hits.slice(0, flags.limit);
    const omitted = hits.length - shown.length;
    const counts = `searched ${countOf(picked.length, "trace")} · ${countOf(hits.length, "row")} matched`;
    const lines = [
      logLine(log, hits.length === 0 ? counts : `${counts} · showing ${shown.length}`),
      "",
    ];
    if (hits.length === 0) {
      lines.push("no rows matched");
    }
    lines.push(...shown.flatMap(hitLines));
    if (omitted > 0) {
      lines.push(
        "",
        `${countOf(omitted, "more row")} matched. Narrow with ${deps.names.trace}, ${deps.names.kind}, or a longer pattern, or raise ${deps.names.limit}.`,
      );
    }
    return {
      text: lines.join("\n"),
      json: {
        log: log.logPath,
        pattern: options.pattern,
        tracesSearched: picked.length,
        matched: hits.length,
        omitted,
        hits: shown,
      },
      exitCode: 0,
    };
  });
}

function hitLines(hit: PrintedHit): string[] {
  const count = hit.matches > 1 ? `  (${hit.matches} matches)` : "";
  return [`${hit.address}${count}`, `  ${hit.header}`, `  ${hit.snippet}`];
}

/** Why the kinds are not all kinds search knows; undefined when they are. */
function kindsProblem(kinds: string[] | undefined, names: OptionNames): string | undefined {
  const unknown = (kinds ?? []).filter((name) => !(SEARCH_KINDS as string[]).includes(name));
  if (unknown.length === 0) {
    return undefined;
  }
  return `${names.kind} takes these kinds: ${KINDS_LIST} (not ${unknown.join(", ")})`;
}

/** The kinds search knows, for a message. */
export const KINDS_LIST = SEARCH_KINDS.join(", ");
