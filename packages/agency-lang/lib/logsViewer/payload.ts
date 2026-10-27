import {
  completionOf,
  normalizeMessage,
  hasTokenUsage,
  tokensCacheWrite,
} from "../statelog/wireAccessors.js";
import { fmtTokens, fmtUsd } from "./format.js";
import { hostedCallTitle } from "./hostedCalls.js";
import { childEvent, fmtDuration } from "./spanText.js";
import {
  decodeStructured,
  structuredLines,
  type FlatRole,
  type StructuredLine,
} from "./structured.js";
import {
  rowEvents,
  toolErrorMessages,
  toolResultText,
  toolStatusText,
  type StoryRow,
  type RoundStoryRow,
  type ToolStoryRow,
  type HostedStoryRow,
  type InterruptStoryRow,
  type ErrorStoryRow,
  type LlmGroupStoryRow,
} from "./story.js";
import { modelText, type Round } from "./timeline/rounds.js";
import { buildTreeIndex, nearestAncestor, walkNodes } from "./forest.js";
import { overviewData, type OverviewCall } from "./overviewData.js";
import { spanExtent } from "./timeline/spans.js";
import type { TreeNode } from "./types.js";
import type { Comment, CommentThread } from "../runDirectory/comments.js";
import { AGENT_MARK, HUMAN_MARK } from "./marks.js";
/** `faded` marks a line that is history, painted in one muted color.
 *  `oneRow` keeps a line to a single painted row, cut with an ellipsis. */
export type PayloadLine = (
  | {
      kind: "heading";
      text: string;
      tone: "assistant" | "tool" | "interrupt" | "error" | "user" | "chrome" | "accent";
    }
  | { kind: "meta"; text: string }
  /** A rule across the width with a label on it: `── RESULT · ~4.4k tokens ──`. */
  | {
      kind: "rule";
      text: string;
      tone?: "assistant" | "tool" | "interrupt" | "error" | "user" | "chrome" | "accent";
    }
  | { kind: "text"; text: string; indent: number; role: FlatRole | "plain" | "error" }
  /** A field with its value on the same line; the painter colors the key. */
  | { kind: "pair"; key: string; text: string; indent: number }
  /** A list of same-shaped objects; the painter draws rows when they fit. */
  | { kind: "table"; columns: string[]; rows: string[][]; indent: number }
  | { kind: "code"; text: string; language: string; indent?: number }
  | { kind: "json"; text: string }
  /** The overview's three charts over these calls, painted by `overviewCharts`. */
  | { kind: "charts"; calls: OverviewCall[] }
  | { kind: "blank" }
) & { faded?: boolean; oneRow?: boolean };
export type PayloadOptions = {
  raw: boolean;
  /** The trace the row belongs to. A group row charts its calls with it
   *  and shows its summary alone without it. */
  trace?: TreeNode;
  /** The comment threads on this row, listed after the payload. */
  comments?: CommentThread[];
};
type PayloadMakers = {
  [Kind in StoryRow["kind"]]: (
    row: Extract<StoryRow, { kind: Kind }>,
    options: PayloadOptions,
  ) => PayloadLine[];
};
const PAYLOADS: PayloadMakers = {
  round: roundPayload,
  user: (row) => [{ kind: "heading", text: "USER", tone: "user" }, ...valuePayload(row.text)],
  tool: toolPayload,
  hosted: hostedPayload,
  interrupt: interruptPayload,
  error: errorPayload,
  pause: (row) => [
    { kind: "heading", text: row.resumed ? "PAUSED, THEN RESUMED" : "PAUSED", tone: "interrupt" },
    {
      kind: "meta",
      text:
        row.pausedMs === undefined
          ? "The run stopped here and is still waiting for a response."
          : `The run stopped here for ${fmtDuration(row.pausedMs, { minutes: true })} and resumed when the response came.`,
    },
  ],
  llmGroup: llmGroupPayload,
  subagent: (row) => [
    { kind: "heading", text: `SUBAGENT · ${row.label}`, tone: "assistant" },
    ...rawPayload(row),
  ],
  machinery: rawPayload,
};
export function payloadFor(row: StoryRow, options: PayloadOptions): PayloadLine[] {
  if (options.raw) {
    return rawPayload(row);
  }
  const make = PAYLOADS[row.kind] as (row: StoryRow, options: PayloadOptions) => PayloadLine[];
  return [
    ...(row.orphan ? ORPHAN_NOTE : []),
    ...make(row, options),
    ...commentsPayload(options.comments ?? []),
  ];
}

/** The `comments` section under a row's payload: each thread as
 *  `✎ adit · 14:30: why…`, its replies indented under it. */
export function commentsPayload(threads: readonly CommentThread[]): PayloadLine[] {
  if (threads.length === 0) {
    return [];
  }
  const line = (comment: Comment, indent: number): PayloadLine => ({
    kind: "text",
    text: `${comment.author.kind === "human" ? HUMAN_MARK : AGENT_MARK} ${comment.author.id} · ${fmtClock(comment.created)} · ${comment.id}: ${comment.text}`,
    indent,
    role: "plain",
  });
  return [
    { kind: "blank" },
    { kind: "rule", text: `COMMENTS · ${threads.length}`, tone: "accent" },
    ...threads.flatMap((thread) => [
      line(thread.comment, 0),
      ...thread.replies.map((reply) => line(reply, 1)),
    ]),
  ];
}

function fmtClock(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
/** Why a span can name a parent the log never recorded. The viewer states
 *  the fact and lists the causes; matching the span to a tool by name
 *  would be wrong whenever a tool is called twice. */
const ORPHAN_NOTE: PayloadLine[] = [
  { kind: "heading", text: "parent span not in this log", tone: "chrome" },
  {
    kind: "meta",
    text: "The log may have been written before span ids survived a resume, cut off mid-write, still being written, or this is a subprocess whose parent span is in another file.",
  },
];
/** The row's events as JSON. A hosted call has none of its own, so it
 *  shows the provider's items for that call. */
function rawPayload(row: StoryRow): PayloadLine[] {
  const events: unknown[] = row.kind === "hosted" ? row.call.raw : rowEvents(row);
  return events.flatMap((event) =>
    JSON.stringify(event, null, 2)
      .split("\n")
      .map((text) => ({ kind: "json" as const, text })),
  );
}
function reasoningPayload(round: Round): PayloadLine[] {
  if (round.reasoning === undefined) {
    return [];
  }
  return [
    { kind: "heading", text: "REASONING", tone: "chrome" },
    ...valuePayload(round.reasoning),
    { kind: "blank" },
  ];
}
function roundPayload(row: RoundStoryRow): PayloadLine[] {
  const round = row.round;
  return [
    { kind: "heading", text: `ASSISTANT · LLM call ${round.index + 1}`, tone: "assistant" },
    {
      kind: "meta",
      text: `${modelText(round)} · ${fmtDuration(round.durationMs)} · ${fmtUsd(round.costUsd)}`,
    },
    {
      kind: "meta",
      text: roundTokenLine(round),
    },
    { kind: "blank" },
    ...reasoningPayload(round),
    ...roundResponsePayload(round, [], TRACE_DETAIL),
  ];
}

/** A group of LLM calls: the row's title, one line of count and models,
 *  one of wall time against model time and cost, an error count when there
 *  is one, then the overview's charts over just these calls. The rows
 *  beneath show each call, so no call is repeated here. The error count
 *  and the charts cover the same errors: those logged in this span and
 *  not inside a nested thread, which has its own group row. */
function llmGroupPayload(row: LlmGroupStoryRow, options: PayloadOptions): PayloadLine[] {
  const rounds = row.rounds;
  const models = rounds.map((round) => round.model).filter(Boolean);
  const unique = models.filter((value, index) => models.indexOf(value) === index);
  const count = `${rounds.length} LLM ${rounds.length === 1 ? "call" : "calls"}`;
  const llmMs = rounds.reduce((sum, round) => sum + round.durationMs, 0);
  const cost = fmtUsd(rounds.reduce((sum, round) => sum + round.costUsd, 0)) || "$0";
  const extent = spanExtent(row.node);
  const wall =
    extent === undefined
      ? "wall time not recorded"
      : `ran ${fmtDuration(extent.end - extent.start, { minutes: true })}`;
  const lines: PayloadLine[] = [
    { kind: "heading", text: row.title, tone: "assistant" },
    { kind: "meta", text: `${count} · ${unique.join(", ") || "model not recorded"}` },
    { kind: "meta", text: `${wall} · LLM time ${fmtDuration(llmMs, { minutes: true })} · ${cost}` },
  ];
  const errors = ownErrorCount(row.node);
  if (errors > 0) {
    lines.push({
      kind: "text",
      text: `✖ ${errors} ${errors === 1 ? "error" : "errors"}`,
      indent: 0,
      role: "error",
    });
  }
  if (options.trace !== undefined) {
    const calls = groupCalls(row, options.trace);
    if (calls.length > 0) {
      lines.push({ kind: "blank" }, { kind: "charts", calls });
    }
  }
  return lines;
}

/** Errors logged under the span whose nearest `llmCall` ancestor is the
 *  span itself: a nested thread's errors belong to its own group. */
function ownErrorCount(group: TreeNode): number {
  const index = buildTreeIndex(group);
  return walkNodes(group).filter(
    (node) =>
      node.event?.data.type === "error" &&
      nearestAncestor(node, index, (ancestor) => ancestor.label === "llmCall") === group,
  ).length;
}

/** The overview's columns for the group's calls: its completed calls, and
 *  the requests that failed inside the span before the provider answered.
 *  The tools every call shares are dropped from `enclosing`, so the charts
 *  bracket only the nesting inside the group and not the tool the whole
 *  group ran in. */
function groupCalls(row: LlmGroupStoryRow, trace: TreeNode): OverviewCall[] {
  const index = buildTreeIndex(trace);
  const inGroup = (call: OverviewCall): boolean =>
    call.round !== undefined
      ? call.round.spanId === row.node.id
      : nearestAncestor(call.failure!.node, index, (node) => node.label === "llmCall")?.id ===
        row.node.id;
  const calls = overviewData(trace).calls.filter(inGroup);
  const shared = Math.min(...calls.map((call) => call.enclosing.length));
  return calls.map((call) => ({ ...call, enclosing: call.enclosing.slice(shared) }));
}

/** How much of a tool result the overview shows until `x` is pressed. */
export const RESULT_PREVIEW_CHARS = 600;

/** The first RESULT_PREVIEW_CHARS of a result and a line counting the rest. */
export function cutResultPayload(text: string): PayloadLine[] {
  const rest = Math.ceil((text.length - RESULT_PREVIEW_CHARS) / 4);
  return [
    ...valuePayload(text.slice(0, RESULT_PREVIEW_CHARS)),
    { kind: "heading", text: `… ~${fmtTokens(rest)} more tokens · x to show`, tone: "accent" },
  ];
}

/** The completion, then each requested tool call with its arguments and,
 *  when `tools` holds the call's tool rows, what came back. Requests are
 *  matched to tool rows by name, in order, so a tool called twice in one
 *  round pairs first with first. */
export type ResultOptions = {
  /** Print every result whole instead of its first RESULT_PREVIEW_CHARS. */
  fullResults?: boolean;
  /** Cut each argument longer than this many characters. */
  argumentChars?: number;
};

/** How much of each argument an LLM call's row shows. The call row says
 *  which tools were requested; the tool's own row has the arguments whole. */
export const ARGUMENT_PREVIEW_CHARS = 120;
const TRACE_DETAIL: ResultOptions = { argumentChars: ARGUMENT_PREVIEW_CHARS };

/** Whether any completed tool's result is longer than the preview keeps. */
export function hasCutResult(tools: ToolStoryRow[]): boolean {
  return tools.some(
    (tool) =>
      tool.status === "completed" && (toolResultText(tool) ?? "").length > RESULT_PREVIEW_CHARS,
  );
}

export function roundResponsePayload(
  round: Round,
  tools: ToolStoryRow[] = [],
  options: ResultOptions = {},
): PayloadLine[] {
  const event = round.node.event!;
  const calls = normalizeMessage({ role: "assistant", ...event.data.completion }).toolCalls ?? [];
  const unmatched = [...tools];
  const lines = valuePayload(completionOf(event) ?? "");
  for (const call of calls) {
    const at = unmatched.findIndex((tool) => tool.name === call.name);
    const tool = at === -1 ? undefined : unmatched.splice(at, 1)[0];
    lines.push({ kind: "heading", text: `TOOL CALL · ${call.name ?? "tool"}`, tone: "tool" });
    const args =
      options.argumentChars === undefined
        ? call.arguments
        : cutArguments(call.arguments, options.argumentChars);
    lines.push(...valuePayload(args));
    if (tool !== undefined) {
      lines.push(...toolResultPayload(tool, options));
    }
  }
  return lines;
}

/** The arguments with every value longer than `cap` characters cut to
 *  that many and an ellipsis, measured as the text the viewer would print. */
export function cutArguments(args: unknown, cap: number): unknown {
  const shorten = (value: unknown): unknown => {
    const text = typeof value === "string" ? value : (JSON.stringify(value) ?? "");
    return text.length <= cap ? value : `${text.slice(0, cap)}…`;
  };
  if (args !== null && typeof args === "object" && !Array.isArray(args)) {
    return Object.fromEntries(Object.entries(args).map(([key, item]) => [key, shorten(item)]));
  }
  return shorten(args);
}

/** What a requested tool gave back, by its recorded status. */
export function toolResultPayload(tool: ToolStoryRow, options: ResultOptions = {}): PayloadLine[] {
  switch (tool.status) {
    case "completed": {
      const text = toolResultText(tool) ?? "";
      const heading = { kind: "heading" as const, text: "→ RESULT", tone: "tool" as const };
      if (text.length <= RESULT_PREVIEW_CHARS || options.fullResults) {
        return [heading, ...valuePayload(text)];
      }
      return [heading, ...cutResultPayload(text)];
    }
    case "failed":
      return [
        { kind: "heading", text: "✖ RESULT · tool failed", tone: "error" },
        ...toolErrorMessages(tool).map((message) => ({
          kind: "text" as const,
          text: message,
          indent: 0,
          role: "error" as const,
        })),
      ];
    case "rejected":
      return [{ kind: "heading", text: "✖ RESULT · interrupt rejected", tone: "error" }];
    case "awaitingApproval":
      return [{ kind: "heading", text: "⏸ RESULT · waiting for a response", tone: "interrupt" }];
    case "unfinished":
      return [{ kind: "heading", text: "⋯ RESULT · completion not recorded", tone: "chrome" }];
  }
}
/** One line of token counts, the same on every screen: what the model
 *  read, how much of that was cached (and written to the cache), and what
 *  it wrote. `exact` prints full numbers instead of rounded ones. */
export function roundTokenLine(round: Round, opts: { exact?: boolean } = {}): string {
  const event = round.node.event!;
  if (!hasTokenUsage(event)) {
    return "input ? · output ?";
  }
  const fmt = opts.exact ? (count: number) => count.toLocaleString("en-US") : fmtTokens;
  const written = tokensCacheWrite(event);
  const writes = written > 0 ? `, ${fmt(written)} write` : "";
  return `input ${fmt(round.contextTokens)} (${fmt(round.cachedTokens)} cached${writes}) · output ${fmt(round.outputTokens)}`;
}
/** A tool's row, in the shape the overview gives a requested tool: the
 *  call with its arguments, then `→ RESULT` with the whole output. The
 *  arguments include any the model sent as null and the runtime dropped,
 *  with a line saying so, so the row agrees with the LLM call's. */
function toolPayload(row: ToolStoryRow): PayloadLine[] {
  const started = childEvent(row.node, "toolCallStart");
  const finished = childEvent(row.node, "toolCall");
  const output: PayloadLine[] = [
    { kind: "heading", text: `TOOL CALL · ${row.name}`, tone: "tool" },
    { kind: "meta", text: toolStatusText(row) },
    {
      kind: "meta",
      text: row.durationMs === undefined ? "duration not recorded" : fmtDuration(row.durationMs),
    },
    ...valuePayload(argumentsWithDropped((started ?? finished)?.data.args, row.droppedNulls)),
  ];
  if (row.droppedNulls.length > 0) {
    output.push({ kind: "meta", text: "Null arguments in tool calls are dropped, defaults apply" });
  }
  output.push(
    ...toolErrorMessages(row).map((message) => ({
      kind: "text" as const,
      text: message,
      indent: 0,
      role: "error" as const,
    })),
  );
  if (finished !== undefined) {
    output.push(
      {
        kind: "heading",
        text: `→ RESULT · ~${fmtTokens(resultTokenEstimate(finished.data.output))} tokens`,
        tone: "tool",
      },
      ...valuePayload(finished.data.output),
    );
  }
  return output;
}
/** A tool the provider ran inside an LLM call. The log has no timing or
 *  result text for it, only what the provider reported. */
function hostedPayload(row: HostedStoryRow): PayloadLine[] {
  const { call } = row;
  const status = call.status ?? "status not recorded";
  return [
    { kind: "heading", text: hostedCallTitle(call), tone: call.failed ? "error" : "tool" },
    {
      kind: "meta",
      text: `${status} · run by ${call.provider || "the provider"} inside LLM call ${row.round.index + 1}`,
    },
    ...valuePayload(call.details),
  ];
}
/** The recorded arguments with the dropped ones restored as `name: null`.
 *  Arguments recorded as anything but an object are shown as recorded. */
function argumentsWithDropped(args: unknown, dropped: string[]): unknown {
  if (dropped.length === 0 || args === null || typeof args !== "object" || Array.isArray(args)) {
    return args;
  }
  const restored: Record<string, unknown> = { ...(args as Record<string, unknown>) };
  for (const name of dropped) {
    restored[name] = null;
  }
  return restored;
}
export function resultTokenEstimate(output: unknown): number {
  const result = output as { __type?: string; success?: boolean; value?: unknown } | null;
  const value = result?.__type === "resultType" && result.success === true ? result.value : output;
  const text = typeof value === "string" ? value : (JSON.stringify(value) ?? "");
  // Rough estimate for the result text, excluding viewer formatting and message overhead.
  return Math.ceil(text.length / 4);
}
function errorPayload(row: ErrorStoryRow): PayloadLine[] {
  const event = row.node.event;
  const data = event?.data;
  const lines: PayloadLine[] = [
    { kind: "heading", text: "ERROR", tone: "error" },
    { kind: "text", text: row.message, indent: 0, role: "error" },
  ];
  if (typeof data?.functionName === "string") {
    lines.push({ kind: "meta", text: `function: ${data.functionName}` });
  }
  if (event?.span_id) {
    lines.push({ kind: "meta", text: `span: ${event.span_id}` });
  }
  const source = data?.sourceLocation;
  if (typeof source?.moduleId === "string") {
    const suffix = typeof source.line === "number" ? `:${source.line}` : "";
    lines.push({ kind: "meta", text: `source: ${source.moduleId}${suffix}` });
  }
  return lines;
}
function interruptPayload(row: InterruptStoryRow): PayloadLine[] {
  const interrupt = row.interrupt;
  return [
    { kind: "heading", text: `INTERRUPT · ${interrupt.effect}`, tone: "interrupt" },
    { kind: "meta", text: interrupt.outcome },
    {
      kind: "meta",
      text: `tool: ${row.toolName ?? "unknown"} · resolved by: ${interrupt.resolvedBy ?? "not recorded"}`,
    },
    { kind: "text", text: interrupt.message, indent: 0, role: "plain" },
    ...valuePayload(row.node.event?.data.interrupt?.data),
  ];
}
/** Whole code blocks stay intact until the painter highlights them. */
export function valuePayload(value: unknown): PayloadLine[] {
  const decoded = typeof value === "string" ? decodeStructured(value) : undefined;
  const lines = structuredLines(decoded ?? value);
  return structuredPayload(lines);
}
function structuredPayload(lines: StructuredLine[]): PayloadLine[] {
  const output: PayloadLine[] = [];
  for (let position = 0; position < lines.length; position++) {
    const line = lines[position];
    if (line.role === "pair") {
      output.push(...pairPayload(line));
      continue;
    }
    if (line.role === "table") {
      output.push({ kind: "table", columns: line.columns, rows: line.rows, indent: line.indent });
      continue;
    }
    if (line.role !== "text") {
      output.push({ kind: "text", ...line });
      continue;
    }
    const block = [line.text];
    let next = lines[position + 1];
    while (next?.role === "text" && next.indent === line.indent) {
      block.push(next.text);
      position += 1;
      next = lines[position + 1];
    }
    const text = block.join("\n");
    const previous = lines[position - block.length];
    const language = previous?.role === "key" && previous.text === "code" ? "agency" : "plaintext";
    if (language !== "plaintext") {
      output.push({ kind: "code", text, language, indent: line.indent });
    } else {
      output.push(
        ...block.map((text) => ({
          kind: "text" as const,
          text,
          indent: line.indent,
          role: "text" as const,
        })),
      );
    }
  }
  return output;
}
/** A one-line `code` field is still Agency source, highlighted like a
 *  longer one. */
function pairPayload(line: Extract<StructuredLine, { role: "pair" }>): PayloadLine[] {
  if (line.key === "code") {
    return [
      { kind: "text", text: "code", indent: line.indent, role: "key" },
      { kind: "code", text: line.text, language: "agency", indent: line.indent + 2 },
    ];
  }
  return [{ kind: "pair", key: line.key, text: line.text, indent: line.indent }];
}
