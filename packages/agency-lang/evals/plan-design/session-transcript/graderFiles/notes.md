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
  rebuilds a transcript from that thread today.
- The session core is `lib/agents/agency-agent/core.agency`. Its
  `message` arm receives the text the user typed, runs the turn, and
  emits the reply as a `session.reply` event. It belongs to the agent,
  not to the runtime.
- `lib/stdlib/agentDriver/` is the driver a front-end uses to run a
  session. It belongs to the agent too.
- A run's globals are saved in every checkpoint and set back on every
  restore.

## How to read the checklist

- A plan that edits `lib/stdlib/`, `lib/agents/`, or `stdlib/agents/`
  does not change the runtime. A plan that edits anything under
  `lib/runtime/` does.
- A plan that adds a key such as `hidden` to message metadata adds a mark
  to messages.
- A plan that pushes notes, context, or a cancel note as a message of
  their own, where they were part of the user's message before, splits a
  message.
- A plan may move the cancel note from the front of the message text into
  the list of notes sent with the message. The model is sent the same
  joined text, so this does not change what the model is sent.
- A plan that keeps a separate record of what was typed and replied, in
  any store, gets its transcript from something recorded as each turn
  happens. The store does not have to be the run's globals.

## The two reference plans

`rejected-plan.md` and `approved-plan.md` in this folder are two plans a
person reviewed for this task. They are here for a person reading the
results. A plan different from both can pass every point.
