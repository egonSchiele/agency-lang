import type {
  BranchSummary,
  Checkpoint,
  GuardSummary,
  LoopState,
  ThreadView,
} from "../checkpointStore.js";
import type { LoopStopKind } from "../sourceLocation.js";
import type { StateJSON } from "../stateStack.js";
import type { BranchAddress, FrameAddress, GuardAddress, Refusal, ThreadAddress } from "./edits.js";

/** Where the stop is: its branch path, and which of the loop's own stops
 *  it is, if any. An omitted address resolves against this. A stop in a
 *  batch shares its checkpoint with its siblings, so the caller passes
 *  the stop's own location; a checkpoint on its own passes its own. */
export type StopAt = { branchPath: string[]; loopStop: LoopStopKind | undefined };

/** The stop a checkpoint names, for a caller with no stop record. */
export function stopOfCheckpoint(checkpoint: Checkpoint): StopAt {
  return { branchPath: checkpoint.branchPath, loopStop: checkpoint.loopStop };
}

/** What an address found, and where in the checkpoint's JSON. */
export type Located<T> = { jsonPath: string[]; found: T };

/** The frames of the stack `branchPath` leads to, with their paths: the
 *  last stack the walk reaches, when the path is held in full. */
function framesOfStack(
  checkpoint: Checkpoint,
  branchPath: string[],
): { frame: StateJSON; jsonPath: string[] }[] | Refusal {
  const stack = checkpoint.stackAt(branchPath);
  if (!stack) return { refused: `no branch at ${branchPath.join("/")}` };
  return checkpoint.walkFrames(branchPath).slice(-stack.length);
}

export function resolveFrame(
  address: FrameAddress | undefined,
  checkpoint: Checkpoint,
  at: StopAt,
): Located<StateJSON> | Refusal {
  const branchPath = address?.branchPath ?? at.branchPath;
  const frames = framesOfStack(checkpoint, branchPath);
  if ("refused" in frames) return frames;
  if (frames.length === 0) return { refused: `no frames on the stack at ${branchPath.join("/")}` };
  if (address !== undefined && "scope" in address) {
    const found = frames.findLast(({ frame }) => frame.scopeName === address.scope);
    if (!found) return { refused: `no frame of scope ${address.scope} on this stack` };
    return { jsonPath: found.jsonPath, found: found.frame };
  }
  // Omitted depth at the stop's own stack: the frame the stop shows,
  // which at one of the loop's own stops is the caller under the loop.
  const ownStack = address?.branchPath === undefined;
  const depth = address?.depth ?? (ownStack && at.loopStop !== undefined ? 1 : 0);
  const found = frames.at(-1 - depth);
  if (!found) return { refused: `no frame at depth ${depth} on this stack` };
  return { jsonPath: found.jsonPath, found: found.frame };
}

/** The nearest tool loop above the stop: `loopState`'s rule, over every
 *  stack along the branch path, since a stop inside a tool call has its
 *  loop on the parent's stack. */
export function resolveLoopFrame(
  address: { branchPath?: string[] } | undefined,
  checkpoint: Checkpoint,
  at: StopAt,
): Located<LoopState> | Refusal {
  const loop = checkpoint.loopState(address?.branchPath ?? at.branchPath);
  if (!loop) return { refused: "no tool loop above this stop" };
  return { jsonPath: loop.jsonPath, found: loop };
}

export function resolveThread(
  address: ThreadAddress | undefined,
  checkpoint: Checkpoint,
  at: StopAt,
): Located<ThreadView> | Refusal {
  const views = checkpoint.threadsAlong(at.branchPath);
  if (address === undefined || "active" in address) {
    const active = views.find((view) => view.active) ?? views[0];
    if (!active) return { refused: "no thread at this stop" };
    return { jsonPath: active.jsonPath, found: active };
  }
  if ("id" in address) {
    const view = views.find((candidate) => candidate.key === address.id);
    if (!view) return { refused: `no thread with id ${address.id}` };
    return { jsonPath: view.jsonPath, found: view };
  }
  const labelled = views.filter((view) => view.thread.label === address.label);
  if (labelled.length === 0) return { refused: `no thread labelled ${address.label}` };
  if (labelled.length > 1) {
    const ids = labelled.map((view) => view.key).join(", ");
    return { refused: `two threads are labelled ${address.label}: ${ids}; name one by id` };
  }
  return { jsonPath: labelled[0].jsonPath, found: labelled[0] };
}

export function resolveBranch(
  address: BranchAddress,
  checkpoint: Checkpoint,
): Located<BranchSummary> | Refusal {
  const branches = checkpoint.listBranches();
  const matches =
    "path" in address
      ? branches.filter((branch) => branch.path.join("/") === address.path.join("/"))
      : branches.filter((branch) => branch.key === address.key);
  const name = "path" in address ? address.path.join("/") : address.key;
  if (matches.length === 0) return { refused: `no branch ${name}` };
  if (matches.length > 1) {
    const paths = matches.map((branch) => branch.path.join("/")).join(", ");
    return { refused: `two branches are keyed ${name}: ${paths}; name one by path` };
  }
  return { jsonPath: matches[0].jsonPath, found: matches[0] };
}

/** A guard on the stacks the stop runs under, with every copy's path;
 *  `jsonPath` is the owning copy's. */
export function resolveGuard(
  address: GuardAddress,
  branchPath: string[] | undefined,
  checkpoint: Checkpoint,
  at: StopAt,
): Located<GuardSummary> | Refusal {
  const guards = checkpoint.listGuards(branchPath ?? at.branchPath);
  if ("index" in address) {
    const guard = guards[address.index];
    if (!guard) return { refused: `no guard at index ${address.index}` };
    return { jsonPath: guard.jsonPaths[0], found: guard };
  }
  const labelled = guards.filter((guard) => guard.label === address.label);
  if (labelled.length === 0) return { refused: `no guard labelled ${address.label}` };
  if (labelled.length > 1) {
    const indices = labelled.map((guard) => guards.indexOf(guard)).join(", ");
    return { refused: `two guards are labelled ${address.label}: ${indices}; name one by index` };
  }
  return { jsonPath: labelled[0].jsonPaths[0], found: labelled[0] };
}

/** A module's globals in the store the stop reads: a fork or parallel
 *  branch's own copy inside one, the root's otherwise. */
export function resolveModule(
  module: string | undefined,
  branchPath: string[] | undefined,
  checkpoint: Checkpoint,
  at: StopAt,
): Located<Record<string, unknown>> | Refusal {
  const location = checkpoint.globalsLocation(branchPath ?? at.branchPath);
  const name = module ?? checkpoint.moduleId;
  const found = location.store[name];
  if (!found) return { refused: `no globals for module ${name}` };
  return { jsonPath: [...location.jsonPath, name], found };
}
