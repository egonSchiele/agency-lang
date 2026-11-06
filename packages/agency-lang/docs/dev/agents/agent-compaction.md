# Compaction in `agency agent`

A long session fills the model's context window. Compaction replaces the
older messages of the conversation with a summary, so the session can go
on. It is a feature of the agent harness. It does not use the memory
layer's compaction (`lib/runtime/memory/`), which the agent has turned
off, and it does not change the tool loop.

## When it runs

- **Between turns.** After a turn's reply is shown, `compactIfDue` in
  `lib/agents/agency-agent/lib/repl.agency` checks the conversation's
  size. It compacts when the next request would fill 80% of the context
  window. If that compaction fails, the next one waits until the
  conversation has grown by 5% of the window, so a failure that will not
  go away is not paid for after every turn.
- **By hand.** `/compact` compacts now. Text after the command goes into
  the summary prompt: `/compact keep the details of the parser bug`.

It never runs in the middle of a turn. A single turn that outgrows the
window is not helped by this. Running between turns is what keeps the
feature small: the turn's frames have returned, no `llm()` call is open on
the thread, and the session is saved only after the rewrite. So there is no
half-rewritten thread for a resume to find.

It runs in the REPL only. A one-shot run (`-p`) is one turn.

The check runs after the turn is marked done. Escape during the summary
call cancels it and leaves the thread as it was. The cancel is not caught
by `try`, so it ends the REPL line, and the turn is saved with the next
line.

## Which thread

The conversation is the session thread the brain names in
`AgentBrain.session`, the same thread the title and the resume transcript
read. Subagent threads are not compacted.

## How big the conversation is

`contextTokens` in `lib/stdlib/agentCompaction.ts` takes the token count
the provider reported on the thread's last reply. Cached input tokens are
part of it. Messages added after that reply are estimated at four
characters a token. A thread with no counted reply is estimated whole.

The window is the smaller of the context windows of the `main` and
`reasoning` slots (`conversationWindow` in `lib/compaction.agency`), since
a brain's conversation runs on one of the two. A model that is not in the
catalog, such as a local model, has no known window. Then the footer shows
nothing and compaction never starts by itself. `/compact` still works.

The footer shows the share in use, such as `context 42%`. It is the
`context` field of `buildStatus`.

## What is kept

`planCompaction` splits the thread into three parts:

1. **The head.** The system messages the thread starts with. Both brains
   add their system prompt once, at the start of the session. The global
   instructions are added before each `llm()` call and expire with it, so
   they are not in the thread between turns. A system message anywhere
   after the head would be summarized like any other message.
2. **The summarized part.** Everything older than the kept part.
3. **The kept part.** The most recent messages, about 20,000 tokens of
   them, or a quarter of the window when that is less.

The kept part starts at a user message when one is close enough, so it
starts at the beginning of a turn. When one turn is longer than the kept
part, it starts at an assistant message. It never starts at a tool
result, because the call that result answers would be gone. When no such
start exists, there is no compaction.

A summary from an earlier compaction is the first message after the head.
It is given to the summarizer and replaced, so a thread never holds two
summaries.

A message that expires (`docs/dev/runtime/expiring-messages.md`) stays in
the thread and out of the summary, as in memory compaction.

## The summary

`compactConversation` in `lib/compaction.agency` asks for the summary in a
hidden thread of its own, so the call never touches the conversation. The
summarizer reads the older messages as text. A tool result is cut to 2,000
characters there. The prompt asks for fixed headings: goal, constraints,
done, in progress, decisions, files, next steps.

The call raises no interrupt, so no handler or policy is involved. Its
cost is counted like any other call in the session.

The rewrite happens only after the summary came back. A failed or empty
summary leaves the thread as it was and prints a warning.

The summary goes into the thread as a **user** message, the first one
after the head. Its text starts with `SUMMARY_PREFIX`, which is how the
next compaction finds it. There are two reasons it is not a system
message:

- A model wrote it from a transcript that holds web pages, file contents,
  and command output. It should have the standing of the conversation it
  replaces, and not that of the system prompt. The summary prompt also
  tells the summarizer not to follow instructions in the transcript.
- The kept part often starts with an assistant message, because one turn
  of a coding agent is usually longer than the kept part. With the summary
  first, the conversation still starts with a user message, which some
  providers require.

The kept replies lose their token counts (`withoutUsage`). Each count is
the size the provider saw before the compaction, and `contextTokens`
would report that old size from it. Copies are made, because threads share
message objects.

The summary call is a bare `llm()`, which runs on the main slot's model.
`conversationWindow` is never larger than that model's window, so the
transcript fits it whenever the window is known.

## Files

- `lib/stdlib/agentCompaction.ts`: the size, the plan, the transcript, and
  the rewrite. The thread is read and written here because the plan needs
  whole messages, with their tool calls and token counts.
- `lib/agents/agency-agent/lib/compaction.agency`: the thresholds, the
  window, the prompt, and the summary call.
- `lib/agents/agency-agent/lib/repl.agency`: `/compact`, the check after
  each turn, and the footer.
- Tests: `lib/stdlib/agentCompaction.test.ts` and
  `lib/agents/agency-agent/tests/compaction.agency`.

## To remove it

Delete the two compaction files and their tests, and take the three uses
out of `repl.agency`. Nothing else depends on it.
