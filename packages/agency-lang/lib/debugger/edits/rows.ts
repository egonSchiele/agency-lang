import { frameName, type Checkpoint } from "../../runtime/state/checkpointStore.js";
import type { CheckpointEdit } from "../../runtime/state/checkpointPatch/index.js";
import type { LoopStopKind } from "../../runtime/state/sourceLocation.js";

/** Where a pane looks: a stack by branch path and, when the stop is one
 *  of the tool loop's own, which kind, so the shown frame is the caller
 *  under the loop's. */
export type ViewAt = { branchPath: string[]; loopStop: LoopStopKind | undefined };

/** The edits queued at a stop and the line the driver printed for each. */
export type PendingPreview = { edits: CheckpointEdit[]; applied: string[] };

/** What the panes draw from: the stop's checkpoint, where the stop is,
 *  where the person is looking (another branch, after `b`), the module
 *  whose globals the globals pane shows (the viewed frame's), and the
 *  edits queued so far. */
export type StopView = {
  checkpoint: Checkpoint;
  stop: ViewAt;
  viewed: ViewAt;
  moduleId: string;
  pending: PendingPreview;
};

/** A frame by its stack and its distance from the top, 0 the last. */
export type FrameRef = { branchPath: string[]; depth: number };

export type PaneName = "threads" | "locals" | "globals" | "callStack" | "branches" | "guards";

/** One row of a pane, as the pane prints it and as an edit anchors to
 *  it, with the address the patch library takes. */
export type PaneRow =
  | { kind: "thread"; id: string; label: string | null; active: boolean; messageCount: number }
  | { kind: "local"; name: string; value: unknown; arg: boolean; frame: FrameRef }
  | { kind: "global"; module: string; name: string; value: unknown; branchPath: string[] }
  | { kind: "frame"; scopeName: string; moduleId: string; frame: FrameRef }
  | { kind: "tool"; name: string; removed: boolean; loop: { branchPath: string[] } }
  | {
      kind: "branch";
      key: string;
      path: string[];
      label: string;
      status: string;
      owner: string;
    }
  | { kind: "loop"; round: number; removedTools: string[]; tools: string[] | null }
  | {
      kind: "guard";
      index: number;
      label: string | null;
      dimension: "cost" | "time";
      limit: number;
      spent: number;
      disarmed: boolean;
      root: boolean;
    };

export type RowKind = PaneRow["kind"];

const isInternal = (name: string) => name.startsWith("__");

/** For each frame along `branchPath`, the branch path of the stack it is
 *  on: the root's frames are on `[]`, a branch's on the path to it. */
function stacksOf(checkpoint: Checkpoint, branchPath: string[]): string[][] {
  const stacks: string[][] = [];
  for (let depth = 0; depth <= branchPath.length; depth++) {
    const here = branchPath.slice(0, depth);
    const count = checkpoint.stackAt(here)?.length ?? 0;
    for (let i = 0; i < count; i++) stacks.push(here);
  }
  return stacks;
}

/** The depth, from the top of the viewed stack, of the frame the panes
 *  show: the last frame, or at one of the loop's own stops on the
 *  stop's own stack, the caller under the loop's frame. */
function shownDepth(view: StopView): number {
  const ownStack = view.viewed.branchPath.join("/") === view.stop.branchPath.join("/");
  return ownStack && view.viewed.loopStop !== undefined ? 1 : 0;
}

/** The rows a pane shows at this view. The one place a pane row is
 *  made: the panes draw these, and the edits anchor to them. */
export function rowsFor(pane: PaneName, view: StopView): PaneRow[] {
  const { checkpoint, viewed } = view;
  switch (pane) {
    case "threads":
      return checkpoint.listThreads(viewed.branchPath).map((thread) => ({
        kind: "thread",
        id: thread.id,
        label: thread.label,
        active: thread.active,
        messageCount: thread.messageCount,
      }));
    case "locals": {
      const stack = checkpoint.stackAt(viewed.branchPath) ?? [];
      const depth = shownDepth(view);
      const frame = stack.at(-1 - depth);
      if (!frame) return [];
      const ref: FrameRef = { branchPath: viewed.branchPath, depth };
      // The same names the pane prints, in the same order, so row i is
      // line i: an internal name is dropped from args and locals alike.
      const args = Object.entries(frame.args ?? {})
        .filter(([name]) => !isInternal(name))
        .map(([name, value]): PaneRow => ({ kind: "local", name, value, arg: true, frame: ref }));
      const locals = Object.entries(frame.locals ?? {})
        .filter(([name]) => !isInternal(name))
        .map(([name, value]): PaneRow => ({ kind: "local", name, value, arg: false, frame: ref }));
      return [...args, ...locals];
    }
    case "globals": {
      const store = checkpoint.globalsAt(viewed.branchPath).store ?? {};
      const module = view.moduleId;
      return Object.entries(store[module] ?? {}).map(([name, value]) => ({
        kind: "global",
        module,
        name,
        value,
        branchPath: viewed.branchPath,
      }));
    }
    case "callStack": {
      // A loop frame's tools sit under it, keyed to the stack the frame is
      // on, which is the loop `removeTool` resolves from that stack.
      const stacks = stacksOf(checkpoint, viewed.branchPath);
      const frames = checkpoint.framesAlong(viewed.branchPath);
      const rows: PaneRow[] = [];
      frames.forEach((frame, index) => {
        rows.push({
          kind: "frame",
          scopeName: frameName(frame.scopeName),
          moduleId: frame.moduleId ?? "",
          frame: { branchPath: viewed.branchPath, depth: frames.length - 1 - index },
        });
        if (frame.scopeName !== "runPrompt" || !Array.isArray(frame.locals?.toolNames)) return;
        const removed: string[] = Array.isArray(frame.locals?.removedTools)
          ? frame.locals.removedTools
          : [];
        for (const name of frame.locals.toolNames as string[]) {
          rows.push({
            kind: "tool",
            name,
            removed: removed.includes(name),
            loop: { branchPath: stacks[index] },
          });
        }
      });
      return rows;
    }
    case "branches":
      return checkpoint.listBranches().map((branch) => ({
        kind: "branch",
        key: branch.key,
        path: branch.path,
        label: branch.label,
        status: branch.status,
        owner: branch.owner,
      }));
    case "guards": {
      const loop = checkpoint.loopState(viewed.branchPath);
      const loopRow: PaneRow[] = loop
        ? [{ kind: "loop", round: loop.round, removedTools: loop.removedTools, tools: loop.tools }]
        : [];
      const guards = checkpoint.listGuards(viewed.branchPath).map((guard, index): PaneRow => ({
        kind: "guard",
        index,
        label: guard.label,
        dimension: guard.dimension,
        limit: guard.limit,
        spent: guard.spent,
        disarmed: guard.disarmed,
        root: guard.root,
      }));
      return [...loopRow, ...guards];
    }
  }
}
