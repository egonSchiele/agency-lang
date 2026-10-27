import { isPlainObject } from "../config/paths.js";
import type { Host } from "../host/host.js";
import { currentHost } from "../runtime/currentHost.js";
import { stripControlCharacters } from "../utils/controlCharacters.js";
import { color, plainColor, RESET } from "../utils/termcolors.js";
import { stripAnsi, visualWidth, wrapText } from "./layout/ansi.js";

export type TraceOptions = { columns: number; color: boolean };
export type ToolStartEvent = { kind: "toolStart"; toolName: string; args: unknown };
export type ToolEndEvent = {
  kind: "toolEnd";
  toolName: string;
  value: unknown;
  outcome: "success" | "failure" | "plain";
};
export type HostedSearchEvent = { kind: "hostedSearch"; result: unknown };
export type ClientSearchEvent = {
  kind: "clientSearch";
  toolName: string;
  provider: string;
  query: string;
};
export type SessionSaveFailureEvent = { kind: "sessionSaveFailure"; message: string };
export type AgentTraceEvent =
  ToolStartEvent | ToolEndEvent | HostedSearchEvent | ClientSearchEvent | SessionSaveFailureEvent;

type TraceStyle = "heading" | "muted" | "completed" | "active" | "success" | "error" | "warning";
type TraceSpan = { text: string; style?: TraceStyle; bold?: boolean; limit?: number };
type TraceRow = { spans: TraceSpan[]; marker?: TraceSpan };
type TraceBlock = { heading: TraceSpan[]; rows: TraceRow[] };

const DEFAULT_COLUMNS = 80;
const ARGUMENT_PREVIEW_LENGTH = 50;
const RESULT_PREVIEW_LENGTH = 100;
const TAB_WIDTH = 4;
const BODY_PREFIX = "  │ ";
const HEADING_CONTINUATION = "  ";

const OUTCOMES: Record<ToolEndEvent["outcome"], TraceSpan> = {
  success: { text: "✓ Tool finished", style: "success" },
  failure: { text: "✗ Tool failed", style: "error" },
  plain: { text: "· Tool returned", style: "heading" },
};

const TODO_HEADINGS: Record<string, TraceSpan> = {
  todoWrite: { text: "✓ Tasks updated", style: "success" },
  todoAdd: { text: "✓ Tasks updated", style: "success" },
  todoUpdate: { text: "✓ Tasks updated", style: "success" },
  todoList: { text: "Tasks", style: "heading" },
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
      if (Object.hasOwn(TODO_HEADINGS, event.toolName)) {
        return describeToolStart({ ...event, args: {} });
      }
      return describeToolStart(event);
    case "toolEnd":
      if (
        Object.hasOwn(TODO_HEADINGS, event.toolName) &&
        event.outcome !== "failure" &&
        isTodoList(event.value)
      ) {
        return describeTodos(event.toolName, event.value);
      }
      return describeToolEnd(event);
    case "hostedSearch":
      return describeHostedSearch(event.result);
    case "clientSearch":
      return describeSearch("⌕ Searching web", event.toolName, event.provider, [event.query]);
    case "sessionSaveFailure":
      return {
        heading: [{ text: "! Session not saved", style: "warning", bold: true }],
        rows: [{ spans: [{ text: event.message }] }],
      };
  }
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

function describeTodos(toolName: string, todos: Todo[]): TraceBlock {
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
    heading: toolHeading(TODO_HEADINGS[toolName], toolName),
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
  return describeSearch("⌕ Web search", "web_search", provider, queries);
}

function describeSearch(
  label: string,
  toolName: string,
  provider: string,
  queries: string[],
): TraceBlock {
  const count = queries.length === 1 ? "1 query" : `${queries.length} queries`;
  const metadata = queries.length === 0 ? provider : `${provider} · ${count}`;
  const queryRows: TraceRow[] =
    queries.length === 0
      ? [{ spans: [{ text: "Queries not reported", style: "muted" }] }]
      : queries.map((query) => ({
          marker: { text: "·", style: "muted" },
          spans: [{ text: query }],
        }));
  return {
    heading: toolHeading({ text: label, style: "heading" }, toolName),
    rows: [{ spans: [{ text: metadata, style: "muted" }] }, ...queryRows],
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
    heading: toolHeading({ text: "● Tool call", style: "heading" }, event.toolName),
    rows,
  };
}

function describeToolEnd(event: ToolEndEvent): TraceBlock {
  const text = typeof event.value === "string" ? event.value : serialize(event.value);
  const empty = event.value === null || event.value === undefined || event.value === "";
  const span: TraceSpan =
    event.outcome === "failure" ? { text, style: "error" } : { text, limit: RESULT_PREVIEW_LENGTH };
  return {
    heading: toolHeading(OUTCOMES[event.outcome], event.toolName),
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
