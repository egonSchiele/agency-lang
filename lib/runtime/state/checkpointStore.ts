import { deepClone } from "../utils.js";
import { CheckpointError } from "../errors.js";
import type { StateStackJSON } from "./stateStack.js";
import type { GlobalStoreJSON } from "./globalStore.js";
import type { RuntimeContext } from "./context.js";

export type Checkpoint = {
  id: number;
  stack: StateStackJSON;
  globals: GlobalStoreJSON;
  nodeId: string; // which node was active when checkpoint was taken
};

export type CheckpointStoreJSON = {
  checkpoints: Record<number, Checkpoint>;
  counter: number;
};

export class CheckpointStore {
  private checkpoints: Record<number, Checkpoint> = {};
  private counter = 0;
  private restoreCounts: Record<number, number> = {};
  private maxRestores: number;

  constructor(maxRestores = 100) {
    this.maxRestores = maxRestores;
  }

  create(ctx: RuntimeContext<any>): number {
    const nodeId = ctx.stateStack.currentNodeId();
    if (!nodeId) {
      throw new CheckpointError(
        "Cannot create checkpoint: no current node id in state stack.",
      );
    }
    const id = this.counter++;
    this.checkpoints[id] = {
      id,
      stack: ctx.stateStack.toJSON(),
      globals: ctx.globals.toJSON(),
      nodeId,
    };
    return id;
  }

  get(id: number): Checkpoint {
    const cp = this.checkpoints[id];
    if (!cp) {
      throw new CheckpointError(`Checkpoint with id ${id} not found.`);
    }
    return cp;
  }

  delete(id: number): void {
    delete this.checkpoints[id];
    delete this.restoreCounts[id];
  }

  // Invalidate all checkpoints with id > the given id
  invalidateAfter(id: number): void {
    for (const key of Object.keys(this.checkpoints)) {
      const numericKey = Number(key);
      if (numericKey > id) {
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

  toJSON(): CheckpointStoreJSON {
    return {
      checkpoints: deepClone(this.checkpoints),
      counter: this.counter,
    };
  }

  static fromJSON(
    json: CheckpointStoreJSON,
    maxRestores = 100,
  ): CheckpointStore {
    const store = new CheckpointStore(maxRestores);
    store.checkpoints = json.checkpoints;
    store.counter = json.counter;
    return store;
  }
}
