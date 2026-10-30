# Expiring Messages and Round Warning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Warn the model before it runs out of tool-call rounds, and give every message the runtime adds-then-removes one mechanism (`metadata.expires`) that lives on the message itself.

**Architecture:** smoltalk gets an opaque `metadata` field on every message class, round-tripped through JSON and never rendered to a provider. Agency writes `metadata.label` and `metadata.expires = { at, key }` there, deletes the two index-aligned side arrays on `MessageThread`, and replaces three ad-hoc removals (handoff persona, memory facts, and the new round warning) with one `thread.expire(at, key)` call at the point each owner ends. The warning is a user message pushed at the tool loop's round boundary by a new producer, from a new `warnAtRoundsLeft` option.

**Tech Stack:** TypeScript, zod, vitest, smoltalk (owner's library at `~/smoltalk/packages/smoltalk`), Agency stdlib (`.agency` files, built with `make`).

**Spec:** `docs/superpowers/specs/2026-10-30-expiring-messages-and-round-warning.md` (same worktree). Read it first; this plan argues from it.

## Global Constraints

- Repo rules from `CLAUDE.md`: no dynamic imports; objects not maps; arrays not sets; `type` not `interface`; never force-push or amend; commit messages go in a file, never inline (apostrophes break the shell).
- Code rules: `docs/dev/contributing/coding-standards.md`, `anti-patterns.md`. Run `pnpm run typecheck` (never bare `tsc`) after every edit, `pnpm run fmt:ts` on the files you touched (never from the main checkout), and `pnpm run lint:structure` before pushing.
- Changing any `.agency` file under `stdlib/` requires `make` before tests see it.
- Save every test run's output to a file under the scratchpad and read the file; do not re-run to see what failed. Never run the full agency test suite locally.
- Prose rules for docs, docstrings, and comments: `~/.claude/skills/simplify-speech/general-writing-tips.md`, then check against `verbal-tics.md`. Dev docs describe the mechanism and the rule; no history, no "was X, now Y".
- Exact names from the spec: option `warnAtRoundsLeft` with fields `remaining`, `text`, `finalWarning`, `finalWarningText`; defaults `remaining: 3`, `finalWarning: true`; placeholders `{remaining}` and `{limit}`; metadata keys `label` and `expires`; `expires.at` is `"llmCall" | "request" | "handoff"`; the Agency argument is `expires: "never" | "llmCall"` defaulting to `"never"`; the dev doc is `docs/dev/runtime/expiring-messages.md`.
- Exact default texts (copy verbatim):
  - `text`: `Of the {limit} tool rounds for this request, {remaining} remain. Finish what you can with them and then write your answer.`
  - `finalWarningText`: `This is the last tool round for this request. The results of the tool calls you make now are the last you will see. After them, write your answer from what you have.`
  - new `tooManyRounds` refusal: `Error: This request's budget of {limit} tool rounds is used up, so this call was not run. Write your answer now from what you have.`
- The word for the mechanism is `expires` / "expiring messages". Do not introduce another term for it.
- `warnAtRoundsLeft` is not a preset field: do not add it to `LlmOptions` or `LLM_OPTION_KEYS` in `lib/agents/agency-agent/lib/llmOptions.agency`.

## Review Focus

Inputs the spec implies but no obvious test exercises. Each has its test added to the owning task below.

1. A `warnAtRoundsLeft.remaining` larger than the cap (threshold 10, cap 3): the first warning fires at the first boundary, after round 0, with `remaining` 2. (Task 8)
2. A `text` with an unknown placeholder such as `{foo}`: left in the text as written, not an error. (Task 7)
3. An old checkpoint with both `messageLabels` and `messageScopes`: every label and every handoff tag lands on the right message after `fromJSON`. (Task 4)
4. `expire` on a thread where some messages carry other metadata keys and no `expires`: those messages are untouched. (Task 4)
5. A handoff body that pushes a *user* message with no explicit expiry: it is not tagged and stays on the caller's thread, as today. (Task 4)

---

## Part A: smoltalk

### Task 1: `metadata` on every smoltalk message

**Files:**
- Modify: `~/smoltalk/packages/smoltalk/lib/classes/message/BaseMessage.ts` (the `MessageClass` interface, line 20)
- Modify: `~/smoltalk/packages/smoltalk/lib/classes/message/UserMessage.ts`, `SystemMessage.ts`, `AssistantMessage.ts`, `ToolMessage.ts`, `DeveloperMessage.ts`
- Modify: `~/smoltalk/packages/smoltalk/lib/classes/message/index.ts` (the five factory functions, lines 49-110)
- Modify: `~/smoltalk/packages/smoltalk/lib/clients/resolveAttachments.ts:203`
- Modify: `~/smoltalk/packages/smoltalk/CHANGELOG.md`
- Test: `~/smoltalk/packages/smoltalk/lib/classes/message/metadata.test.ts` (new, modeled on `rawData.test.ts` beside it)

**Interfaces:**
- Produces: every message class and factory accepts `options.metadata?: Record<string, unknown>`; every message has `get metadata(): Record<string, unknown> | undefined`; `toJSON()` includes `metadata` only when set; `fromJSON` reads it. `MessageJSON` types gain `metadata?: Record<string, unknown>`.

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

Run: `cd ~/smoltalk/packages/smoltalk && pnpm run test -- lib/classes/message/metadata.test.ts > /tmp/claude-501/smoltalk-metadata.txt 2>&1; tail -30 /tmp/claude-501/smoltalk-metadata.txt`
Expected: FAIL, `metadata` is `undefined` after `fromJSON`.

- [ ] **Step 3: Implement**

In each of the five classes: add `metadata: z.record(z.string(), z.unknown()).optional()` to the zod schema; a `public _metadata?: Record<string, unknown>` field set from `options.metadata` in the constructor; a `get metadata()` getter; write it in `toJSON()` as `metadata: this._metadata` (the existing `JSON.stringify` drops an `undefined` field, which is how `rawData` already stays out when unset); pass `result.data.metadata` through in `fromJSON`. Add `get metadata(): Record<string, unknown> | undefined;` to `MessageClass`. Add `metadata?: Record<string, unknown>` to each factory's `options` type in `index.ts`. In `resolveAttachments.ts:203` pass `metadata: msg.metadata` beside `rawData`.

- [ ] **Step 4: Run the tests and the whole smoltalk suite**

Run: `cd ~/smoltalk/packages/smoltalk && pnpm run build && pnpm run test > /tmp/claude-501/smoltalk-all.txt 2>&1; tail -20 /tmp/claude-501/smoltalk-all.txt`
Expected: all pass. (smoltalk has no prettier; build before test, per `smoltalk-repo-gotchas`.)

- [ ] **Step 5: Changelog and commit**

Add an entry under the unreleased heading of `CHANGELOG.md`: "Every message class accepts and round-trips an opaque `metadata` object. smoltalk never reads it and never sends it to a provider." Do not bump the version; the owner does. Commit in the smoltalk repo with the message in a file.

### Task 2: Pin the new smoltalk in agency-lang

**Files:**
- Modify: `package.json:157` (the `smoltalk` pin)

- [ ] **Step 1:** Ask the owner to publish smoltalk. Until it is published, develop against the local build with `pnpm link ~/smoltalk/packages/smoltalk` in this worktree only, and never commit a `link:` or `file:` entry.
- [ ] **Step 2:** Once published, set the pin to the released version, run `pnpm install`, then `pnpm run typecheck`.
- [ ] **Step 3:** Commit `package.json` and `pnpm-lock.yaml` alone: "Pin smoltalk <version> for message metadata".

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
/** The expiry, or null for a message that stays with the thread. */
export function expiryOf(message: smoltalk.Message): Expiry | null;
/** A copy of `message` with `patch` merged into its metadata. A null
 *  value in the patch removes that key. Goes through toJSON/fromJSON so
 *  the result is a real message instance of the same class. */
export function withMetadata(
  message: smoltalk.Message,
  patch: { label?: string | null; expires?: Expiry | null },
): smoltalk.Message;
/** True when the role may carry an expiry: system or user. */
export function mayExpire(message: smoltalk.Message): boolean;
```

- [ ] **Step 1: Write the failing tests**: `labelOf` and `expiryOf` return null on a bare message; `withMetadata` sets a label and keeps the content and role; `withMetadata` with `expires: null` removes the key and keeps the label; `withMetadata` on a `ToolMessage` keeps `tool_call_id` and `name`; `mayExpire` is true for system and user, false for assistant, tool, and developer.
- [ ] **Step 2: Run** `pnpm exec vitest run lib/runtime/state/messageMetadata.test.ts > <scratch>/meta.txt 2>&1`. Expected: FAIL, module not found.
- [ ] **Step 3: Implement** the five exports. `withMetadata` builds `{ ...message.toJSON(), metadata }` and revives it with `smoltalk.messageFromJSON`, dropping the `metadata` key entirely when the merged object is empty.
- [ ] **Step 4: Run** the test. Expected: PASS.
- [ ] **Step 5: Commit** "Add messageMetadata: label and expiry readers and writers".

### Task 4: `MessageThread` keeps metadata on the message

**Files:**
- Modify: `lib/runtime/state/messageThread.ts`
- Modify: `lib/runtime/state/schemas.ts:10-11` (keep both fields optional; add a comment that they are read-only legacy input)
- Modify: `lib/runtime/handoff.ts:118-130` (`stripHandoffSystemMessages`)
- Modify: `lib/runtime/prompt.ts:270-292` (compaction's `setMessages` call)
- Modify: `lib/runtime/promptEvents.ts:38` (`withMessageLabels`)
- Test: `lib/runtime/state/messageThread.test.ts` (replace the `messageLabels` alignment cases and the whole `MessageThread handoff scopes` block)
- Test: `lib/runtime/promptLabels.test.ts` (should pass unchanged; it reads `labelAt` and `withMessageLabels`)

**Interfaces:**
- Consumes: Task 3.
- Produces, on `MessageThread`:

```ts
push(message: smoltalk.Message, label: string | null = null, expires: Expiry | null = null): void;
expire(at: ExpiresAt, key: string): void;
claimUnkeyed(at: ExpiresAt, key: string): void;
labelAt(index: number): string | null;       // reads metadata
expiryAt(index: number): Expiry | null;       // reads metadata
setMessages(messages: smoltalk.Message[]): void;   // labels/scopes params removed
enterHandoffScope(key: string): void; exitHandoffScope(): void; handoffDepth(): number;  // unchanged
```
  Removed: `messageLabels`, `messageScopes`, `scopeAt`, `removeHandoffScoped`, and the `labels`/`scopes` parameters of `setMessages`. `MessageThreadJSON` keeps `messageLabels?` and `messageScopes?` as input-only legacy fields; `toJSON` no longer writes them.

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
it("a system message pushed inside a handoff scope expires with that handoff, user messages do not", () => {
  // enterHandoffScope("explorer:c1"); push system "persona" and user "brief"
  // expiryAt(0) is { at: "handoff", key: "explorer:c1" }; expiryAt(1) is null  (Review Focus 5)
});
it("nested scopes tag with the innermost key", ...);  // same shape as today's test
it("expire removes only messages matching both at and key", () => {
  // push: user "hello" (label "first"); system "persona" expires handoff explorer:c1;
  // user "warn" expires llmCall k1; system "other" expires handoff oracle:c2;
  // user "plain" with metadata label only
  t.expire("handoff", "explorer:c1");
  expect(contents).toEqual(["hello", "warn", "other", "plain"]);
  expect(t.labelAt(0)).toBe("first");            // Review Focus 4
});
it("claimUnkeyed keys only the unkeyed messages with that at", () => {
  // push user "a" expires llmCall null; user "b" expires llmCall "k0"; system "c" expires handoff null
  t.claimUnkeyed("llmCall", "k1");
  // expiryAt: {llmCall,k1}, {llmCall,k0}, {handoff,null}
});
it("push refuses an expiry on a tool, assistant, or developer message", () => {
  expect(() => t.push(smoltalk.assistantMessage("x"), null, { at: "llmCall", key: "k" })).toThrow(/expire/);
  expect(() => t.push(smoltalk.toolMessage("x", { tool_call_id: "c", name: "t" }), null, { at: "llmCall", key: "k" })).toThrow(/expire/);
});
it("toJSON writes neither messageLabels nor messageScopes", () => {
  // after pushes with a label and an expiry: expect("messageLabels" in json).toBe(false), same for messageScopes
});
it("fromJSON folds legacy messageLabels and messageScopes into the messages", () => {   // Review Focus 3
  const json = { messages: [sysJSON("a"), userJSON("b"), sysJSON("c")], messageLabels: ["s0", null, "s2"], messageScopes: ["explorer:c1", null, null] };
  const t = MessageThread.fromJSON(json);
  expect([0,1,2].map(i => t.labelAt(i))).toEqual(["s0", null, "s2"]);
  expect(t.expiryAt(0)).toEqual({ at: "handoff", key: "explorer:c1" });
  expect(t.expiryAt(1)).toBeNull();
});
it("a label and an expiry ride through removeAt, replaceAt, setMessages, adoptFrom, and newSubthreadChild", ...);
```

Delete the existing cases that assert on `messageLabels`/`messageScopes` arrays or on `setMessages(…, labels, scopes)`; keep every case about `labelAt` surviving `removeAt`, `replaceAt`, `removeMatching`, and `adoptFrom`, since `labelAt` stays.

- [ ] **Step 2: Run** the file. Expected: FAIL on `expiryAt`/`expire`/`claimUnkeyed` undefined.
- [ ] **Step 3: Implement** in `messageThread.ts`: delete `messageLabels`, `messageScopes`, and every line that maintains them; `push` calls `mayExpire` and throws `push: a <role> message cannot expire` when given an expiry on another role, computes the handoff default for a system message with no expiry while `handoffScopes` is non-empty, and appends `withMetadata(message, { label, expires })` (or the message itself when both are null); `expire` and `claimUnkeyed` walk backwards using `expiryOf` and `withMetadata`; `labelAt`/`expiryAt` read via `labelOf`/`expiryOf`; `toJSON` drops the two fields; `fromJSON` reads legacy arrays and applies them with `withMetadata` after reviving, a scope string becoming `{ at: "handoff", key }`; `setMessages(messages)` assigns the array; `adoptFrom` copies messages, queue, and repairs. Rewrite the class comment: one paragraph saying per-message data lives in `metadata` (see `messageMetadata.ts`) and pointing at the dev doc from Task 11.
- [ ] **Step 4: Update the callers.** `stripHandoffSystemMessages` → `thread.expire("handoff", scopeKey)`. Compaction in `prompt.ts`: drop the `labels`/`scopes` arrays and call `messages.setMessages([...head, summary, ...tail])`; delete the comment about labels riding along. `withMessageLabels` in `promptEvents.ts`: unchanged in behavior; it still calls `labelAt(i)`, so the only edit is the comment, which should no longer talk about index alignment as a hazard. `schemas.ts`: keep both fields, comment them as legacy input.
- [ ] **Step 5: Run** `pnpm run typecheck`, then `pnpm exec vitest run lib/runtime/state lib/runtime/promptLabels.test.ts lib/runtime/handoff.test.ts > <scratch>/thread.txt 2>&1` (add `lib/runtime/threadRepair.test.ts` and `lib/runtime/memory` if they fail to typecheck). Expected: PASS.
- [ ] **Step 6: Run the handoff agency-js suite**: `pnpm run agency test js tests/agency-js/handoff > <scratch>/handoff.txt 2>&1`. Expected: PASS with the fixture unchanged (`persona`, `pauseWithPersona`, `nested`, `cancelledHandoff` all still strip).
- [ ] **Step 7: Commit** "MessageThread: labels and expiries live on the message".

### Task 5: Memory facts expire with their request

**Files:**
- Modify: `lib/runtime/prompt.ts:876-925` (the facts push and the `finally`)
- Test: `tests/agency/memory/llm-injection.agency` and its `.test.json`

**Interfaces:**
- Consumes: Task 4 `push(..., expires)` and `expire`.

- [ ] **Step 1: Extend the test.** In `llm-injection.agency`, after the `llm("mom", { memory: true })` call, read the active thread with `getMessages()` from `std::thread` and set a second flag when no message contains `"Relevant context from memory:"`. Return `{ injected: injected, removed: removed }` and update the `.test.json` expected output to `{"injected":true,"removed":true}`. Check `docs/site/guide/message-threads.md` for the exact name of the function that returns the active thread's messages before writing it.
- [ ] **Step 2: Run** `pnpm run agency test tests/agency/memory/llm-injection.agency > <scratch>/mem.txt 2>&1`. Expected: PASS already (today's `findLastIndex` removal works). This step pins the behavior before the mechanism changes.
- [ ] **Step 3: Implement.** Inside the request step: `const requestKey = llmCallKey(which)` is already computed by `requestStepWithTripRetry` (line 834); pass it into the body or recompute it with `llmCallKey({ first: true })`. Push with `messages.push(smoltalk.systemMessage(injectedFactsContent), null, { at: "request", key: requestKey })`. In the `finally`, replace the `findLastIndex`/`removeAt` block with `messages.expire("request", requestKey)`. Delete the `injectedFactsContent` variable if nothing else reads it.
- [ ] **Step 4: Run** the agency test again and `pnpm exec vitest run lib/runtime/memory`. Expected: PASS.
- [ ] **Step 5: Commit** "Memory facts expire with their request".

### Task 6: `llmCall` expiry: claim at call start, expire at call end, and the `expires` argument

**Files:**
- Modify: `lib/runtime/prompt.ts` (the `pushPrompt` step at ~868; a new `expireLlmCall` step before each of the three returns at ~1917, ~1931, and ~2028)
- Modify: `lib/stdlib/thread.ts:67-91` (`_systemMessage`, `_userMessage`)
- Modify: `stdlib/thread.agency:89-111` (`systemMessage`, `userMessage`)
- Test: `lib/runtime/prompt.toolRounds.test.ts` (one new case)
- Test: `tests/agency/threads/expires-llm-call.agency` + `.test.json` (new)
- Modify: `docs/dev/contributing/message-thread-tests.md` (add the new case to the list)

**Interfaces:**
- Consumes: Task 4.
- Produces: `runPrompt` claims unkeyed `llmCall` messages with `self.llmCallKey` (a string stored on the frame; see Step 3) and expires them at return. Agency: `systemMessage(msg, label = "", expires: "never" | "llmCall" = "never")` and `userMessage(msg, label = "", expires: "never" | "llmCall" = "never")`. TS: `_systemMessage(msg, label = "", expires: "never" | "llmCall" = "never")`, same for `_userMessage`.

- [ ] **Step 1: Write the failing unit test** in `prompt.toolRounds.test.ts` (its `setup`/`call` helpers already drive `runPrompt` with a `MessageThread`):

```ts
it("an unkeyed llmCall message is claimed by the next call and gone when it returns", async () => {
  const s = setup([{ return: "done" }]);
  const thread = s.threads.getOrCreateActive();
  thread.push(smoltalk.userMessage("just for this call"), null, { at: "llmCall", key: null });
  await runInTestContext(s.ctx, async (run) => {
    await call(run, s, thread, { baked: 3 });
  });
  expect(s.client.requests[0].map(m => m.content)).toContain("just for this call");  // add request recording to RecordingClient if it only records tool names
  expect(thread.getMessages().map(m => m.content)).not.toContain("just for this call");
});
```

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

- [ ] **Step 3: Run both.** Expected: the unit test fails (message still on the thread); the agency test fails to compile (`expires` is not a parameter yet).
- [ ] **Step 4: Implement in `prompt.ts`.** Store the call's key once: `self.llmCallKey ??= llmSpanId` right after `reopenSpan` (line 790), so a resume reads the same key from the frame. In the `pushPrompt` step body, before the prompt push: `messages.claimUnkeyed("llmCall", self.llmCallKey)`. Add a helper inside `runPrompt`:

```ts
const expireLlmCall = () =>
  pr.step("expireLlmCall", async () => {
    messages.expire("llmCall", self.llmCallKey);
    self.messagesJSON = snapshotThread();
  });
```

and call `await expireLlmCall()` immediately after each `guardGate.final` step (the `accept` and `surfaceFailure` branches, and the no-schema `break` path) and before the value is returned. Not in the `finally`.

- [ ] **Step 5: Implement the stdlib argument.** `_systemMessage`/`_userMessage` take `expires` and pass `expires === "llmCall" ? { at: "llmCall", key: null } : null` to `push`. In `thread.agency`, add the parameter to both defs and one sentence to each docstring: `@param expires - "never" (the default) keeps the message on the thread; "llmCall" removes it when the next llm() call on this thread returns.` Run `make`.
- [ ] **Step 6: Run** `pnpm run typecheck`; the unit file; `pnpm run agency test tests/agency/threads/expires-llm-call.agency`; and `pnpm run agency test js tests/agency-js/handoff` (a handoff body's call must not expire the caller's messages). Expected: PASS.
- [ ] **Step 7:** Add the new case to `docs/dev/contributing/message-thread-tests.md`. Commit "llmCall expiry and the expires argument on systemMessage and userMessage".

### Task 7: The `warnAtRoundsLeft` option and its pure helpers

**Files:**
- Create: `lib/runtime/roundWarning.ts`
- Test: `lib/runtime/roundWarning.test.ts`
- Modify: `stdlib/llm.agency:98-115` (`LlmDefaults`) and the module doc above it
- Modify: `lib/stdlib/llm.ts:32-60` (`LlmDefaults`) and `_setLlmOptions` (line ~94, the `replyLimits` merge)
- Modify: `lib/typeChecker/builtins.ts` (the `llm()` option table, beside `maxRepeatedToolCalls` at line 178)

**Interfaces:**
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
/** Field-by-field: the call's value over the branch default over DEFAULT_ROUND_WARNING. */
export function roundWarningSettings(perCall: WarnAtRoundsLeft | undefined, branch: WarnAtRoundsLeft | undefined): RoundWarningSettings;
/** Replaces {remaining} and {limit}; any other brace text is left as is. */
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
- [ ] **Step 3: Implement** `roundWarning.ts` to the interfaces. `remaining` for the boundary after `round` is `limit - (round + 1)`; `first` is due when `!fired.first && settings.remaining > 0 && remaining <= settings.remaining && remaining > 1`; `final` when `!fired.final && settings.finalWarning && remaining === 1`. Check `final` before `first`.
- [ ] **Step 4: Add the option type** in all three places. `stdlib/llm.agency` `LlmDefaults`: `warnAtRoundsLeft?: { remaining?: number, text?: string, finalWarning?: boolean, finalWarningText?: string };` and a paragraph in the module doc, in the style of the `replyLimits` paragraph, saying what each field does, the two placeholders, and the defaults. `lib/stdlib/llm.ts` `LlmDefaults`: `warnAtRoundsLeft?: WarnAtRoundsLeft;` imported from `roundWarning.ts`. `_setLlmOptions`: merge `warnAtRoundsLeft` field by field like `replyLimits` (reuse `roundWarningSettings`'s merge or a small shared `mergeFields` helper; do not write a third merge). `builtins.ts`: an `objectType` entry with the four optional properties, with a one-line comment pointing at `roundWarning.ts`. Run `make`.
- [ ] **Step 5: Run** `pnpm run typecheck`, the new test file, and `pnpm exec vitest run lib/stdlib/llm.test.ts lib/typeChecker` (save output). Expected: PASS.
- [ ] **Step 6: Commit** "warnAtRoundsLeft option and round-warning helpers".

### Task 8: The warning producer at the round boundary

**Files:**
- Modify: `lib/runtime/turnBoundary.ts` (`BoundaryContext`, new `roundWarningProducer`, `runRoundBoundary`)
- Modify: `lib/runtime/prompt.ts` (read `warnAtRoundsLeft` off `clientConfig` at ~610 and `stackDefaults` at ~660; fill the new `BoundaryContext` fields in `boundaryCtx()` at ~807)
- Test: `lib/runtime/turnBoundary.test.ts`
- Test: `lib/runtime/prompt.toolRounds.test.ts`

**Interfaces:**
- Consumes: Task 7 helpers; Task 6 `self.llmCallKey`.
- Produces: `BoundaryContext` gains `roundWarning: { settings: RoundWarningSettings; limit: number; round: number; callKey: string } | null` (null at the initial boundary and on validation retries, where no warning is due). `runnerState.roundWarnings: { first: boolean; final: boolean }`. The producer pushes `smoltalk.userMessage(text)` with label `"roundWarning"` and expiry `{ at: "llmCall", key: callKey }`.

- [ ] **Step 1: Write the failing producer tests** in `turnBoundary.test.ts` using `makeBctx`: with settings default, limit 5, round 1 (remaining 3): `take` returns one user message whose content contains "5 tool rounds" and "3 remain", with label `roundWarning` and expiry `{ at: "llmCall", key: "k" }`, and sets `runnerState.roundWarnings.first`; a second `take` at the same round returns `[]`; round 3 (remaining 1) returns the final text and sets `final`; `roundWarning: null` returns `[]`. Extend the "canonical step sequences" test so the round boundary's step list includes `round.N.roundWarning` between `queuedMessages` and `guardGate`.
- [ ] **Step 2: Write the failing loop tests** in `prompt.toolRounds.test.ts` (the `RecordingClient` must record each request's messages; add `readonly requests: smoltalk.Message[][]`):

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

`call()` needs a `warnAtRoundsLeft?: WarnAtRoundsLeft` option passed on `clientConfig`.

- [ ] **Step 3: Run both files.** Expected: FAIL.
- [ ] **Step 4: Implement.** In `prompt.ts`: destructure `warnAtRoundsLeft: ccWarnAtRoundsLeft` from `clientConfig` and `warnAtRoundsLeft: stackWarnAtRoundsLeft` from `stackDefaults` (keep it out of `stackSmolDefaults`, like `maxToolCallRounds`); `const roundWarning = roundWarningSettings(ccWarnAtRoundsLeft, stackWarnAtRoundsLeft)`; `self.runnerState.roundWarnings ??= { first: false, final: false }`; `boundaryCtx(round?: number)` fills `roundWarning` when a round is given, else null; `runRoundBoundary(round, boundaryCtx(round))`. In `turnBoundary.ts`: `roundWarningProducer.take` returns `[]` when `bctx.roundWarning` is null, else calls `roundWarningDue(settings, round, limit, runnerState.roundWarnings)`, marks the kind fired, and returns the message. `TurnMessage` gains `expires?: Expiry | null`, and `drainProducer` passes it to `push`. `runRoundBoundary` drains it after `queuedMessages` and before the gate.
- [ ] **Step 5: Run** `pnpm run typecheck` and both test files. Expected: PASS.
- [ ] **Step 6: Commit** "Warn the model at the round boundary before the tool-round cap".

### Task 9: The refusal text

**Files:**
- Modify: `lib/runtime/toolLoopGuards.ts:240` (`tooManyRounds` in `refusalMessage`)
- Test: `lib/runtime/prompt.toolRounds.test.ts` (the `REFUSAL` regex at line 89 and the first `describe` case)

- [ ] **Step 1:** Change `REFUSAL` to `/This request's budget of (\d+) tool rounds is used up/` and run the file. Expected: the first case FAILS.
- [ ] **Step 2:** Replace the string with the Global Constraints text, `{limit}` filled from `state.maxToolCallRounds`. Run the file. Expected: PASS. Also run `grep -rn "Maximum number of tool call rounds" lib tests docs` and update every hit (the `tool-loop-guards.md` quote is Task 11).
- [ ] **Step 3: Commit** "Round-cap refusal names the request, not the tool list".

### Task 10: End-to-end agency-js cases

**Files:**
- Modify: `tests/agency-js/handoff/agent.agency`, `test.js`, `llmMocks.json`, `fixture.json`
- Create: `tests/agency-js/round-warning/agent.agency`, `test.js`, `llmMocks.json`, `fixture.json`, `agency.json`, `useTestLLMProvider` (copy the last two from `tests/agency-js/handoff`)
- Modify: `docs/dev/contributing/message-thread-tests.md`

- [ ] **Step 1: `warningInsideHandoff`.** In the handoff `agent.agency`, add a handoff def whose body calls `llm("brief: ${question}", { tools: [lookup], maxToolCallRounds: 2 })`, and a node that dispatches it. Mocks: the caller calls the handoff; the body calls `lookup` once (round 0, remaining 1 → final warning), then returns text; the caller returns text. In `test.js`, record: the body's second request contains "last tool round" (the final warning), and the caller's final request does not contain "tool round" at all. Follow the shape of the `persona` block. Rebuild the fixture when prompted and read the diff before accepting it.
- [ ] **Step 2: `round-warning` resume case.** `agent.agency`: a tool `pauseMe` that raises an unhandled interrupt (copy from the handoff test), and `export node run()` that calls `llm("go", { tools: [pauseMe, ping], maxToolCallRounds: 3 })`. Mocks: round 0 calls `ping`; round 1 calls `pauseMe` (the run pauses; on resume the round finishes, then the boundary after round 1 has remaining 1 → final warning); round 2 returns text. `test.js`: run, `respondToInterrupts(paused.data, [approve()], …)`, then record: the number of requests containing "last tool round" is exactly 1, the final thread (from the last `onLLMCallStart` plus the returned value) holds none after the call, and `allWellFormed`. Reuse the `makeCapture`/`wellFormed` helpers by copying them; agency-js tests are standalone.
- [ ] **Step 3: Run** `pnpm run agency test js tests/agency-js/handoff > <scratch>/h.txt 2>&1` and `pnpm run agency test js tests/agency-js/round-warning > <scratch>/rw.txt 2>&1`. Expected: PASS, fixtures saved.
- [ ] **Step 4:** Add both cases to `message-thread-tests.md`. Commit "Agency-js cases for the round warning inside a handoff and across a resume".

### Task 11: Docs

**Files:**
- Create: `docs/dev/runtime/expiring-messages.md`
- Modify: `docs/dev/runtime/threads.md` (the `messageLabels` section, ~lines 20-60, and the `messageScopes` mentions)
- Modify: `docs/dev/language/handoff-functions.md` (step 3 and 4 of "What happens", and "Resume")
- Modify: `docs/dev/agents/tool-loop-guards.md` ("The round cap": the quoted refusal, a "The round warning" paragraph, and the per-call note)
- Modify: `docs/dev/llm/smoltalk.md` ("Message construction" / "Message serialization": the `metadata` field)
- Modify: `CLAUDE.md` (the Runtime index) and `.claude/skills/agency-runtime-docs/SKILL.md` (same line)
- Regenerate: `make` for the stdlib docs under `docs/site/stdlib/` (never hand-edit them)

- [ ] **Step 1: Write `expiring-messages.md`** with these sections, each a few plain paragraphs: What an expiring message is; The metadata keys (`label`, `expires: { at, key }`) and `messageMetadata.ts`; The three values of `at`, who owns each, and the exact place each is expired (Task 5, 6, and `closeHandoff`); The claim rule for an unkeyed `llmCall` message; Which roles may expire and why; Serialization, and how a checkpoint with `messageLabels`/`messageScopes` revives; Clones keep expiring messages, and why that is correct (the three cases from the spec), plus the handoff-body effect; The rule (push with an expiry; never find a message again by content or index) and the four sanctioned edits of assistant and tool messages; Files. No history, no narration of the change.
- [ ] **Step 2:** Edit the other five docs as listed. In `threads.md`, replace the labels and scopes sections with one paragraph that says per-message data lives in `metadata` and links the new doc. In `CLAUDE.md` and the skill, add one index line: `docs/dev/runtime/expiring-messages.md — Messages the runtime adds and later removes: the metadata.expires record on the message, the three owners (llm() call, request, handoff) and where each expires, the claim rule for unkeyed messages, why clones keep them, and the four sanctioned edits that are not expiries.`
- [ ] **Step 3:** Run `make`, then `git status` to confirm only the expected `docs/site/stdlib/*.md` pages changed. Read every new and edited paragraph against `verbal-tics.md`.
- [ ] **Step 4: Commit** "Dev docs for expiring messages and the round warning".

### Task 12: Pre-PR checks

- [ ] **Step 1:** `pnpm run typecheck`; `pnpm run lint:structure`; `pnpm run fmt:ts` on the touched TypeScript files only, from this worktree.
- [ ] **Step 2:** Run the unit tests for every touched file in one vitest invocation, output to a file; run the three agency-js suites (`handoff`, `end-turn`, `round-warning`) and the two agency tests (`memory/llm-injection`, `threads/expires-llm-call`). Fix anything red before pushing.
- [ ] **Step 3:** Audit the diff against `docs/dev/contributing/anti-patterns.md`.
- [ ] **Step 4:** Write the PR description in a file. It states: the smoltalk version it depends on; the spec and dev-doc paths; and answers to interrupts, checkpoints, and isolation copied from the spec's Part 5. Open the PR and stop; the owner merges.
