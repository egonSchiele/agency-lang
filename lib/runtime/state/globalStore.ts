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
    }));
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

  static fromJSON(json: GlobalStoreJSON): GlobalStore {
    const gs = new GlobalStore();
    gs.store = json.store || {};
    gs.initializedModules = new Set(json.initializedModules || []);
    return gs;
  }
}
