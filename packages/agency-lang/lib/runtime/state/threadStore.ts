import { StatelogClient } from "../../statelogClient.js";
import { MessageThread, MessageThreadJSON } from "./messageThread.js";

export type ThreadStoreJSON = {
  threads: Record<string, MessageThreadJSON>;
  counter: number;
  activeStack: string[];
  /** session-name → thread-id map. Populated by openSession on first
   *  entry; subsequent entries with the same name resume the recorded
   *  thread via resumeExisting. Round-tripped so sessions survive
   *  interrupt resume / cross-node hops. */
  sessions?: Record<string, string>;
};

export type MessageThreadID = string;

/**
 * Long-lived state that is shared between a parent `ThreadStore` and
 * every per-branch view forked from it. See `ThreadStore.forkBranchView`
 * for the rationale. Holding these fields in a single object lets the
 * branch view alias them by reference: writes to the registry (new
 * threads, new messages on existing threads, new sessions, counter
 * increments) are visible across all sibling branches and the parent.
 *
 * Per-branch state — currently just `activeStack` — lives on the
 * `ThreadStore` instance itself, not in the registry.
 */
type ThreadRegistry = {
  threads: Record<MessageThreadID, MessageThread>;
  counter: number;
  /** session-name → thread-id. See ThreadStoreJSON.sessions for docs.
   *  Backed by `Object.create(null)` so user-supplied session names
   *  like `"__proto__"` or `"constructor"` cannot mutate the
   *  Object prototype (prototype pollution). */
  sessions: Record<string, MessageThreadID>;
  statelogClient?: StatelogClient;
};

export class ThreadStore {
  /**
   * Shared long-lived registry (threads/sessions/counter). The
   * top-level per-run ThreadStore owns its registry; branch views
   * built via `forkBranchView()` alias the parent's registry so
   * `threads`, `sessions`, and `counter` reads/writes from any
   * branch are visible everywhere. Per-branch divergence lives in
   * `activeStack` (a plain instance field below).
   */
  private registry: ThreadRegistry;

  /** Per-branch active-thread stack. Each branch view has its own
   *  copy seeded by `forkBranchView` so a branch's `pushActive` /
   *  `popActive` / `llm()` calls write to a branch-local subthread
   *  instead of the parent's currently-active thread. */
  activeStack: MessageThreadID[] = [];

  constructor() {
    this.registry = {
      threads: {},
      counter: 0,
      sessions: Object.create(null),
    };
    this.activeStack = [];
  }

  // ── Registry-backed accessors ───────────────────────────────────
  // Preserved as public getters so existing call sites that do
  // `store.threads[id]`, `store.sessions["x"]`, and `store.counter`
  // keep working without touching the registry directly.

  get threads(): Record<MessageThreadID, MessageThread> {
    return this.registry.threads;
  }

  set threads(value: Record<MessageThreadID, MessageThread>) {
    this.registry.threads = value;
  }

  get sessions(): Record<string, MessageThreadID> {
    return this.registry.sessions;
  }

  set sessions(value: Record<string, MessageThreadID>) {
    this.registry.sessions = value;
  }

  get counter(): number {
    return this.registry.counter;
  }

  set counter(value: number) {
    this.registry.counter = value;
  }

  private get statelogClient(): StatelogClient | undefined {
    return this.registry.statelogClient;
  }

  // Set after construction. Most callers should pass the client to
  // `withDefaultActive(client)` instead so the initial default thread
  // is logged consistently with subsequent thread/subthread blocks.
  setStatelogClient(client: StatelogClient): void {
    this.registry.statelogClient = client;
  }

  /**
   * Build a per-branch view of this store. Used by `runInBranchAlsFrame`
   * so each fork / parallel / race branch gets its own active-thread
   * pointer without losing access to the shared registry — explicit
   * cross-branch coordination via `thread(session: ...)` or
   * `thread(continue: id)` keeps working because both still consult
   * the same `threads` / `sessions` maps.
   *
   * The returned view:
   *   - Aliases this store's `ThreadRegistry` by reference. New
   *     threads created in the branch (`create`, `createSubthread`,
   *     session opens) land in the shared registry. The counter is
   *     also shared so branch-created ids never collide.
   *   - Has a fresh `activeStack` seeded with a new subthread of this
   *     store's currently-active thread (if any). Unguarded `llm()` /
   *     `userMessage()` calls inside the branch write to that
   *     subthread rather than the parent's active thread.
   *
   * If this store has no active thread (rare — typically only true
   * for fresh `new ThreadStore()` outside a run), the view starts
   * with an empty `activeStack` and any unguarded thread access in
   * the branch will throw the usual "no active thread" error.
   */
  forkBranchView(): ThreadStore {
    const view = new ThreadStore();
    // Alias the shared registry. Casting through `unknown` avoids
    // declaring `registry` as readonly-public; the field stays
    // private to the class while letting us share by reference.
    (view as unknown as { registry: ThreadRegistry }).registry =
      this.registry;

    const parentActiveId = this.activeId();
    if (parentActiveId !== undefined) {
      // Create the branch-local subthread on the shared registry,
      // then seed the view's activeStack with its id. Uses the same
      // helper as `createSubthread()` — the only difference is we
      // push the new id onto the *view's* activeStack rather than
      // `this.activeStack`.
      const id = this.createSubthreadOf(parentActiveId);
      view.activeStack.push(id);
    }

    return view;
  }

  /**
   * Build a per-branch view that restores a previously-captured
   * `activeStack` rather than seeding a fresh subthread. Called by
   * `runInBranchAlsFrame` on resume after an interrupt inside a fork
   * branch: the pre-interrupt active-thread pointer was snapshotted
   * onto `BranchState.activeStack` and serialized; on re-entry we
   * recreate a branch view aliasing the (now-deserialized) parent's
   * registry and reinstate the exact same activeStack so the resumed
   * branch's unguarded `llm()` / `userMessage()` calls land on the
   * same subthread they were writing to pre-interrupt.
   *
   * Does NOT create a new subthread — the subthread that was originally
   * created at first-fork-time still lives in the shared registry and
   * its id is in `activeStack`. Statelog is not re-emitted.
   */
  restoreBranchView(activeStack: MessageThreadID[]): ThreadStore {
    const view = new ThreadStore();
    (view as unknown as { registry: ThreadRegistry }).registry =
      this.registry;
    view.activeStack = [...activeStack];
    return view;
  }

  // Create a store with a default active thread. If `client` is passed,
  // the default thread is logged as a normal threadCreated event so the
  // implicit root thread appears in the trace alongside user-created ones.
  static withDefaultActive(client?: StatelogClient): ThreadStore {
    const store = new ThreadStore();
    if (client) store.setStatelogClient(client);
    store.getOrCreateActive();
    return store;
  }

  // Create a new empty thread, return its ID
  create(): MessageThreadID {
    const id = (this.counter++).toString();
    this.threads[id] = new MessageThread();
    this.statelogClient?.threadCreated({
      threadId: id,
      threadType: "thread",
    });
    return id;
  }

  createAndReturnThread(): MessageThread {
    const id = this.create();
    return this.get(id);
  }

  // Create a subthread that inherits from the current active thread
  createSubthread(): MessageThreadID {
    return this.createSubthreadOf(this.activeId()!);
  }

  /** Registry-only subthread creation: build a subthread that
   *  inherits from the thread at `parentRegistryId`, log it, and
   *  return its new registry id. Does NOT touch `activeStack` —
   *  callers decide where (if anywhere) to push the new id. Used by
   *  `createSubthread()` (which pushes onto `this.activeStack`) and
   *  `forkBranchView()` (which pushes onto the view's activeStack). */
  createSubthreadOf(parentRegistryId: MessageThreadID): MessageThreadID {
    const id = (this.registry.counter++).toString();
    const parentThread = this.registry.threads[parentRegistryId];
    this.registry.threads[id] = parentThread.newSubthreadChild(parentRegistryId);
    this.registry.statelogClient?.threadCreated({
      threadId: id,
      threadType: "subthread",
      parentThreadId: parentRegistryId,
    });
    return id;
  }

  // Create a subthread that inherits from the current active thread and return it
  createAndReturnSubthread(): MessageThread {
    const id = this.createSubthread();
    return this.get(id);
  }

  // Get a thread by ID
  get(id: MessageThreadID): MessageThread {
    return this.threads[id];
  }

  // Push a thread ID onto the active stack
  pushActive(id: MessageThreadID): void {
    this.activeStack.push(id);
  }

  // Pop the active stack (thread stays in store!)
  popActive(): MessageThreadID | undefined {
    return this.activeStack.pop();
  }

  // Get the currently active thread ID
  activeId(): MessageThreadID | undefined {
    return this.activeStack[this.activeStack.length - 1];
  }

  // Get the currently active MessageThread
  active(): MessageThread | undefined {
    const id = this.activeId();
    return id !== undefined ? this.threads[id] : undefined;
  }

  // Get the active thread, or create a new one, push it active, and return it.
  getOrCreateActive(): MessageThread {
    const existing = this.active();
    if (existing) return existing;
    const id = this.create();
    this.pushActive(id);
    return this.threads[id];
  }

  /** Re-activate a previously-closed thread. Pushes `id` onto the
   *  active stack (same path as pushActive) without creating a new
   *  MessageThread. Throws if `id` is unknown — a silent fallback to
   *  create-new would mask a real bug (typo, hallucinated id) at the
   *  call site.
   *
   *  v1: rejects subthreads. A subthread's identity is tied to its
   *  parent's context at the time it was created; resuming one
   *  outside that context could surface confusing message ordering.
   *  If a user wants to continue inside a subthread, they should
   *  resume the parent thread and open a fresh `subthread {}` block.
   */
  resumeExisting(id: MessageThreadID): void {
    const thread = this.threads[id];
    // Display id: only prepend `t` when `id` is a numeric counter
    // string. Callers that accidentally pass a slug (`"t1"`) or a
    // non-numeric id (test mocks, ids that already look slug-shaped)
    // would otherwise show up as `tt1` in the error message.
    const displayId = /^\d+$/.test(id) ? `t${id}` : id;
    if (!thread) {
      throw new Error(`Cannot resume unknown thread id: ${displayId}`);
    }
    if (thread.parentId !== null) {
      throw new Error(
        `Cannot resume subthread ${displayId}. Resume the parent thread and open ` +
          `a fresh subthread block instead.`,
      );
    }
    this.activeStack.push(id);
    this.statelogClient?.threadResumed?.({ threadId: id });
  }

  /** Open a named session. Returns `{id, existed}` — `existed` is
   *  `true` when this name already mapped to a thread. Always leaves
   *  the session's thread on top of `activeStack`. First entry
   *  creates a top-level thread (never a subthread); later entries
   *  resume via `resumeExisting` (which already rejects subthreads —
   *  sessions can only map to top-level threads). */
  openSession(name: string): { id: MessageThreadID; existed: boolean } {
    const existing = this.sessions[name];
    if (existing !== undefined) {
      this.resumeExisting(existing);
      return { id: existing, existed: true };
    }
    const id = this.create();
    this.sessions[name] = id;
    this.activeStack.push(id);
    return { id, existed: false };
  }

  // Serialize all threads for interrupt handling / state return
  toJSON(): ThreadStoreJSON {
    const threadsJson: Record<MessageThreadID, MessageThreadJSON> = {};
    for (const [id, thread] of Object.entries(this.threads)) {
      threadsJson[id] = thread.toJSON();
    }
    return {
      threads: threadsJson,
      counter: this.counter,
      activeStack: [...this.activeStack],
      sessions: { ...this.sessions },
    };
  }

  static fromJSON(json: ThreadStoreJSON | ThreadStore): ThreadStore {
    if (json instanceof ThreadStore) return json;
    const store = new ThreadStore();
    if (json.threads) {
      for (const [id, threadJson] of Object.entries(json.threads)) {
        store.threads[id] = MessageThread.fromJSON(threadJson);
      }
    }
    store.counter = json.counter || 0;
    store.activeStack = json.activeStack || [];
    // Rebuild sessions on a null-prototype object so deserialized
    // snapshots with reserved keys (e.g. `__proto__`) cannot
    // pollute the Object prototype.
    const sessions: Record<string, MessageThreadID> = Object.create(null);
    if (json.sessions) {
      for (const [k, v] of Object.entries(json.sessions)) {
        sessions[k] = v;
      }
    }
    store.sessions = sessions;
    return store;
  }
}
