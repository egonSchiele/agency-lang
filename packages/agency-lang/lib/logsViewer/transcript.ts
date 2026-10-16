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
  storyChildren,
  storyOutline,
  toolErrorMessages,
  toolResultText,
  toolStatusText,
  type StoryRow,
  type ToolStoryRow,
  type Interrupt,
} from "./story.js";
import { decodeStructured } from "./structured.js";
import { traceErrors, type TraceError } from "./problems.js";
import { roundsOf, type Round, type ThreadKey } from "./timeline/rounds.js";
import type { TreeNode } from "./types.js";

/** `at` orders blocks by the time of the event each one comes from, so an
 *  error block lands where the error happened and not at a round's end. */
type BlockBase = {
  id: string;
  roundId: string | undefined;
  thread: ThreadKey;
  at: number;
  /** The thread's name, as `Round.threadLabel` gives it; undefined reads as `unnamed`. */
  threadLabel: string | undefined;
  /** How many tool calls deep the thread was started: the call list indents by it. */
  depth: number;
};
export type TranscriptBlock = BlockBase &
  (
    | { kind: "system"; text: string }
    | { kind: "thread"; label: string }
    | { kind: "error"; error: TraceError }
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
  // Errors inside a tool call show in that tool's block. The rest get a
  // block of their own, placed by time on the thread they happened in.
  const loose = traceErrors(trace, index)
    .filter((error) => error.toolId === undefined)
    .map((error) => ({ error, thread: errorThread(error.node, rounds, index) }));
  const compactions = walkNodes(trace)
    .filter((node) => node.event?.data.type === "memoryCompaction")
    .map((node) => ({
      at: Date.parse(node.event!.data.timestamp),
      thread: compactionThread(node, rounds, index),
    }));
  const roundBlocks = rounds.flatMap((round, position) => {
    const state = (threads[threadKey(round.thread)] ??= {
      pending: [],
      systems: [],
      previousEnd: -Infinity,
    });
    const delta = deltas[position];
    const blocks: TranscriptBlock[] = [];
    const base = {
      roundId: round.id,
      thread: round.thread,
      at: round.start,
      threadLabel: round.threadLabel,
      depth: toolDepth(round.node, index),
    };
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
      at: round.end,
      id: round.id,
      kind: "assistant",
      round,
      text,
      structured: text === undefined ? undefined : decodeStructured(text),
      message,
    });
    const tools = storyChildren(story, round.id).filter(
      (row): row is ToolStoryRow => row.kind === "tool",
    );
    const toolBlocks = tools.map((row) => toolBlock(round, row, story, index));
    blocks.push(...toolBlocks);
    state.pending = [
      ...(message ? [message] : []),
      ...representedTools(tools, message?.toolCalls ?? []),
    ];
    state.previousEnd = round.end;
    return blocks;
  });
  return withThreadDividers(withErrorBlocks(roundBlocks, loose));
}
/** A `thread` block wherever the conversation moves to another thread, so
 *  a sub-agent's calls no longer sit in one flat list with the main
 *  conversation's. The divider takes the thread of the block it opens. */
function withThreadDividers(blocks: TranscriptBlock[]): TranscriptBlock[] {
  const keys = blocks.map((block) => threadKey(block.thread));
  // One thread needs no dividers.
  if (keys.every((key) => key === keys[0])) {
    return blocks;
  }
  const out: TranscriptBlock[] = [];
  let current: string | undefined;
  for (const block of blocks) {
    const key = threadKey(block.thread);
    if (key !== current) {
      current = key;
      out.push({
        kind: "thread",
        id: `thread:${block.id}`,
        roundId: undefined,
        thread: block.thread,
        at: block.at,
        threadLabel: block.threadLabel,
        depth: block.depth,
        label: block.threadLabel ?? "unnamed",
      });
    }
    out.push(block);
  }
  return out;
}
/** How many tool calls enclose a completion: the thread's nesting depth. */
function toolDepth(node: TreeNode, index: TreeIndex): number {
  return ancestorsOf(node, index).filter((ancestor) => ancestor.label === "toolExecution").length;
}
/** Each loose error goes before the first later block on its thread, or
 *  before the first later block anywhere when its thread is unknown, so
 *  the transcript reads in time order. An error after every block goes
 *  at the end. */
type ErrorThread = { key: ThreadKey; label: string | undefined; depth: number };
function withErrorBlocks(
  blocks: TranscriptBlock[],
  loose: { error: TraceError; thread: ErrorThread | undefined }[],
): TranscriptBlock[] {
  const out = [...blocks];
  for (const { error, thread } of loose) {
    const block: TranscriptBlock = {
      kind: "error",
      id: `error:${error.id}`,
      roundId: undefined,
      thread: thread?.key ?? { kind: "legacy", id: "" },
      at: error.at,
      threadLabel: thread?.label,
      depth: thread?.depth ?? 0,
      error,
    };
    const position = out.findIndex(
      (candidate) =>
        candidate.at > error.at &&
        (thread === undefined || threadKey(candidate.thread) === threadKey(thread.key)),
    );
    out.splice(position === -1 ? out.length : position, 0, block);
  }
  return out;
}
/** The thread an error happened on: that of the rounds in its nearest
 *  enclosing `llmCall` span, when they agree. */
function errorThread(node: TreeNode, rounds: Round[], index: TreeIndex): ErrorThread | undefined {
  for (const ancestor of ancestorsOf(node, index)) {
    const enclosing = rounds.filter((round) => round.spanId === ancestor.id);
    if (enclosing.length === 0) {
      continue;
    }
    const first = enclosing[0];
    return enclosing.every((round) => threadKey(round.thread) === threadKey(first.thread))
      ? { key: first.thread, label: first.threadLabel, depth: toolDepth(first.node, index) }
      : undefined;
  }
  return undefined;
}
function toolBlock(
  round: Round,
  row: ToolStoryRow,
  story: StoryRow[],
  index: TreeIndex,
): TranscriptBlock {
  const output = toolResultText(row);
  const interrupts = storyChildren(story, row.id).flatMap((child) =>
    child.kind === "interrupt" ? [child.interrupt] : [],
  );
  return {
    kind: "tool",
    id: row.id,
    roundId: round.id,
    thread: round.thread,
    at: row.node.firstTs ?? round.end,
    threadLabel: round.threadLabel,
    depth: toolDepth(round.node, index),
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
        ...toolErrorMessages(block.row),
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
    case "error":
      return block.error.message;
    case "thread":
      return `thread ${block.label}`;
    default:
      return block.text;
  }
}
