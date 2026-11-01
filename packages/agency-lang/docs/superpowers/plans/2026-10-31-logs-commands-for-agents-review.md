# Review: `agency logs` commands for agents (plan of 2026-10-31)

Reviewed: `docs/superpowers/plans/2026-10-31-logs-commands-for-agents.md`
against the revised spec and the code on `main` (c66a13ac4). Measurements
come from the repository's 70 MB `log.jsonl`, through a throwaway script
that has since been deleted.

## Verdict

The plan is sound, and the move to transcript blocks is better than the
`roundDeltas` idea in the first draft of the spec. Transcript blocks
already handle handoffs and history rewrites. Five things need fixing
before anyone implements it:

1. A search hit in a system prompt has no row to map to. Every system
   block has `roundId: undefined`.
2. The plan writes a second block-to-row mapping, but the transcript
   screen already has one.
3. `search` and `session show` can read different logs, so an address from
   `search` fails in `show`.
4. The outline includes the approval rows that the trace screen hides.
   Those are a third of all rows.
5. `--machinery` switches to a different tree. It does not add rows.

The rest are smaller.

## Must fix

### 1. System blocks have no round, so Task 5's mapping cannot place them

Task 5, step 3 maps `system` blocks to `block.roundId`. In
`lib/logsViewer/transcript.ts`, a system block is built like this:

```ts
blocks.push({
  ...base,
  roundId: undefined,
  id: `system:${round.id}:${position}`,
  kind: "system",
  text,
});
```

All 24 system blocks in `log.jsonl` have `roundId: undefined`. A search for
a word in a system prompt would therefore find a block with no row. It
would either print a broken address or drop the hit. The plan's own test,
"A word in the system prompt matches the first call on the thread", would
fail.

The only place the round still appears is the block's id, and the
row-ID contract forbids parsing ids. The block needs to carry its round in
a field. The transcript screen reads `roundId` to decide focus
(`focusId()` in `transcriptScreen.ts`), and that is probably why system
blocks clear it. So add a separate field, such as `ownerRoundId`, rather
than changing `roundId`. Add this to Task 5, with a transcript test.

### 2. The block-to-row mapping already exists in the transcript screen

`selectedRowId()` in `lib/logsViewer/screens/transcriptScreen.ts` already
maps a block to a story row:

```ts
if (block.kind === "tool" || block.kind === "hosted") {
  return block.id;
}
if (block.kind === "assistant") {
  return block.roundId;
}
if (block.kind === "user") {
  return block.roundId === undefined ? undefined : `${block.roundId}:user`;
}
return undefined;
```

Task 5 writes a second mapping beside it, with more cases. The anti-patterns
doc lists this as "Duplicating existing code". The two would drift: the
screen's `A` would copy one address, and `search` would print another for
the same block.

Move the mapping into `transcript.ts` as one pure function, for example
`blockRowId(block, story)`. Give it the cases Task 5 adds: system,
handback, history, and error. Then have both `selectedRowId()` and
`searchTrace` call it. The screen gains addresses for system, history,
and error blocks as a side effect, so `A` works on those blocks too.

### 3. `search` and `session show` can read different logs

The spec gives the `session` commands the open viewer as step 2 and
leaves it out for the new commands. Here is what happens when both apply:

1. The person has `agency logs runs/today/` open in a viewer.
2. `agency.json` names `log.jsonl`.
3. The agent runs `agency logs search ENOENT` and gets the address
   `Xjz…/span-9c01` from `log.jsonl`.
4. The agent runs `agency logs session show Xjz…/span-9c01`, as the skill
   says. `show` uses the open viewer's log, which is the run directory,
   and answers `no row … in trace`. It could also find a different row,
   if the run directory holds a copy of the trace.

The skill promises that no step needs `--log`, so it is exactly this
agent that hits the problem. The header line names the file, but nothing
tells the agent to compare it between commands.

Make the order the same for every command. The new commands should take
the single open viewer's log before `log.logFile`. Reading a viewer's
record is a registry probe. It does not talk to the viewer itself, and the
session commands already do it. If the probe's timeout on a suspended
viewer is a concern, the other consistent choice is the reverse:
`session show` prefers `log.logFile` whenever its `--trace` or address
names a trace that the viewer's log does not hold. Either works. What
matters is that the four skill steps cannot disagree. Add the scenario
above as a test.

### 4. The outline includes approval rows that the trace screen hides

The spec says the outline shows "the same rows the trace screen draws".
`storyOutline(trace, { admin: false })` includes every interrupt row,
successful approvals too. The trace screen hides those afterward
(`traceScreen.ts:332`, the `p` toggle). In `log.jsonl`:

- 418 of the 1,317 outline rows across all traces are approved
  interrupts, or 32%.
- The largest trace, 63 LLM calls, has 75 approved-interrupt rows. Most
  are startup reads of environment variables and skill folders.

An agent would read a third of the outline as noise. This is the same
problem the commands exist to fix. Move the filter at
`traceScreen.ts:332` into a pure function in `story.ts`, call it from both
the screen and `outlineLines`, and add `--approvals` to show the hidden
rows, matching `p`. Add a test that an approved interrupt is hidden by
default and a rejected one is kept.

### 5. `--machinery` switches to a different tree

Task 4 implements `--machinery` as
`outlineRows(trace, { machinery, admin: machinery })`. `outlineRows` with
`machinery: true` returns `forestOutline`, which is the raw span tree that
the `m` key shows. It does not add rows to the story. It replaces the story
with event-level rows such as `evt-12`. The plan's test, "`--machinery`
adds rows", would pass, but it checks the wrong thing.

The forest view is unlikely to help an agent. I suggest dropping
`--machinery`, and offering `--approvals` (finding 4) and `--admin`
instead. `--admin` would be `storyOutline({ admin: true })`, which adds the
handler decisions under each interrupt. If the forest view stays, name it
for what it is (`--forest`) and say in the spec that its row ids differ.

## Should fix

### 6. Headers can be one very long line

`headerLine` uses the first line of a user message or error for its
header (`User turn · ${row.text.split("\n")[0]}`). A prompt written as one
paragraph is one line, often thousands of characters. Every outline line
and every search hit prints that header. Cut headers to a fixed width in
`outlineText` and in search output, for example with `oneLine` from
`lib/cli/runDirectory/table.ts`. `session show` keeps the full header.
Put the width in a named constant, and add a test with a 2,000-character
first line.

### 7. The trace-picking rules leave cases open

`selectTraces` says "`defaultLast` is what no flag means". These cases are
not decided:

1. `--since 1h` alone on `search`. Is that every trace from the last hour,
   or still only the newest one?
2. `--since 2h` alone on `traces`. Is that every match, or the newest 20?
3. `--all` combined with `--last` or `--trace`.
4. `--last 0`, `--last -1`, `--last abc`, and the same for `--limit` and
   `--context`. Commander hands these over as strings.

I suggest these rules. The default applies only when none of `--trace`,
`--last`, `--since`, or `--all` is given. `--since` alone means every
trace that matches. `--all` refuses to combine with `--last` or
`--trace`. A count that is not a positive integer is refused with a
message. Put them in the spec as a table, and give each a test.

### 8. Two edge cases in the config fallback

- **An empty `logFile`.** `config.ts` sets `log.logFile` to `""` on
  purpose, to override an `agency.json` value (see the comment near line
  928). `path.resolve(cwd, "")` is the current directory, which
  `pathKind` reports as a directory. `chooseSession` treats that as a run
  directory and reads `./statelog.jsonl`. Treat an empty `logFile` as
  unset, and test it.
- **A broken `agency.json`.** If the lazy `configuredLog` reader runs on
  every command, an invalid `agency.json` makes
  `agency logs session show … --log x` fail, even though it never needed
  the config. Read the config only when `--log` is absent, and say so in
  Task 1.

### 9. Several open viewers and a configured log

Task 1 places the new step "before the refusal". `chooseSession` has two
refusals: no viewer, and several viewers. If the configured log also
applies when several viewers are open, it silently replaces "say which
with `--log`", which is the safer answer. Say that the configured log
applies only when no viewer is open, and add a test with two viewers and
a configured log.

### 10. The registration test cannot catch a clash with a parent flag

Task 7's test builds a bare `Command` with `addLogsQueryCommands`. The
vendored commander refuses a flag that a parent already declares, but the
bare command declares none of `logs`'s options (`--follow`, `--csv`,
`--trace-id`). A clash would pass this test and crash the real CLI.
`scripts/agency.test.ts` already builds the real program and checks the
`logs` subcommands (line 188). Put the registration test there, or build
the test's parent with the same options as `logs`.

### 11. `openQueryLog` cannot call `resolveTarget` with `QueryDeps`

`resolveTarget` needs `openStore`, `author`, and `socketPathFor`, and it
opens a comments store for a `files` target. `QueryDeps` has none of
these, and a read-only query has no use for a comments store. Export the
log-choosing half instead. That could be `chooseSession` renamed to
`chooseLog`, returning the log path or a refusal. Have `resolveTarget` and
`openQueryLog` both call it. This also gives finding 3 one place to live.

### 12. Moving `withSharedOptions` shares the wrong help text

The helper's descriptions only make sense for the session commands:

```ts
.option("--log <file>", "The statelog to act on; also picks the viewer that has it open")
.option("--trace <id>", "The trace a bare row id belongs to (a full id or unique prefix)")
```

On `search`, `--trace` picks the trace to search. It is not "the trace a
bare row id belongs to". Either let the helper take the descriptions, or
declare the three options in `logsQuery/register.ts` with their own help.

## Minor

13. **Tool arguments match two rows.** `transcriptText` for an assistant
    block uses `messageText`, which includes every requested call's name,
    id, and arguments. The tool block includes the arguments again. A
    search for a file name passed to `read` therefore hits the LLM call
    and the tool. Step 4's merge only joins blocks on the same row, so
    this stays as two hits. Both hits are useful. The spec's sentence
    "Each piece of text belongs to exactly one row" should say that a tool
    call's arguments appear on both the call that asked and the tool that
    ran.
14. **Interrupts outside a tool call cannot be found by search.** The
    transcript has no interrupt block. An interrupt shows up only inside
    its tool's block. The largest trace has 24 interrupts at the top
    level, outside any tool. The outline shows them, but search never
    finds them, and `--kind` has no `interrupt`. Say this in the spec.
15. **The spec claims the trace picker sorts by start time.** It does not.
    `tracePicker.ts` lists traces in the order `buildForest` returns them.
    `--csv` does sort by start time. Fix the sentence. Making the picker
    match can be a later change.
16. **Start time is computed twice.** `traceStartedAt` (the earliest event
    timestamp) and `TraceSummary.startedAt` (`root.firstTs`, the earliest
    leaf timestamp) agree today. `traces` sorts by one and prints the
    other. Either reuse `firstTs`, or add a test that the two agree.
17. **The check in Task 5 is already done.** `toolResultText` in
    `story.ts:162` returns the whole recorded output. The 600-character
    cut lives only in `payload.ts`. Drop the "confirm while writing it"
    note and keep the test.
18. **A fixture helper returns an array.** `sampleRunForest()` returns
    `TreeNode[]`, so the Task 4 and Task 5 tests need `[0]`.
19. **Search over every trace is slower than the spec says.** Building
    transcript blocks for all 89 traces took 0.85 s, on top of 0.35 s to
    read the file. `--all` is still cheap, but the spec's "half a second"
    measured only the outline.
20. **A pattern that starts with `-`.** Commander reads
    `agency logs search --force` as a flag. The docs should show
    `agency logs search -- --force`.
21. **The `extract` refusal for a trace that is not found.** Task 8 keeps
    the first line and drops the table. Point it at
    `agency logs traces --log <log>`, as the several-traces refusal does.
22. **Repeated trace ids in the outline.** Every outline line repeats the
    21-character trace id. A 300-row outline spends about 6,600 characters
    on it. That cost is fine for copy-and-paste addresses. I'd mention it
    only if outline size becomes a complaint.

## Smaller points that are fine as written

- Reading config at action time, not at registration (Task 1).
- Deleting `traceListing.ts`. Only `extract.ts` imports it.
- Running the real binary after the build (Task 10).
- Leaving `extract` with its positional argument.
