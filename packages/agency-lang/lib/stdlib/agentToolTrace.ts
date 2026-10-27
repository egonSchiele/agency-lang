import { isPlainObject } from "../config/paths.js";
import type { Host } from "../host/host.js";
import { currentHost } from "../runtime/currentHost.js";
import { stripControlCharacters } from "../utils/controlCharacters.js";
import { color, plainColor, RESET } from "../utils/termcolors.js";
import { stripAnsi, visualWidth, wrapText } from "./layout/ansi.js";

export type TraceOptions = { columns: number; color: boolean };
export type ToolStartEvent = {
  kind: "toolStart";
  toolName: string;
  args: unknown;
  provider?: string | null;
};
export type ToolEndEvent = {
  kind: "toolEnd";
  toolName: string;
  value: unknown;
  outcome: "success" | "failure" | "plain";
  provider?: string | null;
};
export type HostedSearchEvent = { kind: "hostedSearch"; result: unknown };
export type AgentStartEvent = {
  kind: "agentStart";
  toolName: string;
  message: string;
};
export type SessionSaveFailureEvent = { kind: "sessionSaveFailure"; message: string };
export type AgentTraceEvent =
  ToolStartEvent | ToolEndEvent | HostedSearchEvent | AgentStartEvent | SessionSaveFailureEvent;

type TraceStyle = "heading" | "muted" | "completed" | "active" | "success" | "error" | "warning";
type TraceSpan = { text: string; style?: TraceStyle; bold?: boolean; limit?: number };
type TraceRow = { spans: TraceSpan[]; marker?: TraceSpan };
type TraceBlock = { heading: TraceSpan[]; rows: TraceRow[] };
type ToolEvent = ToolStartEvent | ToolEndEvent;
type TaskPresentation = { kind: "tasks"; heading: TraceSpan };
type AgentPresentation = { kind: "agent"; label: string };
type ToolPresentation = TaskPresentation | AgentPresentation;
type SearchSource = { url: string; title?: string };
type SearchPhase = "started" | "completed" | "reported" | "failed";
type SearchDescription = {
  toolName: string;
  provider: string;
  phase: SearchPhase;
  queries?: string[];
  sources?: SearchSource[] | null;
  error?: string;
};

const DEFAULT_COLUMNS = 80;
const ARGUMENT_PREVIEW_LENGTH = 50;
const RESULT_PREVIEW_LENGTH = 100;
const SOURCE_PREVIEW_COUNT = 5;
const TAB_WIDTH = 4;
const BODY_PREFIX = "  │ ";
const HEADING_CONTINUATION = "  ";

const OUTCOMES: Record<ToolEndEvent["outcome"], TraceSpan> = {
  success: { text: "✓ Tool finished", style: "success" },
  failure: { text: "✗ Tool failed", style: "error" },
  plain: { text: "✓ Tool finished", style: "success" },
};

// A custom presentation owns both lifecycle phases, including empty starts.
const TOOL_PRESENTATIONS: Record<string, ToolPresentation> = {
  todoWrite: { kind: "tasks", heading: { text: "✓ Tasks updated", style: "success" } },
  todoAdd: { kind: "tasks", heading: { text: "✓ Tasks updated", style: "success" } },
  todoUpdate: { kind: "tasks", heading: { text: "✓ Tasks updated", style: "success" } },
  todoList: { kind: "tasks", heading: { text: "Tasks", style: "heading" } },
  researchAgent: { kind: "agent", label: "Research" },
  codeAgent: { kind: "agent", label: "Code" },
  rewriteAgent: { kind: "agent", label: "Rewrite" },
  writingAgent: { kind: "agent", label: "Writing review" },
  reviewAgent: { kind: "agent", label: "Review" },
  oracleAgent: { kind: "agent", label: "Oracle" },
  explorerAgent: { kind: "agent", label: "Explorer" },
};
const SEARCH_HEADINGS: Record<SearchPhase, TraceSpan> = {
  started: { text: "⌕ Web search", style: "active" },
  completed: { text: "✓ Web search", style: "success" },
  reported: { text: "⌕ Web search", style: "muted" },
  failed: { text: "✗ Web search", style: "error" },
};
type TodoStatus = "pending" | "in_progress" | "completed";
type Todo = { id: string; text: string; status: TodoStatus };
type TodoPresentation = { marker: TraceSpan; style?: TraceStyle; suffix: string };
const TODO_STATUSES: Record<TodoStatus, TodoPresentation> = {
  pending: { marker: { text: "○", style: "muted" }, suffix: "" },
  in_progress: {
    marker: { text: "›", style: "active" },
    style: "active",
    suffix: " · in progress",
  },
  completed: { marker: { text: "✓", style: "success" }, style: "completed", suffix: "" },
};

function columnsOrDefault(columns: number | undefined): number {
  return columns !== undefined && Number.isFinite(columns) && columns >= 1
    ? Math.floor(columns)
    : DEFAULT_COLUMNS;
}

export function traceOptionsForHost(host: Host): TraceOptions {
  return {
    columns: columnsOrDefault(host.terminal.size()?.columns),
    color: host.terminal.supportsColor(),
  };
}

/** Describe an event first; only the renderer knows about terminal layout. */
export function formatAgentTrace(event: AgentTraceEvent, options: TraceOptions): string {
  const block = describeEvent(event);
  return block === null ? "" : renderBlock(block, options);
}

/** One write keeps concurrent tool blocks together. */
export function printAgentTrace(host: Host, event: AgentTraceEvent): void {
  const text = formatAgentTrace(event, traceOptionsForHost(host));
  if (text !== "") {
    host.terminal.print([text + "\n"]);
  }
}

export function _printAgentTrace(event: AgentTraceEvent): void {
  const host = currentHost();
  printAgentTrace(host, event);
}

function describeEvent(event: AgentTraceEvent): TraceBlock | null {
  switch (event.kind) {
    case "toolStart":
    case "toolEnd":
      return describeToolEvent(event);
    case "hostedSearch":
      return describeHostedSearch(event.result);
    case "agentStart": {
      const presentation = presentationFor(event.toolName);
      const label = presentation?.kind === "agent" ? presentation.label : "Agent";
      return {
        heading: toolHeading({ text: `→ ${label}`, style: "active" }, event.toolName),
        rows: [{ spans: [{ text: event.message, limit: RESULT_PREVIEW_LENGTH }] }],
      };
    }
    case "sessionSaveFailure":
      return {
        heading: [{ text: "! Session not saved", style: "warning", bold: true }],
        rows: [{ spans: [{ text: event.message }] }],
      };
  }
}

function presentationFor(toolName: string): ToolPresentation | undefined {
  return Object.hasOwn(TOOL_PRESENTATIONS, toolName) ? TOOL_PRESENTATIONS[toolName] : undefined;
}

function describeToolEvent(event: ToolEvent): TraceBlock | null {
  if (event.provider) {
    return describeClientSearch(event, event.provider);
  }
  const presentation = presentationFor(event.toolName);
  if (presentation === undefined) {
    return event.kind === "toolStart" ? describeToolStart(event) : describeToolEnd(event);
  }
  if (event.kind === "toolStart") {
    return null;
  }
  if (presentation.kind === "tasks") {
    if (event.outcome === "failure") {
      return describeToolEnd(event, { text: "✗ Tasks failed", style: "error" });
    }
    return isTodoList(event.value)
      ? describeTodos(event.toolName, event.value, presentation.heading)
      : describeToolEnd(event, { text: "· Task result", style: "muted" });
  }
  const label =
    event.outcome === "failure"
      ? { text: `✗ ${presentation.label} failed`, style: "error" as const }
      : { text: `✓ ${presentation.label} finished`, style: "success" as const };
  return describeToolEnd(event, label);
}

function isTodoList(value: unknown): value is Todo[] {
  return (
    Array.isArray(value) &&
    Array.from(value).every(
      (todo) =>
        isPlainObject(todo) &&
        typeof todo.id === "string" &&
        typeof todo.text === "string" &&
        typeof todo.status === "string" &&
        Object.hasOwn(TODO_STATUSES, todo.status),
    )
  );
}

function describeTodos(toolName: string, todos: Todo[], heading: TraceSpan): TraceBlock {
  const complete = todos.filter((todo) => todo.status === "completed").length;
  const rows: TraceRow[] = todos.map((todo) => {
    const presentation = TODO_STATUSES[todo.status];
    return {
      marker: presentation.marker,
      spans: [
        { text: todo.text, style: presentation.style },
        { text: presentation.suffix, style: "muted" },
      ],
    };
  });
  const taskRows = todos.length === 0 ? [{ spans: [{ text: "No tasks" }] }] : rows;
  return {
    heading: toolHeading(heading, toolName),
    rows: [
      { spans: [{ text: `${complete}/${todos.length} complete`, style: "muted" }] },
      ...taskRows,
    ],
  };
}

function describeHostedSearch(result: unknown): TraceBlock | null {
  if (!isPlainObject(result) || result.tool !== "web_search") {
    return null;
  }
  const provider =
    typeof result.provider === "string" && result.provider !== ""
      ? result.provider
      : "Provider not reported";
  const queries: string[] = Array.isArray(result.queries)
    ? result.queries.filter(
        (query): query is string => typeof query === "string" && query.trim().length > 0,
      )
    : [];
  return describeSearch({
    toolName: "web_search",
    provider,
    phase: "reported",
    queries,
    sources: result.sources === undefined ? undefined : readSources(result.sources),
  });
}

function describeClientSearch(event: ToolEvent, provider: string): TraceBlock {
  if (event.kind === "toolStart") {
    const query = isPlainObject(event.args) ? event.args.query : undefined;
    return describeSearch({
      toolName: event.toolName,
      provider,
      phase: "started",
      queries: typeof query === "string" && query.trim() !== "" ? [query] : [],
    });
  }
  if (event.outcome === "failure") {
    return describeSearch({
      toolName: event.toolName,
      provider,
      phase: "failed",
      error: typeof event.value === "string" ? event.value : serialize(event.value),
    });
  }
  return describeSearch({
    toolName: event.toolName,
    provider,
    phase: "completed",
    sources: readSources(event.value),
  });
}

function readSources(value: unknown): SearchSource[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const sources = value.filter(
    (source): source is SearchSource =>
      isPlainObject(source) &&
      typeof source.url === "string" &&
      source.url.trim() !== "" &&
      (source.title === undefined || typeof source.title === "string"),
  );
  return value.length > 0 && sources.length === 0 ? null : sources;
}

function describeSources(sources: SearchSource[] | null): TraceRow[] {
  if (sources === null) {
    return [{ spans: [{ text: "Sources not reported", style: "muted" }] }];
  }
  const count = sources.length === 1 ? "1 source" : `${sources.length} sources`;
  const rows: TraceRow[] = sources.slice(0, SOURCE_PREVIEW_COUNT).flatMap((source, index) => {
    const title = source.title?.trim() ? source.title : source.url;
    const titleRow: TraceRow = {
      marker: { text: `${index + 1}.`, style: "muted" },
      spans: [{ text: title }],
    };
    return title === source.url
      ? [titleRow]
      : [
          titleRow,
          {
            marker: { text: "  " },
            spans: [{ text: source.url, style: "muted" }],
          },
        ];
  });
  const remaining = sources.length - SOURCE_PREVIEW_COUNT;
  const overflow: TraceRow[] =
    remaining > 0 ? [{ spans: [{ text: `… ${remaining} more sources`, style: "muted" }] }] : [];
  return [{ spans: [{ text: count, style: "muted" }] }, ...rows, ...overflow];
}

function describeSearch(search: SearchDescription): TraceBlock {
  const { queries, provider } = search;
  const count = queries?.length === 1 ? "1 query" : `${queries?.length ?? 0} queries`;
  const metadata = queries?.length ? `${provider} · ${count}` : provider;
  const queryRows: TraceRow[] =
    queries?.map((query) => ({
      marker: { text: "·", style: "muted" },
      spans: [{ text: query }],
    })) ?? [];
  const missingQueries: TraceRow[] =
    queries?.length === 0 ? [{ spans: [{ text: "Queries not reported", style: "muted" }] }] : [];
  const sourceRows = search.sources === undefined ? [] : describeSources(search.sources);
  const errorRows: TraceRow[] =
    search.error === undefined ? [] : [{ spans: [{ text: search.error, style: "error" }] }];
  return {
    heading: toolHeading(SEARCH_HEADINGS[search.phase], search.toolName),
    rows: [
      { spans: [{ text: metadata, style: "muted" }] },
      ...queryRows,
      ...missingQueries,
      ...sourceRows,
      ...errorRows,
    ],
  };
}

function toolHeading(label: TraceSpan, toolName: string): TraceSpan[] {
  return [{ ...label, bold: true }, { text: "  " }, { text: toolName, style: "muted" }];
}

function describeToolStart(event: ToolStartEvent): TraceBlock {
  const rows: TraceRow[] = isPlainObject(event.args)
    ? Object.entries(event.args).map(([key, value]) => ({
        spans: [
          { text: key + ": ", style: "muted" },
          { text: serialize(value), limit: ARGUMENT_PREVIEW_LENGTH },
        ],
      }))
    : [{ spans: [{ text: serialize(event.args), limit: ARGUMENT_PREVIEW_LENGTH }] }];
  return {
    heading: toolHeading({ text: "● Tool call", style: "active" }, event.toolName),
    rows,
  };
}

function describeToolEnd(
  event: ToolEndEvent,
  heading: TraceSpan = OUTCOMES[event.outcome],
): TraceBlock {
  const text = typeof event.value === "string" ? event.value : serialize(event.value);
  const empty = event.value === null || event.value === undefined || event.value === "";
  const span: TraceSpan =
    event.outcome === "failure"
      ? { text, style: "error" }
      : { text, style: "muted", limit: RESULT_PREVIEW_LENGTH };
  return {
    heading: toolHeading(heading, event.toolName),
    rows: empty ? [] : [{ spans: [span] }],
  };
}

function serialize(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "[unserializable value]";
  } catch {
    return "[unserializable value]";
  }
}

function sanitize(text: string): string {
  const normalized = stripAnsi(text).replace(/\r\n/g, "\n");
  return stripControlCharacters(normalized).replace(/\t/g, " ".repeat(TAB_WIDTH));
}

function renderSpan(span: TraceSpan, options: TraceOptions): string {
  const clean = sanitize(span.text);
  const characters = Array.from(clean);
  const text =
    span.limit !== undefined && characters.length > span.limit
      ? characters.slice(0, span.limit).join("") + "…"
      : clean;
  const palette = options.color ? color : plainColor;
  const styles = {
    heading: palette.bold,
    muted: palette.dim,
    completed: palette.dim.strikethrough,
    active: palette.blue,
    success: palette.green,
    error: palette.red,
    warning: palette.yellow,
  };
  const style = span.style === undefined ? palette : styles[span.style];
  return span.bold ? style.bold(text) : style(text);
}

function renderBlock(block: TraceBlock, options: TraceOptions): string {
  const heading = renderLines(block.heading, "", HEADING_CONTINUATION, options);
  const rows = block.rows.flatMap((row) => {
    const rail = renderSpan({ text: BODY_PREFIX, style: "muted" }, options);
    const marker = row.marker ? renderSpan(row.marker, options) + " " : "";
    return renderLines(row.spans, rail + marker, rail + " ".repeat(visualWidth(marker)), options);
  });
  return [...heading, ...rows].join("\n");
}

function renderLines(
  spans: TraceSpan[],
  firstPrefix: string,
  continuationPrefix: string,
  options: TraceOptions,
): string[] {
  const columns = columnsOrDefault(options.columns);
  const prefixWidth = Math.max(visualWidth(firstPrefix), visualWidth(continuationPrefix));
  // At tiny widths, spend the available space on content instead of decoration.
  const prefixesFit = prefixWidth < columns;
  const width = prefixesFit ? columns - prefixWidth : columns;
  const content = spans.map((span) => renderSpan(span, options)).join("");
  return wrapText(content, width).map((line, index) => {
    const linePrefix = index === 0 ? firstPrefix : continuationPrefix;
    const prefix = prefixesFit ? linePrefix : "";
    const rendered = prefix + line;
    return options.color && rendered.includes("\x1b") && !rendered.endsWith(RESET)
      ? rendered + RESET
      : rendered;
  });
}
