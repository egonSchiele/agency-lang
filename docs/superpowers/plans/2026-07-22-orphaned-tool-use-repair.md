# Orphaned tool_use Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task, inline in the main session (this project does not use subagent-driven development). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A session thread abandoned mid-tool-round can never again poison the whole session — reopening it repairs the dangling tool calls — and unowned guard trips in the agency agent get a default answer instead of parking forever.

**Architecture:** All repair logic lives in `lib/runtime/threadRepair.ts`: a shared append procedure with per-case wording, a `repairAbandonedTurn` beside the existing `markThreadCancelled`, and a `repairReopenedThread` wrapper that owns the statelog emission. The one seam that calls it is the reopen branch of `Runner.thread()` — one line — which covers both `session:` and `continue:` reopens and is provably skipped by checkpoint resumes. `MessageThread` owns a monotonic repair generation (`markRepaired()` / `isNewerThan()`), and a new `restoreThreadForResume` helper makes a stale checkpoint restore fail loudly instead of clobbering the repaired thread. Separately, `turnBudgetHandler` in the agency agent stops passing on foreign `std::guard` trips and rejects them.

**Tech Stack:** TypeScript runtime (`lib/runtime/`), vitest unit tests, Agency stdlib/agent code (`.agency`), Agency execution tests (`tests/agency/guards/`).

**Spec:** `/Users/adityabhargava/agency-lang/docs/superpowers/specs/2026-07-22-orphaned-tool-use-on-guard-abort-design.md`

**Reviews incorporated:** `/Users/adityabhargava/agency-lang/docs/superpowers/plans/2026-07-22-orphaned-tool-use-repair-REVIEW.md` (all findings; the plan-level decisions it demanded are written out in the "Decisions" section below) and `.../2026-07-22-orphaned-tool-use-repair-REVIEW-v2.md` (re-verified against main @ 135de584c after #651/#653/#655; its statelog-on-refusal recommendation is in Task 5).

## Global Constraints

- NEVER commit on main. All work happens on branch `adit/orphaned-tool-use-repair`. Re-check `git branch --show-current` before every commit.
- After changing any `.agency` file under `stdlib/` or `lib/agents/`, run `make` (plain `pnpm run build` skips `lib/agents`).
- Save every test run's output to a file (`tee`) so failures never require a rerun.
- Do not run the full agency test suite locally; run only the specific tests named in each task. CI runs the rest.
- Agency syntax: `def name(args): Type { ... }`, parenthesized conditions, `let`/`const` declarations. The `??` operator IS valid Agency (see `budget.agency:186`).
- No dynamic imports; objects not maps; arrays not sets (the one existing `Set` in `threadRepair.ts` is rewritten to an array in Task 1 — a conscious choice, since the function is being rewritten anyway and the arrays hold a handful of ids); types not interfaces.
- Commit messages must not contain apostrophes when passed on the command line; none of the messages below do.
- Do not touch CHANGELOG.md.

---

## Background: the bug in one paragraph

The provider requires that every `tool_use` block in an assistant message is answered by a `tool_result` in the next message. When a turn parks on an unanswered interrupt (e.g. a guard trip nobody answers), the in-flight tool call has no result yet — that gap is supposed to close when the turn resumes. If the user instead types a new message, the REPL reopens the same session thread and appends on top of the gap. The provider then rejects every subsequent request with a 400, permanently. The trace in the spec shows a real session dying this way: 21.7 minutes and $0.58 delivering nothing.

The fix has two independent halves:

1. **Repair at reopen (Tasks 1–5).** When a thread is reopened for new work and its trailing assistant message has unanswered tool calls, synthesize results for them before anything else lands. Reopen is the exact moment the previous turn stopped mattering, and — critically — a *checkpoint resume never travels through the reopen path* (the frame-locals guard at `runner.ts:656-708` skips the thread-open side effect on resume, and `restoreBranchView` reinstates the active stack by direct assignment), so repair can never fire while a real resume is pending. Because repairing makes abandon-then-continue a supported flow, a *late* answer to the abandoned interrupt would restore its snapshot INTO the live thread (the aliasing currently at `prompt.ts:1041-1052`) and clobber both the repair and the new turn — so repair also bumps a generation counter that makes such a restore refuse loudly (Task 5).

2. **Default answer for unowned guard trips (Tasks 6–7).** The turn parked in the first place because `consultExpert`'s inner guard is unlabeled, so `turnBudgetHandler` passed it through and nobody above answers guards. The agent's handler chain gets a catch-all: a `std::guard` trip that is not the turn budget gets rejected (honoring the budget; salvage still runs) instead of parking. Inner stdlib guards get labels so the stop notice can say which budget ran out.

All file paths below are relative to `packages/agency-lang/` unless absolute.

## Decisions the review forced into the open

**The catch-all rejects; it does not prompt.** The spec allowed either. The reason for reject-always: the turn budget is the *user's* contract, and `turnBudgetHandler` already gives it an interactive prompt. Inner guards are engineering limits that exist precisely so subagents are bounded *without* bothering the user — prompting for each of them would turn every nested budget into a user interruption and defeat the point of having per-subagent caps under a single turn budget. Rejecting is also safe in the strong sense: `turnBudgetHandler` is registered at `coordinator.agency:362` as the outermost guard-answering handler (the CLI policy handler outside it passes on `std::guard`), so rejecting steals an answer from nobody. The knock-on: after this change an interactive user cannot grant more time to an inner subagent — a door deliberately closed; today that door only leads to an infinite park. Consequence for Task 6: labels no longer gate any handler logic — they exist purely so the stop notice can name the budget that ran out. Real, but modest; Task 6 is sized accordingly.

**`_lastPartial` is NOT set on a foreign-guard reject.** Both existing reject paths set it (`budget.agency:151`, `:169`) because they end the *turn* and `runTurn` shows the partial. A foreign-guard reject does not end the turn — the inner guard's own salvage runs at its own guard site and the turn continues with that result. Overwriting the turn-level partial with an inner subagent's draft would show the wrong thing if the turn later stops for its own reasons. This reasoning goes in a code comment (Task 7 Step 3).

**Subthreads are not repaired at creation, on purpose.** `createSubthread` clones the parent's messages (`messageThread.ts:146-149`), so in principle a subthread could inherit a damaged tail. In practice it cannot: damage only ever exists on a thread whose run parked and died, and a *new* run must reopen that thread (session or `continue:`) — which repairs it — before the thread can be active and have subthreads created off it. Within a single run, a thread cannot be damaged while code is executing (the whole program pauses on an interrupt). So the reopen seam is sufficient, and the falsifiability of the `isResumption` guard is covered by an explicit resume-re-entry test (Task 4) instead.

**Legacy checkpoints are refused after a repair, on purpose.** Checkpoints created before this PR hold a bare message array that revives with `repairs: 0` (`prompt.ts:1068-1072` documents the legacy branch). Restoring one into a thread repaired since then throws. That is the correct answer — the snapshot genuinely predates the repair — and it is tested explicitly (Task 5).

## Testing rationale (read before judging coverage)

- **The spec's end-to-end "no 400" regression is deliberately not implemented.** The mock provider does not enforce the tool_result pairing rule, so "the next call succeeds rather than 400s" would pass vacuously with mocks and needs a live LLM otherwise. The Task 4 runner tests exercise the real seam with the real `ThreadStore` and real `MessageThread` — the honest equivalent. Do not add a live-LLM test for this.
- **Every test is written to go red if its code is wrong.** The review found five places where the original plan's tests stayed green under broken implementations; each has a named counter-test now: resume re-entry must not repair (Task 4), the statelog event must fire with the right payload and not fire on healthy reopens (Task 3), the stale-restore check must be wired and ordered before `adoptFrom` (Task 5 tests the extracted helper that owns both), repair twice must count twice (Task 3), and label preservation is asserted (Task 1).
- **`turnBudgetHandler` has no existing coverage.** `turn-budget-partial.agency` uses a hand-written imitation, not the real handler. Task 7's fixture imports the real one and covers: foreign-guard reject with salvage, foreign-guard reject without salvage, own-label non-interactive reject, and non-guard pass-through. The own-label *interactive* prompt path stays untested — it needs `input()` mocking, and the non-interactive path covers the same label-matching logic; this is a named gap, not an oversight.

---

### Task 0: Branch setup

**Files:** none (git only)

- [ ] **Step 1: Create a worktree on a new branch off main**

Per project convention, worktrees live inside the `agency-lang` directory:

```bash
cd /Users/adityabhargava/agency-lang/packages/agency-lang
git worktree add worktree-orphan-repair -b adit/orphaned-tool-use-repair main
cd worktree-orphan-repair/packages/agency-lang
make 2>&1 | tee /tmp/orphan-repair-build.log
```

Expected: build completes without errors. All subsequent tasks run from `worktree-orphan-repair/packages/agency-lang`.

---

### Task 1: Restructure threadRepair.ts — shared scan, shared append

One definition of the invalid *tail*, one copy of the append procedure, and per-case wording as data. This is the "declarative core" both repairs share; the spec asked for exactly this split ("Both repair functions share `unansweredToolCalls` and the append loop; only the message text differs").

**Files:**
- Modify: `lib/runtime/threadRepair.ts`
- Modify: `lib/runtime/state/messageThread.ts` (one doc-comment sentence)
- Test: `lib/runtime/threadRepair.test.ts` (append)

**Interfaces:**
- Produces (all in `threadRepair.ts`):
  - `export type DanglingToolCall = { id: string; name: string }`
  - `export function unansweredToolCalls(messages: MessageThread): DanglingToolCall[]` — the trailing assistant turn's unanswered calls only.
  - internal `hasAssistantTurn(messages): boolean` and internal `appendRepair(messages, dangling, wording): void` — not exported; Task 3 reuses them within the module.
  - `markThreadCancelled` now returns `DanglingToolCall[]` (was `void`) so the two repairs share a contract. Its only caller (`prompt.ts:1984` on current main) ignores the return value; no call-site change needed.

**Deliberate behavior changes, called out:** (a) repair now appends via `push` instead of rewriting via `setMessages`, so per-message debug labels survive — verified better, and tested below; (b) the reverse for-loop becomes `findLastIndex` (already used at `prompt.ts:1246`); (c) the `Set` of answered ids becomes an array per CLAUDE.md, decided consciously since the function is being rewritten.

- [ ] **Step 1: Write the failing tests**

Append to `lib/runtime/threadRepair.test.ts` (the file already has the `asst`/`tool`/`roles` builders; add `unansweredToolCalls` to the import from `./threadRepair.js`):

```ts
describe("unansweredToolCalls", () => {
  it("returns only the trailing assistant turn's unanswered calls", () => {
    const t = new MessageThread([
      smoltalk.userMessage("go"),
      asst("", [{ id: "x", name: "f" }]),
      tool("x"),
      asst("", [
        { id: "a", name: "whatIAmDoing" },
        { id: "b", name: "codeAgent" },
      ]),
      tool("a"),
    ]);
    expect(unansweredToolCalls(t).map((c) => c.id)).toEqual(["b"]);
  });

  it("ignores unanswered calls on EARLIER assistant turns — the contract is trailing-turn only", () => {
    const t = new MessageThread([
      smoltalk.userMessage("go"),
      asst("", [{ id: "old", name: "f" }]), // never answered, but not trailing
      asst("", [{ id: "new", name: "f" }]),
    ]);
    expect(unansweredToolCalls(t).map((c) => c.id)).toEqual(["new"]);
  });

  it("trailing assistant with no tool calls (an ordinary reply) reports empty", () => {
    const t = new MessageThread([smoltalk.userMessage("hi"), asst("hello")]);
    expect(unansweredToolCalls(t)).toEqual([]);
  });

  it("valid tail and no-assistant threads both report empty", () => {
    const valid = new MessageThread([
      smoltalk.userMessage("go"),
      asst("", [{ id: "x", name: "f" }]),
      tool("x"),
    ]);
    expect(unansweredToolCalls(valid)).toEqual([]);
    expect(unansweredToolCalls(new MessageThread([smoltalk.userMessage("hi")]))).toEqual([]);
  });
});

describe("markThreadCancelled — label preservation (push, not setMessages)", () => {
  it("keeps per-message debug labels on the right messages and stays aligned", () => {
    const t = new MessageThread();
    t.push(smoltalk.userMessage("go"), "the-user-msg");
    t.push(asst("", [{ id: "y", name: "f" }]), "the-tool-round");
    markThreadCancelled(t);
    expect(t.labelAt(0)).toBe("the-user-msg");
    expect(t.labelAt(1)).toBe("the-tool-round");
    expect(roles(t)).toEqual(["user", "assistant", "tool", "assistant"]);
    // The alignment invariant messageThread.ts warns about: lengths match.
    expect(t.messageLabels.length).toBe(t.getMessages().length);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

```bash
pnpm test:run lib/runtime/threadRepair.test.ts 2>&1 | tee /tmp/orphan-t1.log
```

Expected: FAIL — `unansweredToolCalls` not exported; the label test fails because `setMessages` nulls the labels.

- [ ] **Step 3: Implement**

Replace the body of `lib/runtime/threadRepair.ts` below the imports and the `needsThreadRepair` block (which is untouched) with:

```ts
export type DanglingToolCall = { id: string; name: string };

/** The trailing assistant turn's tool calls that have no ToolMessage
 *  answering them — the only structurally invalid shape a mid-round stop
 *  can leave (every earlier round is complete, or the tool loop would not
 *  have advanced past it). Deliberately NOT a whole-thread validity check;
 *  do not reach for it as one. Empty when the tail is valid or there is
 *  no assistant turn at all. */
export function unansweredToolCalls(
  messages: MessageThread,
): DanglingToolCall[] {
  const all = messages.getMessages();
  const lastAssistant = all.findLastIndex(
    (m) => m instanceof smoltalk.AssistantMessage,
  );
  if (lastAssistant === -1) return [];
  const calls =
    (all[lastAssistant] as smoltalk.AssistantMessage).toolCalls ?? [];
  const answeredIds = all
    .slice(lastAssistant + 1)
    .filter(
      (m): m is smoltalk.ToolMessage => m instanceof smoltalk.ToolMessage,
    )
    .map((m) => m.tool_call_id);
  return calls.filter((c) => !answeredIds.includes(c.id));
}

function hasAssistantTurn(messages: MessageThread): boolean {
  return messages
    .getMessages()
    .some((m) => m instanceof smoltalk.AssistantMessage);
}

type RepairWording = { perCall: string; breadcrumb: string };

/** The one append procedure every repair shares: stub each dangling call,
 *  then leave a breadcrumb assistant message. Appends via `push`, so
 *  per-message debug labels on existing messages survive. Only the
 *  wording varies between repairs; the policy of WHEN to run lives in the
 *  named repair functions. */
function appendRepair(
  messages: MessageThread,
  dangling: DanglingToolCall[],
  wording: RepairWording,
): void {
  for (const call of dangling) {
    // Synthetic response — the model sees WHICH tool was cut off (not a
    // mysterious gap), AND the thread becomes structurally valid for the
    // next provider call, which requires a `tool` reply per `tool_call`.
    messages.push(
      smoltalk.toolMessage(wording.perCall, {
        tool_call_id: call.id,
        name: call.name,
      }),
    );
  }
  messages.push(smoltalk.assistantMessage(wording.breadcrumb));
}
```

Then rewrite `markThreadCancelled` keeping its existing doc comment, minus the sentence about the previous truncating implementation, plus: "Appends via `push`, so per-message debug labels survive. Returns the calls it stubbed (its sibling `repairAbandonedTurn` shares the contract)."

```ts
export function markThreadCancelled(
  messages: MessageThread,
): DanglingToolCall[] {
  if (!hasAssistantTurn(messages)) return []; // nothing sent yet — already valid
  const dangling = unansweredToolCalls(messages);
  appendRepair(messages, dangling, {
    perCall: "[Tool call cancelled before completion.]",
    breadcrumb: "[Response cancelled.]",
  });
  return dangling;
}
```

Note the policy difference this preserves: a user cancel leaves the `[Response cancelled.]` breadcrumb even when no call was dangling (any assistant turn suffices — same as today), which is why `hasAssistantTurn` is its gate rather than `dangling.length`.

In `lib/runtime/state/messageThread.ts`, edit the `messageLabels` doc comment: change "A rewrite via `setMessages` with no labels (summarization, repair) drops them; that is intended." to "A rewrite via `setMessages` with no labels (summarization) drops them; that is intended. (Thread repair appends via `push`, so it keeps them.)"

- [ ] **Step 4: Run to verify everything passes**

```bash
pnpm test:run lib/runtime/threadRepair.test.ts 2>&1 | tee /tmp/orphan-t1b.log
```

Expected: PASS, including the four pre-existing `markThreadCancelled` tests (`threadRepair.test.ts:20,30,51,74`) — they assert message shapes and are agnostic to push-vs-setMessages.

- [ ] **Step 5: Commit**

```bash
git add lib/runtime/threadRepair.ts lib/runtime/threadRepair.test.ts lib/runtime/state/messageThread.ts
git commit -m "refactor: shared scan and append core in threadRepair, labels now survive repair"
```

---

### Task 2: Repair generation on MessageThread — `markRepaired()` / `isNewerThan()`

The staleness invariant lives on the class that owns the value, not spread across four call sites. `repairs` is the stored number (it must be public for `toJSON`/`fromJSON`/`adoptFrom` and for the comparison), but the ONLY writers are `markRepaired()` and the serialization paths — the field's doc comment says so, and no other code assigns it.

**Files:**
- Modify: `lib/runtime/state/messageThread.ts`
- Test: `lib/runtime/state/messageThread.test.ts` (append — the file exists)

**Interfaces:**
- Produces on `MessageThread`:
  - `repairs: number` (default 0; serialized as optional `repairs?: number` on `MessageThreadJSON`, emitted only when > 0 per the `messageLabels` shape-preservation rule; copied by `adoptFrom`).
  - `markRepaired(): void` — the only mutation path; monotonic increment.
  - `isNewerThan(snapshot: MessageThread): boolean` — true when this thread has been repaired since `snapshot` was captured. Task 5 consumes this.

- [ ] **Step 1: Write the failing tests**

Append to `lib/runtime/state/messageThread.test.ts`:

```ts
describe("repair generation — markRepaired / isNewerThan", () => {
  it("defaults to 0 and stays out of JSON until incremented", () => {
    const t = new MessageThread([smoltalk.userMessage("hi")]);
    expect(t.repairs).toBe(0);
    expect("repairs" in t.toJSON()).toBe(false);
  });

  it("markRepaired is monotonic and round-trips through JSON", () => {
    const t = new MessageThread([smoltalk.userMessage("hi")]);
    t.markRepaired();
    t.markRepaired();
    expect(t.repairs).toBe(2);
    expect(MessageThread.fromJSON(t.toJSON()).repairs).toBe(2);
  });

  it("legacy JSON without the field revives as 0", () => {
    expect(MessageThread.fromJSON({ messages: [] }).repairs).toBe(0);
  });

  it("adoptFrom copies the counter with the content", () => {
    const a = new MessageThread();
    const b = new MessageThread([smoltalk.userMessage("hi")]);
    b.markRepaired();
    a.adoptFrom(b);
    expect(a.repairs).toBe(1);
  });

  it("isNewerThan orders live thread against a snapshot", () => {
    const live = new MessageThread();
    const snapshot = new MessageThread();
    expect(live.isNewerThan(snapshot)).toBe(false); // equal → restorable
    live.markRepaired();
    expect(live.isNewerThan(snapshot)).toBe(true); // repaired after → stale
    snapshot.markRepaired();
    expect(live.isNewerThan(snapshot)).toBe(false); // snapshot post-repair → fine
  });
});
```

If the file lacks a `smoltalk` import, add it.

- [ ] **Step 2: Run to verify they fail**

```bash
pnpm test:run lib/runtime/state/messageThread.test.ts 2>&1 | tee /tmp/orphan-t2.log
```

Expected: FAIL — no such members.

- [ ] **Step 3: Implement**

In `lib/runtime/state/messageThread.ts`:

Add to `MessageThreadJSON` (after `summary`):

```ts
  repairs?: number;
```

Add the field on the class (after `summary`):

```ts
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
```

Add the two methods (near `adoptFrom`):

```ts
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
```

In `toJSON()`, after the `messageLabels` block (same only-when-informative rule, so the serialized shape of never-repaired threads — checkpoints, statelog, fixtures — is unchanged):

```ts
    if (this.repairs > 0) {
      json.repairs = this.repairs;
    }
```

In `fromJSON()`: add `let _repairs = 0;` beside the other locals (matching the `_summary`/`_hidden` pattern the file already uses); inside the `"messages" in json` branch:

```ts
      if ("repairs" in json && typeof json.repairs === "number") {
        _repairs = json.repairs;
      }
```

and after `thread.summary = _summary;` add `thread.repairs = _repairs;`.

In `adoptFrom()` add `this.repairs = other.repairs;`.

- [ ] **Step 4: Run to verify it passes**

```bash
pnpm test:run lib/runtime/state/messageThread.test.ts lib/runtime/state/threadStore.test.ts 2>&1 | tee /tmp/orphan-t2b.log
```

Expected: PASS (threadStore tests confirm serialization consumers are unaffected).

- [ ] **Step 5: Commit**

```bash
git add lib/runtime/state/messageThread.ts lib/runtime/state/messageThread.test.ts
git commit -m "feat: repair generation counter on MessageThread with markRepaired and isNewerThan"
```

---

### Task 3: `repairAbandonedTurn` + `repairReopenedThread`

The abandoned-turn repair (new wording — nobody cancelled anything) and the seam-facing wrapper that owns the null check, the nothing-to-do check, and the statelog emission, so the runner stays one line (Task 4).

**Files:**
- Modify: `lib/runtime/threadRepair.ts`
- Test: `lib/runtime/threadRepair.test.ts`

**Interfaces:**
- Consumes: `appendRepair`/`unansweredToolCalls` (Task 1), `MessageThread.markRepaired` (Task 2).
- Produces:
  - `export const ABANDONED_CALL_TEXT = "[Tool call interrupted; the turn was never resumed.]"`
  - `export const ABANDONED_TURN_TEXT = "[The previous turn was interrupted before it finished.]"`
  - `export function repairAbandonedTurn(messages: MessageThread): DanglingToolCall[]` — total no-op returning `[]` on a valid thread; otherwise stubs + breadcrumb + `markRepaired()`.
  - `export type ThreadRepairedSink = { threadRepaired?: (event: { threadId: string; toolCallIds: string[] }) => Promise<void> | void }`
  - `export function repairReopenedThread(thread: MessageThread | undefined, statelog: ThreadRepairedSink | undefined, tid: string): void` — what `Runner.thread()` calls (Task 4). The full `StatelogClient` satisfies `ThreadRepairedSink` structurally once Task 4 adds the method.

- [ ] **Step 1: Write the failing tests**

Append to `lib/runtime/threadRepair.test.ts` (extend the import with the four new names):

```ts
describe("repairAbandonedTurn", () => {
  const damaged = () =>
    new MessageThread([
      smoltalk.userMessage("go"),
      asst("", [
        { id: "a", name: "whatIAmDoing" },
        { id: "b", name: "codeAgent" },
        { id: "c", name: "readDocs" },
      ]),
      tool("a"),
    ]);

  it("answers EVERY dangling call, appends the breadcrumb, bumps the generation", () => {
    const t = damaged();
    const repaired = repairAbandonedTurn(t);
    expect(repaired.map((c) => c.id)).toEqual(["b", "c"]);
    expect(roles(t)).toEqual(["user", "assistant", "tool", "tool", "tool", "assistant"]);
    const stubs = t
      .getMessages()
      .filter((m): m is smoltalk.ToolMessage => m instanceof smoltalk.ToolMessage);
    expect(stubs.map((m) => m.tool_call_id)).toEqual(["a", "b", "c"]);
    expect(stubs[1].content).toBe(ABANDONED_CALL_TEXT);
    expect((t.getMessages().at(-1) as smoltalk.AssistantMessage).content).toBe(
      ABANDONED_TURN_TEXT,
    );
    expect(t.repairs).toBe(1);
  });

  it("valid thread: byte-identical no-op, generation untouched", () => {
    const t = new MessageThread([
      smoltalk.userMessage("go"),
      asst("", [{ id: "x", name: "f" }]),
      tool("x"),
    ]);
    const before = JSON.stringify(t.toJSON());
    expect(repairAbandonedTurn(t)).toEqual([]);
    expect(JSON.stringify(t.toJSON())).toBe(before);
    expect(t.repairs).toBe(0);
  });

  it("repairing twice counts twice — the generation is a counter, not a flag", () => {
    const t = damaged();
    repairAbandonedTurn(t);
    t.push(asst("", [{ id: "z", name: "f" }])); // a second abandoned round
    repairAbandonedTurn(t);
    expect(t.repairs).toBe(2);
  });
});

describe("repairReopenedThread — the seam helper", () => {
  it("repairs and emits threadRepaired with the slugged id and the call ids", () => {
    const t = new MessageThread([
      smoltalk.userMessage("go"),
      asst("", [
        { id: "a", name: "whatIAmDoing" },
        { id: "b", name: "codeAgent" },
      ]),
      tool("a"),
    ]);
    const events: Array<{ threadId: string; toolCallIds: string[] }> = [];
    repairReopenedThread(t, { threadRepaired: (e) => { events.push(e); } }, "7");
    expect(events).toEqual([{ threadId: "t7", toolCallIds: ["b"] }]);
    expect(t.repairs).toBe(1);
  });

  it("healthy thread: NO event, no changes", () => {
    const t = new MessageThread([smoltalk.userMessage("hi"), asst("hello")]);
    const events: unknown[] = [];
    repairReopenedThread(t, { threadRepaired: (e) => { events.push(e); } }, "7");
    expect(events).toEqual([]);
    expect(t.repairs).toBe(0);
  });

  it("tolerates a missing thread and a missing statelog client", () => {
    expect(() => repairReopenedThread(undefined, undefined, "7")).not.toThrow();
  });
});
```

- [ ] **Step 2: Run to verify they fail**

```bash
pnpm test:run lib/runtime/threadRepair.test.ts 2>&1 | tee /tmp/orphan-t3.log
```

Expected: FAIL — not exported.

- [ ] **Step 3: Implement**

Add to `lib/runtime/threadRepair.ts`:

```ts
export const ABANDONED_CALL_TEXT =
  "[Tool call interrupted; the turn was never resumed.]";
export const ABANDONED_TURN_TEXT =
  "[The previous turn was interrupted before it finished.]";

/** Repair a thread whose previous turn parked on an unanswered interrupt
 *  and was then abandoned (the user started a new turn instead of
 *  answering). Distinct wording from `markThreadCancelled` on purpose:
 *  nobody cancelled anything, so the breadcrumb tells the next turn's
 *  model the work was interrupted — it can offer to pick it back up.
 *  Bumps the thread's repair generation so a late restore of the
 *  abandoned turn's checkpoint is refused instead of clobbering the
 *  thread — see `restoreThreadForResume`. Total no-op on a valid
 *  thread. */
export function repairAbandonedTurn(
  messages: MessageThread,
): DanglingToolCall[] {
  const dangling = unansweredToolCalls(messages);
  if (dangling.length === 0) return [];
  appendRepair(messages, dangling, {
    perCall: ABANDONED_CALL_TEXT,
    breadcrumb: ABANDONED_TURN_TEXT,
  });
  messages.markRepaired();
  return dangling;
}

export type ThreadRepairedSink = {
  threadRepaired?: (event: {
    threadId: string;
    toolCallIds: string[];
  }) => Promise<void> | void;
};

/** Everything the reopen seam needs, so `Runner.thread()` stays one line.
 *
 *  A reopen (session second+ entry, or `thread(continue: id)`) means the
 *  previous turn on this thread stopped mattering — at least for the
 *  REPL, where a parked turn blocks the loop, so a reopen implies
 *  abandonment. (Within a single run a reopen from a second step path is
 *  also possible; it is harmless here because a healthy in-run thread
 *  has no dangling tail.) If the abandoned turn parked mid-tool-round,
 *  the thread still ends on an assistant message with unanswered tool
 *  calls — a shape the provider rejects outright, which would otherwise
 *  poison every later request on this session.
 *
 *  Safe at the reopen seam and ONLY there: a checkpoint resume of a
 *  parked turn never reaches it — `Runner.thread()` guards the open side
 *  effect behind `frame.locals[threadKey]`, which is restored with the
 *  checkpoint, and `restoreBranchView` reinstates the active stack by
 *  direct assignment. If either mechanism changes, this repair would
 *  start firing mid-resume; the resume-re-entry test in runner.test.ts
 *  exists to catch exactly that. */
export function repairReopenedThread(
  thread: MessageThread | undefined,
  statelog: ThreadRepairedSink | undefined,
  tid: string,
): void {
  if (!thread) return;
  const repaired = repairAbandonedTurn(thread);
  if (repaired.length === 0) return;
  void statelog?.threadRepaired?.({
    threadId: `t${tid}`,
    toolCallIds: repaired.map((c) => c.id),
  });
}
```

- [ ] **Step 4: Run to verify it passes**

```bash
pnpm test:run lib/runtime/threadRepair.test.ts 2>&1 | tee /tmp/orphan-t3b.log
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/runtime/threadRepair.ts lib/runtime/threadRepair.test.ts
git commit -m "feat: repairAbandonedTurn and the reopen seam helper"
```

---

### Task 4: Wire the seam in Runner.thread + the statelog event

One line in the runner; the statelog method it emits through; tests that make the `isResumption` guard falsifiable.

**Files:**
- Modify: `lib/runtime/runner.ts` (first-execution else branch, before `this.frame.locals[threadKey] = tid;` at ~`runner.ts:706`)
- Modify: `lib/statelogClient.ts` (new method after `threadResumed`, ~line 1200)
- Modify: `lib/runtime/__tests__/testHelpers.ts` (add `threadRepaired: () => {}` to the statelogClient stub, beside `threadResumed`)
- Test: `lib/runtime/runner.test.ts` (append)

Note: `lib/eval/types.ts` and `lib/eval/normalize.ts` mention `threadResumed` only in prose comments — verified; they need NO change.

**Interfaces:**
- Consumes: `repairReopenedThread` (Task 3).
- Produces: statelog event `{ type: "threadRepaired", threadId, toolCallIds }`. The un-awaited `?.` call matches the existing precedent at `runner.ts:792` (`threadEndHookError`).

- [ ] **Step 1: Write the failing tests**

Append to `lib/runtime/runner.test.ts`. Add imports: `import * as smoltalk from "smoltalk";`, `import { ABANDONED_TURN_TEXT } from "./threadRepair.js";`, and `import type { MessageThread } from "./state/messageThread.js";` (`Runner`, `ThreadStore`, `State`, `makeFrame`, `makeMockCtx` are already imported). The existing `thread()` tests use the stubbed `ctx.threads`; these use a real `ThreadStore` passed via opts, which takes precedence.

```ts
describe("thread() — abandoned-turn repair on reopen", () => {
  // The shape a parked-then-abandoned turn leaves behind: trailing
  // assistant with two tool calls, only one answered. Mirrors the trace
  // in the orphaned-tool-use design doc.
  const damage = (t: MessageThread) => {
    t.push(smoltalk.userMessage("go"));
    t.push(
      smoltalk.assistantMessage("", {
        toolCalls: [
          { id: "a", name: "whatIAmDoing", arguments: {} },
          { id: "b", name: "codeAgent", arguments: {} },
        ],
      }),
    );
    t.push(smoltalk.toolMessage("ok", { tool_call_id: "a", name: "whatIAmDoing" }));
  };

  // One thread() entry with its own fresh frame — the shape of a NEW
  // turn. Returns the opened thread id.
  async function openFresh(
    threads: ThreadStore,
    opts: Record<string, unknown>,
  ): Promise<string> {
    let tid = "";
    const runner = new Runner(makeMockCtx(), makeFrame(), { threads });
    await runner.thread(0, "create", opts, async () => {
      tid = threads.activeId()!;
    });
    return tid;
  }

  it("session reopen repairs the dangling tail before new work lands", async () => {
    const threads = new ThreadStore();
    const tid = await openFresh(threads, { session: "main" });
    damage(threads.get(tid)!);

    await openFresh(threads, { session: "main" });

    const thread = threads.get(tid)!;
    const toolIds = thread
      .getMessages()
      .filter((m): m is smoltalk.ToolMessage => m instanceof smoltalk.ToolMessage)
      .map((m) => m.tool_call_id);
    expect(toolIds).toEqual(["a", "b"]);
    expect((thread.getMessages().at(-1) as smoltalk.AssistantMessage).content).toBe(
      ABANDONED_TURN_TEXT,
    );
    expect(thread.repairs).toBe(1);
  });

  it("thread(continue: id) reopen repairs too", async () => {
    const threads = new ThreadStore();
    const tid = await openFresh(threads, {});
    damage(threads.get(tid)!);

    await openFresh(threads, { continueId: tid });

    expect(threads.get(tid)!.repairs).toBe(1);
  });

  it("valid thread reopens byte-identical, generation stays 0", async () => {
    const threads = new ThreadStore();
    const tid = await openFresh(threads, { session: "main" });
    const thread = threads.get(tid)!;
    thread.push(smoltalk.userMessage("hi"));
    thread.push(smoltalk.assistantMessage("hello"));
    const before = JSON.stringify(thread.toJSON());

    await openFresh(threads, { session: "main" });

    expect(JSON.stringify(thread.toJSON())).toBe(before);
    expect(thread.repairs).toBe(0);
  });

  it("a checkpoint-resume re-entry does NOT repair — the frame-locals guard is load-bearing", async () => {
    const threads = new ThreadStore();
    const frame = makeFrame();
    let tid = "";
    const r1 = new Runner(makeMockCtx(), frame, { threads });
    await r1.thread(0, "create", { session: "main" }, async () => {
      tid = threads.activeId()!;
    });
    damage(threads.get(tid)!);

    // Resume shape: locals carried over (they hold __thread_<path>), step
    // counter back at the re-executing step — thread() re-enters its body
    // WITHOUT re-running the open side effect, so no repair may fire.
    const resumedFrame = new State({ args: {}, locals: { ...frame.locals }, step: 0 });
    let reEntered = false;
    const r2 = new Runner(makeMockCtx(), resumedFrame, { threads });
    await r2.thread(0, "create", { session: "main" }, async () => {
      reEntered = true;
    });

    expect(reEntered).toBe(true); // proves we exercised the guard branch, not a step skip
    expect(threads.get(tid)!.repairs).toBe(0);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

```bash
pnpm test:run lib/runtime/runner.test.ts 2>&1 | tee /tmp/orphan-t4.log
```

Expected: the first two tests FAIL (`repairs` stays 0); the last two may already pass — that is fine, they exist to go red under a *wrong* Step 4 (repair-on-every-open, or repair-on-resume).

- [ ] **Step 3: Implement the statelog event**

In `lib/statelogClient.ts`, directly after `threadResumed` (~line 1200):

```ts
  /** Fired when a reopened thread (session second+ entry or
   *  `thread(continue: id)`) was found structurally invalid — its trailing
   *  assistant message had tool calls with no results — and
   *  `repairAbandonedTurn` synthesized the missing results before new work
   *  was appended. A repair means a previous turn parked on an interrupt
   *  and was abandoned; that is worth being able to find in a trace. */
  async threadRepaired({
    threadId,
    toolCallIds,
  }: {
    threadId: string;
    toolCallIds: string[];
  }): Promise<void> {
    await this.post({
      type: "threadRepaired",
      threadId,
      toolCallIds,
    });
  }
```

In `lib/runtime/__tests__/testHelpers.ts`, add `threadRepaired: () => {},` to the statelogClient stub beside `threadResumed: () => {},`.

- [ ] **Step 4: Implement the seam**

In `lib/runtime/runner.ts`, add to the imports: `import { repairReopenedThread } from "./threadRepair.js";`

Inside `thread()`, in the first-execution `else` branch, immediately before `this.frame.locals[threadKey] = tid;` (~line 706):

```ts
      if (isResumption) {
        // Reopened threads are repaired before new work lands; a
        // checkpoint resume never reaches this branch (the frame-locals
        // guard above skips the whole open side effect). The full safety
        // argument lives on repairReopenedThread.
        repairReopenedThread(threads.get(tid), this.ctx.statelogClient, tid);
      }
```

- [ ] **Step 5: Run to verify everything passes**

```bash
pnpm test:run lib/runtime/runner.test.ts lib/runtime/threadRepair.test.ts lib/runtime/state/threadStore.test.ts 2>&1 | tee /tmp/orphan-t4b.log
```

Expected: PASS across all three files.

- [ ] **Step 6: Commit**

```bash
git add lib/runtime/runner.ts lib/statelogClient.ts lib/runtime/__tests__/testHelpers.ts lib/runtime/runner.test.ts
git commit -m "feat: repair abandoned dangling tool calls when a thread is reopened"
```

---

### Task 5: `restoreThreadForResume` — the stale-checkpoint refusal, wired and ordered

The restore block in `prompt.ts` becomes a call to one testable helper that owns BOTH hazards the review flagged: the staleness check being wired at all, and the check running *before* `adoptFrom` (which copies the snapshot's generation onto the live thread — one line of reordering would silently disarm the guard forever; inside the helper, that ordering is asserted by tests instead of by hope).

**Files:**
- Modify: `lib/runtime/threadRepair.ts`
- Modify: `lib/runtime/prompt.ts` (restore block at ~1052 on current main; #653/#655 shifted it down a few lines)
- Test: `lib/runtime/threadRepair.test.ts`

**Interfaces:**
- Consumes: `MessageThread.isNewerThan` (Task 2).
- Produces: `export function restoreThreadForResume(snapshot: MessageThreadJSON | smoltalk.MessageJSON[], live: MessageThread | undefined): MessageThread`. Import `MessageThreadJSON` as a type from `./state/messageThread.js`.

- [ ] **Step 1: Write the failing tests**

Append to `lib/runtime/threadRepair.test.ts`:

```ts
describe("restoreThreadForResume", () => {
  it("adopts into the live thread and preserves the alias", () => {
    const live = new MessageThread([smoltalk.userMessage("hi")]);
    const out = restoreThreadForResume(live.toJSON(), live);
    expect(out).toBe(live); // same object — the caller's alias survives
    expect(roles(out)).toEqual(["user"]);
  });

  it("no live thread: revives the snapshot", () => {
    const snap = new MessageThread([smoltalk.userMessage("hi")]).toJSON();
    expect(roles(restoreThreadForResume(snap, undefined))).toEqual(["user"]);
  });

  it("refuses a snapshot taken before a repair", () => {
    const live = new MessageThread([smoltalk.userMessage("hi")]);
    const snap = live.toJSON(); // generation 0
    live.markRepaired();
    expect(() => restoreThreadForResume(snap, live)).toThrow(
      /repaired after this checkpoint/,
    );
    expect(live.repairs).toBe(1); // refusal must not have adopted anything
  });

  it("legacy bare-array snapshots (implicit generation 0) are refused after a repair", () => {
    const live = new MessageThread([smoltalk.userMessage("hi")]);
    live.markRepaired();
    const legacy = [smoltalk.userMessage("hi").toJSON()];
    expect(() => restoreThreadForResume(legacy, live)).toThrow(
      /repaired after this checkpoint/,
    );
  });

  it("a snapshot taken AFTER the repair restores fine", () => {
    const live = new MessageThread([smoltalk.userMessage("hi")]);
    live.markRepaired();
    expect(restoreThreadForResume(live.toJSON(), live)).toBe(live);
  });
});
```

The third test's final assertion is the ordering guard: if the implementation adopted before checking, `live.repairs` would have been overwritten to 0 and no throw would occur — so a mis-ordered implementation fails this test twice over.

- [ ] **Step 2: Run to verify they fail**

```bash
pnpm test:run lib/runtime/threadRepair.test.ts 2>&1 | tee /tmp/orphan-t5.log
```

Expected: FAIL — not exported.

- [ ] **Step 3: Implement**

Add to `lib/runtime/threadRepair.ts` (extend the type import from `./state/messageThread.js` with `MessageThreadJSON`):

```ts
/** Rebuild the message thread when resuming from a checkpoint.
 *
 *  On resume the caller's `live` thread must stay ALIASED — mutations
 *  during the resumed run (tool responses, the final assistant message)
 *  must propagate to every other holder of the thread. So the restored
 *  JSON is written INTO `live` via `adoptFrom` rather than swapping in a
 *  fresh object (and adoptFrom, not setMessages: setMessages takes only
 *  the messages and would drop the labels fromJSON just restored). On a
 *  normal resume this is a no-op overwrite: both sides were captured in
 *  the same checkpoint.
 *
 *  The exception is a checkpoint that predates a repair of the live
 *  thread. Once `repairAbandonedTurn` has run, the parked turn that took
 *  this snapshot was abandoned and newer turns may exist; restoring would
 *  overwrite all of it. Refusing loudly is correct. The generation check
 *  MUST run before `adoptFrom` — adoptFrom copies the snapshot's (lower)
 *  generation onto the live thread, so checking after would always pass.
 *  The ordering is pinned by tests. */
export function restoreThreadForResume(
  snapshot: MessageThreadJSON | smoltalk.MessageJSON[],
  live: MessageThread | undefined,
): MessageThread {
  const restored = MessageThread.fromJSON(snapshot);
  if (!live) return restored;
  if (live.isNewerThan(restored)) {
    const msg =
      "Cannot resume this turn: its conversation thread was repaired after " +
      "this checkpoint was taken (the parked turn was abandoned and newer " +
      "turns have run since). Restoring would overwrite the newer " +
      "conversation, so it is refused.";
    // Best-effort statelog BEFORE the throw: a throw converts to a Failure
    // at the next def boundary, and Failures can get laundered into prose
    // by the time a model or user sees them — the refusal must stay
    // findable in the trace regardless. Same rationale and shape as
    // claimFrameForScope in state/stateStack.ts.
    agencyStore.getStore()?.ctx?.statelogClient?.error?.({
      errorType: "runtimeError",
      message: msg,
      functionName: "restoreThreadForResume",
    });
    throw new Error(msg);
  }
  live.adoptFrom(restored);
  return live;
}
```

Add the import: `import { agencyStore } from "./asyncContext.js";` — this mirrors `claimFrameForScope` (`lib/runtime/state/stateStack.ts:348` on main), which emits through the same ALS chain before its own throw. The Task 5 tests need no change: they run outside any `agencyStore` frame, so the optional chain is a no-op and the throw still fires.

Note `MessageThread` is currently a type-only import in this file (`import type`); it is now used as a value (`fromJSON`), so change it to a regular import.

In `lib/runtime/prompt.ts`, add `restoreThreadForResume` to the import from `./threadRepair.js`, and replace the restore branch:

```ts
  let messages: MessageThread;
  if (self.messagesJSON) {
    messages = restoreThreadForResume(self.messagesJSON, args.messages);
  } else if (clientConfig.messages) {
```

Trim the big alias comment above it (~1026-1040) to a pointer — the explanation now lives on the helper: keep the first paragraph ("On resume we need `messages` to stay aliased…sees a stale snapshot from the original interrupt time") and replace the rest with "See restoreThreadForResume for how the alias is preserved and when a restore is refused."

- [ ] **Step 4: Run to verify it passes, then prove normal resumes still work**

```bash
pnpm test:run lib/runtime/threadRepair.test.ts 2>&1 | tee /tmp/orphan-t5b.log
make 2>&1 | tail -5
pnpm run agency test tests/agency/guards/turn-budget-partial.agency 2>&1 | tee /tmp/orphan-t5c.log
```

Expected: unit tests PASS; both turn-budget-partial cases PASS — the approve case drives a real checkpoint resume through the new helper with equal generations.

- [ ] **Step 5: Commit**

```bash
git add lib/runtime/threadRepair.ts lib/runtime/threadRepair.test.ts lib/runtime/prompt.ts
git commit -m "feat: refuse restoring checkpoints that predate a thread repair"
```

---

### Task 6: Label the inner stdlib guards

Labels exist so the Task 7 stop notice (and any future prompt) can name the budget that ran out instead of saying "a subagent". Nothing gates on them — Task 7 rejects every non-turn-budget guard regardless — so this task is small and purely about message quality. It runs before Task 7 so the notice has real labels while Task 7 is being tested by hand.

**Files:** all 14 unlabeled `guard(` call sites in the stdlib agents (verified count):

```
stdlib/agents/coding.agency:125       stdlib/agents/agency/expert.agency:80
stdlib/agents/data.agency:131         stdlib/agents/agency/review.agency:124
stdlib/agents/expert.agency:92        stdlib/agents/agency/coding.agency:275
stdlib/agents/explorer.agency:180     stdlib/agents/agency/researcher.agency:90
stdlib/agents/oracle.agency:153       stdlib/agents/agency/verifier.agency:120
stdlib/agents/researcher.agency:135
stdlib/agents/verifier.agency:92
stdlib/agents/planner.agency:249
stdlib/agents/review.agency:93
```

- [ ] **Step 1: Add labels**

Rule: the label is the **exported agent function's name** (e.g. `expertAgent`, `agencyExpertAgent`), NOT the name of whatever helper the `guard(` happens to sit in — several of these guards live inside private helpers, so open each file and find the exported entry point it serves. Example, `stdlib/agents/expert.agency:92`:

```agency
  return guard(cost: maxCost, time: maxTime, label: "expertAgent") {
```

Re-run the verification grep afterward; it must come back empty:

```bash
grep -rn "guard(" stdlib/agents/*.agency stdlib/agents/agency/*.agency | grep -v "label:" | grep -v "_guard"
```

- [ ] **Step 2: Rebuild and sanity-check**

```bash
make 2>&1 | tail -3
pnpm run agency test tests/agency/agents/expert.agency 2>&1 | tee /tmp/orphan-t6.log
```

Expected: build clean; expert agent tests pass.

- [ ] **Step 3: Commit**

```bash
git add stdlib/agents/
git commit -m "feat: label the inner stdlib agent guards so budget notices can name them"
```

---

### Task 7: turnBudgetHandler answers unowned guard trips

The catch-all (see "Decisions" above for why reject-always and why `_lastPartial` stays untouched). The fixture tests the REAL handler — nothing does today; `turn-budget-partial.agency` uses a hand-written imitation.

**Files:**
- Modify: `lib/agents/agency-agent/lib/budget.agency` (`turnBudgetHandler` ~line 136, its docstring, and the module docstring at ~line 13)
- Create: `tests/agency/guards/unowned-guard-rejected.agency`
- Create: `tests/agency/guards/unowned-guard-rejected.test.json`

**Interfaces:**
- Produces: `turnBudgetHandler` now answers ALL `std::guard` interrupts — its own label as before, every other with `reject()` plus an interactive notice. Non-guard interrupts still `pass()`.

- [ ] **Step 1: Write the failing fixture**

`tests/agency/guards/unowned-guard-rejected.agency`:

```agency
// turnBudgetHandler used to pass foreign std::guard trips through, and
// since nothing above it answers guards, an unlabeled inner guard parked
// the turn forever (the orphaned tool_use incident). Now a foreign trip is
// rejected: the budget is a hard stop, the trip converts to a Failure at
// the guard site, and the caller salvages like any other guard failure.
// These tests drive the REAL handler — turn-budget-partial.agency only
// imitates it.
import test { _advanceTime } from "std::date"
import { turnBudgetHandler, TURN_BUDGET_LABEL } from "../../../lib/agents/agency-agent/lib/budget.agency"

// Stands in for a subagent body that saves a partial, then overruns its
// budget. The finalize-as-draft salvage mirrors
// tests/agency/guards/finalize-binder-returns-draft.agency, where a
// REJECTED guard trip returns success carrying the finalize value.
def workWithSalvage(): string {
  saveDraft("PARTIAL")
  _advanceTime(20000)
  return "FULL"

  finalize as draft {
    if (draft != null) {
      return draft
    }
    return "no-draft"
  }
}

def workBare(): string {
  _advanceTime(20000)
  return "FULL"
}

def innerWithSalvage(): Result<string> {
  return guard(cost: $5, time: 10s, label: "expertAgent") {
    return workWithSalvage()
  }
}

def innerBare(): Result<string> {
  return guard(cost: $5, time: 10s, label: "oracleAgent") {
    return workBare()
  }
}

// Foreign label + salvage: reject converts the trip to a Failure at the
// guard site, where finalize-as-draft turns it into a success carrying
// the partial. This is the claim "salvage still runs", demonstrated.
node foreignGuardSalvage() {
  handle {
    const r = innerWithSalvage()
    if (r is success(v)) {
      return "salvaged:${v}"
    }
    return "no-salvage"
  } with turnBudgetHandler
}

// Foreign label, no salvage: a plain Failure the caller can match on.
node foreignGuardBare() {
  handle {
    const r = innerBare()
    return "failure:${isFailure(r)}"
  } with turnBudgetHandler
}

// The handler's OWN label still takes the reject path under the test
// runner (isInteractive() is false), proving the label match is intact.
node ownLabelReject() {
  handle {
    const r = guard(time: 50ms, label: TURN_BUDGET_LABEL) {
      return workBare()
    }
    return "failure:${isFailure(r)}"
  } with turnBudgetHandler
}

// Non-guard interrupts must still pass through to whoever is outside —
// here, the test harness resolves it. Getting the early-return split
// wrong would make the agent reject tool approvals, which would be far
// worse than the bug being fixed.
node nonGuardPassthrough() {
  handle {
    const r = interrupt("confirm")
    return "resolved"
  } with turnBudgetHandler
}
```

`tests/agency/guards/unowned-guard-rejected.test.json`:

```json
{
  "tests": [
    {
      "nodeName": "foreignGuardSalvage",
      "fakeClock": true,
      "description": "A foreign std::guard trip is rejected by turnBudgetHandler; the inner guard's finalize-as-draft salvage turns the Failure into a success carrying the saved partial.",
      "input": "",
      "expectedOutput": "\"salvaged:PARTIAL\"",
      "evaluationCriteria": [{ "type": "exact" }],
      "interruptHandlers": [],
      "llmMocks": []
    },
    {
      "nodeName": "foreignGuardBare",
      "fakeClock": true,
      "description": "A foreign std::guard trip with no salvage is rejected into a plain Failure instead of parking the turn.",
      "input": "",
      "expectedOutput": "\"failure:true\"",
      "evaluationCriteria": [{ "type": "exact" }],
      "interruptHandlers": [],
      "llmMocks": []
    },
    {
      "nodeName": "ownLabelReject",
      "fakeClock": true,
      "description": "The turn-budget label still routes through the handler's own path: non-interactive runs honor the budget as a hard stop.",
      "input": "",
      "expectedOutput": "\"failure:true\"",
      "evaluationCriteria": [{ "type": "exact" }],
      "interruptHandlers": [],
      "llmMocks": []
    },
    {
      "nodeName": "nonGuardPassthrough",
      "fakeClock": true,
      "description": "Non-guard interrupts pass through turnBudgetHandler to the outer resolver.",
      "input": "",
      "expectedOutput": "\"resolved\"",
      "evaluationCriteria": [{ "type": "exact" }],
      "interruptHandlers": [{ "action": "approve", "expectedMessage": "confirm" }],
      "llmMocks": []
    }
  ]
}
```

- [ ] **Step 2: Run to verify the fixture fails for the right reason**

```bash
make 2>&1 | tail -3
pnpm run agency test tests/agency/guards/unowned-guard-rejected.agency 2>&1 | tee /tmp/orphan-t7.log
```

Expected: `foreignGuardSalvage` and `foreignGuardBare` FAIL (the current `pass()` leaves the trip unanswered, so those runs halt on an unresolved interrupt); `ownLabelReject` and `nonGuardPassthrough` already PASS (they cover current behavior that must not regress). Troubleshooting, in order: an import error on the agent lib means checking `pnpm run ast` on the fixture (precedent: `tests/agency/agents/routing.agency` imports `../../../lib/agents/agency-agent/subagents/code.agency`); a trip that never fires means the step-boundary shape is off — mirror `turn-budget-partial.agency`, which advances the clock inside a called function.

- [ ] **Step 3: Implement**

In `lib/agents/agency-agent/lib/budget.agency`, replace the opening check of `turnBudgetHandler`:

```agency
  if (intr.effect != "std::guard" || intr.data.label != TURN_BUDGET_LABEL) {
    return pass()
  }
```

with:

```agency
  if (intr.effect != "std::guard") {
    return pass()
  }
  if (intr.data.label != TURN_BUDGET_LABEL) {
    // A guard trip that reaches this handler has no owner: handlers below
    // us had their chance, and nothing above us answers guards. Passing
    // would park the whole turn at a checkpoint nobody will ever resume
    // (the orphaned tool_use incident, 2026-07-22 design doc). Honor the
    // budget as a hard stop: reject converts the trip to a Failure at the
    // guard site, where the caller salvages via finalize or draftValue.
    // _lastPartial is deliberately NOT set here — that slot is the
    // TURN's best-so-far for runTurn to show when the turn stops, and
    // this turn is continuing; the inner guard's own salvage carries its
    // partial back through the Result.
    if (isInteractive()) {
      const who = intr.data.label ?? "a subagent"
      print(color.yellow(
        "⏳ The ${intr.data.dimension} budget for ${who} ran out; stopping that step with its best result so far.",
      ))
    }
    return reject()
  }
```

Update the function docstring's second sentence to:

```
  Answers every guard trip that reaches it: this turn's trip (matched by
  label) can be granted more budget; any other guard trip has no owner by
  the time it gets here and is rejected, so the budget is a hard stop
  instead of a question nobody answers. Non-guard interrupts pass through
  to the policy handler.
```

Update the module docstring (~line 13-15), which still says the handler only "asks the user whether to grant more, and either extends the guard in place or stops" — add that it also rejects foreign guard trips as hard stops.

If the build reports `print` or `color` unresolved in this module (both should arrive via the std::index prelude — `color.yellow` is already used at ~line 164), add the missing import rather than assuming.

- [ ] **Step 4: Rebuild and verify all four cases plus the imitation fixture**

```bash
make 2>&1 | tail -3
pnpm run agency test tests/agency/guards/unowned-guard-rejected.agency 2>&1 | tee /tmp/orphan-t7b.log
pnpm run agency test tests/agency/guards/turn-budget-partial.agency 2>&1 | tee /tmp/orphan-t7c.log
```

Expected: all four new cases PASS; turn-budget-partial still PASSES (it exercises the guard/salvage machinery the handler sits on).

- [ ] **Step 5: Commit**

```bash
git add lib/agents/agency-agent/lib/budget.agency tests/agency/guards/unowned-guard-rejected.agency tests/agency/guards/unowned-guard-rejected.test.json
git commit -m "feat: turnBudgetHandler rejects unowned guard trips instead of parking the turn"
```

If the test runner generated a checked-in `.js` sibling for the new fixture, add that too.

---

### Task 8: Docs, self-audit, PR

**Files:**
- Modify: `docs/dev/threads.md`
- Modify: `docs/dev/checkpointing.md`

- [ ] **Step 1: Document the reopen repair in docs/dev/threads.md**

Add a section (near wherever sessions/`resumeExisting` are described):

```markdown
## Reopen repair: abandoned turns cannot poison a session

A turn that parks on an unanswered interrupt leaves its thread ending on an
assistant message with unanswered tool calls. If the turn is resumed, the
gap closes naturally. If it is abandoned — the user starts a new turn on
the same session instead of answering — the gap would make the provider
reject every later request (`tool_use` ids without `tool_result` blocks),
killing the session permanently.

So reopening a thread for new work repairs it first. The seam is the
first-execution branch of `Runner.thread()`: on a `session:` second+ entry
or a `thread(continue: id)`, `repairReopenedThread`
(`lib/runtime/threadRepair.ts`) appends a synthetic tool result per
dangling call plus a breadcrumb assistant message, and fires a
`threadRepaired` statelog event. A checkpoint resume never travels through
that branch (the frame-locals guard skips the open side effect), so repair
cannot fire while a parked turn can still be resumed.

Each repair advances the thread's generation (`MessageThread.markRepaired`).
The prompt restore path (`restoreThreadForResume`) refuses a checkpoint
taken before a repair — a late answer to an abandoned turn would otherwise
overwrite the repaired thread and every newer turn, because the restore
writes the snapshot INTO the live aliased thread.

Design history: `docs/superpowers/specs/2026-07-22-orphaned-tool-use-on-guard-abort-design.md`.
```

- [ ] **Step 2: Add the stale-restore note to docs/dev/checkpointing.md**

One paragraph in the restore-semantics area:

```markdown
A checkpoint whose thread has since been repaired (see "Reopen repair" in
threads.md) is stale: `restoreThreadForResume` throws rather than letting
the old snapshot overwrite the repaired thread. `MessageThread.repairs` is
the generation both sides compare; `markRepaired()` is its only writer.
```

- [ ] **Step 3: Full unit run + anti-pattern audit**

```bash
pnpm test:run 2>&1 | tee /tmp/orphan-final-tests.log
pnpm run lint:structure 2>&1 | tee /tmp/orphan-lint.log
```

Expected: PASS / clean. Then audit the whole diff against `docs/dev/anti-patterns.md` and `docs/dev/coding-standards.md` (`git diff main --stat` for the file list, then read each hunk). In particular: no narrating comments, no module-global per-run state, one copy of every procedure (the repair append loop must exist exactly once).

- [ ] **Step 4: Commit docs, push, open the PR**

```bash
git add docs/dev/threads.md docs/dev/checkpointing.md
git commit -m "docs: reopen repair and stale-checkpoint refusal"
git push -u origin adit/orphaned-tool-use-repair
```

PR body content for `/tmp/orphan-pr-body.md` (write the file, then `gh pr create --title "Repair abandoned dangling tool calls on thread reopen" --body-file /tmp/orphan-pr-body.md`):

```markdown
A turn that parks on an unanswered guard trip and is then abandoned left its
session thread ending on an assistant message with unanswered tool calls.
The provider rejects every later request on that thread with a 400, so one
abandoned turn destroyed the whole session (see the trace in
docs/superpowers/specs/2026-07-22-orphaned-tool-use-on-guard-abort-design.md).

This PR:
- restructures threadRepair.ts around one shared scan (unansweredToolCalls)
  and one shared append procedure; per-message debug labels now survive
  repair
- adds repairAbandonedTurn, which synthesizes results for dangling calls
  with wording that tells the next model the turn was interrupted, and
  repairReopenedThread, which Runner.thread() calls in one line on every
  reopen (session second+ entry and thread(continue: id); checkpoint
  resumes provably skip the branch, and a test pins that)
- gives MessageThread a repair generation (markRepaired/isNewerThan) and a
  restoreThreadForResume helper that refuses restoring a checkpoint taken
  before a repair, so a late answer to an abandoned turn fails loudly
  instead of silently overwriting newer conversation
- makes turnBudgetHandler reject unowned std::guard trips instead of
  passing them into a park nobody will resume, with the first real test
  coverage of that handler (foreign-guard salvage, bare failure, own-label
  reject, non-guard pass-through), and labels the 14 inner stdlib guards so
  stop notices can name the budget that ran out

The existing user-cancel repair policy (needsThreadRepair) is deliberately
unchanged; the new rule is separate: a thread must be valid before new work
is appended to it.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
```

---

## Execution notes for the implementer

- Tasks 1→5 are strictly ordered (each consumes the previous). Tasks 6–7 are independent of 1–5; Task 6 goes before Task 7 so the stop notice has real labels during manual testing. They ship in the same PR because the same incident motivated them.
- Guard-trip tests must run via `pnpm run agency test <file>` (the test runner drives fake-clock guard trips; `pnpm run agency <file>` cannot).
- If anything in this plan contradicts what you find in the code, stop and re-read the spec and the review — both cite line numbers verified on 2026-07-22.
