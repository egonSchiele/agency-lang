import { MessageJSON } from "smoltalk";
import { signCheckpoint } from "../checkpointChecksum.js";
import type { HostSettings } from "../../host/host.js";
import { CheckpointError } from "../errors.js";
import { collectModuleFingerprints } from "../referencedModules.js";
import type { ModuleFingerprint } from "../moduleFingerprintRegistry.js";
import { deepClone } from "../utils.js";
import type { RuntimeContext } from "./context.js";
import type { GlobalStoreJSON } from "./globalStore.js";
import { checkpointSchema } from "./schemas.js";
import type { LoopStopKind, SourceLocation } from "./sourceLocation.js";
import type { BranchStateJSON, StateJSON, StateStackJSON } from "./stateStack.js";
import type { StateStack } from "./stateStack.js";
import type { RunUsage } from "../invocationUsage.js";

/** Label used for pinned checkpoints created at function entry for Result error handling. */
export const RESULT_ENTRY_LABEL = "result-entry";

let globalCheckpointCounter = 0;

export type SourceLocationOpts = Omit<SourceLocation, "nodeId">;

/** Whether two locations name the same step on the same stack. A step
 *  inside a tool call is told from the same step in another call of that
 *  tool by its branch path. */
export function sameLocation(a: SourceLocationOpts, b: SourceLocationOpts): boolean {
  const aPath = a.branchPath ?? [];
  const bPath = b.branchPath ?? [];
  return (
    a.moduleId === b.moduleId &&
    a.scopeName === b.scopeName &&
    a.stepPath === b.stepPath &&
    aPath.length === bPath.length &&
    aPath.every((key, index) => key === bPath[index])
  );
}

/** Whether `a`'s step ran on the same stack as `b`'s or on a stack above
 *  it: `a`'s branch path is a prefix of `b`'s. */
function onStackOrAbove(a: SourceLocationOpts, b: SourceLocationOpts): boolean {
  const aPath = a.branchPath ?? [];
  const bPath = b.branchPath ?? [];
  return aPath.length <= bPath.length && aPath.every((key, index) => key === bPath[index]);
}

/** Reset the global checkpoint ID counter. For use in tests only. */
export function resetGlobalCheckpointCounter(): void {
  globalCheckpointCounter = 0;
}

export type ThreadMessages = {
  threadId: string;
  threadIndex: number;
  threadCount: number;
  messages: { role: string; content: string }[];
};

/** One branch of a frame, as the branches pane lists it: a tool call, a
 *  fork branch, or a parallel item, with its own stack. */
export type BranchSummary = {
  /** The branch keys from the root down to this branch. */
  path: string[];
  key: string;
  /** The frame that owns the branch; the tool loop's is `llm()`. */
  owner: string;
  /** The scope the branch runs: the tool's name, or the block's. */
  label: string;
  status: "running" | "interrupted" | "done";
};

/** One guard on the stacks the stopped code runs under. */
export type GuardSummary = {
  label: string | null;
  dimension: "cost" | "time";
  /** Dollars, or milliseconds. */
  limit: number;
  spent: number;
  disarmed: boolean;
  root: boolean;
  /** True when the figures are a branch's own copy of a guard above it:
   *  a time guard's clone carries the parent's remaining time as its
   *  limit, and the branch's own working time as spent. */
  inherited: boolean;
};

/** The tool loop the stopped code is in: its round, counted from 1, and
 *  the tools the loop has removed. */
export type LoopState = { round: number; removedTools: string[] };

export type CheckpointArgs = {
  id?: number;
  stack: StateStackJSON;
  globals: GlobalStoreJSON;
  nodeId: string;
  moduleId?: string;
  scopeName?: string;
  stepPath?: string;
  branchPath?: string[];
  loopStop?: LoopStopKind;
  label?: string | null;
  pinned?: boolean;
  moduleFingerprints?: Record<string, ModuleFingerprint>;
  usage?: unknown;
  traceId?: string;
  signature?: string;
};

export type CheckpointJSON = {
  id: number;
  stack: StateStackJSON;
  globals: GlobalStoreJSON;
  nodeId: string;
  moduleId: string;
  scopeName: string;
  stepPath: string;
  /** Present only for a checkpoint taken on a branch stack, so a
   *  checkpoint from before the field keeps its signature. */
  branchPath?: string[];
  /** Present only for a checkpoint taken at one of the tool loop's own
   *  stops. */
  loopStop?: LoopStopKind;
  label: string | null;
  pinned: boolean;
  moduleFingerprints?: Record<string, ModuleFingerprint>;
  usage?: unknown;
  traceId?: string;
  signature?: string;
};

/** A branch's status. `interruptId` is never cleared once set, so a
 *  branch that stopped on an interrupt and later returned has both
 *  fields; the result decides. */
function branchStatus(branch: BranchStateJSON): BranchSummary["status"] {
  if (branch.result !== undefined) return "done";
  if (branch.interruptId !== undefined) return "interrupted";
  return "running";
}

/** The name of the tool a loop frame called under the branch key
 *  `tool_<index>_<id>`, from the tool calls in the loop's copy of its
 *  thread; undefined when the frame is not a loop's or has no such call. */
function toolCallName(frame: StateJSON | undefined, key: string): string | undefined {
  if (frame?.scopeName !== "runPrompt") return undefined;
  const copy = frame.locals?.messagesJSON;
  const messages: unknown[] = Array.isArray(copy) ? copy : (copy?.messages ?? []);
  for (const message of messages) {
    const calls = (message as { toolCalls?: { id?: string; name?: string }[] } | null)?.toolCalls;
    if (!Array.isArray(calls)) continue;
    const index = calls.findIndex((call, i) => `tool_${i}_${call.id ?? ""}` === key);
    if (index >= 0) return calls[index].name;
  }
  return undefined;
}

export class Checkpoint implements SourceLocation {
  public id: number;
  public stack: StateStackJSON;
  public globals: GlobalStoreJSON;
  public nodeId: string;
  public moduleId: string;
  public scopeName: string;
  public stepPath: string;
  /** The branch keys from the root stack down to the stack the step ran
   *  on, empty for the root. `getCurrentFrame` follows it. */
  public branchPath: string[];
  /** Set for a checkpoint taken at one of the tool loop's own stops,
   *  before a model request or a tool call. See `SourceLocation`. */
  public loopStop?: LoopStopKind;
  public label: string | null;
  public pinned: boolean;
  /** The fingerprint (a hash of the generated code) of each module with a
   *  live frame, captured at creation so a resume can refuse when the code
   *  changed. */
  public moduleFingerprints?: Record<string, ModuleFingerprint>;
  /** What the run had spent when this checkpoint was taken, so a resumed run
   *  keeps counting from there. `unknown` because a checkpoint comes back from
   *  the host; `InvocationUsageMeter.resumeFrom` recovers it. */
  public usage?: unknown;
  /** The statelog trace the run was logging to when this checkpoint was
   *  taken, so a resume from a file can log into the same trace. Absent on
   *  checkpoints from before the field and on contexts with no run id. */
  public traceId?: string;
  /** HMAC checksum embedded at creation when a signing key is configured.
   *  Absent on unsigned checkpoints. See lib/runtime/checkpointChecksum.ts. */
  public signature?: string;

  constructor(args: CheckpointArgs) {
    this.id = args.id ?? globalCheckpointCounter++;
    this.stack = args.stack;
    this.globals = args.globals;
    this.nodeId = args.nodeId;
    this.moduleId = args.moduleId ?? "";
    this.scopeName = args.scopeName ?? "";
    this.stepPath = args.stepPath ?? "";
    this.branchPath = args.branchPath ?? [];
    this.loopStop = args.loopStop;
    this.label = args.label ?? null;
    this.pinned = args.pinned ?? false;
    this.moduleFingerprints = args.moduleFingerprints;
    this.usage = args.usage;
    this.traceId = args.traceId;
    this.signature = args.signature;
  }

  getScopeKey(): string {
    return `${this.moduleId}:${this.scopeName}`;
  }

  /** The location, with `branchPath` only when the step ran on a branch
   *  stack, as `toJSON` writes it. */
  get location(): SourceLocation {
    const location: SourceLocation = {
      nodeId: this.nodeId,
      moduleId: this.moduleId,
      scopeName: this.scopeName,
      stepPath: this.stepPath,
    };
    if (this.branchPath.length > 0) {
      location.branchPath = this.branchPath;
    }
    if (this.loopStop !== undefined) {
      location.loopStop = this.loopStop;
    }
    return location;
  }

  /** The frame the checkpoint was taken in: the last frame of the stack
   *  its branch path leads to. For a step inside a tool call that is the
   *  tool's frame, not the root's last frame. Undefined when the path
   *  names a branch the checkpoint does not hold. */
  getCurrentFrame(): StateJSON | undefined {
    return this.frameAt(this.branchPath);
  }

  /** The last frame of the stack `branchPath` leads to, from the root. */
  frameAt(branchPath: string[]): StateJSON | undefined {
    return this.stackAt(branchPath)?.at(-1);
  }

  /** The frames of the stack `branchPath` leads to, from the root. */
  stackAt(branchPath: string[]): StateJSON[] | undefined {
    let frames: StateJSON[] | undefined = this.stack.stack;
    for (const key of branchPath) {
      frames = frames?.at(-1)?.branches?.[key]?.stack.stack;
    }
    return frames;
  }

  /** The frame a person inspects at a location: the frame the step ran
   *  in, or, at one of the tool loop's own stops, the frame that called
   *  `llm()`, the one under the loop's frame. */
  shownFrame(location: { branchPath?: string[]; loopStop?: LoopStopKind }): StateJSON | undefined {
    const frames = this.stackAt(location.branchPath ?? []);
    return frames?.at(location.loopStop === undefined ? -1 : -2);
  }

  /** The last frame of the root stack. */
  private rootFrame(): StateJSON | undefined {
    return this.stack.stack?.at(-1);
  }

  getThreadMessages(displayIndex?: number): ThreadMessages | null {
    const frame = this.rootFrame();
    if (!frame?.threads) return null;

    const { threads, activeStack } = frame.threads;
    const threadIds = Object.keys(threads);
    if (threadIds.length === 0) return null;

    let selectedId: string;
    let selectedIndex: number;

    if (displayIndex !== undefined) {
      // Explicit index requested (for thread cycling)
      selectedIndex = ((displayIndex % threadIds.length) + threadIds.length) % threadIds.length;
      selectedId = threadIds[selectedIndex];
    } else {
      // Default: prefer the active thread at the top of the stack
      selectedId = activeStack.findLast((id) => threads[id] != null) ?? threadIds[0];
      selectedIndex = threadIds.indexOf(selectedId);
    }

    const selectedThread = threads[selectedId];
    if (!selectedThread) return null;

    const messages = selectedThread.messages.map((m: MessageJSON) => ({
      role: m.role ?? "unknown",
      content: this.getContentFromMessage(m),
    }));

    return {
      threadId: selectedId,
      threadIndex: selectedIndex,
      threadCount: threadIds.length,
      messages,
    };
  }

  private getContentFromMessage(message: MessageJSON): string {
    if (typeof message.content === "string") {
      return message.content;
    } else if (Array.isArray(message.content)) {
      return message.content.map((part) => part.text ?? "").join("");
    } else if (message.content == null) {
      if (message.role === "assistant" && message.toolCalls) {
        return message.toolCalls
          .map((toolCall) => `Tool call: ${toolCall.name}(${JSON.stringify(toolCall.arguments)})`)
          .join("\n");
      }
      return "(no content)";
    }
    return JSON.stringify(message.content);
  }

  /** The frames from the root down the branch path, the deepest last. */
  framesAlong(branchPath: string[]): StateJSON[] {
    const frames: StateJSON[] = [];
    for (let depth = 0; depth <= branchPath.length; depth++) {
      frames.push(...(this.stackAt(branchPath.slice(0, depth)) ?? []));
    }
    return frames;
  }

  /** The stack `branchPath` leads to, as serialized. */
  private stackJSONAt(branchPath: string[]): StateStackJSON | undefined {
    let stack: StateStackJSON | undefined = this.stack;
    for (const key of branchPath) {
      stack = stack?.stack?.at(-1)?.branches?.[key]?.stack;
    }
    return stack;
  }

  /** Every branch in the checkpoint, from the root stack down through
   *  the stacks of the branches themselves, in the order the checkpoint
   *  holds them. Stopped inside one tool, a person sees its siblings.
   *  Only the last frame of a stack holds branches, as `stackAt` reads.
   *  A finished branch has no frames, since a function pops its frame
   *  when it returns, so its name comes from the tool loop's record of
   *  the call, when the loop is the owner. */
  listBranches(): BranchSummary[] {
    const branches: BranchSummary[] = [];
    const visit = (frames: StateJSON[] | undefined, path: string[]) => {
      const frame = frames?.at(-1);
      for (const [key, branch] of Object.entries(frame?.branches ?? {})) {
        const branchPathHere = [...path, key];
        branches.push({
          path: branchPathHere,
          key,
          owner: frame?.scopeName === "runPrompt" ? "llm()" : (frame?.scopeName ?? ""),
          label: branch.stack.stack?.[0]?.scopeName ?? toolCallName(frame, key) ?? key,
          status: branchStatus(branch),
        });
        visit(branch.stack.stack, branchPathHere);
      }
    };
    visit(this.stack.stack, []);
    return branches;
  }

  /** The guards the stopped code runs under, outermost first: those on
   *  each stack along `branchPath`, a stack's inherited ones before its
   *  own. A branch stack serializes the time guards it inherited, since
   *  their elapsed time is its own: each is a clone with the parent's
   *  guard id, the parent's remaining time as its limit, and the branch's
   *  working time as spent. A guard is listed once, in the place of its
   *  outermost copy, with the figures of the deepest, which are the ones
   *  the stopped code is metered by. A cost guard is shared by reference,
   *  so a branch never serializes an inherited one. */
  listGuards(branchPath: string[] = []): GuardSummary[] {
    const guards: GuardSummary[] = [];
    const indexById: Record<string, number> = {};
    for (let depth = 0; depth <= branchPath.length; depth++) {
      const stack = this.stackJSONAt(branchPath.slice(0, depth));
      const own = stack?.guards ?? [];
      const inherited = stack?.inheritedTimeGuards ?? [];
      for (const guard of [...inherited, ...own]) {
        const summary: GuardSummary = {
          label: guard.label ?? null,
          dimension: guard.kind,
          limit: guard.kind === "cost" ? guard.costLimit : guard.timeLimit,
          spent: guard.kind === "cost" ? guard.spent : guard.elapsedMs,
          disarmed: guard.disarmed === true,
          root: guard.isRootBudget === true,
          inherited: inherited.includes(guard),
        };
        const seen = guard.guardId === undefined ? undefined : indexById[guard.guardId];
        if (seen !== undefined) {
          guards[seen] = summary;
          continue;
        }
        if (guard.guardId !== undefined) {
          indexById[guard.guardId] = guards.length;
        }
        guards.push(summary);
      }
    }
    return guards;
  }

  /** The tool loop the stopped code is in, from the deepest loop frame
   *  along `branchPath`; null outside any `llm()` call. */
  loopState(branchPath: string[] = []): LoopState | null {
    const frame = this.framesAlong(branchPath).findLast(
      (candidate) =>
        candidate.scopeName === "runPrompt" && candidate.locals?.toolCallRound !== undefined,
    );
    if (!frame) return null;
    return {
      round: frame.locals.toolCallRound + 1,
      removedTools: Array.isArray(frame.locals.removedTools) ? frame.locals.removedTools : [],
    };
  }

  getGlobalsForModule(): Record<string, any> | null {
    return this.globals.store?.[this.moduleId] ?? null;
  }

  /** The globals the stack `branchPath` leads to sees. A `fork` or
   *  `parallel` branch runs on its own copy of the globals (`runBatch`
   *  saves it as the branch's `globalsJSON` before every checkpoint), so
   *  a module-level variable it changed has the branch's value here and
   *  the root's in `globals`. A branch that shares the globals, a tool
   *  call, has no copy and sees the nearest copy above it, or the root's. */
  globalsAt(branchPath: string[]): GlobalStoreJSON {
    let globals = this.globals;
    let frame = this.rootFrame();
    for (const key of branchPath) {
      const branch = frame?.branches?.[key];
      if (branch?.globalsJSON) globals = branch.globalsJSON;
      frame = branch?.stack.stack.at(-1);
    }
    return globals;
  }

  getFilename(): string {
    return this.moduleId.split("/").pop() || this.moduleId;
  }

  pathEquals(other: Checkpoint): boolean {
    return sameLocation(this, other);
  }

  equals(other: Checkpoint): boolean {
    return JSON.stringify(this.toJSON()) === JSON.stringify(other.toJSON());
  }

  toJSON(): CheckpointJSON {
    const json: CheckpointJSON = {
      id: this.id,
      stack: this.stack,
      globals: this.globals,
      nodeId: this.nodeId,
      moduleId: this.moduleId,
      scopeName: this.scopeName,
      stepPath: this.stepPath,
      label: this.label,
      pinned: this.pinned,
    };
    if (this.branchPath.length > 0) {
      json.branchPath = this.branchPath;
    }
    if (this.loopStop !== undefined) {
      json.loopStop = this.loopStop;
    }
    if (this.moduleFingerprints !== undefined) {
      json.moduleFingerprints = this.moduleFingerprints;
    }
    if (this.usage !== undefined) {
      json.usage = this.usage;
    }
    if (this.traceId !== undefined) {
      json.traceId = this.traceId;
    }
    if (this.signature !== undefined) {
      json.signature = this.signature;
    }
    return json;
  }

  /** A copy with `opts` applied, re-signed under `settings` when this
   *  checkpoint was signed, since `opts` may change signed fields
   *  (typically `id`). */
  clone(opts: Partial<CheckpointArgs>, settings: HostSettings): Checkpoint {
    const copy = Checkpoint.fromJSON({ ...this.toJSON(), ...opts })!;
    if (copy.signature !== undefined) {
      signCheckpoint(copy, settings);
    }
    return copy;
  }

  getLocation(): string {
    return `${this.moduleId}:${this.scopeName}#${this.stepPath}`;
  }

  static fromStateStack(
    stateStack: StateStack,
    ctx: RuntimeContext<any>,
    opts: SourceLocationOpts & { label?: string | null; pinned?: boolean },
  ): Checkpoint {
    const nodeId = ctx.stateStack.currentNodeId();
    if (!nodeId) {
      throw new CheckpointError(
        "Cannot create checkpoint: no current node id in state stack. This error can happen if you call a function that throws an interrupt from the global namespace. Please use `const foo = funcName() with approve` syntax.",
      );
    }
    // Live state that is only written into the stack on demand: a tool
    // loop's thread, a branch's own globals. Every checkpoint, from any
    // stack and for any reason, is taken after these run.
    for (const refresh of ctx.beforeCheckpoint) {
      refresh();
    }
    const stackJson = stateStack.toJSON();
    // Optional only for contexts built by hand in tests; a real context always
    // has a meter.
    const usage: RunUsage | undefined = ctx.invocationUsage?.snapshot();
    const moduleFingerprints = collectModuleFingerprints(stackJson);
    const args: CheckpointArgs = {
      stack: stackJson,
      globals: ctx.globals.toJSON(),
      nodeId,
      usage,
      traceId: ctx.runId ?? undefined,
      ...opts,
    };
    if (Object.keys(moduleFingerprints).length > 0) {
      args.moduleFingerprints = moduleFingerprints;
    }
    const checkpoint = new Checkpoint(args);
    // Keep this the last statement: the signature must cover every field,
    // moduleFingerprints included.
    signCheckpoint(checkpoint, ctx.host.settings);
    return checkpoint;
  }

  static fromContext(
    ctx: RuntimeContext<any>,
    opts: SourceLocationOpts & { label?: string | null; pinned?: boolean },
  ): Checkpoint {
    return Checkpoint.fromStateStack(ctx.stateStack, ctx, opts);
  }

  static fromJSON(json: any): Checkpoint | null {
    if (json instanceof Checkpoint) {
      return json;
    }
    const parsed = checkpointSchema.safeParse(json);
    if (!parsed.success) {
      return null;
    }
    return new Checkpoint(parsed.data);
  }
}

export type CheckpointStoreJSON = {
  checkpoints: Record<number, Checkpoint>;
  counter: number;
};

export class CheckpointStore {
  private checkpoints: Record<number, Checkpoint> = {};
  private restoreCounts: Record<number, number> = {};
  private locationRestoreCounts: Record<string, number> = {};
  private maxRestores: number;
  private maxSize: number;

  constructor(maxRestores = 100, maxSize = -1) {
    this.maxRestores = maxRestores;
    this.maxSize = maxSize;
  }

  create(
    stateStack: StateStack,
    ctx: RuntimeContext<any>,
    opts: SourceLocationOpts & {
      label?: string | null;
      pinned?: boolean;
      removeDuplicate?: boolean;
    },
  ): number {
    if (opts.removeDuplicate) {
      this.removeDuplicate(opts);
    }

    const checkpoint = Checkpoint.fromStateStack(stateStack, ctx, opts);
    this.checkpoints[checkpoint.id] = checkpoint;
    return checkpoint.id;
  }

  add(checkpoint: Checkpoint): void {
    this.checkpoints[checkpoint.id] = checkpoint;
    if (checkpoint.id >= globalCheckpointCounter) {
      globalCheckpointCounter = checkpoint.id + 1;
    }
  }

  cloneCheckpoint(
    _checkpoint: Checkpoint,
    opts: Partial<CheckpointArgs>,
    settings: HostSettings,
  ): number {
    const checkpoint = Checkpoint.fromJSON(_checkpoint);
    if (!checkpoint) {
      throw new CheckpointError("Invalid checkpoint provided for cloning.");
    }
    const id = globalCheckpointCounter++;
    const newCheckpoint = checkpoint.clone({ ...opts, id }, settings);
    this.checkpoints[id] = newCheckpoint;
    return id;
  }

  findCheckpoint(location: SourceLocationOpts): Checkpoint | null {
    const sorted = this.getSorted(); // sorted by id ascending
    const currentIdx = sorted.findIndex((cp) => sameLocation(cp, location));
    if (currentIdx <= 0) return null;
    return sorted[currentIdx - 1];
  }

  /** The newest unpinned checkpoint older than `beforeId` whose step ran
   *  on the stack the program is stopped on, or on a stack above it, and
   *  not at `location`, the step it is stopped at. `step back` rewinds to
   *  it. A sibling branch's steps are passed over: stopped inside one tool
   *  of a round, `step back` must not land in the other tool. The stopped
   *  location is passed on its own because the checkpoint on a stop
   *  inside a tool call is the shared one stamped at the join, whose own
   *  location is the loop's. */
  findBefore(beforeId: number, location: SourceLocationOpts): Checkpoint | null {
    const sorted = this.getSorted(); // sorted by id ascending
    sorted.reverse();
    for (const cp of sorted) {
      if (cp.id >= beforeId || cp.pinned) continue;
      if (onStackOrAbove(cp, location) && !sameLocation(cp, location)) {
        return cp;
      }
    }
    return null;
  }

  createRolling(ctx: RuntimeContext<any>, opts: SourceLocationOpts): number {
    // Remove existing unpinned checkpoint at the same location to avoid duplicates
    const id = this.create(ctx.stateStack, ctx, {
      ...opts,
      label: null,
      pinned: false,
      removeDuplicate: true,
    });
    this.removeDebugFlagsFor(id);
    this.evictIfNeeded();
    return id;
  }

  /** Strip the `__dbg_` flags from the frame the checkpoint was taken in,
   *  and from that frame only, so a replay stops there again. Ancestor
   *  frames keep theirs: a rewind into a tool call must pass through the
   *  `llm()` statement without stopping, and a sibling branch that was
   *  mid-step keeps its flag so it replays past its own stop. */
  removeDebugFlagsFor(id: number): void {
    const cp = this.checkpoints[id];
    if (!cp) return;
    const frame = cp.getCurrentFrame();
    if (!frame || !frame.locals) return;
    for (const key of Object.keys(frame.locals)) {
      if (key.startsWith("__dbg_")) {
        delete frame.locals[key];
      }
    }
  }

  private removeDuplicate(location: SourceLocationOpts): void {
    for (const [id, cp] of Object.entries(this.checkpoints)) {
      if (!cp.pinned && sameLocation(cp, location)) {
        delete this.checkpoints[Number(id)];
        return;
      }
    }
  }

  createPinned(
    stateStack: StateStack,
    ctx: RuntimeContext<any>,
    opts: SourceLocationOpts & {
      label: string | null;
    },
  ): number {
    return this.create(stateStack, ctx, { ...opts, pinned: true });
  }

  /** Mark a checkpoint pinned, re-signing it under `settings` when it was
   *  signed: `pinned` and `label` are signed fields. */
  pin(id: number, label: string | undefined, settings: HostSettings): void {
    const cp = this.checkpoints[id];
    if (!cp) return;
    cp.pinned = true;
    if (label !== undefined) cp.label = label;
    if (cp.signature !== undefined) {
      signCheckpoint(cp, settings);
    }
  }

  get(id: number): Checkpoint | undefined {
    const cp = this.checkpoints[id];
    return cp;
  }

  delete(id: number): void {
    delete this.checkpoints[id];
    delete this.restoreCounts[id];
  }

  getCheckpoints(): Checkpoint[] {
    return Object.values(this.checkpoints).filter(Boolean);
  }

  // Invalidate all checkpoints with id > the given id
  deleteAfterCheckpoint(id: number, deletePinned = false): void {
    for (const key of Object.keys(this.checkpoints)) {
      const numericKey = Number(key);
      if (numericKey > id) {
        if (!deletePinned && this.checkpoints[numericKey].pinned) {
          continue;
        }
        delete this.checkpoints[numericKey];
        delete this.restoreCounts[numericKey];
      }
    }
  }

  getLocationRestoreCount(location: string): number {
    return this.locationRestoreCounts[location] || 0;
  }

  trackLocationRestore(location: string): void {
    this.locationRestoreCounts[location] = (this.locationRestoreCounts[location] || 0) + 1;
  }

  trackRestore(id: number): void {
    this.restoreCounts[id] = (this.restoreCounts[id] || 0) + 1;
    if (this.restoreCounts[id] > this.maxRestores) {
      throw new CheckpointError(
        `Checkpoint ${id} has been restored ${this.maxRestores} times. Possible infinite loop.`,
      );
    }
  }

  getSorted(): Checkpoint[] {
    return Object.values(this.checkpoints).sort((a, b) => a.id - b.id);
  }

  prettyPrint(): string {
    const cps = this.getSorted()
      .map(
        (cp) =>
          `Checkpoint ${cp.id}: nodeId=${cp.nodeId}, moduleId=${cp.moduleId}, scopeName=${cp.scopeName}, stepPath=${cp.stepPath}, label=${cp.label}, pinned=${cp.pinned}`,
      )
      .join("\n");
    return cps || "No checkpoints";
  }

  toJSON(): CheckpointStoreJSON {
    return {
      checkpoints: deepClone(this.checkpoints),
      counter: globalCheckpointCounter,
    };
  }

  static fromJSON(json: CheckpointStoreJSON, maxRestores = 100): CheckpointStore {
    const store = new CheckpointStore(maxRestores);
    const rehydrated: Record<number, Checkpoint> = {};
    for (const [id, cpJson] of Object.entries(json.checkpoints)) {
      const checkpoint = Checkpoint.fromJSON(cpJson);
      if (checkpoint) {
        rehydrated[Number(id)] = checkpoint;
      } else {
        console.warn(
          `Failed to rehydrate checkpoint with id ${id}, skipping. Data: ${JSON.stringify(cpJson)}`,
        );
      }
    }
    store.checkpoints = rehydrated;
    globalCheckpointCounter = Math.max(globalCheckpointCounter, json.counter);
    return store;
  }

  private evictIfNeeded(): void {
    if (this.maxSize < 0) return; // no max size limit
    const unpinned = Object.values(this.checkpoints)
      .filter((cp) => !cp.pinned)
      .sort((a, b) => a.id - b.id);
    while (unpinned.length > this.maxSize) {
      const oldest = unpinned.shift()!;
      delete this.checkpoints[oldest.id];
    }
  }
}
