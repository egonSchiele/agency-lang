import { nativeTypeReplacer, nativeTypeReviver } from "../revivers/index.js";

export type GlobalStoreJSON = {
  store: Record<string, Record<string, any>>;
  initializedModules: string[];
};

export class GlobalStore {
  private store: Record<string, Record<string, any>> = {};
  private initializedModules: Set<string> = new Set();

  get(moduleId: string, varName: string): any {
    return this.store[moduleId]?.[varName];
  }

  set(moduleId: string, varName: string, value: any): void {
    if (!this.store[moduleId]) this.store[moduleId] = {};
    this.store[moduleId][varName] = value;
  }

  isInitialized(moduleId: string): boolean {
    return this.initializedModules.has(moduleId);
  }

  markInitialized(moduleId: string): void {
    this.initializedModules.add(moduleId);
  }

  toJSON(): GlobalStoreJSON {
    return JSON.parse(JSON.stringify({
      store: this.store,
      initializedModules: [...this.initializedModules],
    }, nativeTypeReplacer), nativeTypeReviver);
  }

  getTokenStats(): any {
    return this.get(GlobalStore.INTERNAL_MODULE, "__tokenStats");
  }

  restoreTokenStats(stats: any): void {
    this.set(GlobalStore.INTERNAL_MODULE, "__tokenStats", stats);
  }

  static readonly INTERNAL_MODULE = "__internal";

  static withTokenStats(): GlobalStore {
    const gs = new GlobalStore();
    gs.set(GlobalStore.INTERNAL_MODULE, "__tokenStats", {
      // Model of the most recent LLM call; updated by updateTokenStats and
      // read by the REPL footer. Empty until the first call.
      lastModel: "",
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cachedInputTokens: 0,
        totalTokens: 0,
      },
      cost: {
        inputCost: 0,
        outputCost: 0,
        totalCost: 0,
        currency: "USD",
      },
    });
    return gs;
  }

  static tokenStatsFromJSON(json: GlobalStoreJSON): { totalTokens: number; totalCost: number } {
    const tokenStats = json.store?.[GlobalStore.INTERNAL_MODULE]?.["__tokenStats"];
    if (!tokenStats) return { totalTokens: 0, totalCost: 0 };
    return {
      totalTokens: tokenStats.usage?.totalTokens ?? 0,
      totalCost: tokenStats.cost?.totalCost ?? 0,
    };
  }

  static fromJSON(json: GlobalStoreJSON): GlobalStore {
    const gs = new GlobalStore();
    gs.store = json.store || {};
    gs.initializedModules = new Set(json.initializedModules || []);
    return gs;
  }

  /**
   * Deep-snapshot copy. Used by `runInBranchAlsFrame` so each fork /
   * parallel / race branch sees its own GlobalStore: at fork time the
   * branch starts with the parent's values, then reads/writes inside
   * the branch only touch the clone; the parent is untouched on
   * branch completion.
   *
   * `initializedModules` is preserved so the branch's module guards
   * (`!__globals()!.isInitialized(...)`) treat every module the
   * parent already initialized as still initialized — `__initialize
   * Globals` is a no-op in branches and inherited values stay intact.
   *
   * Implementation: round-trip through `toJSON` / `fromJSON`, which
   * already handles native types (Maps, Sets, Dates) via the shared
   * `nativeTypeReplacer` / `nativeTypeReviver`. If a perf hotspot
   * appears, `Stage 4` in the design doc covers a copy-on-write
   * variant — but for typical agent programs the clone is microseconds.
   */
  clone(): GlobalStore {
    return GlobalStore.fromJSON(this.toJSON());
  }
}
