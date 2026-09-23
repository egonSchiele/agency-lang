import { contentText, type ToolCallRequest } from "../statelog/wireAccessors.js";
import { fmtTokens } from "./format.js";
import { payloadFor, valuePayload, type PayloadLine } from "./payload.js";
import { fmtDuration } from "./spanText.js";
import { toolStatusText } from "./story.js";
import type { TranscriptBlock } from "./transcript.js";

export function transcriptPayload(block: TranscriptBlock, expanded: boolean): PayloadLine[] {
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
      return [{ kind: "heading", text: "── USER ──", tone: "user" }, ...valuePayload(block.text)];
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
      return [
        ...valuePayload(block.structured ?? block.text ?? ""),
        ...requestLines(block.message?.toolCalls ?? []),
      ];
    case "rewrite":
      return [
        {
          kind: "heading",
          tone: "interrupt",
          text: `── ${block.label} ── ${block.messagesBefore} messages → ${block.messagesAfter} · ${fmtTokens(block.tokensBefore)} → ${fmtTokens(block.tokensAfter)} tok ──`,
        },
      ];
    case "tool": {
      const symbol = {
        completed: "→",
        failed: "✖",
        rejected: "✖",
        awaitingApproval: "⚠",
        unfinished: "⋯",
      }[block.row.status];
      const duration =
        block.row.durationMs === undefined
          ? "duration not recorded"
          : fmtDuration(block.row.durationMs);
      const interrupts: PayloadLine[] = block.interrupts.flatMap((interrupt): PayloadLine[] => [
        { kind: "heading", tone: "interrupt", text: `⚠ ${interrupt.effect}  ${interrupt.outcome}` },
        ...(expanded && interrupt.message ? valuePayload(interrupt.message) : []),
      ]);
      return [
        {
          kind: "heading",
          tone: ["failed", "rejected"].includes(block.row.status) ? "error" : "tool",
          text: `${symbol} ${block.row.name}(${block.row.argSummary})   ${block.outputLines} lines   ${duration}`,
        },
        ...interrupts,
        { kind: "meta", text: toolStatusText(block.row) },
        ...(expanded ? payloadFor(block.row, { raw: false }).slice(3) : []),
      ];
    }
  }
}
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
