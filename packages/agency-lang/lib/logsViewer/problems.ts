// What went wrong in a trace, and how its run ended. Pure over the forest:
// the Overview header, the Transcript's error blocks and the Timeline's
// marks all read these records, so the four screens agree on every error.
import { ancestorsOf, buildTreeIndex, walkNodes, type TreeIndex } from "./forest.js";
import { hasRunningWork } from "./timeline/spans.js";
import type { EventEnvelope, TreeNode } from "./types.js";

export type TraceError = {
  /** The first occurrence's node id. */
  id: string;
  message: string;
  errorType: string | undefined;
  /** How often the same message was logged in the same place within a
   *  second: an error rethrown up a call stack is one error. */
  count: number;
  /** Milliseconds since the epoch of the first occurrence. */
  at: number;
  /** The tool call the error was logged inside, innermost, or undefined
   *  for an error between calls. */
  toolId: string | undefined;
  node: TreeNode;
};

/** How the whole run ended, as its lifecycle events record it. `paused`
 *  is a run waiting for someone to answer an interrupt. */
export type RunStatus = "done" | "crashed" | "paused" | "running";

/** Occurrences of one message closer together than this are one error. */
const BURST_WINDOW_MS = 1000;

type Occurrence = { node: TreeNode; at: number; message: string; toolChain: string[] };

export function traceErrors(
  trace: TreeNode,
  index: TreeIndex = buildTreeIndex(trace),
): TraceError[] {
  const occurrences = walkNodes(trace)
    .filter((node) => node.event?.data.type === "error")
    .map((node) => ({
      node,
      at: Date.parse(node.event!.data.timestamp),
      message: String(node.event!.data.message ?? "error"),
      toolChain: ancestorsOf(node, index)
        .filter((ancestor) => ancestor.label === "toolExecution")
        .map((ancestor) => ancestor.id)
        .reverse(),
    }))
    .filter((occurrence) => Number.isFinite(occurrence.at))
    .sort((first, second) => first.at - second.at);
  const errors: (TraceError & { toolChain: string[] })[] = [];
  for (const occurrence of occurrences) {
    const burst = errors.find((error) => sameBurst(error, occurrence));
    if (burst !== undefined) {
      burst.count += 1;
      continue;
    }
    const type = occurrence.node.event!.data.errorType;
    errors.push({
      id: occurrence.node.id,
      message: occurrence.message,
      errorType: typeof type === "string" ? type : undefined,
      count: 1,
      at: occurrence.at,
      toolId: occurrence.toolChain.at(-1),
      node: occurrence.node,
      toolChain: occurrence.toolChain,
    });
  }
  return errors.map(({ toolChain: _chain, ...error }) => error);
}

/** The same message, within the window, on one call stack: a rethrow is
 *  logged by the tool it happened in and then by each tool above it, so
 *  one chain is a prefix of the other. Two sibling tools failing the same
 *  way have diverging chains and stay two errors. */
function sameBurst(error: TraceError & { toolChain: string[] }, occurrence: Occurrence): boolean {
  return (
    error.message === occurrence.message &&
    occurrence.at - error.at <= BURST_WINDOW_MS &&
    (isPrefix(error.toolChain, occurrence.toolChain) ||
      isPrefix(occurrence.toolChain, error.toolChain))
  );
}

function isPrefix(shorter: string[], longer: string[]): boolean {
  return shorter.length <= longer.length && shorter.every((id, at) => longer[at] === id);
}

export function runStatus(trace: TreeNode): RunStatus {
  const events = walkNodes(trace)
    .flatMap((node) => (node.event === undefined ? [] : [node.event]))
    .sort((first, second) => Date.parse(first.data.timestamp) - Date.parse(second.data.timestamp));
  const lastStart = events.findLastIndex((event) => event.data.type === "agentStart");
  // A log with no lifecycle events (an older or truncated log, a bare
  // fixture) can only say whether work is still open.
  if (lastStart === -1) {
    return hasRunningWork(trace) ? "running" : "done";
  }
  const thisRun = events.slice(lastStart + 1);
  const endAt = thisRun.findIndex((event) => event.data.type === "agentEnd");
  if (endAt !== -1) {
    return crashedBefore(thisRun.slice(0, endAt)) ? "crashed" : "done";
  }
  return awaitingResponse(events) ? "paused" : "running";
}

/** A crash is what the runtime logs when a run throws: an `error` with
 *  `errorType: "runtimeError"` right before the footer. A tool that failed
 *  and a structured reply the caller handled also log errors, and a node
 *  that returns nothing has no `result` on its footer, so neither of those
 *  can be the signal. */
function crashedBefore(events: EventEnvelope[]): boolean {
  const last = events.at(-1);
  return last?.data.type === "error" && last.data.errorType === "runtimeError";
}

/** Whether some interrupt's latest resolution still waits on a person.
 *  The runtime logs `propagated` when a handler sent the interrupt up and
 *  `passed` when no handler decided; a later resolution for the same id
 *  (the person's answer) replaces it. */
function awaitingResponse(events: EventEnvelope[]): boolean {
  const latest: Record<string, string> = Object.create(null);
  for (const event of events) {
    if (event.data.type !== "interruptResolved") {
      continue;
    }
    const id = typeof event.data.interruptId === "string" ? event.data.interruptId : "";
    latest[id] = String(event.data.outcome ?? "");
  }
  return Object.values(latest).some((outcome) => outcome === "propagated" || outcome === "passed");
}

/** One pause of the run: an interrupt went to a person, and the run
 *  resumed when the next `agentStart` was logged, if it has yet. */
export type RunPause = {
  interruptId: string | undefined;
  pausedAt: number;
  resumedAt: number | undefined;
  /** The `interruptResolved` event that paused the run. */
  node: TreeNode;
};

export function runPauses(trace: TreeNode): RunPause[] {
  const leaves = walkNodes(trace)
    .filter((node) => node.event !== undefined)
    .map((node) => ({ node, at: Date.parse(node.event!.data.timestamp) }))
    .filter((entry) => Number.isFinite(entry.at))
    .sort((first, second) => first.at - second.at);
  const starts = leaves.filter((entry) => entry.node.event!.data.type === "agentStart");
  const answers = leaves.filter((entry) => entry.node.event!.data.resolvedBy === "user");
  return leaves
    .filter((entry) => {
      const data = entry.node.event!.data;
      return (
        data.type === "interruptResolved" &&
        (data.outcome === "propagated" || data.outcome === "passed")
      );
    })
    .map((entry) => {
      const id = entry.node.event!.data.interruptId;
      // The wait ends when the person answers this interrupt. Several runs
      // can share one trace (a harness naming it for a process tree), so
      // another run's agentStart is only the fallback for a log that
      // recorded no answer.
      const answered = answers.find(
        (answer) => answer.at > entry.at && answer.node.event!.data.interruptId === id,
      );
      return {
        interruptId: typeof id === "string" ? id : undefined,
        pausedAt: entry.at,
        resumedAt: answered?.at ?? starts.find((start) => start.at > entry.at)?.at,
        node: entry.node,
      };
    });
}
