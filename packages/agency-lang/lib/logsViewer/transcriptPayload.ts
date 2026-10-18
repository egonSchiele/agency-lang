import { contentText, type ToolCallRequest } from "../statelog/wireAccessors.js";
import { fmtTokens, fmtUsd } from "./format.js";
import {
  ARGUMENT_PREVIEW_CHARS,
  cutArguments,
  payloadFor,
  valuePayload,
  type PayloadLine,
} from "./payload.js";
import { fmtDuration, truncate } from "./spanText.js";
import { TOOL_STATUS_MARK, toolErrorMessages, toolStatusText } from "./story.js";
import { decisionInputPayload, decisionOutputPayload } from "./decision.js";
import { turnTimes } from "./timeline/turns.js";
import type { TranscriptBlock } from "./transcript.js";
import { fmtOffset } from "./views/shared.js";

/** How much of a tool's first argument its heading shows; Enter has the
 *  arguments whole. */
const HEADING_ARG_CHARS = 80;

export type TranscriptPayloadOptions = {
  /** Show interrupts that were approved; hidden by default, as on the trace. */
  showApprovals?: boolean;
};

export function transcriptPayload(
  block: TranscriptBlock,
  expanded: boolean,
  options: TranscriptPayloadOptions = {},
): PayloadLine[] {
  switch (block.kind) {
    case "system":
      return [
        {
          kind: "heading",
          text: `system prompt · ${block.text.split("\n").length} lines · s to ${expanded ? "hide" : "show"}`,
          tone: "chrome",
        },
        ...(expanded ? valuePayload(block.text) : []),
      ];
    case "user":
      return [
        {
          kind: "heading",
          text: block.promptTo === undefined ? "── USER ──" : `── PROMPT · ${block.promptTo} ──`,
          tone: "user",
        },
        ...valuePayload(block.text),
      ];
    case "handback":
      return [
        { kind: "heading", text: `── HAND-BACK · ${block.tool} ──`, tone: "tool" },
        ...valuePayload(block.text),
      ];
    case "turn":
      return turnPayload(block);
    case "thread": {
      const calls = `${block.calls} LLM ${block.calls === 1 ? "call" : "calls"}`;
      return [
        { kind: "heading", tone: "accent", text: `══ THREAD · ${block.label} · ${calls} ══` },
      ];
    }
    case "pause":
      return [
        {
          kind: "heading",
          tone: "interrupt",
          text:
            block.pausedMs === undefined
              ? "⏸ PAUSED · waiting for a response"
              : `⏸ PAUSED ${fmtDuration(block.pausedMs, { minutes: true })} · ▶ RESUMED`,
        },
      ];
    case "error":
      return [
        { kind: "heading", tone: "error", text: `✖ ERROR` },
        { kind: "text", text: block.error.message, indent: 0, role: "error" },
        ...(block.error.count > 1
          ? [
              {
                kind: "meta" as const,
                text: `logged ${block.error.count} times as it was rethrown`,
              },
            ]
          : []),
      ];
    case "rewrite":
      return [
        {
          kind: "heading",
          tone: "interrupt",
          text: `── ${block.label} ${changedWhere(block)} ── ${block.messagesBefore} messages → ${block.messagesAfter} · ${fmtTokens(block.tokensBefore)} → ${fmtTokens(block.tokensAfter)} tok ──`,
        },
      ];
    case "tool":
      return toolPayload(block, expanded, options);
    case "history":
      return [
        {
          kind: "heading",
          text: ["HISTORY", block.message.role, block.message.name, block.message.toolCallId]
            .filter(Boolean)
            .join(" · "),
          tone: "chrome",
        },
        ...valuePayload(contentText(block.message.content)),
        ...requestLines(block.message.toolCalls ?? []),
      ];
    case "assistant":
      if (block.round.decision !== undefined) {
        return [
          ...decisionInputPayload(block.round.decision),
          { kind: "blank" },
          ...decisionOutputPayload(block.round.decision),
        ];
      }
      return [
        ...valuePayload(block.structured ?? block.text ?? ""),
        ...requestLines(block.message?.toolCalls ?? []),
      ];
  }
}
/** `⏸ waited 9m54s for the user` when a wait preceded the turn, then the
 *  turn's title and one line of its work. */
function turnPayload(block: Extract<TranscriptBlock, { kind: "turn" }>): PayloadLine[] {
  const { workingMs } = turnTimes(block.turn);
  const calls = block.turn.rounds.length;
  const cost = fmtUsd(block.turn.rounds.reduce((sum, round) => sum + round.costUsd, 0));
  const title = block.turn.userText?.split("\n")[0].trim();
  return [
    ...(block.waitedMs === undefined || block.waitedMs <= 0
      ? []
      : [{ kind: "meta" as const, text: `⏸ waited ${fmtOffset(block.waitedMs)} for the user` }]),
    {
      kind: "heading",
      tone: "user",
      text: `══ TURN ${block.turn.index + 1}${title ? ` · ${title}` : ""} ══`,
    },
    {
      kind: "meta",
      text: [`ran ${fmtOffset(workingMs)}`, `${calls} LLM ${calls === 1 ? "call" : "calls"}`, cost]
        .filter(Boolean)
        .join(" · "),
    },
  ];
}
/** A tool's heading, its interrupts, its status when it did not complete,
 *  its errors, and on Enter the arguments and result in the trace's tool-row
 *  shape, then what the model read when that differs. */
function toolPayload(
  block: Extract<TranscriptBlock, { kind: "tool" }>,
  expanded: boolean,
  options: TranscriptPayloadOptions,
): PayloadLine[] {
  const symbol = TOOL_STATUS_MARK[block.row.status];
  const duration =
    block.row.durationMs === undefined
      ? "duration not recorded"
      : fmtDuration(block.row.durationMs);
  // An approved interrupt is the ordinary case and stays out of the way
  // until `p`, as on the trace; a rejection or a pending one always shows.
  const interrupts: PayloadLine[] = block.interrupts
    .filter((interrupt) => options.showApprovals || interrupt.outcome !== "approved")
    .flatMap((interrupt): PayloadLine[] => [
      {
        kind: "heading",
        tone: "interrupt",
        text: `⚠ ${interrupt.effect}  ${interrupt.outcome}`,
      },
      ...(expanded && interrupt.message ? valuePayload(interrupt.message) : []),
    ]);
  return [
    {
      kind: "heading",
      tone: ["failed", "rejected"].includes(block.row.status) ? "error" : "tool",
      text: `${symbol} ${block.row.name}(${truncate(block.row.argSummary.replace(/\s+/g, " "), HEADING_ARG_CHARS)})   ${block.outputLines} lines   ${duration}`,
    },
    ...interrupts,
    // A plain success says nothing more; any other status is stated.
    ...(block.row.status === "completed"
      ? []
      : [{ kind: "meta" as const, text: toolStatusText(block.row) }]),
    // The error is always in view; the arguments and output wait for Enter.
    ...toolErrorMessages(block.row).map((message) => ({
      kind: "text" as const,
      text: message,
      indent: 0,
      role: "error" as const,
    })),
    ...(expanded ? payloadFor(block.row, { raw: false }).slice(3) : []),
    ...(expanded && block.modelSaw !== undefined
      ? [
          { kind: "heading" as const, text: "→ WHAT THE MODEL READ", tone: "chrome" as const },
          ...valuePayload(block.modelSaw),
        ]
      : []),
  ];
}

/** Where a rewrite starts. A thread that was only cut short has no first
 *  changed message to point at, so it reads as cut after its last one. */
function changedWhere(block: { firstChangedAt: number; messagesAfter: number }): string {
  return block.firstChangedAt < block.messagesAfter
    ? `from message ${block.firstChangedAt + 1}`
    : `after message ${block.messagesAfter}`;
}
/** The calls a reply requested. Each argument is cut, as on the trace's
 *  call row, since the tool's own block follows with the arguments whole. */
function requestLines(calls: ToolCallRequest[]): PayloadLine[] {
  return calls.flatMap((call) => [
    {
      kind: "heading" as const,
      tone: "tool" as const,
      text: `TOOL CALL · ${call.name ?? "tool"} · ${call.id ?? "no call ID"}`,
    },
    ...valuePayload(cutArguments(call.arguments, ARGUMENT_PREVIEW_CHARS)),
  ]);
}
