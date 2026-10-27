// The tools a provider ran inside one LLM call, such as OpenAI's or
// Anthropic's built-in web search. The runtime never runs these, so no
// toolCallStart or toolCall event exists for them; smoltalk records them on
// the call's completion as `hostedToolResults`, each with the provider's own
// items in `raw`. This module turns those items into one record per call so
// every screen can draw a row for each.
import type { HostedToolResult } from "smoltalk";
import { hostedToolResultsOf } from "../statelog/wireAccessors.js";
import type { EventEnvelope } from "./types.js";

export type HostedCall = {
  /** `<round id>:hosted:<n>`, counting the round's hosted calls from 0. */
  id: string;
  tool: string;
  provider: string;
  /** One line saying what the call did: its query, or the page it opened. */
  gist: string;
  /** The provider's status, such as `completed`; undefined when not recorded. */
  status: string | undefined;
  failed: boolean;
  /** The facts the detail pane shows: queries, a URL, the sources found. */
  details: Record<string, unknown>;
  /** The provider's own items for this call. */
  raw: unknown[];
};

type CallFacts = Omit<HostedCall, "id" | "provider">;
type ProvidedCall = Omit<HostedCall, "id">;

type Item = Record<string, unknown>;

/** Reads one raw item that starts a call. `items` is the whole `raw` list,
 *  so a reader can find the item holding its call's result. */
type CallReader = (item: Item, result: HostedToolResult, items: Item[]) => CallFacts;

const CALL_READERS: Record<string, CallReader> = {
  // OpenAI Responses: one item per call; the action says what it did.
  web_search_call: openAiWebSearch,
  // Anthropic: the call, then a `web_search_tool_result` that names it.
  server_tool_use: anthropicToolUse,
};

/** A hosted call's title: `HOSTED TOOL CALL · web_search`, so it is never
 *  read as a tool the runtime ran. A failed call starts with ✖. */
export function hostedCallTitle(call: HostedCall): string {
  return `${failMark(call)}HOSTED TOOL CALL · ${call.tool}`;
}

/** The name a narrow list gives a hosted call: `hosted · web_search`. */
export function hostedCallShortLabel(call: HostedCall): string {
  return `${failMark(call)}hosted · ${call.tool}`;
}

function failMark(call: HostedCall): string {
  return call.failed ? "✖ " : "";
}

/** Separates a hosted call's id suffix from its round's id. */
const HOSTED_ID_INFIX = ":hosted:";
const HOSTED_ID_SUFFIX = /:hosted:\d+$/;

/** The calls recorded on one LLM call's completion event. `roundId` is the
 *  id of the round that event is, so each call's id names its round. */
export function hostedCallsIn(event: EventEnvelope, roundId: string): HostedCall[] {
  return hostedToolResultsOf(event)
    .flatMap((result) => callsIn(result))
    .map((call, position) => ({ ...call, id: `${roundId}${HOSTED_ID_INFIX}${position}` }));
}

/** The round a hosted call ran in, as a row id. Any other id comes back
 *  unchanged. `round:L:0:hosted:1` gives `round:L:0`. A screen that does
 *  not draw the hosted row focuses the LLM call that ran it instead. */
export function owningRowId(id: string): string {
  return id.replace(HOSTED_ID_SUFFIX, "");
}

/** The calls one result holds, each with its provider. A result whose raw
 *  items no reader knows (a router that reports only citations) becomes one
 *  call per recorded query, or one call when it recorded none. */
function callsIn(result: HostedToolResult): ProvidedCall[] {
  const items = rawItems(result).filter(isItem);
  const known = items.filter((item) => Object.hasOwn(CALL_READERS, String(item.type)));
  const facts =
    known.length > 0
      ? known.map((item) => CALL_READERS[String(item.type)](item, result, items))
      : summaryCalls(result);
  return facts.map((call) => ({ ...call, provider: result.provider }));
}

/** `raw` as a list. Gemini records one grounding object, not a list. */
function rawItems(result: HostedToolResult): unknown[] {
  if (Array.isArray(result.raw)) {
    return result.raw;
  }
  return result.raw === undefined || result.raw === null ? [] : [result.raw];
}

function openAiWebSearch(item: Item, result: HostedToolResult): CallFacts {
  const action = isItem(item.action) ? item.action : {};
  const status = typeof item.status === "string" ? item.status : undefined;
  const base = { tool: result.tool, status, failed: status === "failed", raw: [item] };
  const url = stringOr(action.url);
  switch (action.type) {
    case "open_page":
      return { ...base, gist: `open ${url}`, details: { url } };
    case "find_in_page":
    case "find":
      return {
        ...base,
        gist: `find "${stringOr(action.pattern)}" in ${url}`,
        details: { pattern: action.pattern, url },
      };
    default: {
      const queries = searchQueries(action);
      const details: Record<string, unknown> = { queries };
      if (Array.isArray(action.sources)) {
        details.sources = action.sources;
      }
      return { ...base, gist: queries.join(" · "), details };
    }
  }
}

/** `queries` when the provider sent several, else the one `query`. */
function searchQueries(action: Item): string[] {
  if (Array.isArray(action.queries) && action.queries.length > 0) {
    return action.queries.map(String);
  }
  return typeof action.query === "string" ? [action.query] : [];
}

function anthropicToolUse(item: Item, result: HostedToolResult, items: Item[]): CallFacts {
  const input = isItem(item.input) ? item.input : {};
  // A call with no id names no result; matching would pair it with any
  // item that also has no `tool_use_id`.
  const answer =
    typeof item.id === "string"
      ? items.find((other) => other.tool_use_id === item.id && other !== item)
      : undefined;
  const content = answer?.content;
  // Every server tool's error is one record with an `error_code`. A
  // successful web_fetch or code_execution result is an object too, so
  // being an object does not mean it failed.
  const failure =
    isItem(content) && content.error_code !== undefined ? String(content.error_code) : undefined;
  const details: Record<string, unknown> = { ...input };
  if (Array.isArray(content)) {
    details.sources = content.filter(isItem).map((source) => ({
      title: source.title,
      url: source.url,
    }));
  }
  if (failure !== undefined) {
    details.error = failure;
  }
  const facts = {
    tool: typeof item.name === "string" ? item.name : result.tool,
    gist: stringOr(input.query) || stringOr(input.url),
    failed: failure !== undefined,
    details,
  };
  if (answer === undefined) {
    return { ...facts, status: undefined, raw: [item] };
  }
  return { ...facts, status: facts.failed ? "failed" : "completed", raw: [item, answer] };
}

/** The provider does not say which query found which source (Gemini's
 *  grounding lists them once for the whole call), so every query's row
 *  shows all of the call's sources. */
function summaryCalls(result: HostedToolResult): CallFacts[] {
  const base = { tool: result.tool, status: undefined, failed: false, raw: rawItems(result) };
  const sources = result.sources ?? result.citations ?? [];
  const queries = result.queries ?? [];
  if (queries.length === 0) {
    return [{ ...base, gist: "", details: { sources } }];
  }
  const shared = sources.length > 0 ? { sources } : {};
  return queries.map((query) => ({ ...base, gist: query, details: { query, ...shared } }));
}

function isItem(value: unknown): value is Item {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringOr(value: unknown): string {
  return typeof value === "string" ? value : "";
}
