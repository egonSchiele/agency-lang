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

export class ThreadStore {
  threads: Record<MessageThreadID, MessageThread> = {};
  counter: number = 0;
  activeStack: MessageThreadID[] = [];
  /** session-name → thread-id. See ThreadStoreJSON.sessions for docs.
   *  Backed by `Object.create(null)` so user-supplied session names
   *  like `"__proto__"` or `"constructor"` cannot mutate the
   *  Object prototype (prototype pollution). */
  sessions: Record<string, MessageThreadID> = Object.create(null);
  private statelogClient?: StatelogClient;

  constructor() {
    this.threads = {};
    this.counter = 0;
    this.activeStack = [];
    this.sessions = Object.create(null);
  }

  // Set after construction. Most callers should pass the client to
  // `withDefaultActive(client)` instead so the initial default thread
  // is logged consistently with subsequent thread/subthread blocks.
  setStatelogClient(client: StatelogClient): void {
    this.statelogClient = client;
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
    const parentId = this.activeId();
    const id = (this.counter++).toString();
    const child = this.threads[parentId!].newSubthreadChild();
    child.parentId = parentId ?? null;
    this.threads[id] = child;
    this.statelogClient?.threadCreated({
      threadId: id,
      threadType: "subthread",
      parentThreadId: parentId,
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
