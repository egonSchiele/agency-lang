import { isPlainObject } from "../config/paths.js";
import type { Host } from "../host/host.js";
import { currentHost } from "../runtime/currentHost.js";
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
export type SessionSaveFailureEvent = { kind: "sessionSaveFailure"; message: string };
export type AgentTraceEvent =
  ToolStartEvent | ToolEndEvent | HostedSearchEvent | SessionSaveFailureEvent;

type TraceStyle = "heading" | "muted" | "completed" | "active" | "success" | "error" | "warning";
type TraceSpan = { text: string; style?: TraceStyle; limit?: number };
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
      return describeToolStart(event);
    case "toolEnd":
      return describeToolEnd(event);
    case "hostedSearch":
      return null;
    case "sessionSaveFailure":
      return {
        heading: [{ text: "! Session not saved", style: "warning" }],
        rows: [{ spans: [{ text: event.message }] }],
      };
  }
}

function toolHeading(label: TraceSpan, toolName: string): TraceSpan[] {
  return [label, { text: "  " }, { text: toolName, style: "muted" }];
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
  return stripAnsi(text)
    .replace(/\r\n/g, "\n")
    .replace(/\t/g, " ".repeat(TAB_WIDTH))
    .replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/g, "�");
}

function renderSpan(span: TraceSpan, options: TraceOptions): string {
  const clean = sanitize(span.text);
  const text =
    span.limit !== undefined && clean.length > span.limit
      ? clean.slice(0, span.limit) + "…"
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
  return span.style === undefined ? text : styles[span.style](text);
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
