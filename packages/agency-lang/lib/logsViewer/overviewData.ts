import { buildTreeIndex, nearestAncestor } from "./forest.js";
import { runStatus, traceErrors, type RunStatus, type TraceError } from "./problems.js";
import { stableLeafId, storyChildren, storyOutline, type ToolStoryRow } from "./story.js";
import { roundsOf, type Round } from "./timeline/rounds.js";
import { spanExtent } from "./timeline/spans.js";
import type { TreeNode } from "./types.js";

/** One column of the overview charts: a completed call, or a request that
 *  failed before the provider answered (`round` undefined, `failure` set). */
export type OverviewCall = {
  /** The round id, or the failed request's story row id so the trace
   *  screen can open it. */
  id: string;
  round: Round | undefined;
  failure: TraceError | undefined;
  /** The problems marked on this column: the tools it requested that
   *  failed, the errors logged between calls that landed here, and the
   *  request failure itself. */
  errors: TraceError[];
  /** The tools this call requested, in story order. */
  tools: ToolStoryRow[];
  /** Order key: the completion time, or the failure time. */
  at: number;
};

export type OverviewData = {
  models: string[];
  status: RunStatus;
  elapsedMs: number;
  costUsd: number;
  rounds: Round[];
  calls: OverviewCall[];
  errors: TraceError[];
};

export function overviewData(trace: TreeNode): OverviewData {
  const index = buildTreeIndex(trace);
  const rounds = roundsOf(trace, index);
  const models = rounds.map((round) => round.model).filter((model) => model !== "");
  const extent = spanExtent(trace);
  const errors = traceErrors(trace, index);
  const story = storyOutline(trace, { admin: false });
  const toolsByRound: Record<string, ToolStoryRow[]> = Object.create(null);
  const roundOfTool: Record<string, string> = Object.create(null);
  for (const round of rounds) {
    const tools = storyChildren(story, round.id).filter(
      (row): row is ToolStoryRow => row.kind === "tool",
    );
    toolsByRound[round.id] = tools;
    for (const tool of tools) {
      roundOfTool[tool.id] = round.id;
    }
  }
  const failures = errors.filter((error) => error.errorType === "llmError");
  const attached = errors.filter((error) => error.errorType !== "llmError");
  const errorsByRound: Record<string, TraceError[]> = Object.create(null);
  for (const error of attached) {
    const owner = callFor(error, { rounds, roundOfTool, index });
    if (owner !== undefined) {
      (errorsByRound[owner.id] ??= []).push(error);
    }
  }
  const calls: OverviewCall[] = [
    ...rounds.map((round) => ({
      id: round.id,
      round,
      failure: undefined,
      errors: errorsByRound[round.id] ?? [],
      tools: toolsByRound[round.id],
      at: round.end,
    })),
    ...failures.map((failure) => ({
      id: stableLeafId(index.byId[index.parentIds[failure.node.id] ?? ""] ?? trace, failure.node),
      round: undefined,
      failure,
      errors: [failure],
      tools: [],
      at: failure.at,
    })),
  ].sort((first, second) => first.at - second.at);
  return {
    models: models.filter((model, index) => models.indexOf(model) === index),
    status: runStatus(trace),
    elapsedMs: extent === undefined ? 0 : extent.end - extent.start,
    costUsd: rounds.reduce((total, round) => total + round.costUsd, 0),
    rounds,
    calls,
    errors,
  };
}

/** Which call an error is marked on. A tool's error goes on the call that
 *  requested the tool. An error between calls (a hook, a validator, a
 *  guard) goes on the last earlier call in its own `llmCall` span, then on
 *  the last earlier call anywhere, then on the first call, so it is never
 *  dropped. */
function callFor(
  error: TraceError,
  lookups: {
    rounds: Round[];
    roundOfTool: Record<string, string>;
    index: ReturnType<typeof buildTreeIndex>;
  },
): Round | undefined {
  const { rounds, roundOfTool, index } = lookups;
  if (error.toolId !== undefined && roundOfTool[error.toolId] !== undefined) {
    return rounds.find((round) => round.id === roundOfTool[error.toolId!]);
  }
  const span = nearestAncestor(error.node, index, (node) => node.label === "llmCall");
  const earlier = (candidates: Round[]) =>
    candidates.filter((round) => round.end <= error.at).at(-1);
  return (
    (span === undefined
      ? undefined
      : earlier(rounds.filter((round) => round.spanId === span.id))) ??
    earlier(rounds) ??
    rounds[0]
  );
}
