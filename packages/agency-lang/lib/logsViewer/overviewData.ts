import { ancestorsOf, buildTreeIndex, nearestAncestor } from "./forest.js";
import { roundDeltas } from "./messageDelta.js";
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
  /** The tool call this request ran inside, with the index of the call
   *  that requested that tool when the log shows it; undefined at the top. */
  inside: { toolName: string; requestedBy: number | undefined } | undefined;
  /** Every tool call this request ran inside, outermost first; empty at
   *  the top. The charts bracket the calls that share one. */
  enclosing: { id: string; toolName: string }[];
  /** The index of the call this one continues, with that call's reply and
   *  tool results added: the previous call on the same thread inside the
   *  same tools (see `roundDeltas`); undefined for the first on a thread. */
  continues: number | undefined;
  /** Order key: the completion time, or the failure time. */
  at: number;
  /** The round's thread name; undefined for a failed request or an unnamed thread. */
  threadLabel: string | undefined;
  /** The name the charts and legend show: the label, with `#2`, `#3`
   *  added when another thread already took the same name, so two calls
   *  of one sub-agent tool read as two threads. `unnamed` without a label. */
  threadName: string;
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
  // A request that failed before the provider answered: an llmError inside
  // an llmCall span. The memory manager logs llmErrors of its own for its
  // extraction and compaction calls, which are not calls in the chart; those
  // are marked on a call like any other error.
  const isFailedRequest = (error: TraceError): boolean =>
    error.errorType === "llmError" &&
    nearestAncestor(error.node, index, (node) => node.label === "llmCall") !== undefined;
  const failures = errors.filter(isFailedRequest);
  const attached = errors.filter((error) => !isFailedRequest(error));
  const errorsByRound: Record<string, TraceError[]> = Object.create(null);
  for (const error of attached) {
    const owner = callFor(error, { rounds, roundOfTool, index });
    if (owner !== undefined) {
      (errorsByRound[owner.id] ??= []).push(error);
    }
  }
  const nameOf = threadNamer(rounds);
  const toolRowByNode: Record<string, { name: string; requestedBy: number }> = Object.create(null);
  for (const round of rounds) {
    for (const tool of toolsByRound[round.id]) {
      toolRowByNode[tool.node.id] = { name: tool.name, requestedBy: round.index };
    }
  }
  const roundById: Record<string, Round> = Object.create(null);
  for (const round of rounds) {
    roundById[round.id] = round;
  }
  const previousOf: Record<string, string | undefined> = Object.create(null);
  for (const delta of roundDeltas(rounds)) {
    previousOf[delta.roundId] = delta.previousRoundId;
  }
  const calls: OverviewCall[] = [
    ...rounds.map((round) => {
      const toolSpans = ancestorsOf(round.node, index).filter(
        (ancestor) => ancestor.label === "toolExecution",
      );
      const nearest = toolSpans[0];
      const enclosing = toolSpans
        .map((span) => ({ id: span.id, toolName: toolRowByNode[span.id]?.name ?? span.summary }))
        .reverse();
      const previous = roundById[previousOf[round.id] ?? ""];
      // A sub-agent's first call diffs against its caller's last call, but
      // "inside … (requested by …)" already says that; "continues" names
      // only a call in the same conversation, at the same tool path.
      const continues =
        previous !== undefined && samePath(previous, round) ? previous.index : undefined;
      return {
        id: round.id,
        round,
        failure: undefined,
        errors: errorsByRound[round.id] ?? [],
        tools: toolsByRound[round.id],
        inside: nearest === undefined ? undefined : insideOf(nearest, toolRowByNode[nearest.id]),
        enclosing,
        continues,
        at: round.end,
        threadLabel: round.threadLabel,
        threadName: nameOf(round),
      };
    }),
    ...failures.map((failure) => {
      const parent = index.byId[index.parentIds[failure.node.id] ?? ""] ?? trace;
      return {
        id: stableLeafId(parent, failure.node),
        round: undefined,
        failure,
        errors: [failure],
        tools: [],
        inside: undefined,
        enclosing: [],
        continues: undefined,
        at: failure.at,
        threadLabel: undefined,
        threadName: "unnamed",
      };
    }),
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

/** One display name per thread, in order of first use. A second thread
 *  with a name already taken gets `#2`, a third `#3`, so two threads that
 *  one tool started (or two unnamed ones) are told apart. */
function samePath(first: Round, second: Round): boolean {
  return JSON.stringify(first.toolPath) === JSON.stringify(second.toolPath);
}
/** The tool a call ran inside: named by its story row when a call
 *  requested it, else by the span alone. */
function insideOf(
  span: TreeNode,
  row: { name: string; requestedBy: number } | undefined,
): OverviewCall["inside"] {
  if (row === undefined) {
    return { toolName: span.summary, requestedBy: undefined };
  }
  return { toolName: row.name, requestedBy: row.requestedBy };
}
function threadNamer(rounds: Round[]): (round: Round) => string {
  const byThread: Record<string, string> = Object.create(null);
  const taken: Record<string, number> = Object.create(null);
  for (const round of [...rounds].sort((first, second) => first.end - second.end)) {
    const key = `${round.thread.kind}:${round.thread.id}`;
    if (byThread[key] !== undefined) {
      continue;
    }
    const label = round.threadLabel ?? "unnamed";
    taken[label] = (taken[label] ?? 0) + 1;
    byThread[key] = taken[label] === 1 ? label : `${label} #${taken[label]}`;
  }
  return (round) => byThread[`${round.thread.kind}:${round.thread.id}`];
}

/** The distinct thread names across the calls, in order of first use, so
 *  every screen that colors by thread picks the same color for a name. */
export function threadNames(calls: OverviewCall[]): string[] {
  const names = calls.flatMap((call) => (call.round === undefined ? [] : [call.threadName]));
  return names.filter((name, index) => names.indexOf(name) === index);
}
