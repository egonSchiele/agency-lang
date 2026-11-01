// `agency logs search <pattern>`: the rows whose own text matches, each
// with the address `agency logs session show` opens. A row's own text is
// what the transcript shows on it, so a word repeated in every later LLM
// call's history is found once, where it first appeared.
import { oneLine } from "@/cli/runDirectory/table.js";
import { formatAddress } from "@/logsViewer/address.js";
import {
  matcherFor,
  searchTrace,
  SEARCH_KINDS,
  type Matcher,
  type SearchKind,
} from "@/logsViewer/rowSearch.js";
import { parseCount, type TraceSelectionFlags } from "@/runDirectory/traceSelection.js";

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
  kind?: string;
  regex: boolean;
  caseSensitive: boolean;
  limit?: string;
  context?: string;
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

function searchFlagsFrom(options: SearchOptions): SearchFlags | { error: string } {
  const limit = parseCount("--limit", options.limit);
  const context = parseCount("--context", options.context);
  const kinds = kindsFrom(options.kind);
  const matcher = matcherFor(options.pattern, options);
  if ("error" in limit) {
    return limit;
  }
  if ("error" in context) {
    return context;
  }
  if ("error" in kinds) {
    return kinds;
  }
  if ("error" in matcher) {
    return matcher;
  }
  return {
    limit: limit.value ?? DEFAULT_SEARCH_LIMIT,
    context: context.value ?? DEFAULT_SNIPPET_CONTEXT,
    kinds: kinds.value,
    matcher,
  };
}

export async function logsSearch(options: SearchOptions, deps: QueryDeps): Promise<QueryResult> {
  const flags = searchFlagsFrom(options);
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
        `${countOf(omitted, "more row")} matched. Narrow with --trace, --kind, or a longer pattern, or raise --limit.`,
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

/** `--kind user,tool` as a list, checked against the kinds search knows. */
function kindsFrom(
  text: string | undefined,
): { value: SearchKind[] | undefined } | { error: string } {
  if (text === undefined) {
    return { value: undefined };
  }
  const names = text
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name !== "");
  const unknown = names.filter((name) => !(SEARCH_KINDS as string[]).includes(name));
  if (names.length === 0 || unknown.length > 0) {
    return {
      error: `--kind takes a comma-separated list of: ${SEARCH_KINDS.join(", ")}${unknown.length > 0 ? ` (not ${unknown.join(", ")})` : ""}`,
    };
  }
  return { value: names as SearchKind[] };
}
