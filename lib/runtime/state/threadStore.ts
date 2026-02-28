import { MessageThread } from "./state/messageThread.js";

export class ThreadStore {
  threads: Record<string, MessageThread> = {};
  counter: number = 0;
  activeStack: string[] = [];

  constructor() {
    this.threads = {};
    this.counter = 0;
    this.activeStack = [];
  }

  // Create a new empty thread, return its ID
  create(): string {
    const id = (this.counter++).toString();
    this.threads[id] = new MessageThread();
    return id;
  }

  // Create a subthread that inherits from the current active thread
  createSubthread(): string {
    const parentId = this.activeId();
    const id = (this.counter++).toString();
    this.threads[id] = this.threads[parentId!].newSubthreadChild();
    return id;
  }

  // Get a thread by ID
  get(id: string): MessageThread {
    return this.threads[id];
  }

  // Push a thread ID onto the active stack
  pushActive(id: string): void {
    this.activeStack.push(id);
  }

  // Pop the active stack (thread stays in store!)
  popActive(): string | undefined {
    return this.activeStack.pop();
  }

  // Get the currently active thread ID
  activeId(): string | undefined {
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
  toJSON(): any {
    const threadsJson: Record<string, any> = {};
    for (const [id, thread] of Object.entries(this.threads)) {
      threadsJson[id] = thread.toJSON();
    }
    return {
      threads: threadsJson,
      counter: this.counter,
      activeStack: [...this.activeStack],
    };
  }

  static fromJSON(json: any): ThreadStore {
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
