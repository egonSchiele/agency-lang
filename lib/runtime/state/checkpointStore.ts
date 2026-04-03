import { CheckpointError } from "../errors.js";
import { deepClone } from "../utils.js";
import type { RuntimeContext } from "./context.js";
import type { GlobalStoreJSON } from "./globalStore.js";
import { checkpointSchema } from "./schemas.js";
import type { SourceLocation } from "./sourceLocation.js";
import type { StateStackJSON } from "./stateStack.js";

let globalCheckpointCounter = 0;

export type SourceLocationOpts = Omit<SourceLocation, "nodeId">;
/** Reset the global checkpoint ID counter. For use in tests only. */
export function resetGlobalCheckpointCounter(): void {
  globalCheckpointCounter = 0;
}

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

  static fromContext(
    ctx: RuntimeContext<any>,
    opts: SourceLocationOpts & { label?: string | null; pinned?: boolean },
  ): Checkpoint {
    const nodeId = ctx.stateStack.currentNodeId();
    if (!nodeId) {
      throw new CheckpointError(
        "Cannot create checkpoint: no current node id in state stack.",
      );
    }
    return new Checkpoint({
      stack: ctx.stateStack.toJSON(),
      globals: ctx.globals.toJSON(),
      nodeId,
      ...opts,
    });
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
  private maxRestores: number;
  private maxSize: number;

  constructor(maxRestores = 100, maxSize = -1) {
    this.maxRestores = maxRestores;
    this.maxSize = maxSize;
  }

  create(
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

    const checkpoint = Checkpoint.fromContext(ctx, opts);
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
    const id = this.create(ctx, {
      ...opts,
      label: null,
      pinned: false,
      removeDuplicate: true,
    });
    this.evictIfNeeded();
    return id;
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
    ctx: RuntimeContext<any>,
    opts: SourceLocationOpts & {
      label: string | null;
    },
  ): number {
    return this.create(ctx, { ...opts, pinned: true });
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
