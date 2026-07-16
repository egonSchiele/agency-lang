# Message Debug Labels Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task (owner preference: inline execution, no subagents). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users attach a debug label to `llm()`, `userMessage()`, `assistantMessage()`, and `systemMessage()` calls, and surface those labels in statelog, so a log reader can tell a verifier's injected message from a real user message.

**Architecture:** Labels are observability-only. They live on `MessageThread` as a per-message parallel array, serialize with the thread, and surface in two statelog places: `promptStart` (the label of the `llm()` call) and `promptCompletion`'s redacted message array (the label of each message). Labels are NEVER sent to the LLM provider — the smoltalk request path is untouched.

**Tech stack:** runtime (`MessageThread`, `runPrompt`), stdlib (`std::thread`), typechecker builtin signature, statelog client.

## Global constraints

- Labels never reach the provider wire. All changes stay on the Agency side of smoltalk.
- The thread-level `label` field (`thread(label:) { ... }`, `messageThread.ts:34`) already exists and is a DIFFERENT thing. The new per-message storage is named `messageLabels` everywhere to avoid collision.
- Thread rewrites (summarization, `threadRepair`) go through `setMessages`, which resets labels. Documented behavior, not a bug.
- Run `make` after touching `stdlib/*.agency` (CLAUDE.md).
- Save all test output to files (CLAUDE.md).

## THE INVARIANT (load-bearing — read before Task 1)

`messageLabels` is aligned with `messages` **by index**: `messageLabels.length === messages.length` at all times, and `messageLabels[i]` is the label of `messages[i]`.

Smoltalk messages have no id (`MessageClass` exposes content/role/name/rawData only), so a label cannot be keyed to its message. An index-aligned parallel array is also the only shape that serializes (a `WeakMap` keyed by message identity would survive slicing but not `toJSON`). The cost is that the invariant is not enforced by the type — it is enforced by keeping the writers few, and by giving every caller an operation that carries the labels along, so no caller has a reason to reach past them:

- **`push(message, label?)`** — the ONLY append. Every other append delegates to it.
- **`removeAt(index)`** — the ONLY removal.
- **`adoptFrom(other)`** — take on another thread's messages AND labels, keeping this thread's identity.
- **The constructor and `setMessages(messages, labels?)`** — the ONLY replacements; both rebuild `messageLabels` to the new length.
- **No other code may touch `this.messages` directly.** A plan review found two sites that would have silently desynced (below); PR review found two more that reached for `setMessages` for jobs that were not rewrites. The fix is structural, not "remember to update both".

Desync is not a graceful degradation — it **mislabels**. If `messageLabels` is one short, every later `labelAt(i)` returns the *previous* message's label. Treat any new `this.messages` mutation as a bug.

Two real leaks this plan closes by construction:
- `addMessage(message)` (`messageThread.ts:48`) is a duplicate of `push` that appends without a label. It is public API (in the `.d.ts`, used by `lib/stdlib/threads.test.ts:46`). It must delegate to `push`, not push on its own.
- The constructor takes `messages` but a field initializer (`messageLabels = []`) would leave it empty against N messages. Reachable via `newSubthreadChild()` → `new MessageThread(this.cloneMessages())`, and async `llm()` runs in a subthread — so a later labeled push there would attribute the new label to message 0. The constructor must seed `messageLabels`.

---

### Task 1: Per-message label storage on MessageThread

**Files:**
- Modify: `lib/runtime/state/messageThread.ts`
- Test: `lib/runtime/state/messageThread.test.ts`

**Interfaces:**
- Produces: `push(message, label?: string | null)`, `labelAt(index): string | null`, `messageLabels` in `MessageThreadJSON`. `addMessage` delegates to `push`.

- [ ] **Step 1: Write the failing tests**

The last three pin the invariant at each site that can grow or replace the arrays. They are the tests that would have caught the two desync leaks.

```ts
describe("per-message labels", () => {
  it("stores a label alongside a pushed message and reads it back by index", () => {
    const t = new MessageThread();
    t.push(smoltalk.userMessage("hi"), "verifier");
    t.push(smoltalk.assistantMessage("ok"));
    expect(t.labelAt(0)).toBe("verifier");
    expect(t.labelAt(1)).toBe(null);
  });

  it("round-trips labels through toJSON/fromJSON", () => {
    const t = new MessageThread();
    t.push(smoltalk.userMessage("hi"), "verifier");
    const revived = MessageThread.fromJSON(t.toJSON());
    expect(revived.labelAt(0)).toBe("verifier");
  });

  it("revives legacy JSON without messageLabels as all-null labels", () => {
    const json = new MessageThread([smoltalk.userMessage("hi")]).toJSON();
    delete (json as any).messageLabels;
    const revived = MessageThread.fromJSON(json);
    expect(revived.labelAt(0)).toBe(null);
  });

  it("setMessages resets labels (summarize/repair drop them)", () => {
    const t = new MessageThread();
    t.push(smoltalk.userMessage("hi"), "verifier");
    t.setMessages([smoltalk.userMessage("summary")]);
    expect(t.labelAt(0)).toBe(null);
  });

  // --- the invariant: length always matches, at every writer ---

  it("a constructor-seeded thread stays aligned when pushed to", () => {
    // Without a constructor seed, messageLabels would be [] against 2
    // messages, and this push would put "late" at index 0.
    const t = new MessageThread([
      smoltalk.userMessage("a"),
      smoltalk.userMessage("b"),
    ]);
    t.push(smoltalk.userMessage("c"), "late");
    expect(t.labelAt(0)).toBe(null);
    expect(t.labelAt(1)).toBe(null);
    expect(t.labelAt(2)).toBe("late");
  });

  it("addMessage keeps the arrays aligned (it delegates to push)", () => {
    const t = new MessageThread();
    t.addMessage(smoltalk.userMessage("a"));
    t.push(smoltalk.userMessage("b"), "second");
    expect(t.labelAt(0)).toBe(null);
    expect(t.labelAt(1)).toBe("second");
  });

  it("a subthread child seeded from a parent starts aligned", () => {
    const parent = new MessageThread();
    parent.push(smoltalk.userMessage("a"), "seed");
    const child = parent.newSubthreadChild(null);
    child.push(smoltalk.userMessage("b"), "child");
    // The parent's labels do not travel (cloneMessages copies messages
    // only); what matters is the child does not mis-attribute.
    expect(child.labelAt(0)).toBe(null);
    expect(child.labelAt(1)).toBe("child");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm test:run lib/runtime/state/messageThread.test.ts > tmp/labels-t1.log 2>&1`
Expected: FAIL — `push` takes one argument, `labelAt` undefined.

- [ ] **Step 3: Implement**

In `MessageThread` (`lib/runtime/state/messageThread.ts`). Note what is NOT here: no `this.messages.push` outside `push`, and no field initializer for `messageLabels` (the constructor seeds it).

```ts
/** Per-message debug labels, aligned with `messages` BY INDEX
 *  (`messageLabels[i]` labels `messages[i]`; the lengths always match).
 *  Observability only: shown in statelog, never sent to the provider.
 *  Distinct from the thread-level `label` (set by `thread(label:)`).
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

/** The ONLY append. Everything that adds a message goes through here. */
push(message: smoltalk.Message, label: string | null = null): void {
  this.messages.push(message);
  this.messageLabels.push(label);
}

/** Alias for `push` with no label. Kept for the existing public API. */
addMessage(message: smoltalk.Message): void {
  this.push(message);
}

labelAt(index: number): string | null {
  return this.messageLabels[index] ?? null;
}

setMessages(messages: smoltalk.Message[]): void {
  this.messages = messages;
  this.messageLabels = messages.map(() => null);
}
```

In `toJSON()`: add `messageLabels: this.messageLabels`. Add `messageLabels?: (string | null)[]` to `MessageThreadJSON` (line ~5).

In `fromJSON()`: **ordering matters.** `fromJSON` loads messages via `thread.setMessages(smoltalkMessages)` (line ~140), and `setMessages` resets `messageLabels` to all-null. So read `json.messageLabels` into a local alongside the other fields, and assign it **after** the `setMessages` call, next to `thread.label = _label`:

```ts
// after: thread.setMessages(smoltalkMessages)
thread.messageLabels =
  _messageLabels ?? smoltalkMessages.map(() => null);
```

Legacy JSON (no `messageLabels`) therefore revives as all-null, and the length always matches the revived messages.

- [ ] **Step 4: Run to verify pass**

Run: `pnpm test:run lib/runtime/state/messageThread.test.ts > tmp/labels-t1b.log 2>&1`
Expected: PASS, including all pre-existing thread tests (push callers that pass one arg still work — label defaults to null).

- [ ] **Step 5: Commit**

Subject: `Add per-message debug labels to MessageThread`

### Task 2: label parameter on the stdlib message functions

**Files:**
- Modify: `lib/stdlib/thread.ts` (the `_systemMessage` / `_userMessage` / `_assistantMessage` helpers, lines 44–80)
- Modify: `stdlib/thread.agency` (the `systemMessage` / `userMessage` / `assistantMessage` defs, lines 64–142)
- Test: extend `lib/stdlib/thread.test.ts` if present, else cover via Task 5's agency-js test

**Interfaces:**
- Consumes: Task 1's `push(message, label)`.
- Produces: `userMessage(msg, label: string = "")` etc. in Agency; empty string means unlabeled.

- [ ] **Step 1: Extend the TS helpers**

Each `_*Message` gains a trailing `label: string = ""` parameter and forwards `label || null`:

```ts
export async function _userMessage(
  msg: smoltalk.UserContentInput,
  label: string = "",
): Promise<void> {
  const { threads } = getRuntimeContext();
  threads.getOrCreateActive().push(smoltalk.userMessage(msg), label || null);
}
```

Same shape for `_systemMessage` and `_assistantMessage`. Leave the deprecated `__internal_*` variants unchanged.

- [ ] **Step 2: Extend the Agency wrappers**

In `stdlib/thread.agency`, each wrapper gains the parameter and passes it through. Docstrings are user-facing (they become tool descriptions):

```
export def userMessage(msg: string | (string | Attachment)[], label: string = "") {
  """
  Add a user message to the current thread's message history. Use this
  to seed the conversation with prior user context that wasn't actually
  typed by the user this turn.

  @param msg - The user message content: a string, or an array mixing text strings and attachments.
  @param label - Optional debug label shown in statelog. Never sent to the model.
  """
  _userMessage(msg, label)
}
```

- [ ] **Step 3: Build and spot-check**

Run: `make > tmp/labels-t2.log 2>&1` then compile a scratch program in the repo (NOT /tmp) using `userMessage("x", label: "seed")` and confirm it typechecks and runs.

- [ ] **Step 4: Commit**

Subject: `Accept a debug label on userMessage/assistantMessage/systemMessage`

### Task 3: label on llm() calls

**Files:**
- Modify: `lib/typeChecker/builtins.ts` (llm named-arg list, lines ~85–115 — add near `metadata`)
- Modify: `lib/runtime/prompt.ts` (`runPrompt`, line 755; prompt-message push line ~1020; assistant push line ~679; `promptStart` call site)
- Modify: `lib/statelogClient.ts` (`promptStart`, line 457)

**Interfaces:**
- Consumes: Task 1's labeled `push`.
- Produces: `llm("...", label: "verifier")` labels the prompt user message and the assistant completion message, and stamps `label` on the `promptStart` event.

- [ ] **Step 1: Typechecker signature**

In the llm builtin's named-arg list add:

```ts
// Observability-only debug label: stamps this call's promptStart event
// and the messages the call appends. Never sent to the provider.
{ key: "label", value: optional(string) },
```

- [ ] **Step 2: Runtime extraction**

`llm()` named args arrive on `clientConfig` (the codegen passes the options object verbatim; `runPrompt`'s doc comment at line 755 describes how retry fields are already "extracted below and stripped"). Follow that exact pattern for `label`: pull it off `clientConfig` into a local `callLabel: string | null` and delete it from the config forwarded to smoltalk — the provider must never see it.

- [ ] **Step 3: Stamp the messages and the event**

One `llm(label:)` call labels MORE THAN ONE message — that is intended, not a leak. The label marks "these messages came from this call":

- `messages.push(smoltalk.userMessage(prompt), callLabel)` at the prompt push (line ~1020).
- `messages.push(smoltalk.assistantMessage(completion.output), callLabel)` at the completion push (line ~679).
- `promptStart({ ..., label: callLabel })`; add `label?: string | null` to the `promptStart` params in `lib/statelogClient.ts` and include it in the posted event.

`messages` here is a `MessageThread` (runPrompt line ~941), so these are `MessageThread.push` — Task 1's labeled append. The call's other pushes (the injected-facts system message ~1009, and every tool-loop push ~1187/1214/1279/1362+) keep passing one argument and correctly take `label = null`; they stay aligned for free because they all go through the same `push`. Do not hand-label them.

- [ ] **Step 4: Unit-verify the strip**

Add a test (pattern: existing runPrompt option tests near the retry tests) asserting the config forwarded to the LLM client has no `label` key. Run and save output.

- [ ] **Step 5: Commit**

Subject: `Accept a debug label on llm() and stamp it on promptStart`

### Task 4: labels in the promptCompletion message dump

**Files:**
- Modify: `lib/runtime/prompt.ts` (the success-path `promptCompletion` emission — the only place the request payload is logged, see comment at line ~630)

**Interfaces:**
- Consumes: Task 1's `labelAt`.
- Produces: each entry of `promptCompletion.messages` carries `label` when one was set.

- [ ] **Step 1: Merge labels at emission**

Where the redacted message array is built for `promptCompletion` (line ~658, `messages: redactMessagesForLog(messages)`), merge in the label by index, adding the key only when non-null (keeps unlabeled logs byte-compatible).

Call `labelAt` on **the same `MessageThread` that produced the dump** — the local is named `messages`, not `thread`. `redactMessagesForLog` returns `messages.toJSON().messages`, which maps `this.messages` in order, so index `i` lines up with `messageLabels[i]`:

```ts
const labeled = redactMessagesForLog(messages).map((m, i) => {
  const label = messages.labelAt(i);
  return label === null ? m : { ...m, label };
});
```

Only `promptCompletion` gets per-message labels. `promptStart` carries the scalar call label from Task 3; its message dump stays unlabeled (deliberate — one place to read per-message labels).

- [ ] **Step 2: Verify via statelog**

Deterministic-mock LLM tests cannot inspect messages; statelog is the inspection channel (established pattern). Reuse the statelog-capture helper from the existing statelog tests (`lib/runtime/statelogPromptEvents.test.ts` or nearest equivalent — grep `promptCompletion` in tests) to assert the label appears.

- [ ] **Step 3: Commit**

Subject: `Show message labels in promptCompletion statelog events`

### Task 5: end-to-end test and docs

**Files:**
- Create: `tests/agency-js/message-labels/` (program + test.json + JS assertion, copy the structure of an existing statelog-reading agency-js test)
- Modify: `docs/dev/statelog.md` (one paragraph: where labels appear), `docs/dev/threads.md` (the `messageLabels` field and the setMessages reset rule)

- [ ] **Step 1: The agency-js fixture**

Program: `systemMessage("sys")` (UNLABELED, first — so it sits at index 0 and any off-by-one is visible), then `userMessage("context", label: "seed")`, then a mocked `llm("go", label: "coder")`. JS side runs with `--log-file`, parses the statelog JSONL, and asserts:

- `promptStart` has `label: "coder"`.
- In the `promptCompletion` message array, assert label-to-message **pairing**, not mere presence: the entry whose content is `"sys"` has no label; the `"context"` entry has `"seed"`; the `"go"` user entry and the assistant completion entry both have `"coder"`. Presence-only assertions ("seed appears somewhere") would pass a shifted array.

- [ ] **Step 2: Run it**

Run: `pnpm run agency test js tests/agency-js/message-labels/<file> > tmp/labels-t5.log 2>&1`
Expected: PASS.

- [ ] **Step 3: Docs + `make doc`**

Stdlib reference regenerates from the docstrings written in Task 2. Update the two dev docs by hand.

- [ ] **Step 4: Full validation + commit**

`pnpm test:run > tmp/labels-final.log 2>&1`, `pnpm run lint:structure`, `make fixtures` (expect zero churn — no codegen changes). Commit: `Add message-labels e2e test and docs`.

## Explicitly out of scope

- Auto-labeling messages the RUNTIME injects (guard-approve feedback, tool-reply attachments). The resumable-guards plan picks this up; it needs only Task 1's `push(message, label)`.
- Filtering/slicing threads by label. Deferred to the thread-scoping brainstorm.

## Self-review notes

- Every `push` caller keeps working (label defaults to null) — the signature change is additive.
- `messageLabels` naming avoids the existing thread-level `label` field collision.
- The provider wire is provably untouched: labels live on `MessageThread`, and the only smoltalk-bound data is the unmodified `messages` array; Task 3 Step 4 pins the config strip.
- **The alignment invariant is enforced structurally, not by vigilance**: one append (`push`), two replacements (constructor, `setMessages`), nothing else touching `this.messages`. `addMessage` delegates rather than duplicating. Each writer has a test that would fail on a desync.
- Verified against the code before writing: `runPrompt`'s `messages` is a `MessageThread` (line ~941), so its system/tool-loop pushes route through the labeled `push` and stay aligned with no extra work.

### Review findings folded in (2026-07-16)

- `addMessage` was a second, un-audited append path (public API, used in `lib/stdlib/threads.test.ts:46`) → now delegates to `push`.
- A `messageLabels = []` field default would desync against a constructor-provided `messages`, mis-attributing a later label to message 0 — reachable via `newSubthreadChild` and async `llm()` subthreads → constructor now seeds the array.
- `fromJSON` calls `setMessages` internally (which resets labels), so the JSON restore must be sequenced after it → called out in Task 1 Step 3.
- Task 4 must call `labelAt` on the dumped `MessageThread` (`messages`), not a differently-named `thread`.
- Task 5's e2e now pins label-to-message pairing with an unlabeled system message at index 0.
- `llm()` labeling multiple messages (prompt + completion) is **intended**; documented in Task 3 Step 3 so it is not "fixed" later.

### PR review round 2 findings (2026-07-16)

Two more real bugs, both from callers reaching for `setMessages` for a job that was not a rewrite — the same class of problem as `addMessage`, and fixed the same way (give the caller the operation it actually wants):

- **The memory layer lost every label on the normal path.** `prompt.ts` removed its injected-facts system message with `setMessages([...slice, ...slice])`, resetting all labels as collateral — so with memory on, a labeled program lost its labels after the first `llm()` call. Now `removeAt(i)`.
- **Labels did not survive interrupt/resume.** `runPrompt` snapshotted `messages.toJSON().messages` (a bare array) into `self.messagesJSON`; resume revived it through `fromJSON`'s legacy branch, which has no labels to read. And the resume path then called `setMessages(restored.getMessages())`, discarding whatever had been restored. Now the snapshot persists the full `MessageThreadJSON` (back-compatible: `fromJSON` still accepts the bare array) and resume uses `adoptFrom`. Pinned by `tests/agency-js/message-labels-resume`, verified to fail without the fix (`labeledAfterResume: []`).

Also: `setMessages` gained the optional `labels` argument, which removed the `fromJSON` ordering trap entirely and gave length-normalization one home (a mismatched array is refused, not padded — unlabeled beats mislabeled); `toJSON` now copies the labels array rather than handing out the live one; `withMessageLabels` declares `& { label?: string }`; and the index join through smoltalk's redaction is now pinned by a test with a real attachment rather than assumed.
