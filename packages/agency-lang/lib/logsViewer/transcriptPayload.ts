import { contentText, type ToolCallRequest } from "../statelog/wireAccessors.js";
import { fmtTokens, fmtUsd } from "./format.js";
import { hostedCallTitle } from "./hostedCalls.js";
import {
  ARGUMENT_PREVIEW_CHARS,
  cutArguments,
  payloadFor,
  resultTokenEstimate,
  valuePayload,
  type PayloadLine,
} from "./payload.js";
import { systemPromptPayload } from "./roundInputPayload.js";
import { childEvent, fmtDuration, truncate } from "./spanText.js";
import { TOOL_STATUS_MARK, toolErrorMessages, toolStatusText } from "./story.js";
import { decisionInputPayload, decisionOutputPayload } from "./decision.js";
import { turnTimes } from "./timeline/turns.js";
import type { TranscriptBlock } from "./transcript.js";
import { fmtOffset } from "./views/shared.js";

/** The names a reply's `→ 4 tool calls` line lists before it is cut. */
const REQUEST_NAMES_CHARS = 60;

export type TranscriptPayloadOptions = {
  /** Show interrupts that were approved; hidden by default, as on the trace. */
  showApprovals?: boolean;
  /** The block is a thread row whose group is folded away. */
  folded?: boolean;
};

export function transcriptPayload(
  block: TranscriptBlock,
  expanded: boolean,
  options: TranscriptPayloadOptions = {},
): PayloadLine[] {
  switch (block.kind) {
    case "system":
      return systemPromptPayload("system", block.text, expanded);
    case "user":
      return [
        {
          kind: "heading",
          text: block.promptTo === undefined ? "USER" : `PROMPT · ${block.promptTo}`,
          tone: "user",
        },
        ...valuePayload(block.text),
      ];
    case "handback":
      return [
        { kind: "heading", text: `HAND-BACK · ${block.tool}`, tone: "tool" },
        ...valuePayload(block.text),
      ];
    case "turn":
      return turnPayload(block);
    case "thread": {
      const calls = `${block.calls} LLM ${block.calls === 1 ? "call" : "calls"}`;
      const folded = options.folded ? " ▸ folded · Enter opens" : "";
      return [
        {
          kind: "heading",
          tone: "accent",
          text: `══ THREAD · ${block.label} · ${calls} ══${folded}`,
        },
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
        { kind: "heading", tone: "error", text: "✖ ERROR" },
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
    case "hosted":
      return hostedPayload(block, expanded);
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
      return assistantPayload(block);
  }
}
/** The reply's text, then one line naming the tools it asked for, since
 *  each has its own block next. A request no block stands for is shown
 *  here whole. */
function assistantPayload(block: Extract<TranscriptBlock, { kind: "assistant" }>): PayloadLine[] {
  const decision = block.round.decision === undefined ? "" : " · decision";
  const heading: PayloadLine = {
    kind: "heading",
    tone: "assistant",
    text: `ASSISTANT · LLM call ${block.round.index + 1}${decision}`,
  };
  if (block.round.decision !== undefined) {
    return [
      heading,
      ...decisionInputPayload(block.round.decision),
      { kind: "blank" },
      ...decisionOutputPayload(block.round.decision),
    ];
  }
  const requests = block.message?.toolCalls ?? [];
  const text = block.structured ?? block.text ?? "";
  const names = truncate(
    requests.map((call) => call.name ?? "tool").join(", "),
    REQUEST_NAMES_CHARS,
  );
  return [
    heading,
    ...(text === "" && requests.length > 0 ? [] : valuePayload(text)),
    ...(requests.length === 0
      ? []
      : [
          {
            kind: "meta" as const,
            text: `→ ${requests.length} tool ${requests.length === 1 ? "call" : "calls"} · ${names}`,
          },
        ]),
    ...requestLines(block.unpaired),
  ];
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
/** `TOOL CALL · name`, the arguments cut as on the trace's call row, the
 *  tool's interrupts, its status when it did not complete, its errors, and
 *  the result's first line under a `RESULT` rule; on Enter the arguments
 *  and result whole in the trace's tool-row shape, then what the model
 *  read when that differs. */
function toolPayload(
  block: Extract<TranscriptBlock, { kind: "tool" }>,
  expanded: boolean,
  options: TranscriptPayloadOptions,
): PayloadLine[] {
  const failed = ["failed", "rejected"].includes(block.row.status);
  const mark = failed ? `${TOOL_STATUS_MARK[block.row.status]} ` : "";
  const started =
    childEvent(block.row.node, "toolCallStart") ?? childEvent(block.row.node, "toolCall");
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
      tone: failed ? "error" : "tool",
      text: `${mark}TOOL CALL · ${block.row.name}`,
    },
    ...(expanded ? [] : valuePayload(cutArguments(started?.data.args, ARGUMENT_PREVIEW_CHARS))),
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
    ...(expanded ? expandedToolBody(block) : resultPreview(block)),
  ];
}
/** The trace's tool detail after its three header lines, with its
 *  `→ RESULT` heading drawn as the rule the collapsed box used, so the
 *  box keeps its shape when it opens; then what the model read. */
function expandedToolBody(block: Extract<TranscriptBlock, { kind: "tool" }>): PayloadLine[] {
  const detail = payloadFor(block.row, { raw: false })
    .slice(3)
    .map((line): PayloadLine =>
      line.kind === "heading" && line.text.startsWith("→ RESULT")
        ? { kind: "rule", text: line.text.slice(2), tone: "tool" }
        : line,
    );
  return [
    ...detail,
    ...(block.modelSaw === undefined
      ? []
      : [
          { kind: "rule" as const, text: "WHAT THE MODEL READ", tone: "chrome" as const },
          ...valuePayload(block.modelSaw),
        ]),
  ];
}
/** The result's first line under its rule, and how much more Enter has. */
function resultPreview(block: Extract<TranscriptBlock, { kind: "tool" }>): PayloadLine[] {
  const finished = childEvent(block.row.node, "toolCall");
  if (block.output === undefined || finished === undefined) {
    return [];
  }
  const lines = block.output.split("\n");
  const more = lines.length - 1;
  return [
    {
      kind: "rule",
      tone: "tool",
      text: `RESULT · ~${fmtTokens(resultTokenEstimate(finished.data.output))} tokens`,
    },
    { kind: "text", text: lines[0], indent: 0, role: "plain", oneRow: true },
    {
      kind: "meta",
      text:
        more > 0
          ? `… (+${more} more ${more === 1 ? "line" : "lines"} · Enter opens)`
          : "(Enter opens)",
    },
  ];
}

/** A tool the provider ran inside the call above it. Collapsed, the box
 *  says what it did in one line; Enter shows the trace's detail for it. */
function hostedPayload(
  block: Extract<TranscriptBlock, { kind: "hosted" }>,
  expanded: boolean,
): PayloadLine[] {
  const { call } = block.row;
  const heading: PayloadLine = {
    kind: "heading",
    tone: call.failed ? "error" : "tool",
    text: hostedCallTitle(call),
  };
  if (expanded) {
    return [heading, ...payloadFor(block.row, { raw: false }).slice(1)];
  }
  return [
    heading,
    ...(call.gist === ""
      ? []
      : [
          {
            kind: "text" as const,
            text: call.gist,
            indent: 0,
            role: "plain" as const,
            oneRow: true,
          },
        ]),
    { kind: "meta", text: "(Enter opens)" },
  ];
}
/** Where a rewrite starts. A thread that was only cut short has no first
 *  changed message to point at, so it reads as cut after its last one. */
function changedWhere(block: { firstChangedAt: number; messagesAfter: number }): string {
  return block.firstChangedAt < block.messagesAfter
    ? `from message ${block.firstChangedAt + 1}`
    : `after message ${block.messagesAfter}`;
}
/** Requested calls that have no tool block of their own: a request no
 *  tool ran, or one in seeded history. Their arguments are shown whole,
 *  since nothing else will show them. */
function requestLines(calls: ToolCallRequest[]): PayloadLine[] {
  return calls.flatMap((call) => [
    {
      kind: "heading" as const,
      tone: "tool" as const,
      text: `TOOL CALL · ${call.name ?? "tool"} · ${call.id ?? "no call ID"}`,
    },
    ...valuePayload(call.arguments),
  ]);
}
