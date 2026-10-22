// The one-screen summary an agent reads first and after every move: the
// stop, the stack, the threads, the branches, the guards, the usage, what
// happened since the last visit, and what makes sense next. One pure
// function of what the visit was shown, to text and to JSON.
import type { PartiesMessage } from "@/debugger/attach/protocol.js";
import type { Checkpoint } from "@/runtime/state/checkpointStore.js";
import type { DebugStopData } from "@/runtime/debugger.js";

import { stackOf, usageOf, type FrameView } from "./readers.js";

export type WhereInput = {
  program: string;
  node: string;
  pid: number;
  parties: PartiesMessage;
  recent: string[];
  checkpoint: Checkpoint | undefined;
  stop: DebugStopData | undefined;
  /** The stop's source line, when the module's map is on disk. */
  line: number | undefined;
  /** The statement's text, when the source is on disk. */
  statement: string | undefined;
  /** The program's own interrupt the stop is beside, if any. */
  interruptId: string | undefined;
};

export type WhereJson = {
  pid: number;
  program: string;
  node: string;
  stopped: true;
  stop: {
    scope: string;
    label: string | null;
    moduleId: string;
    line: number | null;
    statement: string | null;
    depth: number;
    branchPath: string[];
  } | null;
  stack: FrameView[];
  threads: {
    id: string;
    label: string | null;
    parentId: string | null;
    messages: number;
    active: boolean;
  }[];
  branches: { key: string; label: string; owner: string; status: string; path: string[] }[];
  guards: {
    label: string | null;
    dimension: string;
    spent: number;
    limit: number;
    disarmed: boolean;
    root: boolean;
  }[];
  usage: { totalTokens: number; totalCost: number };
  parties: { terminal: boolean; cli: boolean };
  recent: string[];
  interruptId: string | null;
};

export function whereJson(input: WhereInput): WhereJson {
  const branchPath = input.stop?.branchPath ?? [];
  const checkpoint = input.checkpoint;
  return {
    pid: input.pid,
    program: input.program,
    node: input.node,
    stopped: true,
    stop:
      input.stop === undefined
        ? null
        : {
            scope: input.stop.scopeName,
            label: input.stop.label,
            moduleId: input.stop.moduleId,
            line: input.line ?? null,
            statement: input.statement ?? null,
            depth: input.stop.depth,
            branchPath,
          },
    stack: checkpoint === undefined ? [] : stackOf(checkpoint, branchPath),
    threads:
      checkpoint === undefined
        ? []
        : checkpoint.listThreads(branchPath).map((thread) => ({
            id: thread.id,
            label: thread.label,
            parentId: thread.parentId,
            messages: thread.messageCount,
            active: thread.active,
          })),
    branches:
      checkpoint === undefined
        ? []
        : checkpoint.listBranches().map((branch) => ({
            key: branch.key,
            label: branch.label,
            owner: branch.owner,
            status: branch.status,
            path: branch.path,
          })),
    guards:
      checkpoint === undefined
        ? []
        : checkpoint.listGuards(branchPath).map((guard) => ({
            label: guard.label,
            dimension: guard.dimension,
            spent: guard.spent,
            limit: guard.limit,
            disarmed: guard.disarmed,
            root: guard.root,
          })),
    usage: checkpoint === undefined ? { totalTokens: 0, totalCost: 0 } : usageOf(checkpoint),
    parties: { terminal: input.parties.terminal, cli: input.parties.cli },
    recent: input.recent,
    interruptId: input.interruptId ?? null,
  };
}

export function whereText(input: WhereInput): string {
  const json = whereJson(input);
  const lines: string[] = [];
  lines.push(`${json.program} · node ${json.node} · pid ${json.pid}`);
  if (json.parties.terminal) {
    lines.push("a terminal debugger is attached too");
  }
  if (json.stop === null) {
    lines.push("stopped (no statement to show)");
  } else {
    const label = json.stop.label === null ? "" : ` ("${json.stop.label}")`;
    const where =
      json.stop.line === null ? json.stop.moduleId : `${json.stop.moduleId}:${json.stop.line}`;
    lines.push(`stopped in ${json.stop.scope}${label} · ${where}`);
    if (json.stop.statement !== null) {
      lines.push(`  ${json.stop.statement.trim()}`);
    }
  }
  if (json.stack.length > 0) {
    lines.push(`stack   ${json.stack.map(frameWords).join(" › ")}`);
  }
  // A thread with no label and no messages yet is the empty main thread
  // of a program that has not called the model; not worth a line.
  const threads = json.threads.filter((thread) => thread.label !== null || thread.messages > 0);
  if (threads.length > 0) {
    const words = threads.map(
      (thread) =>
        `${thread.label ?? thread.id} (${thread.messages} message${thread.messages === 1 ? "" : "s"}${thread.active ? ", active" : ""})`,
    );
    lines.push(`threads ${words.join(" · ")}`);
  }
  if (json.branches.length > 0) {
    const branches = json.branches.map(
      (branch) => `${branch.key} ${branch.label} (${branch.status})`,
    );
    lines.push(`branches ${branches.join(" · ")}`);
  }
  if (json.guards.length > 0) {
    lines.push(`guards  ${json.guards.map(guardWords).join(" · ")}`);
  }
  lines.push(
    `usage   ${json.usage.totalTokens.toLocaleString()} tokens · $${json.usage.totalCost.toFixed(2)}`,
  );
  if (json.interruptId !== null) {
    lines.push(
      `the program raised an interrupt (${json.interruptId}); its caller answers it, not the debugger`,
    );
  }
  if (json.recent.length > 0) {
    lines.push(`since   ${json.recent.join(" · ")}`);
  }
  lines.push("next    step, next, continue, frame, thread, branches, guards, detach");
  return lines.join("\n");
}

function frameWords(frame: FrameView): string {
  if (frame.loop === undefined) {
    return frame.name;
  }
  const removed =
    frame.loop.removedTools.length === 0 ? "" : `; removed ${frame.loop.removedTools.join(", ")}`;
  return `${frame.name} (round ${frame.loop.round}${removed})`;
}

export function guardWords(guard: WhereJson["guards"][number]): string {
  const name = guard.root ? "root budget" : (guard.label ?? "guard");
  const figures =
    guard.dimension === "cost"
      ? `cost $${guard.spent.toFixed(2)} of $${guard.limit.toFixed(2)}`
      : `time ${duration(guard.spent)} of ${duration(guard.limit)}`;
  return `${name} · ${figures}${guard.disarmed ? " (disarmed)" : ""}`;
}

export function duration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest === 0 ? `${minutes}m` : `${minutes}m${rest}s`;
}

/** The line `where` prints for a program that is running. */
export function runningText(program: string, pid: number, parties: PartiesMessage): string {
  const beside = parties.terminal ? "; a terminal debugger is attached too" : "";
  return `${program} · pid ${pid} is running${beside}; wait stops here at its next stop`;
}
