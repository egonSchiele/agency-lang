# Session Transcript Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A reopened session shows what the user typed and what the agent replied, and nothing else.

**Architecture:** The session core records each turn in a list of its own: the text the user typed, then the reply. The list is kept in the run's globals, so every checkpoint saves it and every restore brings it back. `_readTranscript` shows that list. The conversation thread the model reads is not changed.

**Tech Stack:** TypeScript stdlib helpers (`lib/stdlib`), the agent driver (`lib/stdlib/agentDriver`), the session core (`lib/agents/agency-agent`), vitest, the `session-core` agency-js test.

**Spec:** this plan. It replaces `2026-11-21-hidden-messages.md`. The reasons are in `2026-11-21-hidden-messages-architecture-review.md`, under "Alternative B".

## Background

### How a transcript is built today

When you reopen a session, the terminal prints the saved conversation. Perry does the same when a client opens a restored session. The `searchSessions` tool reads the same text. All three call one function:

```ts
// lib/stdlib/agentSessions.ts
export function _readTranscript(checkpointJson: unknown, threadId: string): TranscriptMessage[]
```

It opens the saved checkpoint, finds the conversation thread, and returns every user and assistant message that has text.

That thread is the list of messages the model reads. It was not written for a person. It holds user-role messages the user never typed:

1. The cancel note. After a cancel, the driver's `withCancelNote` puts a sentence such as `(The user cancelled their previous request, "do x", partway through. …)` in front of the next message.
2. Notes. The core's `withPendingNotes` puts a `!` command's output, or an image's path, above the message.
3. The project block. `withProjectContextIfMoved` puts the whole block in front of the message after a coder moved the working directory.
4. A slash command's expanded prompt, in place of the `/cmd` the user typed.
5. A subagent's prompt, with a `<context>` block after the task.
6. The runtime's own messages: handoff markers, guard feedback, the round warning, validation feedback.
7. The compaction summary.

A reopened session draws each of these as a `>` line, as if the user had said it.

The assistant side has the same problem. After a model calls a subagent, the subagent's messages stay on the thread. A reopened session shows them as replies. The live view showed only the final reply.

### What the live view shows

The terminal draws two things for a turn. It draws the text the user typed with `renderUserLine(text)`. It draws the reply when the core emits `session.reply`. A reopened session should show the same two things.

### What the session core knows

One place has both values. The `message` arm in `lib/agents/agency-agent/core.agency` receives the answer:

```
{ kind: "message", text, notes, target } => {
```

`text` is what the user typed, with one exception described below. After the turn the core has the reply, and emits it:

```
emit({ type: "session.reply", text: replyText })
```

So the core can write both down as they happen. Nothing has to be worked out later from the thread.

The exception is the cancel note. The driver joins it onto the front of `text` before the answer reaches the core (`submit` in `lib/stdlib/agentDriver/machine.ts`). Task 2 moves the note into `notes`, so `text` is the typed text alone.

### Where the list is kept

A run has a globals store. The store is saved in every checkpoint and set back on every restore. The fetch cache already keeps its state there, in a module of its own named `__fetchCache` (`lib/runtime/fetchCache.ts`). The transcript uses the same pattern, in a module named `__agentTranscript`.

Keeping the list in the checkpoint gives three behaviours with no extra code:

- **Cancel.** A cancelled turn goes back to the checkpoint from before the turn. The entry for that turn was added after that checkpoint, so it is gone, as the turn's messages are.
- **Resume in another process.** A turn that paused on an approval has its user entry in the approval's checkpoint. A resume does not run the statement that added it again, so the entry is there once.
- **`/fork`.** A fork copies the checkpoint, so it copies the list.

The module name is spelled in one TypeScript file, which both writes and reads the list. A `let` global in an Agency file would not work as well. Its key in a checkpoint is the file's build path, such as `dist/lib/agents/agency-agent/lib/record.agency`, and a reader in TypeScript would break when that file moved.

## Decisions

- **The list holds the typed text and the final reply.** That is what the live view draws. It does not hold text the model wrote before a tool call.
- **`_readTranscript` keeps its signature.** It returns the list when the checkpoint has one. Otherwise it reads the thread, as today. The terminal, Perry and session search need no change.
- **A session saved before this change keeps its history.** The first entry added to a run with no list starts the list from the thread's messages, using today's reader. From then on only the core adds to it. Without this, a session resumed after the upgrade would show only its new turns.
  - *Changed during implementation:* the final review found that such a session is never resumed. This change edits `core.agency`, so `canResume` refuses every session saved before it ("changed"). The seeding was removed. `_readTranscript` still reads the thread for a checkpoint with no list, so old sessions are still shown and searched.
- **The model is sent the same text as before.** The cancel note becomes the last note. `withPendingNotes` joins the notes and the message with blank lines, so the joined text is unchanged: notes, then the cancel note, then the message.
- **A turn the core catches as a failure keeps its user entry and gets no reply entry.** This is a turn whose `try runTurn(…)` returns a failure. The error is shown live as `session.error` and is not part of the conversation.
- **A turn the driver rolls back leaves no entry.** When a leg fails in the driver, or the process stops in the middle of a turn, the driver goes back to the pause the turn started from. The user's entry goes away with the turn's messages, and the next message carries the "failed" note.
- **A cancelled request is not shown after a reopen.** Today a reopened session shows the cancel note, which names the request. After this change it shows neither. The agent does not remember the request either, so the transcript matches what the agent knows.
- **The list is in the root globals.** A `fork` or `parallel` branch runs on its own copy of the globals. The core adds entries at the top level, outside any branch, and `transcriptIn` reads `cp.globals`.
- **A refused start target adds nothing.** The core refuses it before a turn starts.
- **An empty reply adds nothing.** Today's reader also leaves out a message with no text.
- **The list is not capped and compaction does not touch it.** A compacted session reopens with its whole conversation. The list holds only typed text and final replies, which are a small part of a checkpoint next to tool results.
- **Session search reads the list too**, because it goes through `_readTranscript`. It stops matching notes, `!` output and text the model wrote before a tool call.

## Out of scope

- Changing what the model is sent. Notes, context and the project block stay where they are on the thread.
- A `hidden` key on messages, and any change to `push`, `userMessage`, the handoff code or the stdlib agents.
- Session titles. `conversationText` in `lib/agents/agency-agent/lib/sessionTitle.agency` still reads the thread.
- The Perry update. After the next agency-lang publish, `src/agent/sessionMachine.test.ts` in Perry replaces its three uses of `withCancelNote`. Perry's own code needs no change.

## Global Constraints

- The globals module is `__agentTranscript` and its key is `messages`. Only `lib/stdlib/agentTranscript.ts` spells them.
- An entry is `{ role: "user" | "assistant"; content: string }`, the existing `TranscriptMessage` type.
- `withCancelNote` is replaced by `cancelNote`. No alias is kept.
- Do not edit `CHANGELOG.md`. Do not hand-edit `docs/site`.
- Run `make` before the `session-core` test. `pnpm run build` does not compile the agent's `.agency` files.
- Save every test run's output to a file. Run agent tests with `HOME` set to a scratch folder.
- Format only the TypeScript files this plan names: `pnpm exec prettier --write <files>`.
- Paths below are relative to `packages/agency-lang/`.

## Review Focus

1. **A turn paused on an approval, then resumed.** The user's entry is in the list exactly once, before and after the approval. Pinned in Task 3.
2. **A message sent with notes.** The list has the typed text only, and the model's request still has the notes above the text. Pinned in Task 3.
3. **A session saved before this change, then continued.** Its earlier messages are still shown, followed by the new turn. Pinned in Task 3 by a session whose saved list is deleted before its next turn. Task 1 pins the pure function and the reader's fallback.
4. **A cancel followed by a message.** The cancel note is in `notes`, `text` is what the user typed, and two cancels give one note naming both. Pinned in Task 2.
5. **A turn that fails.** The list ends with the user's entry and has no reply for it. Pinned in Task 3.

---

### Task 0: Merge `main` into the branch

The worktree is at `223e64439`. `main` has three commits on top. One of them, #1533, changes `core.agency`, `machine.ts`, and the `session-core` test and fixture, which Tasks 2 and 3 edit. The line numbers in this plan are from `main`.

- [ ] **Step 1:** `git merge main`. Do not rebase. Expected: a clean merge, since this branch has no commits of its own.
- [ ] **Step 2:** `pnpm install`.

### Task 1: The transcript list and the reader

**Files:**
- Create: `lib/stdlib/agentTranscript.ts`
- Create: `lib/stdlib/agentTranscript.test.ts`
- Modify: `lib/stdlib/agentSessions.ts` (`_readTranscript`, and `TranscriptMessage` moves out)
- Modify: `lib/stdlib/agentCompaction.ts` (export `threadById`)
- Test: `lib/stdlib/agentSessions.test.ts`

**Interfaces:**
- Produces, all in `lib/stdlib/agentTranscript.ts`:
  - `type TranscriptMessage = { role: "user" | "assistant"; content: string }`. `agentSessions.ts` re-exports it, so existing imports keep working.
  - `transcriptOfMessages(messages: { role?: string; content?: unknown }[]): TranscriptMessage[]`. This is the loop that is in `_readTranscript` today: user and assistant messages whose text is not empty.
  - `withEntry(existing: TranscriptMessage[] | null, threadMessages: { role?: string; content?: unknown }[], entry: TranscriptMessage): TranscriptMessage[]`. It returns `existing` with `entry` added. When `existing` is null it starts from `transcriptOfMessages(threadMessages)`. When `entry.content` is `""` it adds nothing.
  - `transcriptIn(checkpoint: Checkpoint): TranscriptMessage[] | null`. It returns the list in the checkpoint's globals, or null when the module is absent or its value is not an array.
  - `_addToTranscript(role: "user" | "assistant", content: string, threadId: string): void`. It reads the list from `currentRun().globals`, calls `withEntry` with the live thread's messages, and stores the result. It gets the thread with `threadById(threadId)` from `agentCompaction.ts`. A live thread holds `smoltalk.Message` instances and `transcriptOfMessages` reads saved JSON, so convert first:

    ```ts
    const threadMessages = thread === null ? [] : thread.getMessages().map((m) => m.toJSON());
    ```
- `_readTranscript(checkpointJson, threadId)` returns `transcriptIn(cp)` when it is not null. Otherwise it returns `transcriptOfMessages` of the saved thread, as today. It still returns `[]` for a checkpoint it cannot read.

- [ ] **Step 1: Write the failing tests.**

  In `agentTranscript.test.ts`:

  ```ts
  const user = (content: string) => ({ role: "user" as const, content });
  const assistant = (content: string) => ({ role: "assistant" as const, content });

  it("adds an entry to an existing list and ignores the thread", () => {
    expect(withEntry([user("a")], [{ role: "user", content: "old" }], assistant("b"))).toEqual([
      user("a"),
      assistant("b"),
    ]);
  });

  it("starts a missing list from the thread's messages", () => {
    const thread = [
      { role: "system", content: "You are an agent." },
      { role: "user", content: "old question" },
      { role: "assistant", content: "old answer" },
    ];
    expect(withEntry(null, thread, user("new"))).toEqual([
      user("old question"),
      assistant("old answer"),
      user("new"),
    ]);
  });

  it("adds nothing for an empty entry", () => {
    expect(withEntry([user("a")], [], assistant(""))).toEqual([user("a")]);
  });
  ```

  In `agentSessions.test.ts`, inside `describe("reading a saved conversation")`, next to the existing `saved` checkpoint:

  ```ts
  it("reads the session's own transcript when the checkpoint has one", () => {
    const withList = {
      ...saved,
      globals: {
        store: { __agentTranscript: { messages: [{ role: "user", content: "typed" }] } },
        initializedModules: [],
      },
    };
    expect(_readTranscript(withList, "t3")).toEqual([{ role: "user", content: "typed" }]);
    // The list does not depend on the thread id.
    expect(_readTranscript(withList, "")).toEqual([{ role: "user", content: "typed" }]);
  });

  it("reads the thread when the transcript is not a list", () => {
    const broken = {
      ...saved,
      globals: { store: { __agentTranscript: { messages: "nope" } }, initializedModules: [] },
    };
    expect(_readTranscript(broken, "t3")).toEqual([
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi there" },
    ]);
  });
  ```

  The existing test "reads the user and assistant messages of the thread the id names" stays as it is. It pins the fallback for a session saved before this change.

  The existing test "returns nothing for an unknown id or an empty one" uses a checkpoint with no list, so it also stays.

- [ ] **Step 2: Run them and see them fail.** `pnpm vitest run lib/stdlib/agentTranscript.test.ts lib/stdlib/agentSessions.test.ts`, output saved to a file. Expected: FAIL, `agentTranscript.ts` does not exist.
- [ ] **Step 3: Implement.** Store the list the way `lib/runtime/fetchCache.ts` stores its cache: `run.globals.get(module, key)` and `run.globals.set(module, key, value)`. Always store a new array, and do not change the old one in place.
- [ ] **Step 4: Run the tests and see them pass.** Same command. Then `pnpm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit.** Message: `agent sessions: a transcript list in the run's globals, and the reader prefers it`

### Task 2: The cancel note travels in `notes`

**Files:**
- Modify: `lib/stdlib/agentDriver/run.ts` (replace `withCancelNote`)
- Modify: `lib/stdlib/agentDriver/machine.ts` (`submit`, line 162)
- Modify: `lib/stdlib/agentDriver/index.ts` (the export)
- Docs: `docs/dev/agents/session-driver.md`, which names `withCancelNote` twice. Say that the note is sent as the last note.
- Test: `lib/stdlib/agentDriver/run.test.ts`, `machine.test.ts`, `index.test.ts`

**Interfaces:**
- Produces: `cancelNote(args: { cancelledTexts: string[]; failedTexts?: string[] }): string | null`. It returns the sentence `withCancelNote` put in front of the message, without the message and without the blank line. It returns null when both lists are empty.
- `submit` builds its answer as:

  ```ts
  { kind: "message", text, notes: [...(action.notes ?? []), ...(note === null ? [] : [note])], target }
  ```

  `text` is exactly what the user typed.

- [ ] **Step 1: Update the tests.**
  - `run.test.ts`: rename the `describe` to `cancelNote`. `cancelNote({ cancelledTexts: [] })` is `null`. `cancelNote({ cancelledTexts: ["do x"] })` is `'(The user cancelled their previous request, "do x", partway through. Some of its changes may already have been made.)'`. Keep each existing failed-text case, with the message and the blank line removed from its expected string.
  - `machine.test.ts`: each test that expected `withCancelNote` output in `text` now expects `text: "next"` and `notes: [cancelNote(dropped)]`. The test for two cancels in a row expects one note that names both requests.
  - Add one case to `machine.test.ts`, "the cancel note comes after the user's own notes": submit with `notes: ["NOTE-A"]` after a cancel. The answer's `notes` are `["NOTE-A", cancelNote(dropped)]`.
  - `index.test.ts`: the export list has `cancelNote` and no `withCancelNote`.
- [ ] **Step 2: Run them and see them fail.** `pnpm vitest run lib/stdlib/agentDriver`, output saved to a file. Expected: FAIL, `cancelNote` is not exported.
- [ ] **Step 3: Implement** `cancelNote` from the body of `withCancelNote`, and use it in `submit`.
- [ ] **Step 4: Run the tests and see them pass.** Same command, then `pnpm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit.** Message: `agentDriver: send the cancel note as a note, so the message is what the user typed`

### Task 3: The session core records each turn

**Files:**
- Modify: `lib/agents/agency-agent/core.agency` (the `message` arm, lines 413–460)
- Test: `tests/agency-js/session-core/test.js`, `tests/agency-js/session-core/fixture.json`
- Docs: `docs/dev/agents/agent-sessions.md`, `docs/dev/agents/session-core.md`

**Interfaces:**
- Consumes: `_addToTranscript(role, content, threadId)` from Task 1, imported the way `lib/compaction.agency` imports from `agency-lang/stdlib-lib/agentCompaction.js`. `conversationThread()` from `lib/record.agency`, which the core already imports.

The `message` arm changes in two places:

```
for (note in notes) {
  addNote(note)
}
// Before the turn, so a cancel takes the entry away with the turn.
_addToTranscript("user", text, conversationThread())
setTurnBudget(budget.maxCost, budget.maxTime)
```

```
if (reply is success(replyText)) {
  _addToTranscript("assistant", replyText, conversationThread())
  emit({ type: "session.reply", text: replyText })
}
```

Each call is a statement of its own. Do not put either inside the argument of the `try runTurn(…)` call: the comment above that call explains that such a call runs again on a resume.

The first call comes after the start-target check, so a refused target adds nothing.

- [ ] **Step 1: Write the failing tests** in `session-core/test.js`. Import `_readTranscript` from the built `agentSessions.js`, as the file imports the program. Add this helper next to `pauseData`:

  ```js
  const transcriptOf = (session) =>
    _readTranscript(session.pause[0].checkpoint, pauseData(session).thread);
  ```

  Then record these values on `result`, and add the expected values to `fixture.json`:

  - After `await chat.answer(message("hello"))`, the first turn of `chat`:
    `result.transcriptAfterOneTurn = transcriptOf(chat)`. Expected: the user entry `"hello"`, then one assistant entry holding the same text as `result.reply[0]`.
  - A new session, `noted`, answered with `{ kind: "message", text: "hi", notes: ["NOTE-A", "NOTE-B"], target: "" }`:
    `result.notedTranscriptUser = transcriptOf(noted)[0]`. Expected: `{ role: "user", content: "hi" }`.
    `result.notedModelSawNotes = userTextsSent.includes("NOTE-A\n\nNOTE-B\n\nhi")`. Expected: `true`. The stub client already records every request's last user text in `userTextsSent`.
  - The existing `asker` session, whose turn pauses on an edit approval. Do not use `editor`: its policy approves the edit, so it never pauses. After `await asker.answer(message("edit the note"))`:
    `result.transcriptAtApproval = _readTranscript(asker.pause[0].checkpoint, "")`. Expected: `[{ role: "user", content: "edit the note" }]`.
    After `await asker.answer(undefined)`: `result.transcriptAfterApproval = transcriptOf(asker)`. Expected: the same user entry once, then the reply.
  - A session saved before this change. Start a new session, `old`, and answer it with `message("before the upgrade")`. Then delete its list and send a second message:

    ```js
    delete old.pause[0].checkpoint.globals.store.__agentTranscript;
    await old.answer(message("after the upgrade"));
    result.upgradedTranscript = transcriptOf(old).map((entry) => `${entry.role}: ${entry.content}`);
    ```

    Expected: four entries. The first turn's user text and reply come first, read from the thread. `"after the upgrade"` and its reply follow. This test runs `_addToTranscript` inside the core before a turn, where it has to find the live thread. The test's run sets no checkpoint checksum, so the edited checkpoint is accepted.
  - After `await chat.answer(message("fail this turn"))`:
    `result.transcriptAfterFailure = transcriptOf(chat).slice(-1)`. Expected: `[{ role: "user", content: "fail this turn" }]`.
  - A new session answered with `{ kind: "message", text: "hi", notes: [], target: "nope" }`:
    `result.refusedTargetTranscript = transcriptOf(thatSession)`. Expected: `[]`.

- [ ] **Step 2: Run it and see it fail.** `make`, then `HOME=<scratch> pnpm run agency test js tests/agency-js/session-core --check-capabilities > <output file> 2>&1`. Expected: FAIL on the new keys. `transcriptAfterOneTurn` shows what the thread holds today.
- [ ] **Step 3: Implement** the two calls shown under Interfaces.
- [ ] **Step 4: Run the test and see it pass.** Same commands. Expected: PASS, with the keys that existed before this task unchanged.
- [ ] **Step 5: Update the dev docs.**
  - `docs/dev/agents/agent-sessions.md`, "The transcript": the saved conversation shown to a person is the session's transcript list. Say where it is kept, who adds to it, that `_readTranscript` reads the thread for a session with no list, and that the first new entry starts the list from the thread. Keep the paragraph on the conversation thread, which the title, compaction and the context percentage still read.
  - The same file, "Searching saved sessions", "What is read": the search reads the transcript, so it covers what the user typed and the final replies.
  - `docs/dev/agents/session-core.md`, where it describes `notes`: the driver sends the cancel note as the last note.
  - In the transcript section, say that the core adds entries at the top level and that the list is in the root globals, so a call moved into a `fork` or `parallel` branch would write to that branch's copy.
  - Run `pnpm run lint:structure`. Expected: PASS.
- [ ] **Step 6: Commit.** Message: `session core: record what the user typed and the reply; reopened sessions show that`

### Task 4: Open the PR

- [ ] **Step 1:** Check the diff against `docs/dev/contributing/anti-patterns.md`.
- [ ] **Step 2:** Run only the tests named in Tasks 1 to 3 once more, with output saved to a file. Expected: PASS.
- [ ] **Step 3:** Write the PR description in a file and open the PR with `gh pr create --body-file <file>`. The description lists what a user sees:
  - a reopened session and session search show what the user typed and the final replies
  - a compacted session reopens with its whole conversation
  - `withCancelNote` is replaced by `cancelNote`, and the cancel note arrives in `notes`
  - Perry's `sessionMachine.test.ts` needs the rename at its next agency-lang update
