# Expiring Messages and Round Warning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Warn the model before it runs out of tool-call rounds, and give every message the runtime adds-then-removes one mechanism (`metadata.expires`) that lives on the message itself.

**Architecture:** smoltalk gets an opaque `metadata` field on every message class, round-tripped through JSON and never rendered to a provider. Agency writes `metadata.label` and `metadata.expires = { at, key }` there, deletes the two index-aligned side arrays on `MessageThread`, and replaces three ad-hoc removals (handoff persona, memory facts, and the new round warning) with one `thread.expire(at, key)` call at the point each owner ends. The warning is a user message pushed at the tool loop's round boundary by a new producer, from a new `warnAtRoundsLeft` option.

**Tech Stack:** TypeScript, zod, vitest, smoltalk (owner's library at `~/smoltalk/packages/smoltalk`), Agency stdlib (`.agency` files, built with `make`).

**Spec:** `docs/superpowers/specs/2026-10-30-expiring-messages-and-round-warning.md` (same worktree). Read it first; this plan argues from it. The review that shaped this version is beside the plan, `2026-10-30-expiring-messages-and-round-warning-review.md`.

## Global Constraints

- Repo rules from `CLAUDE.md`: no dynamic imports; objects not maps; arrays not sets; `type` not `interface`; never force-push or amend; commit messages go in a file, never inline (apostrophes break the shell).
- Code rules: `docs/dev/contributing/coding-standards.md`, `anti-patterns.md`. Run `pnpm run typecheck` (never bare `tsc`) after every edit, `pnpm run fmt:ts` on the files you touched (never from the main checkout), and `pnpm run lint:structure` before pushing.
- Changing any `.agency` file under `stdlib/` requires `make` before tests see it.
- Save every test run's output to a file under this session's scratchpad directory (the one named in the environment, not `/tmp`) and read the file; do not re-run to see what failed. Never run the full agency test suite locally. In this repo run vitest as `pnpm exec vitest run <files>`; in smoltalk the same, since its `pnpm run test` is watch mode.
- Every commit step lists the files it stages. Never `git add -A` or `git add .`; the worktree will carry an uncommitted `pnpm link` for most of Part B.
- Never edit a CHANGELOG, here or in smoltalk. The owner cuts smoltalk releases and writes both changelogs.
- Prose rules for docs, docstrings, and comments: `~/.claude/skills/simplify-speech/general-writing-tips.md`, then check against `verbal-tics.md`. Dev docs describe the mechanism and the rule; no history, no "was X, now Y".
- Exact names from the spec: option `warnAtRoundsLeft` with fields `remaining`, `text`, `finalWarning`, `finalWarningText`; defaults `remaining: 3`, `finalWarning: true`; placeholders `{remaining}` and `{limit}`; metadata keys `label` and `expires`; `expires.at` is `"llmCall" | "request" | "handoff"`; the Agency argument is `expires: "never" | "llmCall"` defaulting to `"never"`; the dev doc is `docs/dev/runtime/expiring-messages.md`.
- Exact default texts (copy verbatim):
  - `text`: `Of the {limit} tool rounds for this request, {remaining} remain. Finish what you can with them and then write your answer.`
  - `finalWarningText`: `This is the last tool round for this request. The results of the tool calls you make now are the last you will see. After them, write your answer from what you have.`
  - new `tooManyRounds` refusal: `Error: This request's budget of {limit} tool rounds is used up, so this call was not run. Write your answer now from what you have.`
- The word for the mechanism is `expires` / "expiring messages". Do not introduce another term for it.
- `warnAtRoundsLeft` is not a preset field: do not add it to `LlmOptions` or `LLM_OPTION_KEYS` in `lib/agents/agency-agent/lib/llmOptions.agency`.
- Round arithmetic, from the spec: at the boundary after 0-based `round`, `remaining = limit - (round + 1)`. The request after round `limit - 1` offers no tools (`atRoundCap` becomes `toolCallRound + 1 >= limit`).

## Review Focus

Inputs the spec implies but no obvious test exercises. Each has its test added to the owning task below.

1. A `warnAtRoundsLeft.remaining` larger than the cap (threshold 10, cap 3): the first warning fires at the first boundary, after round 0, with `remaining` 2. (Task 7)
2. A `text` with an unknown placeholder such as `{foo}`: left in the text as written, not an error. (Task 7)
3. An old checkpoint with both `messageLabels` and `messageScopes`: every label and every handoff tag lands on the right message after `fromJSON`. (Task 4)
4. A tool message that arrives with `metadata.expires` already set (from a seeded `messages:` array or an edited checkpoint): `expire` leaves it in place. (Task 3 and Task 4)
5. A call that ends through `endTurn`, and one that throws on a cancel: the round warning is gone from the thread afterwards. A call that leaves paused on an interrupt still has it. (Task 6)

---

## Part A: smoltalk

### Task 1: `metadata` on every smoltalk message

**Files** (paths under `~/smoltalk/worktree-message-metadata/packages/smoltalk/`, see Step 0):
- Modify: `lib/classes/message/BaseMessage.ts` (the `MessageClass` interface, line 20)
- Modify: `lib/classes/message/UserMessage.ts`, `SystemMessage.ts`, `AssistantMessage.ts`, `ToolMessage.ts`, `DeveloperMessage.ts`
- Modify: `lib/classes/message/index.ts` (the five factory functions, lines 49-110)
- Modify: `lib/clients/resolveAttachments.ts:203`
- Test: `lib/classes/message/metadata.test.ts` (new, modeled on `rawData.test.ts` beside it)

**Interfaces:**
- Produces: every message class and factory accepts `options.metadata?: Record<string, unknown>`; every message has `get metadata(): Record<string, unknown> | undefined`; `toJSON()` includes `metadata` only when set; `fromJSON` reads it. `MessageJSON` types gain `metadata?: Record<string, unknown>`. No setter: Agency treats messages as values and writes metadata copy-on-write (Task 3).

- [ ] **Step 0: Work on a branch in a smoltalk worktree.** The smoltalk checkout is on `main` with the owner's uncommitted edits (`CHANGELOG.md`, `package.json`). Run `cd ~/smoltalk && git worktree add worktree-message-metadata -b adit/message-metadata && cd worktree-message-metadata && pnpm install && pnpm --filter smoltalk build`. Do every smoltalk step in that worktree.

- [ ] **Step 1: Write the failing tests** in `metadata.test.ts`

```ts
describe("metadata survives toJSON and fromJSON", () => {
  const metadata = { label: "verifier", expires: { at: "llmCall", key: "k1" } };
  it("on a user message", () => {
    const m = new UserMessage("hi", { metadata });
    expect(UserMessage.fromJSON(JSON.parse(JSON.stringify(m))).metadata).toEqual(metadata);
  });
  // the same for SystemMessage, AssistantMessage, DeveloperMessage, and
  // ToolMessage("ok", { tool_call_id: "c1", name: "t", metadata })
  it("is left out of the JSON when unset", () => {
    expect(JSON.stringify(new UserMessage("hi"))).not.toContain("metadata");
    expect(JSON.stringify(new SystemMessage("be brief"))).not.toContain("metadata");
  });
  it("never reaches a provider rendering", () => {
    const m = new UserMessage("hi", { metadata });
    expect(JSON.stringify(m.toOpenAIMessage())).not.toContain("verifier");
    expect(JSON.stringify(m.toGoogleMessage())).not.toContain("verifier");
    expect(JSON.stringify(m.toOllamaMessage())).not.toContain("verifier");
    expect(JSON.stringify(m.toOpenAIResponseInputItem())).not.toContain("verifier");
    // AnthropicRenderer: find how UserMessage.test.ts renders a message for
    // Anthropic and assert the same way.
  });
});
```

Add one test in the existing attachment-resolution test file (find it with `grep -rl resolveAttachments lib --include=*.test.ts`): a `UserMessage` with an image part and `metadata` comes out of the resolver with the same `metadata`.

- [ ] **Step 2: Run the tests to see them fail**

Run: `pnpm exec vitest run lib/classes/message/metadata.test.ts > <scratch>/smoltalk-metadata.txt 2>&1; tail -30 <scratch>/smoltalk-metadata.txt`
Expected: FAIL, `metadata` is `undefined` after `fromJSON`.

- [ ] **Step 3: Implement**

In each of the five classes: add `metadata: z.record(z.string(), z.unknown()).optional()` to the zod schema; a `public _metadata?: Record<string, unknown>` field set from `options.metadata` in the constructor; a `get metadata()` getter; write it in `toJSON()` as `metadata: this._metadata` (the existing `JSON.stringify` drops an `undefined` field, which is how `rawData` already stays out when unset); pass `result.data.metadata` through in `fromJSON`. Add `get metadata(): Record<string, unknown> | undefined;` to `MessageClass`. Add `metadata?: Record<string, unknown>` to each factory's `options` type in `index.ts`. In `resolveAttachments.ts:203` pass `metadata: msg.metadata` beside `rawData`.

- [ ] **Step 4: Run the tests and the whole smoltalk suite**

Run: `pnpm --filter smoltalk build && pnpm exec vitest run --exclude='**/*.live.test.ts' > <scratch>/smoltalk-all.txt 2>&1; tail -20 <scratch>/smoltalk-all.txt`
Expected: all pass. (smoltalk has no prettier; build before test, per `smoltalk-repo-gotchas`.)

- [ ] **Step 5: Commit and open the smoltalk PR**

`git add lib/classes/message/*.ts lib/clients/resolveAttachments.ts <the attachment test file>` and commit with a message from a file: "Every message carries an opaque metadata object". Open a PR against smoltalk `main`. The PR body carries the one changelog sentence for the owner: "Every message class accepts and round-trips an opaque `metadata` object. smoltalk never reads it and never sends it to a provider." Do not touch `CHANGELOG.md` or the version.

### Task 2: Pin the new smoltalk in agency-lang

**Files:**
- Modify: `package.json:157` (the `smoltalk` pin) and `pnpm-lock.yaml`

- [ ] **Step 1:** Until the owner publishes, develop against the local build: `pnpm link ~/smoltalk/worktree-message-metadata/packages/smoltalk` in this worktree only. This writes a `link:` entry into tracked files; every later commit in this plan names its files, so the link is never staged.
- [ ] **Step 2:** Once published (smoltalk is in `minimumReleaseAgeExclude` in `pnpm-workspace.yaml:22`, so a new release installs at once): `git checkout HEAD -- package.json pnpm-lock.yaml` to drop the link, set the pin to the released version, `pnpm install`, `pnpm run typecheck`.
- [ ] **Step 3:** `git add package.json pnpm-lock.yaml` and commit: "Pin smoltalk <version> for message metadata". This must land before Task 12 pushes; CI cannot pass against a link.

---

## Part B: agency-lang

### Task 3: The metadata module

**Files:**
- Create: `lib/runtime/state/messageMetadata.ts`
- Test: `lib/runtime/state/messageMetadata.test.ts`

**Interfaces:**
- Produces:

```ts
export type ExpiresAt = "llmCall" | "request" | "handoff";
export type Expiry = { at: ExpiresAt; key: string | null };
export type MessageMetadata = { label?: string; expires?: Expiry };
/** The debug label, or null. */
export function labelOf(message: smoltalk.Message): string | null;
/** The expiry, or null for a message that stays with the thread. Always
 *  null for a role that may not expire, whatever its JSON carries. */
export function expiryOf(message: smoltalk.Message): Expiry | null;
/** A copy of `message` with `patch` applied to its metadata. A key the
 *  patch leaves out is kept; a null value removes that key. Rebuilt through
 *  toJSON/messageFromJSON, so the result is an instance of the same class
 *  and the original is untouched (adoptFrom and getMessages share
 *  instances between holders). An empty result means no `metadata` key. */
export function withMetadata(
  message: smoltalk.Message,
  patch: { label?: string | null; expires?: Expiry | null },
): smoltalk.Message;
/** True when the role may carry an expiry: system or user. */
export function mayExpire(message: smoltalk.Message): boolean;
```

- [ ] **Step 1: Write the failing tests**: `labelOf` and `expiryOf` return null on a bare message; `withMetadata` sets a label and keeps content and role, and the original instance is unchanged; `withMetadata({ expires: null })` removes the key and keeps the label; a patch with only `expires` keeps an existing label (the omitted-key rule); `withMetadata` on a `ToolMessage` keeps `tool_call_id` and `name`; emptying the object leaves `metadata` undefined; `mayExpire` is true for system and user, false for assistant, tool, and developer; `expiryOf` is null for a tool message revived from JSON that carries `metadata.expires` (Review Focus 4).
- [ ] **Step 2: Run** `pnpm exec vitest run lib/runtime/state/messageMetadata.test.ts > <scratch>/meta.txt 2>&1`. Expected: FAIL, module not found.
- [ ] **Step 3: Implement** the five exports to the interfaces.
- [ ] **Step 4: Run** the test. Expected: PASS.
- [ ] **Step 5: Commit** `git add lib/runtime/state/messageMetadata.ts lib/runtime/state/messageMetadata.test.ts`: "Add messageMetadata: label and expiry readers and writers".

### Task 4: `MessageThread` keeps metadata on the message

**Files:**
- Modify: `lib/runtime/state/messageThread.ts`
- Modify: `lib/runtime/state/schemas.ts:10-11` (keep both fields optional; comment them as legacy input only)
- Modify: `lib/runtime/handoff.ts:118-130` (`stripHandoffSystemMessages`)
- Modify: `lib/runtime/prompt.ts:270-292` (compaction's `setMessages` call)
- Modify: `lib/runtime/promptEvents.ts:38` (`withMessageLabels`)
- Test: `lib/runtime/state/messageThread.test.ts` (replace the `messageLabels` alignment cases and the whole `MessageThread handoff scopes` block)
- Test: `lib/runtime/promptLabels.test.ts:132` and `lib/runtime/threadRepair.test.ts:163` (both read `thread.messageLabels`, which goes away)
- Test: `lib/runtime/state/checkpointStore.test.ts:913` (feeds `messageLabels` as input; must keep passing through the legacy fold)

**Interfaces:**
- Consumes: Task 3 (`withMetadata`, `labelOf`, `expiryOf`, `mayExpire`).
- Produces, on `MessageThread`:

```ts
push(message: smoltalk.Message, label: string | null = null, expires: Expiry | null = null): void;
expire(at: ExpiresAt, key: string): void;
claimUnkeyed(at: ExpiresAt, key: string): void;
labelAt(index: number): string | null;       // reads metadata
expiryAt(index: number): Expiry | null;       // reads metadata
replaceAt(index: number, message: smoltalk.Message): void;  // copies the old label onto `message`
setMessages(messages: smoltalk.Message[]): void;   // labels/scopes params removed
enterHandoffScope(key: string): void; exitHandoffScope(): void; handoffDepth(): number;  // unchanged
```
  Removed: `messageLabels`, `messageScopes`, `scopeAt`, `removeHandoffScoped`, and the `labels`/`scopes` parameters of `setMessages`. `MessageThreadJSON` keeps `messageLabels?` and `messageScopes?` as input-only legacy fields; `toJSON` no longer writes them.
- Produces, in `promptEvents.ts`: `withMessageLabels` returns each message's JSON without its `metadata` key and with the top-level `label` it writes today, so the logged shape is unchanged.

- [ ] **Step 1: Write the failing tests**

Replace the handoff-scope block with `describe("MessageThread expiring messages", ...)`:

```ts
it("push writes the label and expiry into the message's metadata", () => {
  const t = new MessageThread();
  t.push(smoltalk.userMessage("hi"), "first", { at: "llmCall", key: "c1" });
  expect(t.labelAt(0)).toBe("first");
  expect(t.expiryAt(0)).toEqual({ at: "llmCall", key: "c1" });
  expect(t.getMessages()[0].metadata).toEqual({ label: "first", expires: { at: "llmCall", key: "c1" } });
});
it("push keeps metadata the message already carries when given no value for it", () => {
  const labeled = smoltalk.systemMessage("persona", { metadata: { label: "persona" } });
  t.enterHandoffScope("explorer:c1");
  t.push(labeled);           // no label argument, handoff default expiry
  expect(t.labelAt(0)).toBe("persona");
  expect(t.expiryAt(0)).toEqual({ at: "handoff", key: "explorer:c1" });
});
it("a system message pushed inside a handoff scope expires with that handoff, user messages do not", ...);
it("nested scopes tag with the innermost key", ...);  // same shape as today's test
it("expire removes only messages matching both at and key, and never a tool message", () => {
  // push: user "hello" (label "first"); system "persona" expires handoff explorer:c1;
  // user "warn" expires llmCall k1; system "other" expires handoff oracle:c2;
  // a tool message revived from JSON with metadata.expires handoff explorer:c1  (Review Focus 4)
  t.expire("handoff", "explorer:c1");
  expect(contents).toEqual(["hello", "warn", "other", <tool content>]);
  expect(t.labelAt(0)).toBe("first");
});
it("claimUnkeyed keys only the unkeyed messages with that at", ...);
it("push refuses an expiry on a tool, assistant, or developer message", () => {
  expect(() => t.push(smoltalk.assistantMessage("x"), null, { at: "llmCall", key: "k" })).toThrow(/expire/);
});
it("replaceAt keeps the old message's label", () => {
  t.push(smoltalk.assistantMessage("draft"), "answer");
  t.replaceAt(0, smoltalk.assistantMessage("final"));
  expect(t.labelAt(0)).toBe("answer");
  expect(t.getMessages()[0].content).toBe("final");
});
it("toJSON writes neither messageLabels nor messageScopes", ...);
it("fromJSON folds legacy messageLabels and messageScopes into the messages", () => {   // Review Focus 3
  const json = { messages: [sysJSON("a"), userJSON("b"), sysJSON("c")], messageLabels: ["s0", null, "s2"], messageScopes: ["explorer:c1", null, null] };
  const t = MessageThread.fromJSON(json);
  expect([0,1,2].map(i => t.labelAt(i))).toEqual(["s0", null, "s2"]);
  expect(t.expiryAt(0)).toEqual({ at: "handoff", key: "explorer:c1" });
  expect(t.expiryAt(1)).toBeNull();
});
it("a label and an expiry ride through removeAt, removeMatching, setMessages, adoptFrom, and newSubthreadChild", ...);
```

Delete the existing cases that assert on `messageLabels`/`messageScopes` arrays or on `setMessages(…, labels, scopes)`; keep every case about `labelAt` surviving `removeAt`, `replaceAt`, `removeMatching`, and `adoptFrom`. In `promptLabels.test.ts:132` and `threadRepair.test.ts:163`, replace the `messageLabels.length` assertions with a check that `labelAt` returns the expected label for the last message. In `promptLabels.test.ts`'s `withMessageLabels` block add: a labeled, expiring message is dumped with top-level `label` and no `metadata` key, and the dump of an unlabeled thread equals `redactMessagesForLog` as today.

- [ ] **Step 2: Run** the three files. Expected: FAIL on `expiryAt`/`expire`/`claimUnkeyed` undefined.
- [ ] **Step 3: Implement** in `messageThread.ts`: delete `messageLabels`, `messageScopes`, and every line that maintains them. `push`: throw `push: a <role> message cannot expire` when given an expiry and `mayExpire` is false; compute the handoff default for a system message with no expiry while `handoffScopes` is non-empty; build the patch from only the arguments that are non-null and append `withMetadata(message, patch)`, or the message itself when the patch is empty. `expire`: `this.messages = this.messages.filter(m => !matches(expiryOf(m)))`. `claimUnkeyed`: map each unkeyed match through `withMetadata`. `replaceAt`: `this.messages[index] = withMetadata(message, { label: labelOf(old) })` when the old message had a label, else the message as given. `labelAt`/`expiryAt` read via `labelOf`/`expiryOf`. `toJSON` drops the two fields; `fromJSON` reads the legacy arrays and applies them with `withMetadata` after reviving, a scope string becoming `{ at: "handoff", key }`. `setMessages(messages)` assigns; `adoptFrom` copies messages, queue, and repairs. Rewrite the class comment to one paragraph: per-message data lives in `metadata` (see `messageMetadata.ts` and the dev doc from Task 11).
- [ ] **Step 4: Update the callers.** `stripHandoffSystemMessages` → `thread.expire("handoff", scopeKey)`. Compaction in `prompt.ts`: drop the labels and scopes arrays; keep every expiring message out of the summarized range: find the indices the plan summarizes (the complement of `systemPrefixIndices` and `tailIndices` over `original`), keep those with `expiryOf(original[i]) !== null`, and call `messages.setMessages([...head, summary, ...keptEarly, ...tail])`. `withMessageLabels` in `promptEvents.ts`: strip `metadata` from each dumped message and add the top-level `label` as today. `schemas.ts`: keep both fields, comment them as legacy input.
- [ ] **Step 5: Run** `pnpm run typecheck`, then `pnpm exec vitest run lib/runtime/state lib/runtime/promptLabels.test.ts lib/runtime/threadRepair.test.ts lib/runtime/handoff.test.ts lib/runtime/memory > <scratch>/thread.txt 2>&1`. Expected: PASS.
- [ ] **Step 6: Run the handoff agency-js suite**: `pnpm run agency test js tests/agency-js/handoff > <scratch>/handoff.txt 2>&1`. Expected: PASS with the fixture unchanged (its `test.js` records counts and roles, never whole messages; `persona`, `pauseWithPersona`, `nested`, `cancelledHandoff` all still strip).
- [ ] **Step 7: Commit** `git add lib/runtime/state/messageThread.ts lib/runtime/state/messageThread.test.ts lib/runtime/state/schemas.ts lib/runtime/handoff.ts lib/runtime/prompt.ts lib/runtime/promptEvents.ts lib/runtime/promptLabels.test.ts lib/runtime/threadRepair.test.ts`: "MessageThread: labels and expiries live on the message".

### Task 5: The call key, and memory facts that expire with their request

**Files:**
- Modify: `lib/runtime/prompt.ts:790` (after `reopenSpan`) and `:876-925` (the facts push and the `finally`)
- Test: `tests/agency/memory/llm-injection.agency` and its `.test.json`

**Interfaces:**
- Consumes: Task 4 `push(..., expires)` and `expire`.
- Produces: `self.llmCallKey: string`, minted once per `llm()` call and stored on the frame (`self.llmCallKey ??= nanoid()`, `nanoid` is already a dependency), so a resume reads the same key. Not the statelog span id: `reopenSpan` returns `undefined` when logging is off (`lib/statelogClient.ts:350`). The request key is `` `${self.llmCallKey}:${llmCallKey(which)}` ``.

- [ ] **Step 1: Extend the test.** In `llm-injection.agency`, after `llm("mom", { memory: true })`, read the thread with `getThread(currentThreadId())` from `std::thread` (`stdlib/thread.agency:634, 644`) and set `removed` when no message contains `"Relevant context from memory:"`. Return `{ injected: injected, removed: removed }`; update the `.test.json` expected output to `{"injected":true,"removed":true}`.
- [ ] **Step 2: Run** `pnpm run agency test tests/agency/memory/llm-injection.agency > <scratch>/mem.txt 2>&1`. Expected: PASS already (today's removal works). This pins the behavior before the mechanism changes.
- [ ] **Step 3: Implement.** Add `self.llmCallKey ??= nanoid();` right after line 790. `requestStepWithTripRetry` already computes `const key = llmCallKey(which)` (line 834); pass `which` into the request body or recompute the key there, and build `const requestKey = \`${self.llmCallKey}:${llmCallKey(which)}\``. Push with `messages.push(smoltalk.systemMessage(facts), null, { at: "request", key: requestKey })`. In the `finally`, replace the `findLastIndex`/`removeAt` block with `messages.expire("request", requestKey)`. Delete `injectedFactsContent` if nothing else reads it.
- [ ] **Step 4: Run** the agency test again and `pnpm exec vitest run lib/runtime/memory lib/runtime/prompt.toolRounds.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `git add lib/runtime/prompt.ts tests/agency/memory/llm-injection.agency tests/agency/memory/llm-injection.test.json`: "A call key on the runPrompt frame; memory facts expire with their request".

### Task 6: `llmCall` expiry: claim at call start, expire at call end, and the `expires` argument

**Files:**
- Modify: `lib/runtime/prompt.ts` (the `pushPrompt` step at ~868; the `finally` at ~2005)
- Modify: `lib/stdlib/thread.ts:67-91` (`_systemMessage`, `_userMessage`)
- Modify: `stdlib/thread.agency:89-111` (`systemMessage`, `userMessage`)
- Test: `lib/runtime/prompt.toolRounds.test.ts` (new cases; `RecordingClient` gains `readonly requests: smoltalk.Message[][]`)
- Test: `tests/agency/threads/expires-llm-call.agency` + `.test.json` (new)
- Modify: `docs/dev/contributing/message-thread-tests.md` (add the new case)

**Interfaces:**
- Consumes: Task 4; `self.llmCallKey` from Task 5.
- Produces: `runPrompt` claims unkeyed `llmCall` messages in `pushPrompt` and expires `llmCall` messages in its `finally` under `if (shouldPop)`. Agency: `systemMessage(msg, label = "", expires: "never" | "llmCall" = "never")` and `userMessage(msg, label = "", expires: "never" | "llmCall" = "never")`. TS: `_systemMessage(msg, label = "", expires: "never" | "llmCall" = "never")`, same for `_userMessage`.

- [ ] **Step 1: Write the failing unit tests** in `prompt.toolRounds.test.ts`. The existing helpers are `setup(mocks)` and `call(run, s, thread, opts)`, driven as `runInTestContext(s.ctx, s.ctx.stateStack, s.threads, (run) => call(...))` (line 143):

```ts
describe("llmCall expiry", () => {
  it("an unkeyed llmCall message is claimed by the next call and gone when it returns", async () => {
    const s = setup([{ return: "done" }]);
    const thread = new MessageThread();
    thread.push(smoltalk.userMessage("just for this call"), null, { at: "llmCall", key: null });
    await runInTestContext(s.ctx, s.ctx.stateStack, s.threads, (run) => call(run, s, thread, { baked: 3 }));
    expect(s.client.requests[0].map((m) => m.content)).toContain("just for this call");
    expect(thread.getMessages().map((m) => m.content)).not.toContain("just for this call");
  });
  it("is gone after a call that ends through endTurn", ...);       // Review Focus 5: a tool that calls _endTurn("llm") and returns; mock one toolCall then nothing
  it("is gone after a call that throws", ...);                      // Review Focus 5: a client whose text() rejects with an abort error; expect the call to reject and the thread to be clean
  it("stays on the thread while the call is paused on an interrupt", ...);  // a tool that raises an unhandled interrupt; the call returns interrupts; the message is still there
});
```

Look at `lib/runtime/handoff.test.ts` and `tests/agency-js/end-turn` for how `endTurn` is driven from a tool in tests, and at `prompt.toolRounds.test.ts`'s `RecordingClient` for where to add `requests`.

- [ ] **Step 2: Write the failing agency test** `tests/agency/threads/expires-llm-call.agency`:

```
import { userMessage } from "std::thread"

let firstSaw: boolean = false
let secondSaw: boolean = false
let calls: number = 0

callback("onLLMCallStart") as data {
  calls = calls + 1
  for (msg in data.messages) {
    if (msg.content == "Reply in French for this question only.") {
      if (calls == 1) {
        firstSaw = true
      }
      if (calls == 2) {
        secondSaw = true
      }
    }
  }
}

node main(): any {
  userMessage("Reply in French for this question only.", expires: "llmCall")
  const a: string = llm("What is the capital of Peru?")
  const b: string = llm("And of Chile?")
  return { firstSaw: firstSaw, secondSaw: secondSaw }
}
```

with a `.test.json` expecting `{"firstSaw":true,"secondSaw":false}` and two `{ "return": "..." }` mocks. Verify the syntax with `pnpm run ast tests/agency/threads/expires-llm-call.agency` before relying on it.

- [ ] **Step 3: Run both.** Expected: the unit tests fail (message still on the thread); the agency test fails to compile (`expires` is not a parameter yet).
- [ ] **Step 4: Implement in `prompt.ts`.** In the `pushPrompt` step body, before the prompt push: `messages.claimUnkeyed("llmCall", self.llmCallKey)`. In the `finally` at the bottom of `runPrompt`:

```ts
if (shouldPop) {
  messages.expire("llmCall", self.llmCallKey);
  stateStack.pop();
}
```

`shouldPop` is false only on the three paused exits (`prompt.ts:1769, 1809, 1992`), so a paused call keeps its messages; every other exit (the no-schema return, structured accept and failure, the `endTurn` return at line 1840, a cancel, a guard failure) expires. No step is needed: a popped frame is never replayed. A `pauseSignal` never lands inside a tool loop (`docs/dev/runtime/pause.md`), so it is not an exit here.

- [ ] **Step 5: Implement the stdlib argument.** `_systemMessage`/`_userMessage` take `expires` and pass `expires === "llmCall" ? { at: "llmCall", key: null } : null` to `push`. In `thread.agency`, add the parameter to both defs and one sentence to each docstring: `@param expires - "never" (the default) keeps the message on the thread; "llmCall" removes it when the next llm() call on this thread returns.` Run `make`.
- [ ] **Step 6: Run** `pnpm run typecheck`; the unit file; `pnpm run agency test tests/agency/threads/expires-llm-call.agency`; and `pnpm run agency test js tests/agency-js/handoff` (a handoff body's call must not expire the caller's messages; the keys keep them apart). Expected: PASS.
- [ ] **Step 7:** Add the new case to `docs/dev/contributing/message-thread-tests.md`. Commit `git add lib/runtime/prompt.ts lib/runtime/prompt.toolRounds.test.ts lib/stdlib/thread.ts stdlib/thread.agency tests/agency/threads/expires-llm-call.agency tests/agency/threads/expires-llm-call.test.json docs/dev/contributing/message-thread-tests.md`: "llmCall expiry and the expires argument on systemMessage and userMessage".

### Task 7: The `warnAtRoundsLeft` option and its pure helpers

**Files:**
- Create: `lib/runtime/roundWarning.ts`
- Test: `lib/runtime/roundWarning.test.ts`
- Modify: `lib/runtime/localDefaults.ts:40-52` (`mergedReplyLimits` becomes a call to a generic `mergeFields`)
- Modify: `lib/runtime/prompt.ts:678` (the per-call `replyLimits` merge uses `mergeFields`)
- Modify: `stdlib/llm.agency:98-115` (`LlmDefaults`) and the module doc above it
- Modify: `lib/stdlib/llm.ts:32-60` (`LlmDefaults`) and `_setLlmOptions` (line ~94)
- Modify: `lib/typeChecker/builtins.ts` (the `llm()` option table, beside `maxRepeatedToolCalls` at line 178)

**Interfaces:**
- Produces, in `localDefaults.ts`: `export function mergeFields<T extends object>(base: T | null | undefined, over: T | null | undefined): T | undefined` with the body `mergedReplyLimits` has today.
- Produces, in `roundWarning.ts`:

```ts
export type WarnAtRoundsLeft = {
  remaining?: number;
  text?: string;
  finalWarning?: boolean;
  finalWarningText?: string;
};
export type RoundWarningSettings = Required<WarnAtRoundsLeft>;
export const DEFAULT_ROUND_WARNING: RoundWarningSettings;   // the Global Constraints texts, remaining 3, finalWarning true
/** Field-by-field: the call's value over the branch default over DEFAULT_ROUND_WARNING, through mergeFields. */
export function roundWarningSettings(perCall: WarnAtRoundsLeft | undefined, branch: WarnAtRoundsLeft | undefined): RoundWarningSettings;
/** Replaces {remaining} and {limit}; any other brace text is left as is.
 *  Not renderMessage from lib/typeChecker/diagnostics.ts: that one throws
 *  on an unknown placeholder, and this text is the user's. */
export function fillRoundWarning(template: string, values: { remaining: number; limit: number }): string;
/** Which warning, if any, is due at the boundary after `round` (0-based)
 *  under `limit`, given which have already fired. */
export function roundWarningDue(
  settings: RoundWarningSettings,
  round: number,
  limit: number,
  fired: { first: boolean; final: boolean },
): { kind: "first" | "final"; text: string } | null;
```

- [ ] **Step 1: Write the failing tests** in `roundWarning.test.ts`: `roundWarningSettings(undefined, undefined)` equals the default; `{ text: "x" }` over `{ remaining: 5 }` gives remaining 5, text "x", the default final text; `fillRoundWarning` fills both placeholders, and leaves `{foo}` alone (Review Focus 2); `roundWarningDue` with the defaults and limit 50: null after round 40, `first` after round 46 (remaining 3), null after round 47 once `fired.first`, `final` after round 48 (remaining 1), null after round 49; limit 10: `first` after round 6, `final` after round 8; limit 2: `final` after round 0 (remaining is already 1); with `remaining: 1`, only `final` ever fires; with `remaining: 0`, no `first`; with `finalWarning: false`, no `final`; with `remaining: 10` and limit 3: `first` after round 0 with text containing "2 remain" (Review Focus 1).
- [ ] **Step 2: Run** the file. Expected: FAIL, module not found.
- [ ] **Step 3: Implement.** First, in `localDefaults.ts`, add `mergeFields` with the body `mergedReplyLimits` has today, make `mergedReplyLimits` a one-line call to it, and switch `prompt.ts:678` to `mergeFields`. Then write `roundWarning.ts` to the interfaces, with `roundWarningSettings` as `mergeFields(mergeFields(DEFAULT_ROUND_WARNING, branch), perCall)`. In `roundWarningDue`, `remaining = limit - (round + 1)`; `final` is due when `!fired.final && settings.finalWarning && remaining === 1`; `first` when `!fired.first && settings.remaining > 0 && remaining <= settings.remaining && remaining > 1`. Check `final` before `first`.
- [ ] **Step 4: Add the option type** in all three places. `stdlib/llm.agency`: a named, exported `type WarnAtRoundsLeft = { remaining?: number; text?: string; finalWarning?: boolean; finalWarningText?: string }` beside `OpenRouterOptions`, `warnAtRoundsLeft?: WarnAtRoundsLeft;` in `LlmDefaults`, and a paragraph in the module doc, in the style of the `replyLimits` paragraph, saying what each field does, the two placeholders, and the defaults. `lib/stdlib/llm.ts` `LlmDefaults`: `warnAtRoundsLeft?: WarnAtRoundsLeft;` imported from `roundWarning.ts`. `_setLlmOptions`: replace the `key === "replyLimits" ? … : value` ternary with `const MERGED_FIELD_BY_FIELD = ["replyLimits", "warnAtRoundsLeft"]` and one `mergeFields` call for any key in it. `builtins.ts`: an `objectType` entry for `warnAtRoundsLeft` with the four optional properties, one comment line pointing at `roundWarning.ts`; and, since Task 10 passes `maxToolCallRounds` on an `llm()` literal and the table has no such row (only `maxRepeatedToolCalls` at line 178; the researcher dodges the excess-property check by building its options through a helper, `researcher.agency:105`), add `{ key: "maxToolCallRounds", value: optional(number) }` beside it. Confirm the error first with a one-line `.agency` file through `pnpm run compile`. Run `make`.
- [ ] **Step 5: Run** `pnpm run typecheck`, the new test file, and `pnpm exec vitest run lib/stdlib/llm.test.ts lib/typeChecker lib/runtime/localDefaults.test.ts` (save output). Expected: PASS.
- [ ] **Step 6: Commit** `git add lib/runtime/roundWarning.ts lib/runtime/roundWarning.test.ts lib/runtime/localDefaults.ts lib/runtime/prompt.ts stdlib/llm.agency lib/stdlib/llm.ts lib/typeChecker/builtins.ts`: "warnAtRoundsLeft option and round-warning helpers".

### Task 8: The warning producer at the round boundary

**Files:**
- Modify: `lib/runtime/turnBoundary.ts` (the module header's "Three sources" list, `BoundaryContext`, `TurnMessage`, new `roundWarningProducer`, `runRoundBoundary`)
- Modify: `lib/runtime/prompt.ts` (read `warnAtRoundsLeft` off `clientConfig` at ~610 and `stackDefaults` at ~660; fill the new `BoundaryContext` fields in `boundaryCtx()` at ~807)
- Test: `lib/runtime/turnBoundary.test.ts`
- Test: `lib/runtime/prompt.toolRounds.test.ts`

**Interfaces:**
- Consumes: Task 7 helpers; `self.llmCallKey` from Task 5.
- Produces: `BoundaryContext` gains `roundWarning: { settings: RoundWarningSettings; limit: number; round: number; callKey: string } | null` (null at the initial boundary and on validation retries, where no warning is due). `TurnMessage` gains `expires?: Expiry | null`, which `drainProducer` passes to `push`. `runnerState.roundWarnings: { first: boolean; final: boolean }`. The producer pushes `smoltalk.userMessage(text)` with label `"roundWarning"` and expiry `{ at: "llmCall", key: callKey }`.

- [ ] **Step 1: Write the failing producer tests** in `turnBoundary.test.ts` using `makeBctx`: with settings default, limit 5, round 1 (remaining 3): `take` returns one user message whose content contains "5 tool rounds" and "3 remain", with label `roundWarning` and expiry `{ at: "llmCall", key: "k" }`, and sets `runnerState.roundWarnings.first`; a second `take` at the same round returns `[]`; round 3 (remaining 1) returns the final text and sets `final`; `roundWarning: null` returns `[]`. Extend the "canonical step sequences" test so the round boundary's step list includes `round.N.roundWarning` between `queuedMessages` and `guardGate`.
- [ ] **Step 2: Write the failing loop tests** in `prompt.toolRounds.test.ts` (`call()` gains `warnAtRoundsLeft?: WarnAtRoundsLeft` passed on `clientConfig`):

```ts
describe("the round warning", () => {
  it("warns at 3 left and on the last round, once each, and the thread holds neither afterwards", async () => {
    // cap 5 via baked, pingMocks(5): requests[2] (after round 1) contains the first text with "5 tool rounds" and "3 remain";
    // requests[4] (after round 3) contains the final text; no other request contains either;
    // thread after the call: no message contains "tool rounds for this request"
  });
  it("remaining: 0 sends only the final warning", ...);
  it("finalWarning: false sends only the first", ...);
  it("a cap of 2 sends only the final warning", ...);
  it("a custom text without placeholders is sent as given", ...);
  it("the call's warnAtRoundsLeft merges field by field over the branch default", ...);  // _setLlmOptions({ warnAtRoundsLeft: { remaining: 2 } }) then the call passes { text: "custom {remaining}" }
});
```

- [ ] **Step 3: Run both files.** Expected: FAIL.
- [ ] **Step 4: Implement.** In `prompt.ts`: destructure `warnAtRoundsLeft: ccWarnAtRoundsLeft` from `clientConfig` and `warnAtRoundsLeft: stackWarnAtRoundsLeft` from `stackDefaults` (keep it out of `stackSmolDefaults`, like `maxToolCallRounds`); `const roundWarning = roundWarningSettings(ccWarnAtRoundsLeft, stackWarnAtRoundsLeft)`; `self.runnerState.roundWarnings ??= { first: false, final: false }`; `boundaryCtx(round?: number)` fills `roundWarning` when a round is given, else null; `runRoundBoundary(round, boundaryCtx(round))`. In `turnBoundary.ts`: `roundWarningProducer.take` returns `[]` when `bctx.roundWarning` is null, else calls `roundWarningDue(settings, round, limit, runnerState.roundWarnings)`, marks the kind fired, and returns the message with its expiry. `drainProducer` passes `m.expires ?? null` to `push`. `runRoundBoundary` drains it after `queuedMessages` and before the gate. Update the module header to four producers and describe the fourth in one line.
- [ ] **Step 5: Run** `pnpm run typecheck` and both test files. Expected: PASS.
- [ ] **Step 6: Commit** `git add lib/runtime/turnBoundary.ts lib/runtime/turnBoundary.test.ts lib/runtime/prompt.ts lib/runtime/prompt.toolRounds.test.ts`: "Warn the model at the round boundary before the tool-round cap".

### Task 9: No tools after the last allowed round, and the refusal text

**Files:**
- Modify: `lib/runtime/prompt.ts:597` (`atRoundCap`)
- Modify: `lib/runtime/toolLoopGuards.ts:240` (`tooManyRounds` in `refusalMessage`) and its doc comment on `toolsOffered`
- Test: `lib/runtime/prompt.toolRounds.test.ts` (the `REFUSAL` regex at line 90, the four `toMatch(/\(N\) exceeded/)` assertions at lines 151, 183, 193, 204, and the `offered`/`hosted` expectations at lines 155-157)

- [ ] **Step 1:** Change `REFUSAL` to `/This request's budget of (\d+) tool rounds is used up/`, the four assertions to `toMatch(/budget of N tool rounds/)`, and the first case's `offered` to `[["ping"], ["ping"], ["ping"], [], []]` and `hosted` to `[search, search, search, [], []]` (the mock client still answers the fourth request with a `ping` call, which is refused, so there are still five requests). Run the file. Expected: FAIL on both.
- [ ] **Step 2:** `atRoundCap` becomes `() => self.toolCallRound + 1 >= roundLimit`. Replace the refusal string with the Global Constraints text, `{limit}` filled from `state.maxToolCallRounds`. Update the `toolsOffered` doc comment: the bare request is the one after the last allowed round, and the refusal is the fallback for a model that calls a tool it was not offered. Run `grep -rn "Maximum number of tool call rounds" lib tests docs` and update every hit outside `docs/dev` (that doc is Task 11). Run the file and `pnpm exec vitest run lib/runtime/toolLoopGuards.test.ts`. Expected: PASS.
- [ ] **Step 3: Commit** `git add lib/runtime/prompt.ts lib/runtime/toolLoopGuards.ts lib/runtime/prompt.toolRounds.test.ts`: "Offer no tools after the last allowed round; the refusal names the request".

### Task 10: End-to-end agency-js cases

**Files:**
- Modify: `tests/agency-js/handoff/agent.agency`, `test.js`, `llmMocks.json`, `fixture.json`
- Create: `tests/agency-js/round-warning/agent.agency`, `test.js`, `llmMocks.json`, `fixture.json`, `agency.json`, `useTestLLMProvider` (copy the last two from `tests/agency-js/handoff`)
- Modify: `docs/dev/contributing/message-thread-tests.md`

- [ ] **Step 1: `warningInsideHandoff`.** In the handoff `agent.agency`, add a handoff def whose body calls `llm("brief: ${question}", { tools: [lookup], maxToolCallRounds: 2 })` (the per-call row from Task 7 makes this typecheck), and a node that dispatches it. Mocks: the caller calls the handoff; the body calls `lookup` once (round 0, remaining 1 → the final warning), then returns text; the caller returns text. In `test.js`, record counts only, like the `persona` block: the body's second request contains "last tool round" once, and the caller's final request contains "tool round" zero times. Rebuild the fixture when prompted and read the diff before accepting it.
- [ ] **Step 2: `round-warning` resume case.** `agent.agency`: a `ping` tool, a `pauseMe` tool that raises an unhandled interrupt (copy from the handoff test), and `export node run()` that calls `llm("go", { tools: [ping, pauseMe], maxToolCallRounds: 5 })` and then a second `llm("summarize", {})` with no tools on the same thread. Mocks, in order: `ping` (round 0), `ping` (round 1), `pauseMe` (round 2, the run pauses), `ping` (round 3), text (round 4 never asks for tools), text (the second call). Boundaries: after round 1 remaining 3, the first warning fires before the pause; after round 2 remaining 2, which would fire the first warning a second time if `runnerState.roundWarnings` had not survived the checkpoint; after round 3 remaining 1, the final warning. `test.js`: run, `respondToInterrupts(paused.data, [approve()], …)`, then record: the number of requests containing "tool rounds for this request" is exactly 1, the number containing "last tool round" is exactly 1, the second call's `onLLMCallStart` messages contain neither text, and `allWellFormed`. Copy the `makeCapture`/`wellFormed` helpers; agency-js tests are standalone.
- [ ] **Step 3: Run** `pnpm run agency test js tests/agency-js/handoff > <scratch>/h.txt 2>&1` and `pnpm run agency test js tests/agency-js/round-warning > <scratch>/rw.txt 2>&1`. Expected: PASS, fixtures saved.
- [ ] **Step 4:** Add both cases to `message-thread-tests.md`. Commit `git add tests/agency-js/handoff tests/agency-js/round-warning docs/dev/contributing/message-thread-tests.md`: "Agency-js cases for the round warning inside a handoff and across a resume".

### Task 11: Docs

**Files:**
- Create: `docs/dev/runtime/expiring-messages.md`
- Modify: `docs/dev/runtime/threads.md` (the `messageLabels` section, ~lines 20-60, and the `messageScopes` mentions)
- Modify: `docs/dev/language/handoff-functions.md` (step 3 and 4 of "What happens", and "Resume")
- Modify: `docs/dev/agents/tool-loop-guards.md` ("The round cap": the quoted refusal, the bare request now being the one after the last allowed round, a "The round warning" paragraph, and the per-call note)
- Modify: `docs/dev/llm/smoltalk.md` ("Message construction" / "Message serialization": the `metadata` field)
- Modify: `CLAUDE.md` (the Runtime index) and `.claude/skills/agency-runtime-docs/SKILL.md` (same line)
- Regenerate: `make` for the stdlib docs under `docs/site/stdlib/` (never hand-edit them)

- [ ] **Step 1: Write `expiring-messages.md`** with these sections, each a few plain paragraphs: What an expiring message is; The metadata keys (`label`, `expires: { at, key }`) and `messageMetadata.ts`, with one sentence that the `metadata` option of `llm()` (`builtins.ts`) is an unrelated thing; The three values of `at`, who owns each, the key each uses, and the exact place each is expired (the request `finally`, the `runPrompt` `finally` under `shouldPop`, `closeHandoff`); The claim rule for an unkeyed `llmCall` message, including that one pushed in a handoff body with no `llm()` call of its own is claimed by the caller's next call; Which roles may expire, why, and that `expiryOf` ignores an expiry on any other role; Copy-on-write, and why (`adoptFrom` and `getMessages` share instances); Serialization, the statelog dump stripping `metadata`, and how a checkpoint with `messageLabels`/`messageScopes` revives; Compaction keeps expiring messages out of the summary; Clones keep expiring messages, and why that is correct (the three cases from the spec), plus the handoff-body effect; The rule (push with an expiry; never find a message again by content or index) and the four sanctioned edits of assistant and tool messages; Files. No history, no narration of the change.
- [ ] **Step 2:** Edit the other five docs as listed. In `threads.md`, replace the labels and scopes sections with one paragraph that says per-message data lives in `metadata` and links the new doc. In `CLAUDE.md` and the skill, add one index line: `docs/dev/runtime/expiring-messages.md — Messages the runtime adds and later removes: the metadata.expires record on the message, the three owners (llm() call, request, handoff) and where each expires, the claim rule for unkeyed messages, why clones keep them, and the four sanctioned edits that are not expiries.`
- [ ] **Step 3:** Run `make`, then `git status` to confirm only the expected `docs/site/stdlib/*.md` pages changed. Read every new and edited paragraph against `verbal-tics.md`.
- [ ] **Step 4: Commit** `git add docs/dev/runtime/expiring-messages.md docs/dev/runtime/threads.md docs/dev/language/handoff-functions.md docs/dev/agents/tool-loop-guards.md docs/dev/llm/smoltalk.md CLAUDE.md .claude/skills/agency-runtime-docs/SKILL.md docs/site/stdlib/<changed pages>`: "Dev docs for expiring messages and the round warning".

### Task 12: Pre-PR checks

- [ ] **Step 1:** Task 2 Steps 2 and 3 must be done (real pin, no `pnpm link`) before anything is pushed. `git status` must show no change to `package.json` or `pnpm-lock.yaml` beyond the pin commit.
- [ ] **Step 2:** `pnpm run typecheck`; `pnpm run lint:structure`; `pnpm run fmt:ts` on the touched TypeScript files only, from this worktree.
- [ ] **Step 3:** Run the unit tests for every touched file in one vitest invocation, output to a file. Run these agency-js suites, which record labels or whole messages and may need their fixtures re-recorded (read each diff before accepting): `handoff`, `end-turn`, `round-warning`, `message-labels`, `message-labels-resume`, `message-labels-resume-parallel`, `stdlib-thread-messages`, `thread-identity-resume`. Run the two agency tests `memory/llm-injection` and `threads/expires-llm-call`. Fix anything red before pushing.
- [ ] **Step 4:** Audit the diff against `docs/dev/contributing/anti-patterns.md`.
- [ ] **Step 5:** Write the PR description in a file. It states: the smoltalk version it depends on; the spec and dev-doc paths; the behavior change that the request after the last allowed round offers no tools; and answers to interrupts, checkpoints, and isolation copied from the spec's Part 5. Open the PR and stop; the owner merges.
