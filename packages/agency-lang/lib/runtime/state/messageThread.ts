import * as smoltalk from "smoltalk";
import { nanoid } from "nanoid";
import {
  expiryOf,
  labelOf,
  mayExpire,
  withMetadata,
  type Expiry,
  type ExpiresAt,
  type MetadataPatch,
} from "./messageMetadata.js";

/** Queue entries are plain JSON-safe data (the QueuedMessage contract), so
 *  a JSON round trip clones them. Deliberately NOT runtime/utils'
 *  deepClone: importing it here creates the cycle messageThread → utils →
 *  runtime/index → threadStore → messageThread, which leaves ThreadStore
 *  undefined while bootstrapThreadStore's `extends` evaluates. */
const cloneQueue = (q: QueuedMessage[]): QueuedMessage[] => JSON.parse(JSON.stringify(q));

export type MessageThreadJSON = {
  id?: string;
  messages: smoltalk.MessageJSON[];
  /** Legacy input only: checkpoints written before labels and handoff tags
   *  moved into each message's metadata. `toJSON` never writes them. */
  messageLabels?: (string | null)[];
  messageScopes?: (string | null)[];
  parentId?: string | null;
  hidden?: boolean;
  label?: string | null;
  summary?: string | null;
  queuedMessages?: QueuedMessage[];
  repairs?: number;
};

/** A message waiting on a thread for delivery at the thread's next
 *  request-turn (see MessageThread.queueMessage). Plain data — content is
 *  a string or smoltalk user-content parts, both JSON-safe — so the queue
 *  serializes with the thread wherever the thread serializes. No "system"
 *  role: a mid-thread system turn is rejected or reinterpreted by some
 *  providers, and a caller who wants to steer can say role "user".
 *  Assistant content is string-only — smoltalk.assistantMessage takes a
 *  string, and the union makes the compiler reject an array at the
 *  queueMessage call site instead of a producer papering over it. */
export type QueuedMessage =
  | { role: "user"; content: string | smoltalk.UserContentInput; label: string | null }
  | { role: "assistant"; content: string; label: string | null };

/** A conversation: smoltalk messages plus thread-level state. What the
 *  runtime knows about one message (its debug label, and when it expires)
 *  lives in that message's `metadata`, read and written only through
 *  messageMetadata.ts, so every edit of the array is a plain array edit.
 *  See docs/dev/runtime/expiring-messages.md. */
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
  /** Repair generation: how many times `repairAbandonedTurn`
   *  (threadRepair.ts) has rewritten this thread. A repair answers tool
   *  calls a parked-then-abandoned turn left dangling, so any checkpoint
   *  snapshot taken BEFORE it is stale — restoring one would overwrite
   *  the repair and everything appended since. `isNewerThan` is that
   *  comparison; `markRepaired` is the ONLY writer outside the
   *  serialization paths (fromJSON / adoptFrom). Never assign directly.
   *  Round-tripped through `toJSON`/`fromJSON` so checkpoints record the
   *  generation they captured. */
  repairs: number = 0;
  /** The dispatches whose bodies are running on this thread right now,
   *  innermost last. A system message pushed while one is open expires with
   *  it. Transient: the prompt loop re-enters a scope when it re-runs a
   *  dispatch after a resume, so nothing here is serialized. */
  private handoffScopes: string[] = [];
  /** Messages queued by `queueMessage`, waiting for the thread's next
   *  request-turn. Drained by the turn-boundary machinery in the tool
   *  loop; never sent to the provider directly from here. Serialized
   *  only when non-empty. */
  queuedMessages: QueuedMessage[] = [];

  constructor(messages: smoltalk.Message[] = []) {
    this.messages = messages;
    this.id = nanoid();
  }

  /** Alias for `push` with no label. Kept for the existing public API. */
  addMessage(message: smoltalk.Message): void {
    this.push(message);
  }

  cloneMessages(): smoltalk.Message[] {
    return this.messages.map((m) => m.toJSON()).map((m) => smoltalk.messageFromJSON(m));
  }

  getMessages(): smoltalk.Message[] {
    return this.messages;
  }

  /** Wholesale rewrite: the restore path and memory compaction. */
  setMessages(messages: smoltalk.Message[]): void {
    this.messages = messages;
  }

  removeAt(index: number): void {
    this.messages.splice(index, 1);
  }

  /** Swap the message at `index` for `message`, keeping the old message's
   *  label: the callers replace an assistant message with an edited copy
   *  of it, and the copy is the same turn. */
  replaceAt(index: number, message: smoltalk.Message): void {
    if (index < 0 || index >= this.messages.length) {
      throw new Error(`replaceAt: index ${index} is outside a thread of ${this.messages.length}`);
    }
    const label = labelOf(this.messages[index]);
    this.messages[index] = label === null ? message : withMetadata(message, { label });
  }

  /** Remove every message at or after `fromIndex` that `matches`. Walks
   *  backwards so each removal leaves the indexes still to visit untouched. */
  removeMatching(fromIndex: number, matches: (message: smoltalk.Message) => boolean): void {
    for (let index = this.messages.length - 1; index >= fromIndex; index--) {
      if (matches(this.messages[index])) {
        this.removeAt(index);
      }
    }
  }

  /** Take on `other`'s messages while keeping this thread's identity. The
   *  resume path needs the alias preserved, so it cannot just swap in the
   *  restored object. */
  adoptFrom(other: MessageThread): void {
    this.messages = [...other.messages];
    // The pending queue rides along: prompt.ts restores a resumed call via
    // adoptFrom (its args.messages alias), and a queue that survived
    // toJSON but not adoptFrom would be dropped exactly on resume.
    this.queuedMessages = cloneQueue(other.queuedMessages);
    this.repairs = other.repairs;
  }

  /** Record that this thread was repaired. Monotonic on purpose — the
   *  stale-checkpoint check reads `repairs` as a generation number, so it
   *  must only ever go up. */
  markRepaired(): void {
    this.repairs += 1;
  }

  /** True when this thread has been repaired since `snapshot` was
   *  captured — which makes restoring `snapshot` a write over newer
   *  history. See restoreThreadForResume in threadRepair.ts. */
  isNewerThan(snapshot: MessageThread): boolean {
    return this.repairs > snapshot.repairs;
  }

  /** The only append. `label` and `expires` are written into the
   *  message's metadata when given; a null argument leaves whatever the
   *  message already carries. A system message pushed while a handoff body
   *  runs, with no expiry of its own, expires with that handoff. */
  push(
    message: smoltalk.Message,
    label: string | null = null,
    expires: Expiry | null = null,
  ): void {
    // Runtime check, not only a type: push is reachable from plain JS.
    if (expires !== null && !mayExpire(message)) {
      throw new Error(`push: a ${message.role} message cannot expire`);
    }
    const patch: MetadataPatch = {};
    if (label !== null) {
      patch.label = label;
    }
    const expiry = expires ?? this.handoffExpiry(message);
    if (expiry !== null) {
      patch.expires = expiry;
    }
    const unchanged = Object.keys(patch).length === 0;
    this.messages.push(unchanged ? message : withMetadata(message, patch));
  }

  /** The expiry a system message pushed while a handoff body runs gets,
   *  unless it already carries one. */
  private handoffExpiry(message: smoltalk.Message): Expiry | null {
    const scope = this.currentHandoffScope();
    if (message.role !== "system" || scope === null || expiryOf(message) !== null) {
      return null;
    }
    return { at: "handoff", key: scope };
  }

  /** The label of the message at `index`, or null when unlabeled. */
  labelAt(index: number): string | null {
    const message = this.messages[index];
    return message === undefined ? null : labelOf(message);
  }

  /** The expiry of the message at `index`, or null when it stays. */
  expiryAt(index: number): Expiry | null {
    const message = this.messages[index];
    return message === undefined ? null : expiryOf(message);
  }

  /** Remove every message that expires with this owner. The only removal
   *  path for expiring messages. */
  expire(at: ExpiresAt, key: string): void {
    this.messages = this.messages.filter((message) => {
      const expiry = expiryOf(message);
      return expiry === null || expiry.at !== at || expiry.key !== key;
    });
  }

  /** Give `key` to every message that expires with this kind of owner but
   *  names none yet: an `llmCall` message Agency code pushed before the call
   *  that will own it started. */
  claimUnkeyed(at: ExpiresAt, key: string): void {
    this.messages = this.messages.map((message) => {
      const expiry = expiryOf(message);
      return expiry !== null && expiry.at === at && expiry.key === null
        ? withMetadata(message, { expires: { at, key } })
        : message;
    });
  }

  /** Mark the start of a handoff body on this thread: every system message
   *  pushed until the matching `exitHandoffScope` belongs to `key`. Scopes
   *  nest, innermost winning, for a handoff dispatched inside a handoff. */
  enterHandoffScope(key: string): void {
    this.handoffScopes.push(key);
  }

  exitHandoffScope(): void {
    this.handoffScopes.pop();
  }

  /** How many handoff bodies are running on this thread right now. */
  handoffDepth(): number {
    return this.handoffScopes.length;
  }

  private currentHandoffScope(): string | null {
    return this.handoffScopes[this.handoffScopes.length - 1] ?? null;
  }

  /** Queue a message for delivery at this thread's next request-turn:
   *  the start of the thread's next `llm()` call, or after a tool round
   *  within a running call. The mid-turn-safe counterpart to an immediate
   *  `push` — callable at any moment without breaking the tool-call /
   *  tool-result adjacency the provider requires. If no `llm()` ever runs
   *  against this thread again, the message simply waits, serialized with
   *  the thread. */
  queueMessage(
    content: string | smoltalk.UserContentInput,
    opts: { role?: "user" | "assistant"; label?: string } = {},
  ): void {
    // Runtime validation, not just types: this is a public API callable
    // from plain JS helpers, where an invalid role or an assistant
    // message with array content would otherwise surface later as a
    // malformed provider message, far from the caller that made it.
    const role = opts.role ?? "user";
    const label = opts.label ?? null;
    if (role === "assistant") {
      if (typeof content !== "string") {
        throw new Error("queueMessage: assistant-role queued messages must have string content");
      }
      this.queuedMessages.push({ role, content, label });
      return;
    }
    if (role !== "user") {
      throw new Error(
        `queueMessage: role must be "user" or "assistant" (got ${JSON.stringify(role)})`,
      );
    }
    this.queuedMessages.push({ role, content, label });
  }

  /** Remove and return every queued message, oldest first. Called by the
   *  turn-boundary drain exactly once per delivery point. */
  takeQueuedMessages(): QueuedMessage[] {
    const taken = this.queuedMessages;
    this.queuedMessages = [];
    return taken;
  }

  hasQueuedMessages(): boolean {
    return this.queuedMessages.length > 0;
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
      id: this.id,
      messages: this.messages.map((m) => m.toJSON()),
      parentId: this.parentId,
      hidden: this.hidden,
      label: this.label,
      summary: this.summary,
    };
    // Only when non-empty, so a thread with no queue serializes as it
    // always has. Deep clone, not an array spread: a spread copies the
    // array but aliases the entry objects, so a consumer editing the
    // returned JSON could mutate the live queue.
    if (this.queuedMessages.length > 0) {
      json.queuedMessages = cloneQueue(this.queuedMessages);
    }
    if (this.repairs > 0) {
      json.repairs = this.repairs;
    }
    return json;
  }

  static fromJSON(
    json: MessageThreadJSON | MessageThread | smoltalk.MessageJSON[] | smoltalk.Message[],
  ): MessageThread {
    if (json instanceof MessageThread) return json;
    const thread = new MessageThread();
    if (!Array.isArray(json) && typeof json.id === "string" && json.id.length > 0) {
      thread.id = json.id;
    }

    let _messages: any[] = [];
    let _messageLabels: (string | null)[] | undefined = undefined;
    let _messageScopes: (string | null)[] | undefined = undefined;
    let _parentId: string | null = null;
    let _hidden = false;
    let _label: string | null = null;
    let _summary: string | null = null;
    let _repairs = 0;
    if (Array.isArray(json)) {
      _messages = json;
    } else if ("messages" in json) {
      _messages = json.messages;
      if ("messageLabels" in json && json.messageLabels !== undefined) {
        _messageLabels = json.messageLabels;
      }
      if ("messageScopes" in json && json.messageScopes !== undefined) {
        _messageScopes = json.messageScopes;
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
      if ("repairs" in json && typeof json.repairs === "number") {
        _repairs = json.repairs;
      }
    } else {
      throw new Error("Invalid input for MessageThread.fromJSON");
    }

    const messagesToJSON = _messages.map((m: smoltalk.MessageJSON | smoltalk.Message) =>
      "toJSON" in m ? m.toJSON() : m,
    );

    const smoltalkMessages = messagesToJSON.map((m: smoltalk.MessageJSON) =>
      smoltalk.messageFromJSON(m),
    );

    thread.setMessages(foldLegacyArrays(smoltalkMessages, _messageLabels, _messageScopes));
    thread.parentId = _parentId;
    thread.hidden = _hidden;
    thread.label = _label;
    thread.summary = _summary;
    thread.repairs = _repairs;
    // Accept only a real array: persisted JSON containing
    // `queuedMessages: null` (or any non-array) must not throw during
    // resume — it revives as an empty queue, same as the absent key.
    if (!Array.isArray(json) && "queuedMessages" in json && Array.isArray(json.queuedMessages)) {
      thread.queuedMessages = cloneQueue(json.queuedMessages);
    }

    return thread;
  }
}

/** Write an old checkpoint's index-aligned `messageLabels` and
 *  `messageScopes` into the messages' metadata. A scope string was the key
 *  of the handoff dispatch the system message belonged to. Arrays whose
 *  length disagrees with the messages are ignored: guessing an alignment
 *  would put labels on the wrong messages. */
function foldLegacyArrays(
  messages: smoltalk.Message[],
  labels: (string | null)[] | undefined,
  scopes: (string | null)[] | undefined,
): smoltalk.Message[] {
  const usable = (values: (string | null)[] | undefined) =>
    values !== undefined && values.length === messages.length ? values : null;
  const labelList = usable(labels);
  const scopeList = usable(scopes);
  return messages.map((message, index) => {
    const label = labelList?.[index] ?? null;
    const scope = scopeList?.[index] ?? null;
    const patch: MetadataPatch = {};
    if (label !== null) {
      patch.label = label;
    }
    if (scope !== null) {
      patch.expires = { at: "handoff", key: scope };
    }
    if (Object.keys(patch).length === 0) {
      return message;
    }
    return withMetadata(message, patch);
  });
}
