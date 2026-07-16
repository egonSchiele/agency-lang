import * as smoltalk from "smoltalk";
import { nanoid } from "nanoid";

export type MessageThreadJSON = {
  messages: smoltalk.MessageJSON[];
  messageLabels?: (string | null)[];
  parentId?: string | null;
  hidden?: boolean;
  label?: string | null;
  summary?: string | null;
};

export class MessageThread {
  messages: smoltalk.Message[] = [];
  id: string;
  /** ID of the parent thread when this thread was created via
   *  `ThreadStore.createSubthread()`. `null` for top-level threads
   *  (the default `MessageThread` constructor leaves it null). Used by
   *  `agency.threads.list()` to surface the parent linkage in
   *  ThreadInfo, and by `ThreadStore.resumeExisting()` to reject
   *  resuming a subthread outside its parent's context. */
  parentId: string | null = null;
  /** When `true`, this thread is excluded from `agency.threads.list()`
   *  (and therefore the stdlib `listThreads()` user-facing surface).
   *  Set by `Runner.thread` at first-create time when the user opts
   *  in via `thread(hidden: true) { ... }`. Round-tripped through
   *  `toJSON`/`fromJSON` so the flag survives interrupt resume. */
  hidden: boolean = false;
  /** Optional user-supplied label from `thread(label: "...") { ... }`.
   *  Set by `Runner.thread` at first-create time. `null` for threads
   *  created without a label or via `subthread {}` without one.
   *  Surfaces on `agency.threads.list()` so the stdlib `listThreads()`
   *  can attach it to `ThreadInfo`. Round-tripped through
   *  `toJSON`/`fromJSON` so the value survives interrupt resume. */
  label: string | null = null;
  /** Cached summary produced by the stdlib `summaryFor()` helper on
   *  first `listThreads()` call after the thread closes. Written via
   *  the TS-side `_setThreadSummary` shim so the cache lives on the
   *  per-run `MessageThread` and gets GC'd with the run — no
   *  module-level state in TS. `null` until the summary is computed.
   *  Round-tripped through `toJSON`/`fromJSON`. */
  summary: string | null = null;
  /** Per-message debug labels, aligned with `messages` BY INDEX
   *  (`messageLabels[i]` labels `messages[i]`; the lengths always match).
   *  Observability only: shown in statelog, never sent to the provider.
   *  Distinct from the thread-level `label` above (set by `thread(label:)`).
   *
   *  The alignment is maintained by keeping the writers to a minimum:
   *  `push` is the only append, the constructor and `setMessages` are the
   *  only replacements, and nothing else touches `this.messages`. A desync
   *  does not degrade gracefully — it shifts every later label onto the
   *  wrong message — so keep it that way. A rewrite via `setMessages`
   *  (summarization, repair) drops labels; that is intended. */
  messageLabels: (string | null)[];

  constructor(messages: smoltalk.Message[] = []) {
    this.messages = messages;
    // Seed, don't default: `new MessageThread([...])` (e.g. via
    // newSubthreadChild) must start aligned, or a later push lands its
    // label on message 0.
    this.messageLabels = messages.map(() => null);
    this.id = nanoid();
  }

  /** Alias for `push` with no label. Kept for the existing public API. */
  addMessage(message: smoltalk.Message): void {
    this.push(message);
  }

  cloneMessages(): smoltalk.Message[] {
    return this.messages
      .map((m) => m.toJSON())
      .map((m) => smoltalk.messageFromJSON(m));
  }

  getMessages(): smoltalk.Message[] {
    return this.messages;
  }

  setMessages(messages: smoltalk.Message[]): void {
    this.messages = messages;
    this.messageLabels = messages.map(() => null);
  }

  /** The ONLY append. Everything that adds a message goes through here,
   *  so `messages` and `messageLabels` cannot drift apart. */
  push(message: smoltalk.Message, label: string | null = null): void {
    this.messages.push(message);
    this.messageLabels.push(label);
  }

  /** The label of the message at `index`, or null when unlabeled. */
  labelAt(index: number): string | null {
    return this.messageLabels[index] ?? null;
  }

  newChild(): MessageThread {
    const child = new MessageThread();
    return child;
  }

  /** Build a subthread child seeded with a clone of this thread's
   *  messages. Caller passes the parent's registry id so the child
   *  knows where it descended from — used by `ThreadStore` to
   *  link subthreads back into the registry and by
   *  `agency.threads.list()` to surface the parent relationship. */
  newSubthreadChild(parentRegistryId: string | null): MessageThread {
    const child = new MessageThread(this.cloneMessages());
    child.parentId = parentRegistryId;
    return child;
  }

  toJSON(): MessageThreadJSON {
    return {
      messages: this.messages.map((m) => m.toJSON()),
      messageLabels: this.messageLabels,
      parentId: this.parentId,
      hidden: this.hidden,
      label: this.label,
      summary: this.summary,
    };
  }

  static fromJSON(
    json:
      | MessageThreadJSON
      | MessageThread
      | smoltalk.MessageJSON[]
      | smoltalk.Message[],
  ): MessageThread {
    if (json instanceof MessageThread) return json;
    const thread = new MessageThread();

    let _messages: any[] = [];
    let _messageLabels: (string | null)[] | undefined = undefined;
    let _parentId: string | null = null;
    let _hidden = false;
    let _label: string | null = null;
    let _summary: string | null = null;
    if (Array.isArray(json)) {
      _messages = json;
    } else if ("messages" in json) {
      _messages = json.messages;
      if ("messageLabels" in json && json.messageLabels !== undefined) {
        _messageLabels = json.messageLabels;
      }
      if ("parentId" in json && json.parentId !== undefined) {
        _parentId = json.parentId;
      }
      if ("hidden" in json && json.hidden === true) {
        _hidden = true;
      }
      if ("label" in json && json.label !== undefined) {
        _label = json.label;
      }
      if ("summary" in json && json.summary !== undefined) {
        _summary = json.summary;
      }
    } else {
      throw new Error("Invalid input for MessageThread.fromJSON");
    }

    const messagesToJSON = _messages.map(
      (m: smoltalk.MessageJSON | smoltalk.Message) =>
        "toJSON" in m ? m.toJSON() : m,
    );

    const smoltalkMessages = messagesToJSON.map((m: smoltalk.MessageJSON) =>
      smoltalk.messageFromJSON(m),
    );

    thread.setMessages(smoltalkMessages);
    // AFTER setMessages: it resets messageLabels to all-null, so the
    // restore has to come second or it gets clobbered. Legacy JSON (no
    // messageLabels) keeps the all-null array setMessages just built.
    thread.messageLabels =
      _messageLabels ?? smoltalkMessages.map(() => null);
    thread.parentId = _parentId;
    thread.hidden = _hidden;
    thread.label = _label;
    thread.summary = _summary;

    return thread;
  }
}
