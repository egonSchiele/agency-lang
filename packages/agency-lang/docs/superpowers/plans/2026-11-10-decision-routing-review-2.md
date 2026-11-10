# Review, round 2: `decision: true`, expiring personas, and the router

Plan: `docs/superpowers/plans/2026-11-10-decision-routing.md`
First review: `docs/superpowers/plans/2026-11-10-decision-routing-review.md`

## The first review's findings

All thirteen are in the plan:

- the router slot's own provider list;
- `--local` with a router;
- the dependency sentence and `decision: true` in the sketch;
- the order of the tool names;
- the first decision entry in catalog order;
- the handoff fixtures and the message-thread test index;
- the failure notice;
- the Jev-only floor;
- `text` from one `match`;
- the memory id;
- the plugin version;
- the cancel;
- the main thread after a routed turn;
- the four agents left alone.

The findings below are about text the plan added in response, checked
against the code in this worktree.

## Important

### 1. The search for embedding rules misses the local path, and four checks need the router's provider list

Task 6 says to find the places that handle the embedding slot by name
with `rg -n embedding lib/agents/agency-agent/lib`, and names two files.
These are all the places that test for `"embedding"` by name, outside
tests:

| Place | What it does | What the router needs |
| --- | --- | --- |
| `lib/modelRequest.agency:95` | `--model` flag: refuses an embedding value with no provider | the same check, with the router's provider list |
| `lib/modelRequest.agency:117` | counts every other slot as a chat slot for the `--local` rule | the router is not a chat slot |
| `lib/modelRequest.agency:176`, `:186` | `localModelOf` carries the embedding value into `LocalModel` | carry the router value too |
| `lib/session.agency:136` | leaves the embedding slot out of the mixed-provider warning | leave the router out too (see below) |
| `lib/session.agency:264` | `/model`: refuses an embedding value with no provider | the same check, with the router's provider list |
| `lib/session.agency:330` | `/model`: warns when the embedding provider's key is missing | the router's key check, if one is kept (finding 5) |
| `lib/settings.agency:92` | `settings.json`: ignores an embedding value with no provider | the same check, with the router's provider list |
| `lib/presetRules.agency:128-134` | preset: refuses an embedding value with no provider | the same check, with the router's provider list |
| `shared.agency:489` | resolves a local embedding name to its served name | nothing; a `llama-cpp` router value is a file path |
| `shared.agency:512` | `configureLocalModel` builds a local session's slots by hand and calls `applyResolved` | add the router here, or `getRouterModel()` is `""` in every local session |

The last two are in `shared.agency`, which is not under `lib/`, so the
plan's search does not find them. `configureLocalModel` is the place
the plan means by "the local path must apply it". Name it.

The four "needs the provider/model form" checks all call
`embeddingSpecHasProvider` (`lib/models.agency:118`), which reads
`knownProviders()`. For the router those checks must read the router's
list. Otherwise `router=typesafe/jev-1.14` passes the parse and is then
refused by the check. Give the check the list as an argument and call
it with each slot's own list.

The mixed-provider warning (`session.agency:136`) warns when an
`llmOptions` block sets a provider-specific option and the session's
slots use more than one provider. The router's decision call ignores
those options (`dispatchDecision` reads only the model, provider, keys,
and base URL). A router on `openrouter` with a main model on
`anthropic` would print a warning that does not apply. Leave the router
out, as the embedding slot is left out.

Add a test for the local path: a `--local` session with the router set
has a non-empty `getRouterModel()`. The plan's test only checks that the
flags are accepted.

### 2. The wording the router should copy is not saved anywhere

Task 7 says to use the descriptions from
`scripts/decision-shadow/runDecisions.ts` in `worktree-decision-shadow`.
That script asks the original question: nine options (`research`,
`code`, `agencyCode`, `explorer`, `oracle`, `review`, `writing`,
`rewrite`, `coordinator`), with a description attached to each option.
The plan's table compares later versions with three options and the
descriptions in the prompt. The last row adds thirty tool names. I could
not find the text of those versions, or the list of thirty names, in
the script or in the results doc
(`docs/superpowers/specs/2026-11-09-decision-routing-shadow-test-results.md`
in the same worktree). The results doc was last written before the
follow-up runs and mentions none of them.

This matters for the `coordinator` line. In the nine-option script it
reads "Anything small enough to handle directly: ...". With three
options, an Agency task, a review, and a second opinion also belong to
the coordinator. If the follow-up runs widened that line, the
implementer cannot tell from the files the plan points at.

Before starting, save the exact prompt text of the version in the last
row, and the thirty names it used, in the results doc or in the plan.
Then point Task 7 at that text. The plan already says to keep the tested
wording, and this gives the implementer something to keep.

### 3. The cancel test needs a decision mock that waits

Task 7 asks for a test in which "a cancelled router call cancels the
turn". The deterministic client's `decide` checks the abort signal once
and returns the mock at once (`lib/runtime/deterministicClient.ts:357-363`).
Only text mocks take a `delayMs` that waits on the signal (line 277).
So a test cannot cancel a router call while it is in flight.

Either add `delayMs` to decision mocks, which is a small change to test
code in `lib/runtime/` and should be named as an exception to "nothing
in `lib/runtime/` beyond Part A", or test the cancel some other way and
say how.

## Minor

### 4. `--model main=typesafe/jev-1.14` is not refused today

Task 6's tests include "`--model main=typesafe/jev-1.14` is still
refused". `modelFlagProblem` (`lib/modelRequest.agency:91-103`) checks
the provider form only for the embedding slot. For the main slot,
`parseModelSpec` sees an unknown prefix and keeps the whole string as
the model name with no provider. The test should say what is true and
should stay true: the main slot's provider is not `typesafe`, and the
whole string is the model name.

### 5. Report a broken router one way, not two

The plan now does both things my first review offered: a startup key
check and a line the first time the router fails. The line covers a
missing key, a wrong model name, and a server that is down. The startup
check covers only the key. I would drop the startup check. If it stays,
use `missingProviderEnvVar`, which the embedding slot's `/model` path
already uses (`lib/session.agency:333`), and do not add a new table of
key names.

Reset the "already reported" flag when `/model` changes the router slot.
Otherwise a user who fixes the slot and then hits a different error
never sees it.

### 6. Two long lines

Lines 182 and 908 run past the wrap width the rest of the plan uses.
They are from edits. Reflow them.
