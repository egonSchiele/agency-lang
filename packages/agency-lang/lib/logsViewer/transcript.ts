import {
  completionMessageOf,
  contentText,
  toolReplyContent,
  threadIdOf,
  threadIdentityOf,
  type ToolCallRequest,
} from "../statelog/wireAccessors.js";
import { ancestorsOf, buildTreeIndex, walkNodes, type TreeIndex } from "./forest.js";
import { messageKey, messagesOf, type HistoryRewrite, type WireMessage } from "./messageDelta.js";
import { childEvent, spanDetail } from "./spanText.js";
import {
  storyChildren,
  storyOutline,
  threadComplete,
  threadLabelOf,
  toolErrorMessages,
  toolResultText,
  toolStatusText,
  type StoryRow,
  type ToolStoryRow,
  type Interrupt,
} from "./story.js";
import { decodeStructured } from "./structured.js";
import { runPauses, traceErrors, type TraceError } from "./problems.js";
import { roundsOf, type Round, type ThreadKey } from "./timeline/rounds.js";
import { traceTurns, turnTimes, type Turn } from "./timeline/turns.js";
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
  /** The `llmCall` spans the block is inside, outermost first, as the
   *  trace groups them: the top-level conversation, then the sub-agent's
   *  thread under its tool, and so on. A fold on a group hides every block
   *  whose path holds it. */
  groupPath: string[];
};
export type TranscriptBlock = BlockBase &
  (
    | { kind: "system"; text: string }
    /** A thread group, one per `llmCall` span, named as the trace names
     *  it: `calls` counts the span's own LLM calls, `tool` is the tool
     *  that started it (undefined for a top-level thread), and `complete`
     *  is the trace's fold rule for it. Its id is `group:<span id>`. */
    | { kind: "thread"; label: string; calls: number; tool: string | undefined; complete: boolean }
    /** A message the person sent, when the trace has more than one. The
     *  wait before it is the end of the previous turn. */
    | { kind: "turn"; turn: Turn; waitedMs: number | undefined }
    | { kind: "error"; error: TraceError }
    | { kind: "pause"; pausedMs: number | undefined; resumed: boolean }
    /** A user-role message. `promptTo` names who the program wrote it for
     *  (the tool whose body made the call, else the thread), for a message
     *  the program composed; undefined for one the person sent. */
    | { kind: "user"; text: string; promptTo: string | undefined }
    /** The user-role message the runtime pushes when a handoff returns:
     *  `[name finished. …]` or `[name stopped before finishing: …]`. */
    | { kind: "handback"; tool: string; text: string }
    | { kind: "history"; message: WireMessage; text: string }
    | {
        kind: "assistant";
        round: Round;
        text: string | undefined;
        structured: unknown | undefined;
        message: WireMessage | undefined;
        /** Requests no tool block stands for, such as a tool the runtime
         *  never ran; the block shows these itself. */
        unpaired: ToolCallRequest[];
      }
    | {
        kind: "tool";
        row: ToolStoryRow;
        interrupts: Interrupt[];
        output: string | undefined;
        outputLines: number;
        /** The tool message the model read when it differs from the
         *  recorded output: a capped result, or an error with the loop's
         *  advice appended. Set once the next round's input shows it. */
        modelSaw: string | undefined;
      }
    | ({ kind: "rewrite"; label: "CONTEXT COMPACTED" | "HISTORY CHANGED" } & HistoryRewrite)
  );
type ToolBlock = Extract<TranscriptBlock, { kind: "tool" }>;
/** What one thread's conversation has shown so far. `shown` is every
 *  message a block already stands for, in conversation order: system
 *  prompts, the person's messages, each call's completion, and each tool's
 *  reply. A round's input is matched against it in order, so a message
 *  shows once however the runtime later reshapes the history around it. */
type ThreadHistory = {
  shown: WireMessage[];
  systems: string[];
  /** Tool blocks by the id of the request that ran them, so the reply the
   *  model read can be laid beside the recorded output. */
  toolsByCallId: Record<string, ToolBlock>;
  /** The last round on the thread, and the last at each tool path. */
  lastRound: Round | undefined;
  lastAtPath: Record<string, Round>;
  previousEnd: number;
};
export function threadKey(thread: ThreadKey): string {
  return JSON.stringify([thread.kind, thread.id]);
}
function newHistory(): ThreadHistory {
  return {
    shown: [],
    systems: [],
    toolsByCallId: Object.create(null),
    lastRound: undefined,
    lastAtPath: Object.create(null),
    previousEnd: -Infinity,
  };
}
/** Whether an input message is one already shown. Equal keys match. So
 *  does an assistant message that kept a completion's text and lost some
 *  of its tool calls, which is what a handoff leaves in the caller's
 *  history in place of the call that dispatched it. A tool reply matches
 *  the tool it answers by call id whatever its content, since the content
 *  the model read is laid beside the tool block instead. */
export function represents(shown: WireMessage, message: WireMessage): boolean {
  if (messageKey(shown) === messageKey(message)) {
    return true;
  }
  if (shown.role === "tool" && message.role === "tool") {
    return Boolean(shown.toolCallId) && shown.toolCallId === message.toolCallId;
  }
  if (shown.role !== "assistant" || message.role !== "assistant") {
    return false;
  }
  const kept = shown.toolCalls ?? [];
  const calls = message.toolCalls ?? [];
  return (
    messageKey({ ...shown, toolCalls: undefined }) ===
      messageKey({ ...message, toolCalls: undefined }) &&
    calls.length < kept.length &&
    calls.every((call) => kept.some((candidate) => candidate.id === call.id))
  );
}
/** Which of `now` the shown messages already stand for. Each shown message
 *  is consumed once, so a message that appears twice is matched once per
 *  occurrence; order is not required, since a tool that ran beside a
 *  handoff can have its reply land earlier in the shared history later. */
function matchShown(now: WireMessage[], shown: WireMessage[]): (WireMessage | undefined)[] {
  const consumed = shown.map(() => false);
  return now.map((message) => {
    const at = shown.findIndex(
      (candidate, position) => !consumed[position] && represents(candidate, message),
    );
    if (at === -1) {
      return undefined;
    }
    consumed[at] = true;
    return shown[at];
  });
}
/** Whether every message of `before` other than a system prompt is still
 *  in `now`, in order. System prompts come and go with handoffs; the other
 *  messages go only when the history was rewritten. */
function keepsHistory(before: WireMessage[], now: WireMessage[]): boolean {
  const kept = before.filter((message) => message.role !== "system");
  return matchShown(kept, now).every((match) => match !== undefined);
}
/** The round's input compared with what the thread showed before: a
 *  rewrite when neither the last round on the thread nor the last at this
 *  tool path is still in the input. A sub-agent that ran on the thread in
 *  between may have extended it (a handoff) or worked on a copy (a
 *  subthread), so either predecessor counts. */
function rewriteOf(
  round: Round,
  now: WireMessage[],
  state: ThreadHistory,
): HistoryRewrite | undefined {
  const candidates = [state.lastAtPath[JSON.stringify(round.toolPath)], state.lastRound].filter(
    (candidate): candidate is Round => candidate !== undefined,
  );
  if (
    candidates.length === 0 ||
    candidates.some((candidate) => keepsHistory(messagesOf(candidate), now))
  ) {
    return undefined;
  }
  const previous = state.lastRound!;
  const before = messagesOf(previous);
  const firstChangedAt = before.findIndex(
    (message, position) =>
      position >= now.length || messageKey(message) !== messageKey(now[position]),
  );
  return {
    messagesBefore: before.length,
    messagesAfter: now.length,
    tokensBefore: previous.contextTokens,
    tokensAfter: round.contextTokens,
    firstChangedAt: firstChangedAt === -1 ? now.length : firstChangedAt,
  };
}
const HAND_BACK = /^\[(\S+) (?:finished\.|stopped before finishing)/;
/** The tool a handoff's hand-back message names, or undefined. */
export function handBackTool(text: string): string | undefined {
  return HAND_BACK.exec(text)?.[1];
}
/** Who a user-role message was written for, when the program wrote it: the
 *  innermost tool whose body made the call, else, when the trace records the
 *  person's messages as `turnStart` events and this is not one of them, the
 *  thread (a helper call such as the one that titles a session). Undefined
 *  for a message the person sent. */
function promptedBy(
  round: Round,
  text: string,
  index: TreeIndex,
  turnMessages: string[] | undefined,
): string | undefined {
  const tool = ancestorsOf(round.node, index).find(
    (ancestor) => ancestor.label === "toolExecution",
  );
  if (tool !== undefined) {
    return spanDetail(tool) ?? tool.label;
  }
  if (turnMessages === undefined || turnMessages.some((message) => text.startsWith(message))) {
    return undefined;
  }
  return round.threadLabel ?? "unnamed";
}
/** The person's messages, when the trace records them; undefined for a
 *  trace from before `turnStart` was logged, where a user message cannot
 *  be told from a prompt the program wrote. */
function turnMessagesOf(trace: TreeNode): string[] | undefined {
  const messages = walkNodes(trace)
    .filter((node) => node.event?.data.type === "turnStart")
    .map((node) => node.event!.data.message)
    .filter((message): message is string => typeof message === "string");
  return messages.length === 0 ? undefined : messages;
}
export function transcriptBlocks(trace: TreeNode): TranscriptBlock[] {
  const index = buildTreeIndex(trace);
  const rounds = roundsOf(trace, index);
  const story = storyOutline(trace, { admin: false });
  // One conversation per thread. A sub-agent that runs on its caller's
  // thread shares the caller's history, whether it extends it (a handoff)
  // or works on a copy (a subthread), so both match against the same
  // record of what has been shown.
  const conversations: Record<string, ThreadHistory> = Object.create(null);
  // Errors inside a tool call show in that tool's block. The rest get a
  // block of their own, placed by time on the thread they happened in.
  const loose: LooseBlock[] = [
    ...traceErrors(trace, index)
      .filter((error) => error.toolId === undefined)
      .map((error) => ({
        at: error.at,
        thread: blockThread(error.node, rounds, index),
        block: { kind: "error" as const, id: `error:${error.id}`, error },
      })),
    ...runPauses(trace).map((pause) => ({
      at: pause.pausedAt,
      thread: blockThread(pause.node, rounds, index),
      block: {
        kind: "pause" as const,
        id: `pause:${pause.node.id}`,
        pausedMs: pause.resumedAt === undefined ? undefined : pause.resumedAt - pause.pausedAt,
        resumed: pause.resumedAt !== undefined,
      },
    })),
    ...turnBlocks(trace, rounds),
  ];
  const turnMessages = turnMessagesOf(trace);
  const compactions = walkNodes(trace)
    .filter((node) => node.event?.data.type === "memoryCompaction")
    .map((node) => ({
      at: Date.parse(node.event!.data.timestamp),
      thread: compactionThread(node, rounds, index),
    }));
  const roundBlocks = rounds.flatMap((round) => {
    const thread = threadKey(round.thread);
    const state = (conversations[thread] ??= newHistory());
    const blocks: TranscriptBlock[] = [];
    const base = {
      roundId: round.id,
      thread: round.thread,
      at: round.start,
      threadLabel: round.threadLabel,
      depth: toolDepth(round.node, index),
      groupPath: groupPathOf(round, index),
    };
    const now = messagesOf(round);
    const rewrite = rewriteOf(round, now, state);
    if (rewrite !== undefined) {
      const compacted = compactions.some(
        ({ at, thread: owner }) =>
          owner !== undefined &&
          threadKey(owner) === thread &&
          state.previousEnd < at &&
          at <= round.end,
      );
      blocks.push({
        ...base,
        id: `${round.id}:rewrite`,
        kind: "rewrite",
        label: compacted ? "CONTEXT COMPACTED" : "HISTORY CHANGED",
        ...rewrite,
      });
    }
    // A decision model never saw a chat: its block shows the state, the
    // questions and the answers, so its input is not shown as a
    // conversation that led up to a reply.
    const matched = round.decision === undefined ? matchShown(now, state.shown) : now;
    for (const [position, message] of now.entries()) {
      const already = matched[position];
      if (already !== undefined) {
        if (already.role === "tool" && already.toolCallId !== undefined) {
          noteModelView(state.toolsByCallId[already.toolCallId], message);
        }
        continue;
      }
      const text = messageText(message);
      if (message.role === "system") {
        if (!state.systems.includes(text)) {
          state.systems.push(text);
          blocks.push({
            ...base,
            roundId: undefined,
            id: `system:${round.id}:${position}`,
            kind: "system",
            text,
          });
        }
      } else if (message.role === "user") {
        const tool = handBackTool(text);
        blocks.push(
          tool === undefined
            ? {
                ...base,
                id: `${round.id}:user:${position}`,
                kind: "user",
                text,
                promptTo: promptedBy(round, text, index, turnMessages),
              }
            : { ...base, id: `${round.id}:user:${position}`, kind: "handback", tool, text },
        );
      } else {
        blocks.push({
          ...base,
          id: `${round.id}:history:${position}`,
          kind: "history",
          text,
          message,
        });
      }
    }
    const message = completionMessageOf(round.node.event!);
    const text = message === undefined ? undefined : contentText(message.content);
    const tools = storyChildren(story, round.id).filter(
      (row): row is ToolStoryRow => row.kind === "tool",
    );
    const toolBlocks = tools.map((row) => toolBlock(round, row, story, index));
    const requests = message?.toolCalls ?? [];
    const paired = toolBlocks.map((block) => requestFor(block.row, tools, requests));
    blocks.push(
      {
        ...base,
        at: round.end,
        id: round.id,
        kind: "assistant",
        round,
        text,
        structured: text === undefined ? undefined : decodeStructured(text),
        message,
        unpaired: requests.filter((request) => !paired.includes(request)),
      },
      ...toolBlocks,
    );
    // What this round added to the thread's shown history: its input's
    // new messages, its completion, and its tools' replies.
    state.shown.push(
      ...now.filter(
        (_, position) => matched[position] === undefined && round.decision === undefined,
      ),
      ...(message ? [message] : []),
      ...representedTools(toolBlocks, requests, state.toolsByCallId),
    );
    state.lastRound = round;
    state.lastAtPath[JSON.stringify(round.toolPath)] = round;
    state.previousEnd = round.end;
    return blocks;
  });
  return withGroupDividers(withLooseBlocks(roundBlocks, loose), rounds, index);
}
/** The `llmCall` spans a round sits in, outermost first, ending with its own. */
function groupPathOf(round: Round, index: TreeIndex): string[] {
  const outer = ancestorsOf(round.node, index)
    .filter((ancestor) => ancestor.label === "llmCall" && ancestor.id !== round.spanId)
    .map((ancestor) => ancestor.id)
    .reverse();
  return [...outer, round.spanId];
}
/** The reply the model read, kept on the tool block when it is not the
 *  recorded output as the block already shows it. */
function noteModelView(block: ToolBlock | undefined, message: WireMessage): void {
  if (block === undefined) {
    return;
  }
  const read = contentText(message.content);
  const shown = block.output ?? toolErrorMessages(block.row).join("\n");
  if (read !== shown) {
    block.modelSaw = read;
  }
}
/** A `turn` block for each of the person's messages when the trace has
 *  more than one, placed by time; each carries the wait that preceded it. */
function turnBlocks(trace: TreeNode, rounds: Round[]): LooseBlock[] {
  const turns = traceTurns(trace, rounds);
  if (turns.length < 2) {
    return [];
  }
  return turns.map((turn) => ({
    at: turn.start,
    thread: undefined,
    block: {
      kind: "turn" as const,
      id: `turn:${turn.index}`,
      turn,
      waitedMs: turn.index === 0 ? undefined : turnTimes(turns[turn.index - 1]).waitingMs,
    },
  }));
}
/** A `thread` block before the first block of each `llmCall` span, the
 *  group the trace and the timeline show for it, so a sub-agent's calls
 *  sit under their own thread row and not in one flat list with the main
 *  conversation's. A group that resumes after a nested one, as the caller
 *  does after a hand-back, gets no second row, as on the trace. A trace
 *  that is one group needs no row. */
function withGroupDividers(
  blocks: TranscriptBlock[],
  rounds: Round[],
  index: TreeIndex,
): TranscriptBlock[] {
  const paths = blocks.map((block) => block.groupPath.join("/"));
  if (
    blocks.every((block) => block.groupPath.length === 1) &&
    paths.every((path) => path === paths[0])
  ) {
    return blocks;
  }
  const opened: string[] = [];
  const out: TranscriptBlock[] = [];
  for (const block of blocks) {
    for (const [position, spanId] of block.groupPath.entries()) {
      if (opened.includes(spanId)) {
        continue;
      }
      opened.push(spanId);
      const node = index.byId[spanId];
      const own = rounds.filter((round) => round.spanId === spanId);
      const tool =
        node && ancestorsOf(node, index).find((ancestor) => ancestor.label === "toolExecution");
      out.push({
        kind: "thread",
        id: `group:${spanId}`,
        roundId: undefined,
        thread: own[0]?.thread ?? block.thread,
        at: block.at,
        threadLabel: own[0]?.threadLabel ?? block.threadLabel,
        depth: node ? toolDepth(node, index) : block.depth,
        groupPath: block.groupPath.slice(0, position + 1),
        label: threadLabelOf(own),
        calls: own.length,
        tool: tool === undefined ? undefined : (spanDetail(tool) ?? tool.label),
        complete: tool !== undefined && node !== undefined && threadComplete(node),
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
type BlockThread = {
  key: ThreadKey;
  label: string | undefined;
  depth: number;
  groupPath: string[];
};
/** A block that comes from an event rather than a round: an error between
 *  calls, or a pause. It goes before the first later block on its thread,
 *  or before the first later block anywhere when its thread is unknown,
 *  so the transcript reads in time order. One after every block goes at
 *  the end. */
type LooseBlockBody =
  | { kind: "error"; id: string; error: TraceError }
  | { kind: "pause"; id: string; pausedMs: number | undefined; resumed: boolean }
  | { kind: "turn"; id: string; turn: Turn; waitedMs: number | undefined };
type LooseBlock = { at: number; thread: BlockThread | undefined; block: LooseBlockBody };
function withLooseBlocks(blocks: TranscriptBlock[], loose: LooseBlock[]): TranscriptBlock[] {
  const out = [...blocks];
  for (const { at, thread, block } of loose) {
    const placed: TranscriptBlock = {
      ...block,
      roundId: undefined,
      thread: thread?.key ?? { kind: "legacy", id: "" },
      at,
      threadLabel: thread?.label,
      depth: thread?.depth ?? 0,
      groupPath: thread?.groupPath ?? [],
    };
    const position = out.findIndex(
      (candidate) =>
        candidate.at > at &&
        (thread === undefined || threadKey(candidate.thread) === threadKey(thread.key)),
    );
    // A block with no thread of its own joins the thread of the block it
    // lands beside, so it opens no divider.
    const neighbor = out[position === -1 ? out.length - 1 : position];
    if (thread === undefined && neighbor !== undefined) {
      Object.assign(placed, {
        thread: neighbor.thread,
        threadLabel: neighbor.threadLabel,
        depth: neighbor.depth,
        groupPath: neighbor.groupPath,
      });
    }
    out.splice(position === -1 ? out.length : position, 0, placed);
  }
  return out;
}
/** The thread an event happened on: that of the rounds in its nearest
 *  enclosing `llmCall` span, when they agree. */
function blockThread(node: TreeNode, rounds: Round[], index: TreeIndex): BlockThread | undefined {
  for (const ancestor of ancestorsOf(node, index)) {
    const enclosing = rounds.filter((round) => round.spanId === ancestor.id);
    if (enclosing.length === 0) {
      continue;
    }
    const first = enclosing[0];
    return enclosing.every((round) => threadKey(round.thread) === threadKey(first.thread))
      ? {
          key: first.thread,
          label: first.threadLabel,
          depth: toolDepth(first.node, index),
          groupPath: groupPathOf(first, index),
        }
      : undefined;
  }
  return undefined;
}
function toolBlock(
  round: Round,
  row: ToolStoryRow,
  story: StoryRow[],
  index: TreeIndex,
): ToolBlock {
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
    groupPath: groupPathOf(round, index),
    row,
    interrupts,
    output,
    outputLines: output ? output.split("\n").length : 0,
    modelSaw: undefined,
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

/** The tool messages the round's tool blocks stand for. Each block is
 *  paired with one request (`requestFor`) and represents that request's
 *  reply whatever the tool returned: the block shows the recorded output
 *  or error, and the reply the model read is laid beside it when it
 *  differs (`noteModelView`). A tool no request can be found for is not
 *  represented, so its reply stays visible as history. */
function representedTools(
  blocks: ToolBlock[],
  requests: ToolCallRequest[],
  toolsByCallId: Record<string, ToolBlock>,
): WireMessage[] {
  const tools = blocks.map((block) => block.row);
  return blocks.flatMap((block) => {
    const request = requestFor(block.row, tools, requests);
    if (request?.id === undefined || request.id === "") {
      return [];
    }
    toolsByCallId[request.id] = block;
    const finished = childEvent(block.row.node, "toolCall");
    const content = finished === undefined ? undefined : toolReplyContent(finished);
    return [
      { role: "tool", name: block.row.name, toolCallId: request.id, content: content ?? null },
    ];
  });
}
/** The request that ran a tool: the one its recorded call id names, else
 *  the one with its name at its position among the round's same-named
 *  tools, as the trace pairs them. A recorded id that names no request
 *  pairs with nothing. */
function requestFor(
  tool: ToolStoryRow,
  tools: ToolStoryRow[],
  requests: ToolCallRequest[],
): ToolCallRequest | undefined {
  const started = childEvent(tool.node, "toolCallStart");
  const finished = childEvent(tool.node, "toolCall");
  const id = finished?.data.toolCallId ?? started?.data.toolCallId;
  if (typeof id === "string" && id.length > 0) {
    return requests.find((request) => request.id === id);
  }
  const sameName = tools.filter((other) => other.name === tool.name);
  return requests.filter((request) => request.name === tool.name)[sameName.indexOf(tool)];
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
    case "pause":
      return block.resumed ? "paused, then resumed" : "paused, waiting for a response";
    case "thread":
      return `thread ${block.label}`;
    case "turn":
      return `turn ${block.turn.index + 1} ${block.turn.userText ?? ""}`.trim();
    case "handback":
      return block.text;
    default:
      return block.text;
  }
}
