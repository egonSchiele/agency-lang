# Hidden Messages Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A message can be marked hidden: the model reads it, but a transcript never shows it as something the user said.

**Architecture:** A new `hidden` key in each message's `metadata`, next to `label` and `expires`. It is saved in checkpoints and never sent to a provider. Every place that adds text the user did not type puts it on the thread as its own user message, marked hidden where it is created. The message holding the user's words is then exactly what they typed. `_readTranscript`, the one reader that rebuilds a conversation for a person, skips hidden messages.

**Tech Stack:** TypeScript runtime (`lib/runtime`), Agency stdlib (`stdlib/*.agency`), the agent driver (`lib/stdlib/agentDriver`), the session core (`lib/agents/agency-agent`), vitest, the `session-core` agency-js test.

**Spec:** this plan, and its review (`2026-11-21-hidden-messages-review.md`). A reopened session rebuilds its transcript from the checkpoint's conversation thread (`_readTranscript`). These kinds of text the user never typed show up there as user messages:

1. **The cancel note.** After a cancel, the driver's `withCancelNote` puts `(The user cancelled their previous request, "…", partway through. …)` in front of the next message.
2. **Notes.** The core's `withPendingNotes` puts a message answer's `notes` (a `!` command's output, an image's path) above the message.
3. **The project block.** `withProjectContextIfMoved` puts "The working directory changed. This project block replaces the earlier one." and the whole block in front of the message after a coder moved the working directory.
4. **Subagent prompts.** A handoff body's `llm()` calls append to the caller's thread. On a routed turn (`coordinatorBrain` calling `researchAgent(settings, routed.text)`), the thread gets `withContext(task, context)`: the user's text followed by a `<context>…</context>` block. When the coordinator *model* calls a subagent, the task the model wrote lands there too.
5. **The runtime's own user messages.** Handoff markers (`[researchAgent finished. …] Continue with the user's request.`, at `lib/runtime/handoff.ts:134, 145, 249, 405`), guard feedback, reply attachments and the round warning (`lib/runtime/turnBoundary.ts`).

## Decisions

- **Hidden is data.** It is one metadata key, `hidden: true`, absent on a message that is shown. `lib/runtime/state/messageMetadata.ts` stays the only module that spells it. Code can check, change and test it. A later front-end can show hidden messages as notices instead of skipping them. The word matches `thread(hidden: true)`: the thing still exists and still works, but listings for people leave it out. Docstrings say plainly that the model still reads a hidden message.
- **Each source marks its own messages.** Nothing guesses afterwards from content or position. A new source of model-only text must mark itself, and the reader tests catch one that doesn't.
- **A hidden message is a user message, not a system message.** smoltalk moves every system message into Anthropic's top-level system prompt (`clients/anthropic.js`), which would lose the note's place before the message and break prompt caching.
- **Runs of user messages go to the provider as they are.**
  - A turn can now put two or three user messages in a row on the thread: the turn's hidden note, a subagent's hidden context, then the user's text. The thread keeps them separate, with their metadata.
  - smoltalk's Anthropic client already merges a run into one message, in the copy it sends. OpenAI, Gemini and the local Qwen templates in use accept runs.
  - The public API already allows runs: `userMessage()` followed by `llm()`.
  - If a provider is found to reject runs, the fix is a merge in that provider's smoltalk client, as Anthropic's has. That is not part of this plan.
  - To keep runs short, each turn pushes **one** hidden note: the project block, then the notes, then the cancel note, joined with blank lines. That is today's order, so the cancel note stays directly above the user's text.
- **A user message pushed while a model-called handoff runs is hidden automatically.** This is the same rule that gives a system message pushed there a handoff expiry. It covers the task the coordinator model wrote, a subagent body's own `userMessage()` calls, and the turn-boundary producers inside it. Only the tool loop enters a handoff scope (`toolInvocation.ts`). A handoff called from code (a routed turn, a start target) is an ordinary call, and its prompt is shown.
- **The runtime marks its own synthetic messages hidden everywhere:**
  - the handoff markers
  - guard feedback
  - reply attachments
  - the round warning

  Queued messages (`queueMessage`) are **not** hidden, since their content could one day be what the user typed while a turn runs. Their docstring says so.
- **The public additions are `userMessage(…, hidden: true)` and `hiddenUserMessage` for TypeScript callers in the runtime.** `llm()` gets no new option. The researcher's empty-answer follow-up ("You returned no answer…") on a routed turn is rare and stays visible.
- **The cancel note travels as a note.** The driver adds it to the answer's `notes`, not to `text`.
- **Notes reach the turn as a list, not inside the text.** `runTurn(target, text, notes)`. The attachment scan reads the notes and the text, so `/image` still attaches its image. The brain, the router and slash expansion get the user's text alone.
- **Start targets on their own thread keep getting the joined text.** Oracle, explorer, review, writing and rewrite open a `thread {}` of their own, so nothing they are sent reaches the conversation, and a hidden note on the conversation thread would not reach them. They get the note and the text joined, as today. Code, agencyCode and research run on the conversation thread. They get the hidden note pushed there, then the text.
- **A routed subagent's context is its own hidden message**, pushed before the task with `expires: "llmCall"`. Only the researcher and the coder are on a routed path. The Agency researcher is reached only through the tool loop, where the scope rule already hides its prompt, so it is not changed.
  - With the expiry, context no longer piles up on the conversation thread with every routed turn. The model reads it only during the call it was written for.
  - The researcher pushes it again before its empty-answer follow-up, as it already does with its persona.
  - `withContext` and `contextMessage` share one private `contextBlock`.
- **What the model is sent changes in these ways:**
  - Notes and context are separate messages.
  - The context comes before the task, and leaves the thread when its call ends.
  - The router no longer sees notes.
  - `/cmd` expands even after a `!` note.

  Old checkpoints have no `hidden` key, so a session saved before this change still shows its notes once.

## Out of scope

- **Slash expansion.** A reopened transcript shows the expanded prompt, not `/cmd …`. Showing `/cmd` means keeping the typed text next to the expansion, which is separate work.
- **The live view and a reopened session still differ.** After a model-called handoff, the subagent's assistant messages stay on the thread, so a reopened transcript shows them as replies while the live view shows only the final answer.
- **Session titles** (`conversationText` in `lib/agents/agency-agent/lib/sessionTitle.agency`) still read hidden text. The title model having more context is harmless.
- **The cut-off note** (`cutOffRetry.ts`) expires with its own request and is never in a saved checkpoint.
- **Lost notes on cancel.** A `!` note sent with a message that is then cancelled is lost, because the cancel rolls back to the checkpoint before it. That was already true before this plan.
- **A guide section.** The `userMessage` docstring (regenerated into the stdlib reference) is the user-facing doc.

## Global Constraints

- The metadata key is spelled `hidden` and its only stored value is `true`. Only `lib/runtime/state/messageMetadata.ts` reads or writes it.
- The `userMessage` parameter is `hidden: boolean = false`, added after `expires`.
- `withCancelNote` is replaced by `cancelNote`, an exported rename. Perry imports it in one test file, so the Perry bump PR (Task 7) updates that file.
- Run `pnpm install` in this worktree before the first test run. It has no `node_modules`.
- Paths below are relative to `packages/agency-lang/`.

## Review Focus

1. **A turn paused on an approval, then resumed in another process.** The turn's hidden note is on the thread exactly once, and a subagent's hidden prompt is still hidden. Pinned in Task 3 (resume test) and Task 1 (`fromJSON` round-trip).
2. **A handoff the model calls from inside a routed subagent** (routed coder → model calls explorer). The explorer's prompt is hidden and the routed prompt is not. Pinned in Task 1 (scope tests).
3. **`/image` after this change.** The image note is in `notes`, not in the text, and the model call still carries the attachment. Pinned in Task 3.
4. **Two cancels in a row, then a message.** One hidden note naming both requests, directly above the user's text. Pinned in Tasks 2 and 3.
5. **A session saved before this change.** It reads back as before, notes included, with no error. Pinned by the existing `_readTranscript` test, whose messages carry no metadata, staying green in Task 3.

---

### Task 1: The `hidden` key, the handoff-scope rule, `userMessage(hidden:)`

**Files:**
- Modify: `lib/runtime/state/messageMetadata.ts`
- Modify: `lib/runtime/state/messageThread.ts` (`push`, a private `handoffHidden` next to `handoffExpiry`, and the `queueMessage` docstring)
- Modify: `stdlib/thread.agency` (`userMessage`: the parameter and one docstring line), `lib/stdlib/thread.ts` (`_userMessage`). Regenerate `docs/site/stdlib/` with `make doc`.
- Test: `lib/runtime/state/messageMetadata.test.ts`, `lib/runtime/state/messageThread.test.ts`
- Docs: `docs/dev/runtime/expiring-messages.md`, "The metadata on a message": add the key to the type and one short paragraph with the rule, worded "a user message pushed while a model-called handoff runs is hidden".

**Interfaces:**
- Produces:
  - `MessageMetadata = { label?: string; expires?: Expiry; hidden?: true }`
  - `MetadataPatch = { label?: string | null; expires?: Expiry | null; hidden?: true | null }`
  - `isHidden(message: { metadata?: Record<string, unknown> }): boolean`: true only when `metadata.hidden === true`. It takes the JSON shape too, so `_readTranscript` can call it on saved messages.
  - `hiddenUserMessage(content: smoltalk.UserContentInput): smoltalk.Message`: `withMetadata(smoltalk.userMessage(content), { hidden: true })`.
  - `push` gives a **user** message pushed while a handoff scope is open `hidden: true`, unless the message already has the key. Its comment states the rule in the same words as the doc.
  - `userMessage(msg, label = "", expires = "never", hidden = false)`. `_userMessage` pushes `hiddenUserMessage(msg)` when `hidden` is set. `push` keeps metadata a message already carries, so its signature does not change.

- [ ] **Step 1: Write the failing tests.**
  - `messageMetadata.test.ts`, "isHidden reads only a true hidden key": `isHidden(hiddenUserMessage("x"))` is `true`. A message without metadata, and the JSON `{ role: "user", content: "x", metadata: { hidden: "yes" } }`, are `false`. `withMetadata(m, { hidden: null })` removes the key.
  - `messageThread.test.ts`:
    - "a user message pushed in a handoff scope is hidden": `enterHandoffScope("k")`, push a user message, then a system message. The user message is hidden. The system message is not hidden, and its expiry is `{ at: "handoff", key: "k" }`. A user message pushed after `exitHandoffScope()` is not hidden.
    - "a code-called push around a scope is shown": push with no scope (shown), enter a scope and push (hidden), exit and push (shown).
    - "nested scopes hide until the outer one closes": enter `a`, enter `b`, push (hidden), exit `b`, push (hidden), exit `a`, push (shown).
    - "hidden survives toJSON/fromJSON": a hidden message is hidden after `MessageThread.fromJSON(t.toJSON())`.
- [ ] **Step 2: Run them and see them fail.** `pnpm vitest run lib/runtime/state/messageMetadata.test.ts lib/runtime/state/messageThread.test.ts`. Expected: FAIL, `isHidden` is not exported.
- [ ] **Step 3: Implement.**
  - Add the key, `isHidden` and `hiddenUserMessage`. Widen `metadataOf`'s parameter to `{ metadata?: Record<string, unknown> }`.
  - Add `handoffHidden` to `push`, add the `userMessage` parameter, and add the `queueMessage` docstring line: "Queued messages are not hidden; queue only text the user may see as theirs, or mark it hidden."
- [ ] **Step 4: Run the tests and see them pass.** Same command. Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "runtime: hidden messages; user messages in a model-called handoff are hidden"`

### Task 2: The cancel note goes in `notes`

**Files:**
- Modify: `lib/stdlib/agentDriver/run.ts` (replace `withCancelNote`), `lib/stdlib/agentDriver/machine.ts` (`submit`), `lib/stdlib/agentDriver/index.ts` (export)
- Test: `lib/stdlib/agentDriver/run.test.ts`, `machine.test.ts` (lines 134, 149, 175, 299), `index.test.ts` (export list)

**Interfaces:**
- Produces: `cancelNote(dropped: DroppedTexts): string | null`. It returns the same sentence `withCancelNote` put in front of the message, without the message or the blank line, and null when nothing was dropped. `submit`'s answer is `{ kind: "message", text, notes: [...(action.notes ?? []), note], target }`, with `text` exactly what the user typed and `note` included only when it is not null.

- [ ] **Step 1: Update the tests.**
  - `run.test.ts`, `describe("cancelNote")`: `cancelNote({ cancelledTexts: [] })` is `null`. `cancelNote({ cancelledTexts: ["do x"] })` is `'(The user cancelled their previous request, "do x", partway through. Some of its changes may already have been made.)'`. Keep the existing failed-text cases with the message removed from their expected strings.
  - `machine.test.ts`: each of the four tests expects the leg's response to be `approve({ kind: "message", text: "next", notes: [cancelNote(dropped)], target: "" })`.
  - "two cancels in a row are both in the note" stays, with a single note naming both.
- [ ] **Step 2: Run them and see them fail.** `pnpm vitest run lib/stdlib/agentDriver`. Expected: FAIL, `cancelNote` is not exported.
- [ ] **Step 3: Implement** `cancelNote` from `withCancelNote`'s body, then use it in `submit`.
- [ ] **Step 4: Run the tests and see them pass.** Same command. Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "agentDriver: send the cancel note as a note, not in the message"`

### Task 3: A turn's notes and project block are one hidden message; the reader skips hidden messages

**Files:**
- Modify: `lib/agents/agency-agent/core.agency` (the `message` arm, around lines 391–399)
- Modify: `lib/agents/agency-agent/lib/turn.agency` (`runTurn`, `dispatchToBrain`)
- Modify: `lib/agents/agency-agent/lib/startTargets.agency` (`runStartTarget`)
- Modify: `lib/agents/agency-agent/lib/projectContext.agency` (`withProjectContextIfMoved` becomes `movedProjectNote`)
- Modify: `lib/agents/agency-agent/lib/pendingNotes.agency` (`withPendingNotes` becomes `joinNotes`)
- Modify: `lib/stdlib/agentSessions.ts` (`_readTranscript`)
- Modify: `stdlib/agents/brains/coordinator.agency` (the `ROUTE_MAX_CHARS` comment no longer mentions command output)
- Test: `lib/agents/agency-agent/tests/userCommands.agency`, `tests/jobsSlash.agency`, `lib/stdlib/agentSessions.test.ts`, `tests/agency-js/session-core/test.js`
- Docs: `docs/dev/agents/session-core.md`, one sentence where it describes notes.

**Interfaces:**
- Consumes: `userMessage(…, hidden: true)` and `isHidden` (Task 1), the note-carrying answer (Task 2).
- Produces:
  - `joinNotes(lines: string[], message: string): string`: the lines that are not `""`, then the message, joined with `"\n\n"`. It returns the message alone when no line is left.
  - `movedProjectNote(): string`: `"The working directory changed. This project block replaces the earlier one.${block}"` when the directory moved, else `""`. It has the same conditions as today's `withProjectContextIfMoved`.
  - `runTurn(target: string, userMsg: string, notes: string[]): string`
  - `runStartTarget(target: string, message: string, note: string): string`. Code, agencyCode and research push `note` hidden, then get `message`. The other targets get `joinNotes([note], message)`.
  - `_readTranscript` leaves out every message for which `isHidden` is true. Perry's `restoredState`, the terminal's restore and session search all go through it.
- `dispatchToBrain(target, userMsg, notes)`, in order:
  1. `expanded = expandSlash(userMsg, slashCommands())`, then `setMessageRewritten(expanded != userMsg)`.
  2. `note = joinNotes([movedProjectNote(), ...notes], "")`, trimmed. This is today's order, with the cancel note last.
  3. For a start target: `runStartTarget(target, expanded, note)`.
  4. Otherwise: push `note` with `userMessage(note, hidden: true)` when it is not empty. Then `checkForAttachments(joinNotes(notes, expanded))` and `answerTurn(_brainName, expanded, attachments)`.

- [ ] **Step 1: Write the failing tests.**
  - `agentSessions.test.ts`, "leaves hidden messages out": the saved thread has a hidden user message `"(The user cancelled …)"` before `"hello"`. `_readTranscript(saved, "t3")` returns only `hello` and `hi there`.
  - `userCommands.agency`, `jobsSlash.agency`: the `withPendingNotes` cases become `joinNotes(takePendingNotes(), …)` with the same expected strings.
  - `session-core/test.js`:
    - "a turn's notes are one hidden message and the transcript is what the user typed": answer `{ kind: "message", text: "hi", notes: ["NOTE-A", "NOTE-B"], target: "" }`. The test client's request holds the user message `"NOTE-A\n\nNOTE-B"` directly before `"hi"`. `_readTranscript` on the next pause's checkpoint (thread id from the pause's `data.thread`) returns user messages `["hi"]`.
    - "an image note still attaches": write a 1×1 PNG to the temp project. Answer with `notes: [imageNote(pngPath)]`. The test client's request carries an image part.
    - "a resumed turn holds its note once": a message with `notes: ["NOTE-R"]` whose model call asks for an approval-gated tool. Answer the approval. The thread in the next pause's checkpoint holds `NOTE-R` exactly once.
    - "a refused start target pushes no note": with `target: "nope"` and `notes: ["NOTE-X"]`, the error event is sent, and the next turn's model call has no `NOTE-X`.
- [ ] **Step 2: Run them and see them fail.** `pnpm vitest run lib/stdlib/agentSessions.test.ts`, then `pnpm run build && node tests/agency-js/session-core/test.js`. Expected: FAIL on the new cases.
- [ ] **Step 3: Implement.**
  - In the core, after the start-target check, keep `for (note in notes) { addNote(note) }`, then call `runTurn(startTarget, text, takePendingNotes())`. Keep `runTurn`'s call on its own line, per the core's resume-desync comment.
  - Then implement the turn path, the start targets and `_readTranscript` (`continue` on `isHidden(m)`) as the Interfaces say.
- [ ] **Step 4: Run the tests and see them pass.** Same commands, plus `pnpm run agency test lib/agents/agency-agent/tests/userCommands.agency lib/agents/agency-agent/tests/jobsSlash.agency`. Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "session core: a turn's notes are one hidden message; transcripts leave hidden messages out"`

### Task 4: The runtime's synthetic user messages are hidden

**Files:**
- Modify: `lib/runtime/handoff.ts` (the four `smoltalk.userMessage(…)` pushes at lines 134, 145, 249, 405 become `hiddenUserMessage(…)`)
- Modify: `lib/runtime/turnBoundary.ts` (`attachmentsProducer`, `guardFeedbackProducer`, `roundWarningProducer` build `hiddenUserMessage(…)`; `queuedMessagesProducer` is unchanged)
- Test: `lib/runtime/handoff.test.ts`, `lib/runtime/turnBoundary.test.ts`

**Interfaces:**
- Consumes: `hiddenUserMessage`, `isHidden` (Task 1).

- [ ] **Step 1: Write the failing tests.**
  - `turnBoundary.test.ts`, "producer messages are hidden except queued ones": drain each producer with one pending item. The attachments, guard-feedback and round-warning messages are hidden, and a queued user message is not.
  - `handoff.test.ts`, "handoff markers are hidden": after a handoff that finishes, and one that stops, the marker message on the thread is hidden.
- [ ] **Step 2: Run them and see them fail.** `pnpm vitest run lib/runtime/turnBoundary.test.ts lib/runtime/handoff.test.ts`. Expected: FAIL on the new cases.
- [ ] **Step 3: Implement** as listed in Files.
- [ ] **Step 4: Run the tests and see them pass.** Same command. Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "runtime: handoff markers and turn-boundary messages are hidden"`

### Task 5: A routed subagent's prompt is the user's text

**Files:**
- Modify: `stdlib/agents/lib/shared.agency` (`contextBlock`, `contextMessage`; `withContext` uses `contextBlock`), `stdlib/agents/researcher.agency`, `stdlib/agents/coding.agency`
- Test: `tests/agency-js/session-core/test.js`
- Docs: `docs/dev/agents/agent-router.md`, the paragraph "The user's message is not pushed as a message of its own…"

**Interfaces:**
- Consumes: `userMessage(…, hidden: true)` (Task 1).
- Produces:
  - `contextBlock(context: string): string` returns `"<context>\n${context}\n</context>"`. It is not exported.
  - `contextMessage(context: string)` pushes `contextBlock(context)` with `userMessage(…, hidden: true, expires: "llmCall")`, and does nothing when `context == ""`.

- [ ] **Step 1: Write the failing test.** In `session-core/test.js`, "a start-target turn shows only the user's text": answer `{ kind: "message", text: "fix it", notes: [], target: "code" }` with the test client answering the coder's call. The coder's request holds a user message containing `<context>` before `"fix it"`. `_readTranscript` on the next pause returns user messages `["fix it"]`, and the thread holds no `<context>`.
- [ ] **Step 2: Run it and see it fail.** `pnpm run build && node tests/agency-js/session-core/test.js`. Expected: FAIL, the user message holds `<context>`.
- [ ] **Step 3: Implement.**
  - In the researcher and the coder, replace `llm(withContext(task: t, context: c), opts)` with `contextMessage(c)` followed by `llm(t, opts)`.
  - The researcher calls `contextMessage(c)` again before its empty-answer follow-up, next to where it pushes its persona again.
- [ ] **Step 4: Run the test and see it pass.** Same command. Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "agents: a routed subagent's context is a hidden message"`

### Task 6: Changelog and PR

- [ ] **Step 1:** Add a changelog entry. It covers:
  - `userMessage(hidden:)` and hidden messages
  - the `withCancelNote` → `cancelNote` rename
  - handoff markers and turn-boundary messages are hidden
  - the researcher's and coder's context comes before the task and leaves with its call
  - the router no longer sees notes
  - `/cmd` expands after a `!` note
  - `!` output and other notes no longer turn up in session search
  - reopened transcripts show what the user typed
- [ ] **Step 2:** Run only the tests named above, then push and open the PR. CI runs the rest.

### Task 7: Perry bump (separate PR in Perry, after the publish)

**Files:** `package.json` (agency-lang version), `src/agent/sessionMachine.test.ts` (the three `withCancelNote` uses become `cancelNote` with the note in `notes`), `docs/dev/engine.md` ("What a restart loses": a restored transcript leaves out hidden messages, so it shows what the user typed).

- [ ] **Step 1:** Bump, update the tests, and run `pnpm vitest run src/agent/sessionMachine.test.ts src/engine`. Expected: PASS.
- [ ] **Step 2:** Open the PR.
