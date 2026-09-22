import { isDeepStrictEqual } from "node:util";
import {
  completionMessageOf,
  contentText,
  toolReplyContent,
  threadIdOf,
  threadIdentityOf,
  type ToolCallRequest,
} from "../statelog/wireAccessors.js";
import { ancestorsOf, buildTreeIndex, walkNodes, type TreeIndex } from "./forest.js";
import {
  messageKey,
  messagesOf,
  roundDeltas,
  type HistoryRewrite,
  type WireMessage,
} from "./messageDelta.js";
import { childEvent } from "./spanText.js";
import {
  ownedToolNodes,
  storyOutline,
  toolStatusText,
  type StoryRow,
  type ToolStoryRow,
  type Interrupt,
} from "./story.js";
import { decodeStructured } from "./structured.js";
import { roundsOf, type Round, type ThreadKey } from "./timeline/rounds.js";
import type { TreeNode } from "./types.js";

type BlockBase = { id: string; roundId: string | undefined; thread: ThreadKey };
export type TranscriptBlock = BlockBase &
  (
    | { kind: "system"; text: string }
    | { kind: "user"; text: string }
    | { kind: "history"; message: WireMessage; text: string }
    | {
        kind: "assistant";
        round: Round;
        text: string | undefined;
        structured: unknown | undefined;
        message: WireMessage | undefined;
      }
    | {
        kind: "tool";
        row: ToolStoryRow;
        interrupts: Interrupt[];
        output: string | undefined;
        outputLines: number;
      }
    | ({ kind: "rewrite"; label: "CONTEXT COMPACTED" | "HISTORY REWRITTEN" } & HistoryRewrite)
  );
type ThreadHistory = { pending: WireMessage[]; systems: string[]; previousEnd: number };
export function threadKey(thread: ThreadKey): string {
  return JSON.stringify([thread.kind, thread.id]);
}
export function consumeRepresented(message: WireMessage, pending: WireMessage[]): boolean {
  const position = pending.findIndex((candidate) => messageKey(candidate) === messageKey(message));
  if (position < 0) {
    return false;
  }
  pending.splice(position, 1);
  return true;
}
export function transcriptBlocks(trace: TreeNode): TranscriptBlock[] {
  const index = buildTreeIndex(trace);
  const rounds = roundsOf(trace, index);
  const deltas = roundDeltas(rounds);
  const story = storyOutline(trace, { admin: false });
  const threads: Record<string, ThreadHistory> = Object.create(null);
  const compactions = walkNodes(trace)
    .filter((node) => node.event?.data.type === "memoryCompaction")
    .map((node) => ({
      at: Date.parse(node.event!.data.timestamp),
      thread: compactionThread(node, rounds, index),
    }));
  return rounds.flatMap((round, position) => {
    const state = (threads[threadKey(round.thread)] ??= {
      pending: [],
      systems: [],
      previousEnd: -Infinity,
    });
    const delta = deltas[position];
    const blocks: TranscriptBlock[] = [];
    const base = { roundId: round.id, thread: round.thread };
    if (delta.rewrite) {
      state.pending = [];
      const compacted = compactions.some(
        ({ at, thread }) =>
          thread !== undefined &&
          threadKey(thread) === threadKey(round.thread) &&
          state.previousEnd < at &&
          at <= round.end,
      );
      blocks.push({
        ...base,
        id: `${round.id}:rewrite`,
        kind: "rewrite",
        label: compacted ? "CONTEXT COMPACTED" : "HISTORY REWRITTEN",
        ...delta.rewrite,
      });
    }
    const offset = messagesOf(round).length - delta.added.length;
    for (const [position, message] of delta.added.entries()) {
      const text = messageText(message);
      if (message.role === "system") {
        if (!state.systems.includes(text)) {
          state.systems.push(text);
          blocks.push({
            ...base,
            roundId: undefined,
            id: `system:${round.id}:${offset + position}`,
            kind: "system",
            text,
          });
        }
      } else if (message.role === "user") {
        blocks.push({ ...base, id: `${round.id}:user:${offset + position}`, kind: "user", text });
      } else if (!consumeRepresented(message, state.pending)) {
        blocks.push({
          ...base,
          id: `${round.id}:history:${offset + position}`,
          kind: "history",
          text,
          message,
        });
      }
    }
    const message = completionMessageOf(round.node.event!);
    const text = message === undefined ? undefined : contentText(message.content);
    blocks.push({
      ...base,
      id: round.id,
      kind: "assistant",
      round,
      text,
      structured: text === undefined ? undefined : decodeStructured(text),
      message,
    });
    const tools = childrenOf(story, round.id).filter(
      (row): row is ToolStoryRow => row.kind === "tool",
    );
    const toolBlocks = tools.map((row) => toolBlock(round, row, story));
    blocks.push(...toolBlocks);
    state.pending = [
      ...(message ? [message] : []),
      ...representedTools(tools, message?.toolCalls ?? []),
    ];
    state.previousEnd = round.end;
    return blocks;
  });
}
function childrenOf(story: StoryRow[], id: string): StoryRow[] {
  const position = story.findIndex((row) => row.id === id);
  if (position < 0) {
    return [];
  }
  const parent = story[position];
  const next = story.slice(position + 1).findIndex((row) => row.depth <= parent.depth);
  const end = next < 0 ? story.length : position + 1 + next;
  return story.slice(position + 1, end).filter((row) => row.depth === parent.depth + 1);
}
function toolBlock(round: Round, row: ToolStoryRow, story: StoryRow[]): TranscriptBlock {
  const finished = childEvent(row.node, "toolCall");
  const value = finished === undefined ? undefined : toolReplyContent(finished);
  const output = finished === undefined ? undefined : contentText(value ?? finished.data.output);
  const interrupts = childrenOf(story, row.id).flatMap((child) =>
    child.kind === "interrupt" ? [child.interrupt] : [],
  );
  return {
    kind: "tool",
    id: row.id,
    roundId: round.id,
    thread: round.thread,
    row,
    interrupts,
    output,
    outputLines: output ? output.split("\n").length : 0,
  };
}
function compactionThread(
  node: TreeNode,
  rounds: Round[],
  index: TreeIndex,
): ThreadKey | undefined {
  const identity = threadIdentityOf(node.event!);
  if (identity !== null) {
    return { kind: "recorded", id: identity };
  }
  const localId = threadIdOf(node.event!);
  for (const ancestor of ancestorsOf(node, index)) {
    const enclosing = rounds.filter((round) => round.spanId === ancestor.id);
    if (enclosing.length === 0) {
      continue;
    }
    const candidates = enclosing.filter(
      (round) => localId === null || threadIdOf(round.node.event!) === localId,
    );
    const first = candidates[0]?.thread;
    return first && candidates.every((round) => threadKey(round.thread) === threadKey(first))
      ? first
      : undefined;
  }
  return undefined;
}

function matchesRequest(tool: ToolStoryRow, request: ToolCallRequest): boolean {
  if (request.name !== tool.name) {
    return false;
  }
  const started = childEvent(tool.node, "toolCallStart");
  const finished = childEvent(tool.node, "toolCall");
  const id = finished?.data.toolCallId ?? started?.data.toolCallId;
  if (typeof id === "string" && id.length > 0) {
    return request.id === id;
  }
  const args = (started ?? finished)?.data.args;
  if (request.arguments === undefined) {
    return false;
  }
  if (
    !args ||
    typeof args !== "object" ||
    Array.isArray(args) ||
    !request.arguments ||
    typeof request.arguments !== "object" ||
    Array.isArray(request.arguments)
  ) {
    return isDeepStrictEqual(request.arguments, args);
  }
  // Defaulted null arguments are omitted from the recorded call. Nulls
  // retained in the record, including nested values, must still match.
  const normalized = Object.fromEntries(
    Object.entries(request.arguments).filter(
      ([key, value]) => value !== null || Object.hasOwn(args, key),
    ),
  );
  return isDeepStrictEqual(normalized, args);
}

function representedTools(tools: ToolStoryRow[], requests: ToolCallRequest[]): WireMessage[] {
  return tools.flatMap((tool) => {
    const finished = childEvent(tool.node, "toolCall");
    const matching = requests.filter((request) => matchesRequest(tool, request));
    const request = matching[0];
    if (
      tool.status !== "completed" ||
      !finished ||
      matching.length !== 1 ||
      !request.id ||
      tools.filter((other) => matchesRequest(other, request)).length !== 1
    ) {
      return [];
    }
    const content = toolReplyContent(finished);
    if (content === undefined) {
      return [];
    }
    return [{ role: "tool", name: tool.name, toolCallId: request.id, content }];
  });
}
export function messageText(message: WireMessage): string {
  const requests = (message.toolCalls ?? []).map(
    (call) =>
      `${call.name ?? "tool"} [${call.id ?? "no call ID"}] ${JSON.stringify(call.arguments) ?? ""}`,
  );
  return [contentText(message.content), ...requests].filter(Boolean).join("\n");
}
export function transcriptText(block: TranscriptBlock): string {
  switch (block.kind) {
    case "assistant":
      return block.message ? messageText(block.message) : (block.text ?? "");
    case "tool":
      return [
        block.row.name,
        toolStatusText(block.row),
        ...ownedToolNodes(block.row.node, buildTreeIndex(block.row.node))
          .filter((node) => node.event?.data.type === "error")
          .map((node) => String(node.event!.data.message ?? "error")),
        JSON.stringify(
          (childEvent(block.row.node, "toolCallStart") ?? childEvent(block.row.node, "toolCall"))
            ?.data.args,
        ),
        block.output,
        ...block.interrupts.map(
          (interrupt) => `${interrupt.effect} ${interrupt.outcome} ${interrupt.message}`,
        ),
      ]
        .filter(Boolean)
        .join("\n");
    case "rewrite":
      return `${block.label}: ${block.messagesBefore} messages → ${block.messagesAfter} · ${block.tokensBefore} → ${block.tokensAfter} tok`;
    case "history":
      return [block.message.role, block.message.name, block.message.toolCallId, block.text]
        .filter(Boolean)
        .join("\n");
    default:
      return block.text;
  }
}
