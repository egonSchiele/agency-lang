import { StatelogClient } from "../../statelogClient.js";
import { MessageThread, MessageThreadJSON } from "./messageThread.js";

export type ThreadStoreJSON = {
  threads: Record<string, MessageThreadJSON>;
  counter: number;
  activeStack: string[];
};

export type MessageThreadID = string;

export class ThreadStore {
  threads: Record<MessageThreadID, MessageThread> = {};
  counter: number = 0;
  activeStack: MessageThreadID[] = [];
  private statelogClient?: StatelogClient;

  constructor() {
    this.threads = {};
    this.counter = 0;
    this.activeStack = [];
  }

  // Set after construction. The initial default thread created by
  // withDefaultActive() is intentionally not logged — it's an implicit
  // implementation detail, not a user-initiated thread/subthread block.
  setStatelogClient(client: StatelogClient): void {
    this.statelogClient = client;
  }

  static withDefaultActive(): ThreadStore {
    const store = new ThreadStore();
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
    this.threads[id] = this.threads[parentId!].newSubthreadChild();
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
    return store;
  }
}
