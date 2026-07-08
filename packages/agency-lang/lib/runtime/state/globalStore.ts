import { nativeTypeReplacer, nativeTypeReviver } from "../revivers/index.js";
import {
  canHoldDurableTag,
  attachTag,
  detachTag,
  readTag,
} from "./tagSymbol.js";

export type GlobalStoreJSON = {
  store: Record<string, Record<string, any>>;
  initializedModules: string[];
};

export class GlobalStore {
  private store: Record<string, Record<string, any>> = {};
  private initializedModules: Set<string> = new Set();

  // FALLBACK object-tag store for values that can't carry the durable
  // on-object marker (frozen/sealed or native-typed objects, functions — see
  // canHoldDurableTag). Keyed by reference; deliberately a WeakMap so it is
  // (a) excluded from toJSON serialization and (b) reset to empty on clone()
  // (fromJSON constructs a fresh GlobalStore). Object identity does not
  // survive the toJSON/fromJSON round-trip, so THESE tags are branch-local.
  // Plain extensible objects/arrays instead carry the record on the object
  // itself (tagSymbol.ts) and the TaggedReviver preserves it through every
  // state round-trip — those tags are durable.
  private objectTags: WeakMap<object, Record<string, unknown>> = new WeakMap();

  // Tracks whether any WEAKMAP (branch-local) object tag has been set, so
  // hasAnyTags() can answer without enumerating the (non-enumerable) WeakMap.
  // Not serialized and starts false on every fresh store, so it resets on
  // clone()/fromJSON — matching the WeakMap, whose entries also reset. The
  // durable (on-object) path has its own SERIALIZED flag under __internal
  // (DURABLE_FLAG_KEY), which rides toJSON/fromJSON/clone.
  private objectTagsPresent = false;

  private static readonly VALUE_TAGS_KEY = "__valueTags";
  private static readonly DURABLE_FLAG_KEY = "__hasDurableObjectTags";
  static readonly REDACT_TAG = "redact";

  private isRef(value: unknown): value is object {
    return (
      (typeof value === "object" && value !== null) ||
      typeof value === "function"
    );
  }

  // A value can carry tags if it is a reference (keyed by identity in the
  // WeakMap) or a JSON-serializable primitive (keyed by value in the Map).
  // bigint and symbol are excluded on purpose: a bigint Map key throws during
  // MapReviver/JSON serialization (breaking clone() and interrupt save), and a
  // symbol has no stable serializable identity. Tagging one is a silent no-op.
  private isTaggable(value: unknown): boolean {
    if (this.isRef(value)) return true;
    const kind = typeof value;
    return kind === "string" || kind === "number" || kind === "boolean";
  }

  // Primitive tags, keyed by value. Stored as a Map under the __internal
  // module so it rides the existing toJSON/fromJSON/clone machinery. The
  // MapReviver serializes entries as [key, value] pairs through JSON, which
  // preserves primitive key *types* (1, "1", and true stay distinct).
  private valueTagMap(): Map<unknown, Record<string, unknown>> {
    let map = this.get(GlobalStore.INTERNAL_MODULE, GlobalStore.VALUE_TAGS_KEY);
    if (!(map instanceof Map)) {
      map = new Map();
      this.set(GlobalStore.INTERNAL_MODULE, GlobalStore.VALUE_TAGS_KEY, map);
    }
    return map as Map<unknown, Record<string, unknown>>;
  }

  // Resolve the tag record for a value. `create` controls whether a missing
  // record (and its backing store slot) is allocated — reads pass false so a
  // pure lookup never mutates state. Unifies the primitive (value Map) and
  // object (WeakMap) paths so setTag/getTagsFor share one code path. Records
  // are null-prototype so a user-controlled tag key like "__proto__" is stored
  // as an own data property instead of mutating the prototype chain.
  private tagsRecordFor(
    value: unknown,
    create: boolean,
  ): Record<string, unknown> | undefined {
    if (this.isRef(value)) {
      // Follow an existing tag wherever it already lives (so an object frozen
      // AFTER tagging still resolves to its on-object record).
      const durable = readTag(value);
      if (durable !== undefined) {
        // The record may have been created by ANOTHER store (the object
        // arrived by reference, e.g. from a settled branch). On a write, set
        // THIS store's flag too — the redaction gate must be locally true,
        // not dependent on join-propagation ordering. Monotonic + idempotent.
        if (create) this.setDurableObjectTagFlag();
        return durable;
      }
      const weak = this.objectTags.get(value);
      if (weak !== undefined) return weak;
      if (!create) return undefined;
      // Creating: choose the path by current capability.
      const record = Object.create(null) as Record<string, unknown>;
      if (canHoldDurableTag(value)) {
        attachTag(value, record);
        this.setDurableObjectTagFlag();
      } else {
        this.objectTags.set(value, record);
        this.objectTagsPresent = true;
      }
      return record;
    }
    const map = create
      ? this.valueTagMap()
      : this.get(GlobalStore.INTERNAL_MODULE, GlobalStore.VALUE_TAGS_KEY);
    if (!(map instanceof Map)) return undefined;
    let record = map.get(value);
    if (!record && create) {
      record = Object.create(null) as Record<string, unknown>;
      map.set(value, record);
    }
    return record;
  }

  setTag(value: unknown, key: string, val: unknown): void {
    // Silently ignore untaggable values (bigint/symbol) — see isTaggable.
    if (!this.isTaggable(value)) return;
    const record = this.tagsRecordFor(value, true);
    // create=true always yields a record; the guard is for the type checker.
    if (record) record[key] = val;
  }

  getTagsFor(value: unknown): Record<string, unknown> | undefined {
    return this.tagsRecordFor(value, false);
  }

  /** Remove a single tag key from a value. No-op if the value has no tags. */
  removeTag(value: unknown, key: string): void {
    const record = this.getTagsFor(value);
    if (record) delete record[key];
  }

  /** Remove every tag from a value. */
  removeAllTags(value: unknown): void {
    if (this.isRef(value)) {
      const durable = readTag(value);
      if (durable !== undefined) {
        // Prefer detaching the property outright so the object stops
        // matching the TaggedReviver (no perpetual empty "Tagged" wrapper
        // in every subsequent serialization) and getTagsFor returns
        // undefined, consistent with the WeakMap/primitive paths. A
        // frozen/sealed-after-tag target's property is non-configurable —
        // deleting it would throw — so fall back to clearing the record's
        // keys in place; getTagsFor then returns {} (intentional, narrow
        // asymmetry; isRedacted checks `=== true` and is unaffected).
        if (!detachTag(value)) {
          for (const key of Object.keys(durable)) delete durable[key];
        }
        return;
      }
      this.objectTags.delete(value);
      return;
    }
    const map = this.get(GlobalStore.INTERNAL_MODULE, GlobalStore.VALUE_TAGS_KEY);
    if (map instanceof Map) map.delete(value);
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
   * Three signals: the in-memory WeakMap bit (branch-local tags; resets on
   * clone alongside the WeakMap), the serialized durable flag (on-object
   * tags; rides clone/interrupt round-trips), and the primitive Map's size.
   */
  hasAnyTags(): boolean {
    if (this.objectTagsPresent) return true;
    if (this.hasDurableObjectTagFlag()) return true;
    const m = this.get(GlobalStore.INTERNAL_MODULE, GlobalStore.VALUE_TAGS_KEY);
    return m instanceof Map && m.size > 0;
  }

  /** True when any durable (on-object) tag has been created on or adopted by
   * this store. Serialized under __internal, so it survives clone/fromJSON. */
  hasDurableObjectTagFlag(): boolean {
    return (
      this.get(GlobalStore.INTERNAL_MODULE, GlobalStore.DURABLE_FLAG_KEY) ===
      true
    );
  }

  /** Set the durable-object-tag presence flag. Monotonic (never reset —
   * over-approximating costs one redaction pass, under-approximating leaks);
   * OR'd into the parent store when a branch settles (see runBatch). */
  setDurableObjectTagFlag(): void {
    this.set(GlobalStore.INTERNAL_MODULE, GlobalStore.DURABLE_FLAG_KEY, true);
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
