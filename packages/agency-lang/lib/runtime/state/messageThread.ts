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
   *  The alignment is maintained by keeping the writers to a minimum, and
   *  by giving every caller an operation that carries the labels along
   *  instead of a reason to reach past them:
   *
   *  - `push` — the only append.
   *  - `removeAt` — the only removal.
   *  - `adoptFrom` — take on another thread's messages and labels.
   *  - the constructor and `setMessages` — the only replacements.
   *
   *  Nothing else touches `this.messages`. A desync does not degrade
   *  gracefully — it shifts every later label onto the wrong message — so
   *  keep it that way. A rewrite via `setMessages` with no labels
   *  (summarization, repair) drops them; that is intended. */
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

  /** Wholesale rewrite: take on `messages`, and `labels` with them when
   *  the caller has them (the restore path). Without `labels` the new
   *  messages are unlabeled — a rewrite that cannot say what the labels
   *  are does not get to keep the old ones, which is why summarization
   *  and `threadRepair` drop them.
   *
   *  A `labels` array whose length disagrees with `messages` is refused
   *  outright rather than padded or sliced: the lengths disagreeing means
   *  the source is already wrong, and guessing an alignment would put
   *  real labels on the wrong messages. Unlabeled beats mislabeled. */
  setMessages(
    messages: smoltalk.Message[],
    labels?: (string | null)[],
  ): void {
    this.messages = messages;
    this.messageLabels =
      labels !== undefined && labels.length === messages.length
        ? [...labels]
        : messages.map(() => null);
  }

  /** Remove the message at `index`, taking its label with it. For the
   *  callers that edit one message out of the thread and would otherwise
   *  reach for `setMessages` and drop every label as collateral. */
  removeAt(index: number): void {
    this.messages.splice(index, 1);
    this.messageLabels.splice(index, 1);
  }

  /** Take on `other`'s messages AND labels while keeping this thread's
   *  identity. The resume path needs the alias preserved, so it cannot
   *  just swap in the restored object. */
  adoptFrom(other: MessageThread): void {
    this.messages = [...other.messages];
    this.messageLabels = [...other.messageLabels];
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
    const json: MessageThreadJSON = {
      messages: this.messages.map((m) => m.toJSON()),
      parentId: this.parentId,
      hidden: this.hidden,
      label: this.label,
      summary: this.summary,
    };
    // Only when something is actually labeled. An all-null array carries
    // no more information than the absent key (`fromJSON` revives both as
    // all-null), and emitting it would change the serialized shape of
    // every thread — checkpoints, statelog, fixtures — for every program
    // that never labels anything. Same rule as `withMessageLabels`.
    //
    // Copy, not the live array: `messages` above is rebuilt, so handing
    // out the real one would let a consumer mutating the JSON mutate the
    // thread — the one way to reach `messageLabels` without a writer.
    if (this.messageLabels.some((l) => l !== null)) {
      json.messageLabels = [...this.messageLabels];
    }
    return json;
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

    // Labels ride along with the messages: legacy JSON has none and
    // revives unlabeled, and a labels array that disagrees in length is
    // refused inside setMessages rather than guessed at.
    thread.setMessages(smoltalkMessages, _messageLabels);
    thread.parentId = _parentId;
    thread.hidden = _hidden;
    thread.label = _label;
    thread.summary = _summary;

    return thread;
  }
}
