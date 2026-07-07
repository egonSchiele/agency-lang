import { nativeTypeReplacer, nativeTypeReviver } from "../revivers/index.js";

export type GlobalStoreJSON = {
  store: Record<string, Record<string, any>>;
  initializedModules: string[];
};

export class GlobalStore {
  private store: Record<string, Record<string, any>> = {};
  private initializedModules: Set<string> = new Set();

  // Object/array/function tags, keyed by reference. Deliberately a WeakMap so
  // it is (a) excluded from toJSON serialization and (b) reset to empty on
  // clone() (fromJSON constructs a fresh GlobalStore). Object identity does
  // not survive the toJSON/fromJSON round-trip, so object tags are
  // intentionally branch-local and do not cross fork/interrupt boundaries.
  private objectTags: WeakMap<object, Record<string, unknown>> = new WeakMap();

  // Tracks whether any object (reference) tag has been set, so hasAnyTags()
  // can answer without enumerating the (non-enumerable) WeakMap. Not
  // serialized and starts false on every fresh store, so it resets on
  // clone()/fromJSON — matching the WeakMap, whose entries also reset.
  private objectTagsPresent = false;

  private static readonly VALUE_TAGS_KEY = "__valueTags";
  static readonly REDACT_TAG = "redact";

  private isRef(value: unknown): value is object {
    return (
      (typeof value === "object" && value !== null) ||
      typeof value === "function"
    );
  }

  // Primitive tags, keyed by value. Stored as a Map under the __internal
  // module so it rides the existing toJSON/fromJSON/clone machinery. The
  // MapReviver serializes entries as [key, value] pairs through JSON, which
  // preserves primitive key *types* (1, "1", and true stay distinct).
  private valueTagMap(): Map<unknown, Record<string, unknown>> {
    let m = this.get(GlobalStore.INTERNAL_MODULE, GlobalStore.VALUE_TAGS_KEY);
    if (!(m instanceof Map)) {
      m = new Map();
      this.set(GlobalStore.INTERNAL_MODULE, GlobalStore.VALUE_TAGS_KEY, m);
    }
    return m as Map<unknown, Record<string, unknown>>;
  }

  // Resolve the tag record for a value. `create` controls whether a missing
  // record (and its backing store slot) is allocated — reads pass false so a
  // pure lookup never mutates state. Unifies the primitive (value Map) and
  // object (WeakMap) paths so setTag/getTagsFor share one code path.
  private tagsRecordFor(
    value: unknown,
    create: boolean,
  ): Record<string, unknown> | undefined {
    if (this.isRef(value)) {
      let t = this.objectTags.get(value);
      if (!t && create) {
        t = {};
        this.objectTags.set(value, t);
        this.objectTagsPresent = true;
      }
      return t;
    }
    const m = create
      ? this.valueTagMap()
      : this.get(GlobalStore.INTERNAL_MODULE, GlobalStore.VALUE_TAGS_KEY);
    if (!(m instanceof Map)) return undefined;
    let t = m.get(value);
    if (!t && create) {
      t = {};
      m.set(value, t);
    }
    return t;
  }

  setTag(value: unknown, key: string, val: unknown): void {
    const tags = this.tagsRecordFor(value, true);
    // create=true always yields a record; the guard is for the type checker.
    if (tags) tags[key] = val;
  }

  getTagsFor(value: unknown): Record<string, unknown> | undefined {
    return this.tagsRecordFor(value, false);
  }

  /**
   * Mark a value for statelog redaction. Sole *writer* of the redact tag, so
   * the tag's representation lives in exactly one place. Equivalent to the
   * user-facing tag(value, "redact", true).
   */
  markRedacted(value: unknown): void {
    this.setTag(value, GlobalStore.REDACT_TAG, true);
  }

  /**
   * True when a value is marked redact:true. Sole *reader* of the redact tag
   * (the statelog replacer calls this), so the walker never hard-codes the
   * tag shape.
   */
  isRedacted(value: unknown): boolean {
    return this.getTagsFor(value)?.[GlobalStore.REDACT_TAG] === true;
  }

  /**
   * Cheap "are there any tags at all?" check so statelog can skip installing
   * a redaction replacer entirely when nothing is tagged (the common case).
   * The WeakMap can't report size, so object-tag presence is tracked by a
   * boolean flag that resets on clone alongside the WeakMap.
   */
  hasAnyTags(): boolean {
    if (this.objectTagsPresent) return true;
    const m = this.get(GlobalStore.INTERNAL_MODULE, GlobalStore.VALUE_TAGS_KEY);
    return m instanceof Map && m.size > 0;
  }

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
      // Per-model usage breakdown, keyed by model name. Accumulated by
      // updateTokenStats on every LLM call (across all branches, which
      // pointer-share this object), so subagent spend lands here too.
      // Read by the REPL footer (distinct models used this turn) and
      // `/cost` (cumulative per-model breakdown). Null-prototype so a
      // provider-supplied model name (e.g. `__proto__`) can't pollute it.
      models: Object.create(null),
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
