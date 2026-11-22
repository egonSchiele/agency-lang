# Notes for the judge: session-transcript

The work is a plan for a change to the agency-lang repository. These
facts about the repository are true at the commit the plan was written
for. Use them to answer the checklist. Do not score the plan against the
two reference plans named at the end.

## The repository

- `lib/runtime/` is the runtime every Agency program uses. `push` in
  `lib/runtime/state/messageThread.ts` is how a message is added to a
  thread. `lib/runtime/handoff.ts` and `lib/runtime/turnBoundary.ts` add
  the runtime's own messages.
- `userMessage` in `stdlib/thread.agency` and the built-in `llm` are
  public functions that every Agency program can call.
- The conversation thread is the list of messages the model reads. The
  transcript reader, `_readTranscript` in `lib/stdlib/agentSessions.ts`,
  rebuilds a transcript from that thread today. The terminal, the Perry
  app, and the `searchSessions` tool call it.
- The session core is `lib/agents/agency-agent/core.agency`. Its
  `message` arm receives the message answer, runs the turn, and emits the
  reply as a `session.reply` event. It belongs to the agent, not to the
  runtime.
- `lib/stdlib/agentDriver/` is the driver a front-end uses to run a
  session. After a cancel, the driver joins a note about the cancelled
  request onto the front of the next message's text, before the session
  core receives it. So the `text` the core receives is not always what
  the user typed.
- A slash command such as `/review` is expanded into a long prompt after
  the session core receives the typed text.
- Compaction replaces the older part of the conversation thread with a
  summary, and stores the summary as a user message.
- When the model calls a subagent, the subagent's assistant messages stay
  on the conversation thread. The live view shows only the turn's final
  reply.
- A run's globals are saved in every checkpoint and set back on every
  restore. A cancelled turn goes back to the checkpoint from before the
  turn. A `/fork` copies the checkpoint.
- An Agency file's top-level `let` is stored in the globals under the
  file's build path, such as
  `dist/lib/agents/agency-agent/lib/record.agency`. That path changes
  when the file moves.

## How to read the checklist

### no-marks

- A prefix such as `[note]`, a wrapper such as `<hidden>…</hidden>`, or a
  reader that strips text matching a known sentence are all ways of
  telling text apart by its wording.
- A key such as `hidden` in a message's metadata is a flag on a message.
- "A user message pushed while a handoff runs is hidden" is a rule that
  decides from where a message was added.

### model-input-unchanged

- A plan that edits `lib/stdlib/`, `lib/agents/`, or `stdlib/agents/`
  does not change the runtime. A plan that edits anything under
  `lib/runtime/` does.
- A plan that pushes notes, context, or a cancel note as a message of
  their own, where they were part of the user's message before, splits a
  message.
- A plan may move the cancel note from the front of the message text into
  the list of notes sent with the message. The model is sent the same
  joined text, so this does not change what the model is sent.

### own-record

- The record may be kept in anything that every checkpoint saves and
  every restore sets back. The run's globals are one such place. A file
  or a database outside the checkpoint does not count: it keeps a
  cancelled turn's entry, and a fork does not copy it.
- A plan with no record of its own fails all four points.
- For the third point, a plan that records the `text` the session core
  receives, and does not mention the cancel note, fails.
- For the fourth point, a TypeScript reader that looks up an Agency
  file's `let` by the file's build path depends on a source file's path.

### covers-the-cases

- Each point needs the plan to name the case in its own words. A design
  that would handle a case the plan never mentions does not pass that
  point.

## The two reference plans

`rejected-plan.md` and `approved-plan.md` in this folder are two plans a
person reviewed for this task. They are here for a person reading the
results. A plan different from both can pass every point.
