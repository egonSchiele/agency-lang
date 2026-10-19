import {
  contentText,
  normalizeMessage,
  toolNameOf,
  toolReplyContent,
} from "../statelog/wireAccessors.js";
import {
  ancestorsOf,
  buildTreeIndex,
  nearestAncestor,
  walkNodes,
  walkWithDepth,
  type TreeIndex,
} from "./forest.js";
import { roundDeltas, type RoundDelta } from "./messageDelta.js";
import { runPauses, type RunPause } from "./problems.js";
import { decisionSummary } from "./decision.js";
import { childEvent, completionOutcome, spanDetail, toolArgSummary } from "./spanText.js";
import { roundsOf, type Round } from "./timeline/rounds.js";
import { ADMIN_KINDS, hasRunningWork } from "./timeline/spans.js";
import type { EventEnvelope, TreeNode } from "./types.js";

export type Interrupt = { effect: string; message: string; outcome: string; resolvedBy?: string };
export type ToolStatus = "completed" | "failed" | "rejected" | "awaitingApproval" | "unfinished";
export type ToolWork = "started" | "notStarted" | "unknown";
export type ToolOutcome = { status: ToolStatus; work: ToolWork };
export type ToolFailure = { neverStarted: boolean; destructiveRan: boolean };
export type ToolEvidence = {
  completed: boolean;
  errors: ToolFailure[];
  interrupts: ("approved" | "rejected" | "pending")[];
};
type RowBase = {
  id: string;
  depth: number;
  node: TreeNode;
  /** The row's span (or its event's span) names a parent this log never
   *  recorded, so it sits at the top level. */
  orphan: boolean;
};
export type RoundStoryRow = RowBase & { kind: "round"; round: Round; gist: string };
export type UserStoryRow = RowBase & { kind: "user"; text: string };
export type ToolStoryRow = RowBase & {
  kind: "tool";
  name: string;
  argSummary: string;
  durationMs: number | undefined;
  status: ToolStatus;
  work: ToolWork;
  /** Arguments the model sent as null that the runtime dropped before the
   *  call, so the parameter's default applied. */
  droppedNulls: string[];
};
export type InterruptStoryRow = RowBase & {
  kind: "interrupt";
  interrupt: Interrupt;
  toolName: string | undefined;
};
export type ErrorStoryRow = RowBase & { kind: "error"; message: string };
/** The run stopped under this interrupt and waited; `pausedMs` is undefined
 *  while it still waits. */
export type PauseStoryRow = RowBase & {
  kind: "pause";
  pausedMs: number | undefined;
  resumed: boolean;
};
export type SubagentStoryRow = RowBase & { kind: "subagent"; label: string };
/** `title` is the row's name on every screen: `Thread · <label> · N LLM calls`. */
export type LlmGroupStoryRow = RowBase & {
  title: string;
  kind: "llmGroup";
  label: string;
  /** The tool whose call started this thread; undefined for a top-level thread. */
  toolName: string | undefined;
  rounds: Round[];
};
export type MachineryStoryRow = RowBase & { kind: "machinery"; text: string };
export type StoryRow =
  | RoundStoryRow
  | UserStoryRow
  | ToolStoryRow
  | InterruptStoryRow
  | ErrorStoryRow
  | PauseStoryRow
  | SubagentStoryRow
  | LlmGroupStoryRow
  | MachineryStoryRow;
export type OutlineOptions = { machinery: boolean; admin: boolean };
type AdminOptions = { admin: boolean };
type RowContext = {
  node: TreeNode;
  parent: TreeNode;
  depth: number;
  index: TreeIndex;
  roundsByLeaf: Record<string, Round>;
  deltasByRound: Record<string, RoundDelta>;
  pausesByInterrupt: Record<string, RunPause>;
  /** The round that requested each tool span, by the span's node id. */
  requestedByTool: Record<string, Round>;
};
type Lookups = Pick<
  RowContext,
  "index" | "roundsByLeaf" | "deltasByRound" | "pausesByInterrupt" | "requestedByTool"
>;
type RowMaker = (context: RowContext) => StoryRow;
const STORY_EVENTS: Record<string, RowMaker> = {
  promptCompletion: roundRow,
  interruptThrown: interruptRow,
  interruptResolved: interruptRow,
  error: errorRow,
};
const STORY_SPANS: Record<string, RowMaker> = {
  toolExecution: toolRow,
  subprocessRun: subagentRow,
};

export function classifyTool(evidence: ToolEvidence): ToolOutcome {
  if (evidence.completed) {
    return { status: "completed", work: "started" };
  }
  if (evidence.errors.length > 0) {
    let work: ToolWork = "unknown";
    if (evidence.errors.some((error) => error.destructiveRan)) {
      work = "started";
    } else if (evidence.errors.every((error) => error.neverStarted)) {
      work = "notStarted";
    }
    return { status: "failed", work };
  }
  if (evidence.interrupts.includes("pending")) {
    return { status: "awaitingApproval", work: "unknown" };
  }
  if (evidence.interrupts.includes("rejected")) {
    return { status: "rejected", work: "unknown" };
  }
  return { status: "unfinished", work: "unknown" };
}
const TOOL_STATUS_TEXT: Record<ToolStatus, string> = {
  completed: "completed",
  failed: "tool failed",
  rejected: "interrupt rejected; completion not recorded",
  awaitingApproval: "awaiting interrupt response",
  unfinished: "completion not recorded",
};
/** The rows laid out directly under `id` in an outline. */
export function storyChildren(rows: StoryRow[], id: string): StoryRow[] {
  const position = rows.findIndex((row) => row.id === id);
  if (position < 0) {
    return [];
  }
  const parent = rows[position];
  const next = rows.slice(position + 1).findIndex((row) => row.depth <= parent.depth);
  const end = next < 0 ? rows.length : position + 1 + next;
  return rows.slice(position + 1, end).filter((row) => row.depth === parent.depth + 1);
}
/** What a completed tool returned, as text; undefined when it never completed. */
export function toolResultText(row: ToolStoryRow): string | undefined {
  const finished = childEvent(row.node, "toolCall");
  if (finished === undefined) {
    return undefined;
  }
  return contentText(toolReplyContent(finished) ?? finished.data.output);
}
/** The messages of the errors logged inside this tool and not inside a nested one. */
export function toolErrorMessages(row: ToolStoryRow): string[] {
  return ownedToolNodes(row.node, buildTreeIndex(row.node))
    .filter((node) => node.event?.data.type === "error")
    .map((node) => String(node.event!.data.message ?? "error"));
}
/** The one glyph per status every screen uses: ✖ for a tool that failed
 *  or was rejected, ⏸ for one waiting on a person, → for a result. */
export const TOOL_STATUS_MARK: Record<ToolStatus, string> = {
  completed: "→",
  failed: "✖",
  rejected: "✖",
  awaitingApproval: "⏸",
  unfinished: "⋯",
};
export function toolStatusText(outcome: ToolOutcome): string {
  const label = TOOL_STATUS_TEXT[outcome.status];
  if (outcome.status === "failed" && outcome.work === "started") {
    return `${label}; work occurred before it stopped`;
  }
  if (outcome.work === "notStarted") {
    return `${label}; tool did not start`;
  }
  return label;
}
/** Excludes events belonging to nested tool invocations. */
export function ownedToolNodes(node: TreeNode, index: TreeIndex): TreeNode[] {
  return walkNodes(node).filter(
    (child) =>
      child.event !== undefined &&
      nearestAncestor(child, index, (ancestor) => ancestor.label === "toolExecution") === node,
  );
}
function interruptKey(node: TreeNode): string {
  const id = node.event?.data.interruptId;
  return typeof id === "string" ? JSON.stringify(["id", id]) : JSON.stringify(["event", node.id]);
}
function interruptState(node: TreeNode): "approved" | "rejected" | "pending" {
  const outcome = node.event?.data.outcome;
  return outcome === "approved" || outcome === "rejected" ? outcome : "pending";
}
function interruptGroups(nodes: TreeNode[]): TreeNode[][] {
  const groups: Record<string, TreeNode[]> = Object.create(null);
  const interrupts = nodes.filter((node) =>
    ["interruptThrown", "interruptResolved"].includes(node.event?.data.type ?? ""),
  );
  interrupts.sort(
    (first, second) =>
      Date.parse(first.event!.data.timestamp) - Date.parse(second.event!.data.timestamp),
  );
  for (const node of interrupts) {
    (groups[interruptKey(node)] ??= []).push(node);
  }
  return Object.values(groups);
}
function toolEvidence(node: TreeNode, index: TreeIndex): ToolEvidence {
  const owned = ownedToolNodes(node, index);
  return {
    completed: owned.some((child) => child.event!.data.type === "toolCall"),
    errors: owned
      .filter((child) => child.event!.data.type === "error")
      .map((child) => ({
        neverStarted: child.event!.data.neverStarted === true,
        destructiveRan: child.event!.data.destructiveRan === true,
      })),
    interrupts: interruptGroups(owned).map((group) => interruptState(group.at(-1)!)),
  };
}
export function stableLeafId(parent: TreeNode, leafNode: TreeNode): string {
  const type = leafNode.event?.data.type ?? "event";
  const sameType = parent.children.filter((child) => child.event?.data.type === type);
  return `leaf:${parent.id}:${type}:${sameType.indexOf(leafNode)}`;
}
function base(context: RowContext): RowBase {
  return {
    id: context.node.event ? stableLeafId(context.parent, context.node) : context.node.id,
    depth: context.depth,
    node: context.node,
    orphan: (context.node.event ? context.parent : context.node).parentMissing === true,
  };
}
function roundRow(context: RowContext): StoryRow {
  const round = context.roundsByLeaf[context.node.id];
  if (round === undefined) {
    return machineryRow(context);
  }
  return {
    ...base(context),
    kind: "round",
    id: round.id,
    round,
    gist:
      round.decision === undefined
        ? (completionOutcome(context.node.event!) ?? "")
        : `decision · ${decisionSummary(round.decision)}`,
  };
}
function toolRow(context: RowContext): ToolStoryRow {
  const started = childEvent(context.node, "toolCallStart");
  const finished = childEvent(context.node, "toolCall");
  // The forest infers toolExecution only from a start or completion.
  const event = (started ?? finished)!;
  return {
    ...base(context),
    kind: "tool",
    name: toolNameOf(event),
    argSummary: toolArgSummary(event.data.args),
    durationMs: typeof finished?.data.timeTaken === "number" ? finished.data.timeTaken : undefined,
    ...classifyTool(toolEvidence(context.node, context.index)),
    droppedNulls: droppedNullArgs(context, event),
  };
}
/** The names the request set to null that the recorded arguments lack.
 *  The runtime drops a null for a parameter with a default so the default
 *  applies, and the tool row says so instead of leaving the reader to
 *  compare its arguments with the LLM call's. Requests pair with tool
 *  rows by name, in order, as they do on the overview. */
function droppedNullArgs(context: RowContext, event: EventEnvelope): string[] {
  const round = context.requestedByTool[context.node.id];
  if (round === undefined) {
    return [];
  }
  const name = toolNameOf(event);
  const siblings = context.parent.children.filter((node) => {
    const started = childEvent(node, "toolCallStart") ?? childEvent(node, "toolCall");
    return (
      started !== undefined &&
      toolNameOf(started) === name &&
      context.requestedByTool[node.id] === round
    );
  });
  const calls =
    normalizeMessage({ role: "assistant", ...round.node.event!.data.completion }).toolCalls ?? [];
  const request = calls.filter((call) => call.name === name)[siblings.indexOf(context.node)];
  if (!isRecord(request?.arguments)) {
    return [];
  }
  const sent = request.arguments;
  const recorded = isRecord(event.data.args) ? event.data.args : {};
  return Object.keys(sent).filter((key) => sent[key] === null && !Object.hasOwn(recorded, key));
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function interruptRow(context: RowContext): InterruptStoryRow {
  const data = context.node.event!.data;
  const tool = nearestAncestor(
    context.node,
    context.index,
    (node) => node.label === "toolExecution",
  );
  return {
    ...base(context),
    kind: "interrupt",
    interrupt: {
      effect: String(data.interrupt?.effect ?? "interrupt"),
      message: String(data.interrupt?.message ?? ""),
      outcome: interruptState(context.node),
      ...(typeof data.resolvedBy === "string" ? { resolvedBy: data.resolvedBy } : {}),
    },
    toolName: tool === undefined ? undefined : spanDetail(tool),
  };
}
function errorRow(context: RowContext): ErrorStoryRow {
  return {
    ...base(context),
    kind: "error",
    message: String(context.node.event?.data.message ?? "error"),
  };
}
function subagentRow(context: RowContext): SubagentStoryRow {
  const round = Object.values(context.roundsByLeaf).find(
    (round) => round.spanId === context.node.id,
  );
  const tool = nearestAncestor(
    context.node,
    context.index,
    (node) => node.label === "toolExecution",
  );
  return {
    ...base(context),
    kind: "subagent",
    label:
      round?.threadLabel ??
      (tool ? spanDetail(tool) : spanDetail(context.node)) ??
      context.node.label,
  };
}
function llmGroupRow(context: RowContext): LlmGroupStoryRow {
  const tool = nearestAncestor(
    context.node,
    context.index,
    (node) => node.label === "toolExecution",
  );
  const rounds = Object.values(context.roundsByLeaf).filter(
    (round) => round.spanId === context.node.id,
  );
  return {
    ...base(context),
    kind: "llmGroup",
    title: llmGroupTitle(context.node, rounds),
    label: threadLabelOf(rounds),
    toolName: tool ? spanDetail(tool) : undefined,
    rounds,
  };
}
/** The name every screen gives an `llmCall` span: `Thread · main · 13 LLM
 *  calls`. A sub-agent that runs on its caller's thread is named by that
 *  thread too; naming it by its tool instead was tried and read as a
 *  different kind of row. */
export function llmGroupTitle(node: TreeNode, allRounds: Round[]): string {
  const rounds = allRounds.filter((round) => round.spanId === node.id);
  const count = `${rounds.length} LLM ${rounds.length === 1 ? "call" : "calls"}`;
  return `Thread · ${threadLabelOf(rounds)} · ${count}`;
}
/** The thread name a group of rounds shares, `main`, or the names joined
 *  when they differ. */
export function threadLabelOf(rounds: Round[]): string {
  const names = rounds
    .map((round) => round.threadLabel)
    .filter((name): name is string => Boolean(name));
  return names.filter((name, index) => names.indexOf(name) === index).join(", ") || "unnamed";
}
/** Whether an `llmCall` span's thread is done: nothing under it still
 *  runs, and its last call was cancelled or answered without asking for a
 *  tool. A span whose last call requested tools is still in its tool loop,
 *  even between the tools' end and the next call. The trace and the
 *  timeline fold a completed sub-agent on first sight by this rule. */
export function threadComplete(node: TreeNode): boolean {
  if (hasRunningWork(node)) {
    return false;
  }
  const last = node.children
    .flatMap((child) => (child.event ? [child.event] : []))
    .filter((event) =>
      ["promptStart", "promptCompletion", "promptCancelled"].includes(event.data.type),
    )
    .sort((first, second) => Date.parse(first.data.timestamp) - Date.parse(second.data.timestamp))
    .at(-1);
  if (last?.data.type === "promptCancelled") {
    return true;
  }
  if (last?.data.type !== "promptCompletion") {
    return false;
  }
  const calls = normalizeMessage({ role: "assistant", ...last.data.completion }).toolCalls ?? [];
  return calls.length === 0;
}
function machineryRow(context: RowContext): MachineryStoryRow {
  return {
    ...base(context),
    kind: "machinery",
    text: `${context.node.label} ${context.node.summary}`.trim(),
  };
}
function rowFor(context: RowContext): StoryRow {
  const table = context.node.nodeKind === "event" ? STORY_EVENTS : STORY_SPANS;
  const key = context.node.event?.data.type ?? context.node.label;
  return (Object.hasOwn(table, key) ? table[key] : machineryRow)(context);
}
function lookupsFor(trace: TreeNode): Lookups {
  const index = buildTreeIndex(trace);
  const rounds = roundsOf(trace, index);
  const roundsByLeaf: Record<string, Round> = Object.create(null);
  const deltasByRound: Record<string, RoundDelta> = Object.create(null);
  const pausesByInterrupt: Record<string, RunPause> = Object.create(null);
  for (const round of rounds) {
    roundsByLeaf[round.node.id] = round;
  }
  for (const delta of roundDeltas(rounds)) {
    deltasByRound[delta.roundId] = delta;
  }
  for (const pause of runPauses(trace)) {
    if (pause.interruptId !== undefined) {
      pausesByInterrupt[pause.interruptId] = pause;
    }
  }
  const byEnd = [...rounds].sort((first, second) => first.end - second.end);
  const requestedByTool: Record<string, Round> = Object.create(null);
  for (const node of walkNodes(trace)) {
    if (node.label !== "toolExecution") {
      continue;
    }
    const round = requestedBy(node, byEnd, index);
    if (round !== undefined) {
      requestedByTool[node.id] = round;
    }
  }
  return { index, roundsByLeaf, deltasByRound, pausesByInterrupt, requestedByTool };
}
export function forestOutline(trace: TreeNode, options: AdminOptions): StoryRow[] {
  const lookups = lookupsFor(trace);
  return walkWithDepth(trace, (node) => !options.admin && ADMIN_KINDS.includes(node.label)).map(
    (placed) => rowFor({ ...lookups, ...placed }),
  );
}
export function outlineRows(trace: TreeNode, options: OutlineOptions): StoryRow[] {
  return (options.machinery ? forestOutline : storyOutline)(trace, options);
}
function requestedBy(tool: TreeNode, rounds: Round[], index: TreeIndex): Round | undefined {
  return rounds
    .filter(
      (round) =>
        round.spanId === index.parentIds[tool.id] && round.end <= (tool.firstTs ?? Infinity),
    )
    .at(-1);
}
/** Story nesting is computed from flat forest records, then laid out as rows. */
export function storyOutline(trace: TreeNode, options: AdminOptions): StoryRow[] {
  const lookups = lookupsFor(trace);
  const candidates = storyCandidates(trace, lookups);
  const rows = candidates.filter(
    (row) => row.kind !== "machinery" || (options.admin && row.node.label === "handlerDecision"),
  );
  const parents = storyParents(rows, lookups);
  function layOut(parentId: string | undefined, depth: number): StoryRow[] {
    const own = rows.filter((row) => parents[row.id] === parentId);
    // A span whose parent is missing from the log sits at the top level;
    // when one does, the top level reads in time order so it lands where it
    // happened. Otherwise rows keep log order, as they always have.
    const ordered =
      parentId === undefined && own.some((row) => row.orphan) ? [...own].sort(byTime) : own;
    return ordered.flatMap((row) => [
      ...userRows(row, depth, lookups),
      { ...row, depth },
      ...pauseRows(row, depth + 1, lookups),
      ...layOut(row.id, depth + 1),
    ]);
  }
  return layOut(undefined, 0);
}
function byTime(first: StoryRow, second: StoryRow): number {
  return rowTime(first) - rowTime(second);
}
function rowTime(row: StoryRow): number {
  if (row.kind === "round") {
    return row.round.start;
  }
  const event = row.node.event;
  const at = event === undefined ? row.node.firstTs : Date.parse(event.data.timestamp);
  return at === undefined || !Number.isFinite(at) ? Number.POSITIVE_INFINITY : at;
}
/** The pause the run took under this interrupt, when it went to a person. */
function pauseRows(row: StoryRow, depth: number, lookups: Lookups): PauseStoryRow[] {
  if (row.kind !== "interrupt") {
    return [];
  }
  const id = row.node.event?.data.interruptId;
  const pause = typeof id === "string" ? lookups.pausesByInterrupt[id] : undefined;
  if (pause === undefined) {
    return [];
  }
  return [
    {
      kind: "pause",
      id: `${row.id}:pause`,
      depth,
      node: row.node,
      orphan: false,
      pausedMs: pause.resumedAt === undefined ? undefined : pause.resumedAt - pause.pausedAt,
      resumed: pause.resumedAt !== undefined,
    },
  ];
}
function storyCandidates(trace: TreeNode, lookups: Lookups): StoryRow[] {
  const placed = walkWithDepth(trace);
  // An llmCall span inside a tool is a thread row, as before. A top-level
  // one becomes a thread row only when a sibling llmCall span runs on a
  // different thread: a conversation that runs beside the main one (an
  // expression check, a watcher) then reads as its own thread, while a run
  // that calls llm() several times on one thread keeps its calls at the top.
  const candidates = placed.map((item) => {
    const context = { ...lookups, ...item };
    return item.node.label === "llmCall" && isThreadRow(item.node, lookups)
      ? llmGroupRow(context)
      : rowFor(context);
  });
  // A story interrupt is one row: its first occurrence's place and stable
  // ID, with the latest outcome. An interrupt with a recorded id merges
  // across the whole trace, so the answer a person gave in a later run
  // (logged under that run's own span) lands on the interrupt it answers.
  // The first occurrence is the innermost tool's, because child spans walk
  // before their parent's leaves, so a nested tool keeps ownership when
  // the same id is logged at more than one level. Without a recorded id,
  // only occurrences under one owner merge. Raw forest mode retains every
  // occurrence separately.
  const interrupts = candidates.filter((row): row is InterruptStoryRow => row.kind === "interrupt");
  const groups: Record<string, InterruptStoryRow[]> = Object.create(null);
  for (const row of interrupts) {
    const hasId = typeof row.node.event?.data.interruptId === "string";
    const owner = hasId
      ? null
      : (nearestAncestor(row.node, lookups.index, (node) => node.label === "toolExecution")?.id ??
        lookups.index.parentIds[row.node.id]);
    const key = JSON.stringify([owner, interruptKey(row.node)]);
    (groups[key] ??= []).push(row);
  }
  const hidden: string[] = [];
  for (const group of Object.values(groups)) {
    const first = group[0];
    const last = group.at(-1)!;
    // The thrown event names no effect; a resolution does. Take each
    // field from the first occurrence that recorded it.
    const described = group.find((row) => row.interrupt.effect !== "interrupt") ?? first;
    first.interrupt = {
      effect: described.interrupt.effect,
      message: group.find((row) => row.interrupt.message !== "")?.interrupt.message ?? "",
      outcome: last.interrupt.outcome,
      ...(last.interrupt.resolvedBy === undefined ? {} : { resolvedBy: last.interrupt.resolvedBy }),
    };
    hidden.push(...group.slice(1).map((row) => row.id));
  }
  return candidates.filter((row) => !hidden.includes(row.id));
}
function isThreadRow(node: TreeNode, lookups: Lookups): boolean {
  const { index } = lookups;
  if (nearestAncestor(node, index, (ancestor) => ancestor.label === "toolExecution")) {
    return true;
  }
  const parent = index.byId[index.parentIds[node.id]];
  const siblingIds = (parent?.children ?? [])
    .filter((child) => child.nodeKind === "span" && child.label === "llmCall")
    .map((child) => child.id);
  const threads = Object.values(lookups.roundsByLeaf)
    .filter((round) => siblingIds.includes(round.spanId))
    .map((round) => `${round.thread.kind}:${round.thread.id}`);
  return threads.some((thread) => thread !== threads[0]);
}
function storyParents(rows: StoryRow[], lookups: Lookups): Record<string, string | undefined> {
  const parents: Record<string, string | undefined> = Object.create(null);
  for (const row of rows) {
    const ancestors = ancestorsOf(row.node, lookups.index);
    const ancestor = ancestors.find((node) =>
      rows.some((candidate) => candidate.node === node && candidate.kind !== "machinery"),
    );
    parents[row.id] = rows.find((candidate) => candidate.node === ancestor)?.id;
    if (row.kind === "tool") {
      parents[row.id] = lookups.requestedByTool[row.node.id]?.id ?? parents[row.id];
    }
    if (row.kind === "machinery") {
      const tool = nearestAncestor(
        row.node,
        lookups.index,
        (node) => node.label === "toolExecution",
      );
      const interrupt = rows.find(
        (candidate) =>
          candidate.kind === "interrupt" &&
          candidate.node.event?.data.interruptId === row.node.event?.data.interruptId &&
          nearestAncestor(
            candidate.node,
            lookups.index,
            (node) => node.label === "toolExecution",
          ) === tool,
      );
      parents[row.id] = interrupt?.id ?? parents[row.id];
    }
  }
  return parents;
}
function userRows(row: StoryRow, depth: number, lookups: Lookups): UserStoryRow[] {
  if (row.kind !== "round") {
    return [];
  }
  const users = lookups.deltasByRound[row.id].added.filter((message) => message.role === "user");
  if (users.length === 0) {
    return [];
  }
  return [
    {
      kind: "user",
      id: `${row.id}:user`,
      depth,
      node: row.node,
      orphan: row.orphan,
      text: users.map((message) => contentText(message.content)).join("\n"),
    },
  ];
}
