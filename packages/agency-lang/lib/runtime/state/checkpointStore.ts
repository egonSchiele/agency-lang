import { MessageJSON } from "smoltalk";
import { CheckpointError } from "../errors.js";
import { deepClone } from "../utils.js";
import type { RuntimeContext } from "./context.js";
import type { GlobalStoreJSON } from "./globalStore.js";
import { checkpointSchema } from "./schemas.js";
import type { SourceLocation } from "./sourceLocation.js";
import type { StateStackJSON } from "./stateStack.js";
import type { StateStack } from "./stateStack.js";

/** Label used for pinned checkpoints created at function entry for Result error handling. */
export const RESULT_ENTRY_LABEL = "result-entry";

let globalCheckpointCounter = 0;

export type SourceLocationOpts = Omit<SourceLocation, "nodeId">;
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

export type CheckpointArgs = {
  id?: number;
  stack: StateStackJSON;
  globals: GlobalStoreJSON;
  nodeId: string;
  moduleId?: string;
  scopeName?: string;
  stepPath?: string;
  label?: string | null;
  pinned?: boolean;
};

export class Checkpoint implements SourceLocation {
  public id: number;
  public stack: StateStackJSON;
  public globals: GlobalStoreJSON;
  public nodeId: string;
  public moduleId: string;
  public scopeName: string;
  public stepPath: string;
  public label: string | null;
  public pinned: boolean;

  constructor(args: CheckpointArgs) {
    this.id = args.id ?? globalCheckpointCounter++;
    this.stack = args.stack;
    this.globals = args.globals;
    this.nodeId = args.nodeId;
    this.moduleId = args.moduleId ?? "";
    this.scopeName = args.scopeName ?? "";
    this.stepPath = args.stepPath ?? "";
    this.label = args.label ?? null;
    this.pinned = args.pinned ?? false;
  }

  getScopeKey(): string {
    return `${this.moduleId}:${this.scopeName}`;
  }

  get location(): SourceLocation {
    return {
      nodeId: this.nodeId,
      moduleId: this.moduleId,
      scopeName: this.scopeName,
      stepPath: this.stepPath,
    };
  }

  getCurrentFrame() {
    return this.stack.stack?.at(-1);
  }

  getThreadMessages(displayIndex?: number): ThreadMessages | null {
    const frame = this.getCurrentFrame();
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
      selectedId =
        activeStack.findLast((id) => threads[id] != null) ?? threadIds[0];
      selectedIndex = threadIds.indexOf(selectedId);
    }

    const selectedThread = threads[selectedId];
    if (!selectedThread) return null;

    const messages = selectedThread.messages.map((m: MessageJSON) => ({
      role: m.role ?? "unknown",
      content: this.getContentFromMessage(m),
    }));

    return { threadId: selectedId, threadIndex: selectedIndex, threadCount: threadIds.length, messages };
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


  getGlobalsForModule(): Record<string, any> | null {
    return this.globals.store?.[this.moduleId] ?? null;
  }

  getFilename(): string {
    return this.moduleId.split("/").pop() || this.moduleId;
  }

  pathEquals(other: Checkpoint): boolean {
    return (
      this.moduleId === other.moduleId &&
      this.scopeName === other.scopeName &&
      this.stepPath === other.stepPath
    );
  }

  equals(other: Checkpoint): boolean {
    return JSON.stringify(this.toJSON()) === JSON.stringify(other.toJSON());
  }

  toJSON() {
    return {
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
  }

  clone(opts: Partial<CheckpointArgs> = {}): Checkpoint {
    return Checkpoint.fromJSON({ ...this.toJSON(), ...opts })!;
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
    return new Checkpoint({
      stack: stateStack.toJSON(),
      globals: ctx.globals.toJSON(),
      nodeId,
      ...opts,
    });
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
    opts: Partial<CheckpointArgs> = {},
  ): number {
    const checkpoint = Checkpoint.fromJSON(_checkpoint);
    if (!checkpoint) {
      throw new CheckpointError("Invalid checkpoint provided for cloning.");
    }
    const id = globalCheckpointCounter++;
    const newCheckpoint = checkpoint.clone({ ...opts, id });
    this.checkpoints[id] = newCheckpoint;
    return id;
  }

  findCheckpoint(location: SourceLocationOpts): Checkpoint | null {
    const sorted = this.getSorted(); // sorted by id ascending
    const currentIdx = sorted.findIndex(
      (cp) =>
        cp.moduleId === location.moduleId &&
        cp.scopeName === location.scopeName &&
        cp.stepPath === location.stepPath,
    );
    if (currentIdx <= 0) return null;
    return sorted[currentIdx - 1];
  }

  findBefore(checkpoint: Checkpoint): Checkpoint | null {
    const sorted = this.getSorted(); // sorted by id ascending
    const checkpointId = checkpoint.id;
    sorted.reverse();
    for (const cp of sorted) {
      if (cp.id < checkpointId && !cp.pathEquals(checkpoint) && !cp.pinned) {
        return cp;
      }
    }
    return null;
  }

  createRolling(
    ctx: RuntimeContext<any>,
    opts: SourceLocationOpts,
  ): number {
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
      if (
        !cp.pinned &&
        cp.moduleId === location.moduleId &&
        cp.scopeName === location.scopeName &&
        cp.stepPath === location.stepPath
      ) {
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

  pin(id: number, label?: string): void {
    const cp = this.checkpoints[id];
    if (!cp) return;
    cp.pinned = true;
    if (label !== undefined) cp.label = label;
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

  static fromJSON(
    json: CheckpointStoreJSON,
    maxRestores = 100,
  ): CheckpointStore {
    const store = new CheckpointStore(maxRestores);
    const rehydrated: Record<number, Checkpoint> = {};
    for (const [id, cpJson] of Object.entries(json.checkpoints)) {
      const checkpoint = Checkpoint.fromJSON(cpJson);
      if (checkpoint) {
        rehydrated[Number(id)] = checkpoint;
      } else {
        console.warn(
          `Failed to rehydrate checkpoint with id ${id}, skipping. Data: ${JSON.stringify(
            cpJson,
          )}`,
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
