// One round per promptCompletion; an llmCall span can contain many rounds.
import {
  contextTokens,
  cost,
  modelOf,
  threadIdOf,
  threadIdentityOf,
  threadLabelOf,
  tokensCached,
  tokensOut,
} from "../../statelog/wireAccessors.js";
import { buildTreeIndex, walkNodes, type TreeIndex } from "../forest.js";
import type { TreeNode } from "../types.js";
import { threadScopeOf, unambiguousThreadLabels, type ScopeLabelCache } from "./groups.js";

/** Recorded identity, or a conservative span-local key for older logs. */
export type ThreadKey = { kind: "recorded" | "legacy"; id: string };

export type Round = {
  /** `round:<span id>:<ordinal>`. Leaf ids (`evt-<n>`) shift under follow
   * mode when a promptStart becomes hidden; a span id and a count inside
   * it do not. */
  id: string;
  /** 0-based across the trace, by end time. Screens print `index + 1`. */
  index: number;
  spanId: string;
  ordinal: number;
  thread: ThreadKey;
  threadLabel: string | undefined;
  model: string;
  start: number;
  end: number;
  durationMs: number;
  cachedTokens: number;
  /** Fresh input plus cache writes: the model read both uncached. */
  freshTokens: number;
  outputTokens: number;
  contextTokens: number;
  costUsd: number;
  node: TreeNode;
};

type RoundDraft = Omit<Round, "index">;

type DraftInputs = {
  leafNode: TreeNode;
  parent: TreeNode;
  ordinal: number;
  index: TreeIndex;
  labelCache: ScopeLabelCache;
};

const ROUND_PREFIX = "round:";

export function roundId(spanId: string, ordinal: number): string {
  return `${ROUND_PREFIX}${spanId}:${ordinal}`;
}

export function parseRoundId(id: string): { spanId: string; ordinal: number } | undefined {
  if (!id.startsWith(ROUND_PREFIX)) {
    return undefined;
  }
  const lastColon = id.lastIndexOf(":");
  if (lastColon <= ROUND_PREFIX.length) {
    return undefined;
  }
  const ordinalText = id.slice(lastColon + 1);
  if (!/^\d+$/.test(ordinalText)) {
    return undefined;
  }
  const ordinal = Number(ordinalText);
  if (!Number.isSafeInteger(ordinal)) {
    return undefined;
  }
  return { spanId: id.slice(ROUND_PREFIX.length, lastColon), ordinal };
}

export function sameThread(first: Round, second: Round): boolean {
  return first.thread.kind === second.thread.kind && first.thread.id === second.thread.id;
}

export function roundsOf(trace: TreeNode, index: TreeIndex = buildTreeIndex(trace)): Round[] {
  const labelCache: ScopeLabelCache = Object.create(null);
  const drafts = walkNodes(trace).flatMap((parent) =>
    completionsUnder(parent).map((leafNode, ordinal) =>
      draftRound({ leafNode, parent, ordinal, index, labelCache }),
    ),
  );
  const timed = drafts.filter((draft): draft is RoundDraft => draft !== undefined);
  // Array.prototype.sort is stable, so rounds that end together keep
  // forest order.
  const byEnd = [...timed].sort((first, second) => first.end - second.end);
  return byEnd.map((draft, position) => ({ ...draft, index: position }));
}

function completionsUnder(parent: TreeNode): TreeNode[] {
  return parent.children.filter((child) => child.event?.data.type === "promptCompletion");
}

/** Undefined when the completion's timestamp cannot be read. */
function draftRound(inputs: DraftInputs): RoundDraft | undefined {
  const { leafNode, parent, ordinal, index, labelCache } = inputs;
  const event = leafNode.event!;
  const end = Date.parse(event.data.timestamp);
  if (!Number.isFinite(end)) {
    return undefined;
  }
  const durationMs = typeof event.data.timeTaken === "number" ? event.data.timeTaken : 0;
  const scope = threadScopeOf(leafNode, index);
  const threadId = threadIdOf(event) ?? "";
  const identity = threadIdentityOf(event);
  let thread: ThreadKey;
  if (identity === null) {
    thread = { kind: "legacy", id: JSON.stringify([parent.traceId, parent.id, threadId]) };
  } else {
    thread = { kind: "recorded", id: identity };
  }
  const recordedLabel = threadLabelOf(event);
  const legacyLabel = unambiguousThreadLabels(scope, labelCache)[threadId];
  const cachedTokens = tokensCached(event);
  const allInput = contextTokens(event);
  return {
    id: roundId(parent.id, ordinal),
    spanId: parent.id,
    ordinal,
    thread,
    threadLabel: identity === null ? legacyLabel : (recordedLabel ?? undefined),
    model: modelOf(event),
    start: end - durationMs,
    end,
    durationMs,
    cachedTokens,
    freshTokens: allInput - cachedTokens,
    outputTokens: tokensOut(event),
    contextTokens: allInput,
    costUsd: cost(event),
    node: leafNode,
  };
}
