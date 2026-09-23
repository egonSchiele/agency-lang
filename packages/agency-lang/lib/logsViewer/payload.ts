import {
  completionOf,
  normalizeMessage,
  hasTokenUsage,
  tokensCacheWrite,
} from "../statelog/wireAccessors.js";
import { buildTreeIndex } from "./forest.js";
import { fmtTokens, fmtUsd } from "./format.js";
import { childEvent, fmtDuration } from "./spanText.js";
import { decodeStructured, structuredLines, type StructuredLine } from "./structured.js";
import {
  ownedToolNodes,
  toolStatusText,
  type StoryRow,
  type RoundStoryRow,
  type ToolStoryRow,
  type InterruptStoryRow,
  type ErrorStoryRow,
  type LlmGroupStoryRow,
} from "./story.js";
import type { Round } from "./timeline/rounds.js";
export type PayloadLine =
  | {
      kind: "heading";
      text: string;
      tone: "assistant" | "tool" | "interrupt" | "error" | "user" | "chrome";
    }
  | { kind: "meta"; text: string }
  | { kind: "text"; text: string; indent: number; role: StructuredLine["role"] | "plain" | "error" }
  | { kind: "code"; text: string; language: string; indent?: number }
  | { kind: "json"; text: string }
  | { kind: "blank" };
export type PayloadOptions = { raw: boolean };
type PayloadMakers = {
  [Kind in StoryRow["kind"]]: (row: Extract<StoryRow, { kind: Kind }>) => PayloadLine[];
};
const PAYLOADS: PayloadMakers = {
  round: roundPayload,
  user: (row) => [{ kind: "heading", text: "USER", tone: "user" }, ...valuePayload(row.text)],
  tool: toolPayload,
  interrupt: interruptPayload,
  error: errorPayload,
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
  const make = PAYLOADS[row.kind] as (row: StoryRow) => PayloadLine[];
  return make(row);
}
function rawPayload(row: StoryRow): PayloadLine[] {
  const events = row.node.event
    ? [row.node.event]
    : row.node.children.flatMap((child) => (child.event ? [child.event] : []));
  return events.flatMap((event) =>
    JSON.stringify(event, null, 2)
      .split("\n")
      .map((text) => ({ kind: "json" as const, text })),
  );
}
function roundPayload(row: RoundStoryRow): PayloadLine[] {
  const round = row.round;
  return [
    { kind: "heading", text: `ASSISTANT · LLM call ${round.index + 1}`, tone: "assistant" },
    {
      kind: "meta",
      text: `${round.model} · ${fmtDuration(round.durationMs)} · ${fmtUsd(round.costUsd)}`,
    },
    {
      kind: "meta",
      text: roundTokenSummary(row),
    },
    { kind: "blank" },
    ...roundResponsePayload(round),
  ];
}

function llmGroupPayload(row: LlmGroupStoryRow): PayloadLine[] {
  const rounds = row.rounds;
  const models = rounds.map((round) => round.model).filter(Boolean);
  const threads = rounds.map((round) => round.threadLabel).filter(Boolean);
  const unique = (values: (string | undefined)[]): string =>
    values.filter((value, index) => values.indexOf(value) === index).join(", ") || "not recorded";
  const latest = rounds.at(-1);
  const lines: PayloadLine[] = [
    { kind: "heading", text: `THREAD · ${row.label}`, tone: "assistant" },
    { kind: "meta", text: `Tool: ${row.toolName}` },
    { kind: "meta", text: `Thread: ${unique(threads)}` },
    { kind: "meta", text: `Model: ${unique(models)}` },
    {
      kind: "meta",
      text: `${rounds.length} completed LLM ${rounds.length === 1 ? "call" : "calls"}`,
    },
    {
      kind: "meta",
      text: `LLM time: ${fmtDuration(rounds.reduce((sum, round) => sum + round.durationMs, 0))} · Cost: ${fmtUsd(rounds.reduce((sum, round) => sum + round.costUsd, 0)) || "$0"}`,
    },
    {
      kind: "meta",
      text: "Metrics cover these calls; nested tools are excluded. Press r for raw events.",
    },
  ];
  if (latest) {
    lines.push(
      { kind: "blank" },
      {
        kind: "heading",
        text: `Latest response · LLM call ${latest.index + 1}`,
        tone: "assistant",
      },
      ...roundResponsePayload(latest),
    );
  }
  return lines;
}

export function roundResponsePayload(round: Round): PayloadLine[] {
  const event = round.node.event!;
  const calls = normalizeMessage({ role: "assistant", ...event.data.completion }).toolCalls ?? [];
  return [
    ...valuePayload(completionOf(event) ?? ""),
    ...calls.flatMap((call) => [
      {
        kind: "heading" as const,
        text: `TOOL CALL · ${call.name ?? "tool"}`,
        tone: "tool" as const,
      },
      ...valuePayload(call.arguments),
    ]),
  ];
}
function roundTokenSummary(row: RoundStoryRow): string {
  const event = row.node.event!;
  if (!hasTokenUsage(event)) {
    return "context ? · fresh ? · out ?";
  }
  const round = row.round;
  const written = tokensCacheWrite(event);
  const writes = written > 0 ? `, ${fmtTokens(written)} write` : "";
  return `context ${fmtTokens(round.contextTokens)} (${fmtTokens(round.cachedTokens)} cached${writes}) · fresh ${fmtTokens(round.freshTokens)} · out ${fmtTokens(round.outputTokens)}`;
}
function toolPayload(row: ToolStoryRow): PayloadLine[] {
  const started = childEvent(row.node, "toolCallStart");
  const finished = childEvent(row.node, "toolCall");
  const owned = ownedToolNodes(row.node, buildTreeIndex(row.node));
  const errors = owned.filter((node) => node.event?.data.type === "error");
  const output: PayloadLine[] = [
    { kind: "heading", text: `TOOL · ${row.name}`, tone: "tool" },
    { kind: "meta", text: toolStatusText(row) },
    {
      kind: "meta",
      text: row.durationMs === undefined ? "duration not recorded" : fmtDuration(row.durationMs),
    },
    { kind: "heading", text: "Arguments", tone: "chrome" },
    ...valuePayload((started ?? finished)?.data.args),
    ...errors.map((node) => ({
      kind: "text" as const,
      text: String(node.event!.data.message ?? "error"),
      indent: 0,
      role: "error" as const,
    })),
  ];
  if (finished !== undefined) {
    output.push(
      { kind: "heading", text: "Output", tone: "chrome" },
      {
        kind: "meta",
        text: `result: ~${fmtTokens(resultTokenEstimate(finished.data.output))} tokens`,
      },
      ...valuePayload(finished.data.output),
    );
  }
  return output;
}
function resultTokenEstimate(output: unknown): number {
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
    if (line.role !== "text") {
      output.push({ kind: "text", ...line });
      continue;
    }
    const block = [line.text];
    while (lines[position + 1]?.role === "text" && lines[position + 1].indent === line.indent) {
      block.push(lines[++position].text);
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
