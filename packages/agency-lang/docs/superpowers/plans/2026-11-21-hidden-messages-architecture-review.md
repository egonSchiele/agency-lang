# Architecture review: Hidden Messages plan

This is a second review of `2026-11-21-hidden-messages.md`. The first
review (`2026-11-21-hidden-messages-review.md`) checked the plan's details
against the code. This one asks whether the design is the right one.

## Verdict

I would not build this plan. It can be made to work, but it is the
expensive way to fix the problem, and it leaves the problem partly unfixed.

The problem is small: a reopened session shows text the user never typed.
The plan fixes it by changing the conversation the model reads, so that
the saved thread can double as the display. That is seven tasks. They
touch `push` in the runtime, the public `userMessage` function, the
handoff code, the driver's exports, the session core, two stdlib agents,
and Perry. They also change what the model is sent in four ways, and
nothing measures those changes.

There is a much smaller design: the session core writes down what the
user typed and what it replied, and the reader shows that. It is described
under "Alternative B" below. It is my recommendation.

## Why the plan's design is hard

The plan marks the messages that should be left out. Every message
without the mark is shown as the user's words. So the design fails in the
unsafe direction: a source nobody marked is shown as something the user
said.

The plan lists five kinds of text. I found three more that it does not
list, and each would still be shown after all seven tasks:

1. **The compaction summary.** `compactedMessages` builds it as a user
   message (`lib/stdlib/agentCompaction.ts:184`). `_readTranscript` has no
   check for it, so a compacted session reopens with the summary drawn as
   a `>` user line.
2. **Validation retry feedback.** `lib/runtime/prompt.ts:1742` pushes
   `decision.feedback` as a user message with no expiry.
3. **Slash expansion.** The plan puts this out of scope, because the
   expanded prompt and the typed `/cmd` are one message and a flag cannot
   split them.

Item 3 shows the limit of the design. A flag on a whole message only
works when the untyped text is a message of its own. So the plan has to
split messages apart first. The splitting is where most of the plan's
work and most of its risk come from: notes become their own message,
context becomes its own message, and the thread gets runs of user
messages.

The plan says "Each source marks its own messages. Nothing guesses
afterwards from content or position." The handoff rule does not follow
that. `push` would hide a user message because of where the push happens,
inside a handoff scope. That rule also contradicts another decision in
the plan. The plan says queued messages are not hidden. A queued user
message that the tool loop delivers inside a handoff body goes through
`push` while the scope is open, so it would be hidden. The stored value
is only ever `true`, so the queue has no way to say "show this one".

## What the plan changes for the model

The goal is about display. These changes are about model input, and they
come along because of the splitting:

- **Runs of user messages.** I confirmed that smoltalk's Anthropic client
  merges them (`mergeConsecutiveMessages` in `clients/anthropic.js`). The
  plan states that OpenAI, Gemini and the local templates accept runs. I
  did not find where that was checked, and local chat templates differ on
  this.
- **Context that expires.** A routed subagent's context becomes a message
  that leaves the thread when its call ends. Removing a message from the
  middle of a thread changes the prefix the provider cached. The next
  turn then re-reads everything after that point at full price. Today
  the context stays in the message and the prefix stays the same. This
  needs a measurement before it ships.
- **The router no longer sees notes, and `/cmd` expands after a `!`
  note.** Both may be improvements. Neither is needed for the goal.

If any of these is wanted for its own sake, it deserves its own small PR
with its own reason and a before-and-after measurement.

## Public API

`userMessage` is one of the most used stdlib functions. The plan adds a
fourth parameter, `hidden`, to it. The only code that reads the flag is
`_readTranscript`, which belongs to `agency agent`. A person writing their
own Agency program can set `hidden: true` and nothing they can observe
changes. That is a new public concept with one private reader.

The word also already means something else. `thread(hidden: true)` leaves
a thread out of `listThreads()`. A hidden message would not be left out of
anything a user program can call.

## Alternatives

### A. The plan

Mark what to leave out, and split messages so the marks can apply.
Covered above.

### B. The session core keeps its own transcript (recommended)

The session core is the one place that knows exactly what the user typed.
The `message` arm in `core.agency` receives it as `text`. It also knows
the reply, because it emits it as `session.reply`. So it can record both:

```
// record.agency
type TranscriptEntry = { role: "user" | "assistant"; content: string }

let _transcript: TranscriptEntry[] = []

export def addToTranscript(role: "user" | "assistant", content: string) {
  _transcript.push({ role: role, content: content })
}
```

```
// core.agency, in the message arm
addToTranscript("user", text)
...
if (reply is success(replyText)) {
  addToTranscript("assistant", replyText)
  emit({ type: "session.reply", text: replyText })
}
```

`_transcript` is a `let` global, so every checkpoint saves it and every
restore brings it back. Three things follow with no extra code:

- A cancelled turn restores the checkpoint from before the turn, so its
  entry goes away with it, as its messages do today.
- A turn paused on an approval and resumed in another process has its
  entry exactly once.
- `/fork` copies it, because a fork copies the checkpoint.

The reader then shows this list. A session saved before the change has no
list, so the reader falls back to the thread, as today.

One small part of the plan is still needed: Task 2. Today the driver puts
the cancel note in front of `text`, so the core never sees the typed text
alone. Sending the cancel note as the last entry of `notes` fixes that.
`withPendingNotes` then joins notes, cancel note and text in the same
order as today, so the model is sent the same bytes as before.

What B gives that the plan does not:

- The model's input does not change at all. No runs of user messages, no
  cache question, no prompt change to measure.
- It fails in the safe direction. A new source of model-only text is not
  in the list unless someone adds it.
- It fixes the three kinds the plan misses, slash expansion included,
  because it records the typed `/cmd` and never looks at the thread.
- It fixes the item the plan lists as out of scope, where a reopened
  session shows a subagent's messages as replies and the live view does
  not.
- A compacted session reopens with its whole conversation. Today it
  reopens with a summary and the last few turns.
- No runtime change, no public API change, and no change to `push`.

What B costs:

- The typed text and the final reply are stored twice in a checkpoint,
  once in the thread and once in the list. This is small next to tool
  results.
- The list grows for the life of the session, since compaction does not
  touch it. A cap on entries would bound it if that matters.
- There are two records of a conversation. They can disagree after
  someone edits a checkpoint by hand.
- Session search would stop matching intermediate assistant text, such as
  a sentence the model wrote before a tool call. It would match what the
  user typed and the final replies.

Two questions to settle before building B:

1. **How the reader gets the list.** The pause already reports `thread`
   and `record` in its data. Reporting the list the same way is the
   simplest reader, but the payload grows with the session. The other
   choice is for `_readTranscript` to read the global out of the
   checkpoint, which ties a TypeScript reader to a module's variable
   name. I lean towards the pause data, sending only the entries added
   since the last pause, with the driver appending them to the saved
   file. I have not checked how much driver code that needs.
2. **Whether the reopened view should show intermediate assistant text.**
   I did not check what the live view shows while a turn runs. If it
   shows more than the final reply, the same events can be recorded.

Rough size: one PR, the core, `record.agency`, the reader, Task 2, and
tests. No Perry change beyond the `withCancelNote` test update, and that
can be avoided by keeping the old export.

### C. The reader strips known text

`_readTranscript` could recognise the cancel note, the context block and
the rest by their wording. `docs/dev/runtime/expiring-messages.md` rules
this out ("Do not find the message again by its content or its
position"), and it breaks every time a prompt is reworded. I list it only
to say it was considered.

### D. Mark what the user typed, in the thread

The reverse of the plan: put the mark on the typed message and show only
marked messages. This fails safe, like B. It does not work today because
the core does not push the user's message. The brain's `llm(prompt)` call
does, several layers down, so the mark would need a new `llm()` option or
a change to how every brain takes its prompt. B gets the same result
without that.

## If you keep the plan anyway

Fix these first:

1. Add the compaction summary and the validation feedback to the list of
   sources, and mark them.
2. Resolve the queued-message contradiction. Either the scope rule skips
   queued messages, or the plan drops the claim that they are shown.
3. Replace the scope rule in `push` with explicit marks where you can.
   The prompt push at `lib/runtime/prompt.ts:682` could ask the thread
   whether a handoff scope is open and mark its own message. That keeps
   "each source marks its own messages" true.
4. Take the routed-context expiry (Task 5) out, or measure its effect on
   cached input tokens across two routed turns first.
5. Keep `hidden` out of the public `userMessage` signature until a user
   program has something that reads it. The runtime helper
   `hiddenUserMessage` is enough for the agent.

## Effort and impact

| Task | Effort | Impact on the goal | Note |
|---|---|---|---|
| 1. `hidden` key, scope rule, `userMessage(hidden:)` | Medium | Needed by the rest | Changes `push` for every program |
| 2. Cancel note in `notes` | Small | Needed | Also needed by B |
| 3. Notes as a hidden message, reader skips | Large | High | Most of the model-input change |
| 4. Runtime messages hidden | Small | Medium | |
| 5. Routed context as its own message | Medium | Low | Highest risk, cache and prompt change |
| 6. Changelog | Small | | |
| 7. Perry bump | Small | | Caused by a rename |

Task 5 is the one I would cut whatever else is decided. It has the
lowest payoff for the goal and the largest effect on the model.

## What I did not verify

- I read the code and ran nothing.
- I did not check the plan's claim about OpenAI, Gemini and the local
  templates accepting runs of user messages.
- I did not confirm that the validation feedback at `prompt.ts:1742`
  stays on the conversation thread after its call. It is pushed with no
  expiry.
- I did not read Perry's `restoredState`. The plan says it goes through
  `_readTranscript`, and the first review confirmed that.
