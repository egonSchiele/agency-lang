# Review: Hidden Messages Implementation Plan

The design is sound. One metadata key, one rule for handoff scopes, and one
reader that skips hidden messages: that is the right size. I checked the
plan against the code in this worktree. One change would break `/image`,
and two kinds of text the user never typed are missing from the list.
Fix those three before you start. The rest can be handled while you work.

## Blocking

### 1. `/image` stops attaching the image

`imageNote` puts the image's path in a note, "on a line of its own, where
the attachment scan finds it" (`lib/agents/agency-agent/lib/slashCommands/image.agency`).
The scan is `checkForAttachments(expanded)` in `dispatchToBrain`
(`lib/turn.agency`), and it reads only the message text that reached
`runTurn`. Today the note is in that text, because `withPendingNotes`
joins it in. After Task 3 the note is its own hidden message, and `runTurn`
gets only what the user typed. The model then sees a path but no image.

Fix: give the scan the notes too. For example, `runTurn(target, text, notes)`,
with `dispatchToBrain` scanning `[...notes, expanded]` for attachments while
the brain still gets `expanded` alone. Add a session-core test: a message
answer whose notes hold an image note, and the model call carries the
attachment.

### 2. Two more kinds of text the user never typed are left in their message

The goal says the user's message will hold "exactly what they typed". Two
rewrites in `dispatchToBrain` still change that text, and neither is
listed:

- **The project block.** `withProjectContextIfMoved` (`lib/projectContext.agency`)
  puts "The working directory changed. This project block replaces the
  earlier one…" and the whole project block in front of the message
  whenever a coder moved the working directory. That block is long, and a
  reopened session will show it as something the user said. It fits this
  plan's mechanism exactly: push it as a hidden user message, on the
  conversation thread, before the turn.
- **Slash expansion.** `expandSlash` replaces `/cmd …` with the command's
  prompt. `setMessageRewritten` already records that this happened. Showing
  `/cmd …` would need the typed text kept next to the expanded prompt, which
  is more work. Add it to "Out of scope" so a reader knows it was a choice.

Add the project block as item 4 in the spec list, and either handle it in
Task 3 or list it under "Out of scope" with the reason.

### 3. Several user messages in a row

After this change a turn can put two or three user messages in a row on
the thread: the notes, then the context (Task 4), then the user's text.
This codebase avoids that elsewhere. `guardFeedbackProducer`
(`lib/runtime/turnBoundary.ts`) joins feedback into "One joined user
message, not a run of consecutive user messages — providers want
user/assistant alternation."

Before Task 3, check what smoltalk does with consecutive user messages for
each provider: does it merge them, or pass them on as they are? Then do
two things:

- Push all of a turn's notes as **one** hidden message, joined with blank
  lines, the way `withPendingNotes` joined them. This also keeps the
  cancel note directly above the user's text, where it is now.
- If some provider rejects consecutive user messages, the plan needs
  another way to join them (for example, smoltalk merging them at send
  time). Add a line to Decisions saying what you found.

## Should fix

### 4. Pin that a resumed turn doesn't push its notes twice

The core's message arm warns that a call written into a `try` call's
argument "is run again when a paused turn is resumed" (a resume desync).
Task 3 adds a loop that pushes to the thread just before `runTurn`. Add a
case to the session-core test: a message with a note, a turn that pauses on
an approval, the approval answered, and then the thread holds the note
exactly once. This is the same risk as Review Focus 1, but for the core's
own pushes.

### 5. The scope rule hides more than the coordinator's task

`push` would hide **every** user message pushed while a handoff scope is
open, not only the task the model wrote. That includes the turn-boundary
producers (guard feedback, round warnings, queued messages, reply
attachments) and any `userMessage()` a subagent's body calls. Hiding these
is right, since all of them are written for the model. But:

- State the rule that way in the docs and in `push`'s comment: "a user
  message pushed while a model-called handoff runs is hidden."
- The same guard feedback pushed outside a handoff is still shown in a
  reopened transcript. That is one more kind of text the user never typed.
  Name it under "Out of scope", or hide producer messages everywhere: the
  producers are one module, so that is cheap.
- `queueMessage` content could one day be what the user typed while a turn
  runs. Nothing in the agent queues messages today, so nothing breaks yet.
  A line in `queueMessage`'s docstring would keep a later change from
  hiding real user text without anyone noticing.

### 6. Task 4's reasoning about which agents to change

- **The Agency researcher is not on a routed path.** `coordinatorBrain`
  calls `researchAgent(settings, routed.text)`, so `agencyTopic` is false.
  Only the model sets it, through the tool loop, where the scope rule
  already hides the prompt. Changing that agent is harmless, but the
  Decision explaining it is wrong. Either drop that agent from Task 4, or
  say it is changed to match the others.
- **The context now stays on the thread, unseen.** A routed turn pushes
  `researchStyle` and `settings.context` as a permanent hidden message, so
  one more copy builds up with every routed turn. That is what happens
  today, inside the user's message, so the cost doesn't change. But it can
  no longer be seen, and `coordinatorBrain` has also just pushed
  `settings.context` as an `llmCall` system message, so the model already
  reads it twice. Think about `contextMessage` using `expires: "llmCall"`.
  Watch the researcher's second `llm()` call (the empty-answer follow-up),
  which would then run without the context. Either way, write down the
  choice.

### 7. Behavior changes for the changelog

These follow from the plan but aren't in Task 5's list:

- The router now sees only the user's text, with no notes or cancel note.
  The comment on `ROUTE_MAX_CHARS` in `coordinator.agency` ("a message with
  a whole command's output above it") becomes out of date.
- `expandSlash` now sees the user's text first, so `/cmd` probably expands
  even after a `!` note. Check this.
- Session search goes through `_readTranscript`, so `!` command output and
  other notes can no longer be found by searching.

## Minor

- **Task 1's "nested scope" test isn't nested.** As described, it pushes
  with no scope, then with one scope, then with none again. That does pin
  Review Focus 2 (a routed coder is called from code; the explorer it calls
  is in a scope). Either rename the test, or add a truly nested case: enter
  `a`, enter `b`, push (hidden), exit `b`, push (still hidden, `a` is
  open), exit `a`, push (shown).
- **Review Focus 3.** The plan says a cancelled turn's hidden notes "are
  gone with their rolled-back checkpoints." That means a `!` note sent with
  a cancelled message is lost, and that was already true before this plan.
  Say that in one line, so nobody reads it as something this plan causes.
- **The live view and a reopened session still differ.** On a model-called
  handoff, the subagent's assistant messages stay on the thread. A reopened
  transcript shows them as replies, while the live view shows only the
  final answer. Add this to "Out of scope".
- **This worktree has no `node_modules`.** No `smoltalk` resolves, at the
  package or the worktree root. Run `pnpm install` before Task 1's first
  test run.

## Checked and correct

- Only the tool loop enters a handoff scope. `invokeOnThread` has one
  caller (`prompt.ts:843`). `researchAgent` and `codeAgent` are
  `handoff def`s, but called from code they run as ordinary calls.
- Handoff scopes aren't serialized and are re-entered on resume
  (`invokeOnThread`). The `hidden` key travels in the message JSON, so
  Review Focus 1 holds.
- `_readTranscript` is the one place a saved conversation is rebuilt for a
  person: Perry's restore, the terminal's restore and session search all
  call it.
- `userMessage`'s parameters are `(msg, label, expires)`, so `hidden` goes
  last, as planned.
- The other start targets (oracle, explorer, writing, rewrite, review) run
  on threads of their own, so their `withContext` prompts never reach the
  conversation. `agencyCode` goes through `runCoder`, the same as `code`,
  so Task 4's change to `coding.agency` covers it.
- `withCancelNote`'s sentences match `cancelNote`'s planned output, and
  `[...action.notes, note]` keeps today's order: notes, then the cancel
  note, then the message.
- Perry uses `withCancelNote` in exactly three places, all in
  `src/agent/sessionMachine.test.ts`, as Task 6 says.
