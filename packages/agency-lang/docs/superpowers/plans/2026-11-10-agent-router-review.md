# Review: the agent sends a turn straight to a subagent when a decision model is sure

Plan: `docs/superpowers/plans/2026-11-10-agent-router.md`

I checked the plan against the agent code on main (`5b2ff90a8`), the
shadow-test results and scripts in `worktree-decision-shadow`, and the
smoltalk 0.20.2 catalog.

Two things hold up as the plan says:

- The router sketch in Task 2 type-checks. I ran `agency typecheck` on it
  with the main checkout's build: "No type errors found."
- `jev-1.14` is in the 0.20.2 catalog as a decision model under
  `openrouter`, so this plan does not need plan 1.

Findings are ordered by severity.

## Important

### 1. Say which slot kind to use, and how `getRouterModel` reads the slot

The `derived` kind already behaves the way the router slot needs. A
`derived` slot defaults to empty (`lib/agents/agency-agent/lib/models.agency:314-322`).
It never inherits the main provider (`resolution.agency:36`), and a bare
`--model` does not set it (`resolution.agency:63`). `promoteAll` also
leaves its provider alone (`shared.agency:345`). A new kind would turn
`openai` into `openai-responses`, which breaks a decision call. So the
plan should say: use `derived`.

The plan also says to add `getRouterModel()` beside `getSlowModel()`.
That pattern does not carry over. `getSlowModel()` returns a module
global that `applyResolved` sets, but `applyResolved` does nothing for a
`derived` slot (`shared.agency:362-383`). `getRouterModel()` has to read
`getResolvedSlots()["router"]`.

Several places check for the embedding slot by name, and each needs a
router line:

- `modelRequest.agency:42`, `:95`, `:117`, `:176`, `:186`
- `presetRules.agency:128-133`

The built-in label `"built-in:embedding(derived)"` (`models.agency:319`,
`:353`) would print as the router's source in `/model`. Change it to name
the slot.

### 2. An Agency question routed to `research` loses the Agency researcher

`researchAgent` takes `agencyTopic` (`brains/coordinator/subagents/research.agency:33`).
When it is true, the call goes to the researcher that reads the bundled
Agency docs (`research.agency:56-64`). The routed call passes only
`userMsg`, so a question about Agency syntax routed to `research` goes to
the general web researcher.

The three-option question has no option for this. The `code` line says
"except Agency", and the `research` line does not mention Agency. The
shadow logs had no such turns, so the test did not measure it.

Choose one:

- Add "questions about the Agency language" to the `coordinator` line,
  and re-score the three-option run with the new wording.
- List it under "Known limits".

### 3. The router knows about learned tools, but not the coordinator's other tools

The shadow test found one wrong pick: Jev chose `research` for a request
that a learned tool answers in two seconds. The same thing happens with
every tool the coordinator has and the subagents do not. `turnTools`
(`coordinator.agency:115-128`) adds MCP tools, Claude skills, generated
tools, and `learnTools`, not only `learnedExtras()`. A user with an MCP
tool for their issue tracker who asks "what is open on my board?" gets
sent to the researcher.

Have `mainAgent` pass the names of the turn's extra tools into
`pickRoute`. Those are the names in `turnTools(turnStart)` that are not
subagents. This also fixes a contradiction in Task 2: the plan says the
module "does not know about tools", yet it reads `learnedExtras()`
itself.

The "Saved tools: ..." line is new text in a prompt whose wording the
plan otherwise keeps fixed because it was measured. Re-run the scoring
script with the line added, as the plan asks for a new routed subagent.

### 4. Pending notes reach the router and the subagent as the user's message

The REPL sends `withPendingNotes(msg)` (`lib/repl.agency:424`). That
function puts every pending note above the message in one string
(`lib/pendingNotes.agency:15-22`). A note is, for example, the output of
a `!` shell command. The router then reads the note as part of the
user's message, and so does the subagent, as `userMsg`. A long `!cat`
output can also exceed what Jev accepts in one request. The shadow test
capped its state at 90,000 characters for this reason.

The simplest rule: skip routing when the prompt text is longer than a
cap. That covers both cases without new plumbing. Write the cap down in
the dev doc.

### 5. The resume test may pass whether or not the route is asked again

Task 3's test has a routed subagent pause on an approval and then checks
for exactly one decision request after the resume. That test only means
something if the pause goes through a checkpoint and `mainAgent` runs
again from its saved frame. If the agent answers the approval in the
same process, nothing re-runs, and the count is one no matter how the
route is computed. Find out which path the test harness takes, and
choose the one that re-enters `mainAgent`. Before writing the test, ask
what would make it fail, as plan 2 does for its case 6.

### 6. A wrong tool name in the table fails every routed turn

Plan 2 makes an unknown `firstToolCall` name fail the `llm()` call. A
typo or a later rename in the route table would then fail every routed
turn, and the plan says the router must never do that. Add a test that
every row in the table names a tool in `turnTools(...)`. A test like this
fails as soon as someone renames a subagent.

## Minor

### 7. Two more known limits

- **Memory recall.** Plan 2 skips memory recall for the chosen round.
  `mainOptions` sets `memory: true`, so a routed turn starts with no
  recalled facts, where the coordinator would have had them.
- **The coordinator model.** The results document lists, as a next step,
  measuring how the saving depends on the coordinator model. The saving
  is large with GLM 5.3 Flash and small with Opus 4.8. Task 4 should
  record which coordinator model it ran, and the dev doc should say the
  saving depends on it.

### 8. Paths

`lib/presetRules.agency` and `shared.agency` are relative to
`lib/agents/agency-agent/`. Spell them out in full like the other paths in
the plan.
