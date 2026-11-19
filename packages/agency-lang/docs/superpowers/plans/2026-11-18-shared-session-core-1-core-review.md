# Review: Shared Session Core, Plan 1

Reviewed 2026-11-18 against the code on `adit/shared-session-core` (at
`ad3b9903f`), the spec beside the plan, Perry's `src/agency/core.agency` and
`docs/dev/agent-run.md`, and the spike in `.worktrees/spike-run-in-run`.
Paths below are relative to `packages/agency-lang/` unless they start with
`perry/`.

## Summary

The plan's order is right. Untangling the imports first makes the move a
pure move, and the handoff test in Task 6 is the right acceptance test. The
task list matches the files: every module in `lib/agents/agency-agent/lib/`
is on the move list or the stay list, and the list of outside files that
import agent modules matches a grep.

Five problems should be fixed before anyone starts:

1. The plan says two different things about a turn that fails, and the test
   it describes cannot produce a throw.
2. The test setup names the wrong mechanism for the scripted model, and the
   deterministic client cannot do what the fixture asks.
3. The "missing case" check that the spec gives as the reason for a typed
   `Answer` union does not exist for object unions yet.
4. Moving 46 files into `stdlib/` puts them under four stdlib-wide checks.
   Task 2 says "no other edits", so it will fail those checks with no room
   to fix them.
5. Several moved modules read the environment and the user's files in
   `static` initializers. In the stdlib, every program that imports the
   core runs those reads. The repo already has a test that forbids this for
   `std::agents/agency`, and after a handoff the reads see the wrong folder.

Eleven smaller findings belong in the task they name. A few minor notes
close the review.

---

## Fix before starting

### 1. What happens when a turn fails

The plan says three things that do not fit together:

- Task 5: "The turn is written in the `match` arm and not in a function",
  citing Perry's `docs/dev/agent-run.md`, so that a throw ends the leg.
- Task 5: "After the turn: ... the reply or the failure is emitted." That
  means the failure is caught and the core goes on.
- The fixture: `throwingTurnEndsTheLeg: true` and
  `samePauseWorksAfterTheThrow: true`, and Review Focus 4: "The leg ends
  with a failure the driver can read."

The code does not give the leg-ending behaviour either way:

- `runTurn` is a function (`lib/agents/agency-agent/lib/turn.agency:182`).
  Perry's own doc says why that matters
  (`perry/docs/dev/agent-run.md:139`): "An error thrown inside a function
  becomes that function's failure result, which a caller can drop without
  noticing." Calling `runTurn` from the arm puts the turn inside a
  function, so a throw comes back as a failure value. It does not end the
  leg.
- `answerTurn` turns a failed `agencyAgent` call into reply text:
  `return replyText("The agent", result)`
  (`lib/agents/agency-agent/lib/answer.agency:132`, with `replyText` at
  line 81). A model call that fails inside `agencyAgent` most likely
  reaches the core as the reply "The agent stopped before finishing: ...".
  I did not trace every path inside `agencyAgent`.
- The REPL today catches the throw and still counts the turn:
  `const result = try runTurn("", withPendingNotes(msg))`, then
  `markTurnDone()` (`lib/agents/agency-agent/lib/repl.agency:431-434`).

**Recommendation.** Decide on one behaviour and write it into Task 5. The
simplest one, which matches the REPL, is:

```
{ kind: "message", text, notes, target } => {
  for (note in notes) { addNote(note) }
  const reply = try runTurn(target, withPendingNotes(text))
  if (reply is success(replyText)) {
    emit({ type: "session.reply", text: replyText })
  } else if (reply is failure(err)) {
    emit({ type: "session.error", message: "${err}" })
  }
  // then the pending options, markTurnDone, recordTurn, as the plan says
}
```

Then replace the two fixture keys with `turnFailureEmitsError` and
`pausedAgainAfterFailure`. Make the failure come from a path that really
throws. `dispatchToBrain` throws `NO_BRAIN` when no brain is set
(`turn.agency:166-170`), and a test client that throws from `text()` can be
tried too. Assert what the run does, not what the plan expects.

### 2. The scripted model in Tasks 5 and 6

Task 5 says to drive the program "under the scripted model
(`AGENCY_USE_TEST_LLM_PROVIDER=1`, as `tests/agency-js/agent-effort` does)".
That test does something else: it installs its own client with
`__setLLMClient` (`tests/agency-js/agent-effort/test.js:13`).

If the plan means the deterministic client instead, three things are
missing or impossible:

- An agency-js test gets deterministic mocks from an `llmMocks.json` next
  to `fixture.json`, plus a `useTestLLMProvider` marker file so the test
  does not call a real model on push-to-main CI, where the variable is
  unset (`lib/cli/test.ts:1342-1360`). Neither file is in Task 5's or
  Task 6's file list.
- The deterministic client has no mock that throws. Running out of mocks
  throws (`lib/runtime/deterministicClient.ts:290-294`), but every later
  call throws too, so `samePauseWorksAfterTheThrow` cannot pass.
- `recordTurn` writes a title on turn 1 with an extra `llm()` call
  (`resume.agency:280-291`, `sessionTitle.agency:79`). An ordered mock list
  has to account for it.

**Recommendation.** Use `__setLLMClient` with a client that answers by
prompt text, as `agent-effort` does. It can return "stub reply", return a
`std::read` tool call for Task 6, answer the title call, and throw on one
chosen message. Add `llmMocks.json` and the marker only if the plan keeps
the deterministic client.

### 3. The `Answer` union gets no missing-case check

Decision 1 says answers are "checked with `Answer!` and an exhaustive
`match`". The spec gives the check as the reason to prefer a union over a
generic command (spec, "Answers" and open question 2).

The type checker does not check object unions yet.
`docs/dev/compiler/typechecker/narrowing/README.md:93-95`: "Object/tagged-
union discriminant coverage (`{kind:"a"}`) is **B2** — until then a
non-discriminated object union is treated as un-coverable (no
diagnostic)." There are two ways to write the match, and neither gives
both the check and the narrowing:

- `match (answer) { { kind: "message", text } => ... }` narrows `answer` in
  each arm but is never checked for missing cases. Perry's core uses this
  form (`perry/src/agency/core.agency:43`) and gets no check.
- `match (answer.kind) { "message" => ... }` is checked, because
  `answer.kind` is a closed literal union. But it does not narrow
  `answer`, so `answer.text` is a type error in the arm.

**Recommendation.** Keep the union. `Answer!` still rejects a bad shape at
the boundary, which is most of its value. Remove the "exhaustive match"
claim from the plan and the spec, and add a line to open question 2 saying
the check needs B2. Do not add a `_` arm. When B2 ships, a `_` arm would
hide the missing case it is meant to report.

### 4. Moving into `stdlib/` turns on four stdlib-wide checks

Task 2 says "Move the files and rewrite the imports. No other edits." Every
file under `stdlib/` is also checked by:

- `lib/typeChecker/fixtureTypeCheck.integration.test.ts:73-92`. Each stdlib
  file must have "no type errors or warnings". Nothing typechecks
  `lib/agents/` today. I ran `agency tc` on all 53 agent files in the main
  checkout and it reported no errors. I did not check warnings, and this
  test fails on a warning.
- `lib/stdlibCapabilities.test.ts:288-330`. Every exported stdlib function
  that can reach a `stdlib-lib` helper needs a capability tag or an
  allow-list entry. 16 of the agent's files import `stdlib-lib` helpers.
- `lib/typeChecker/alwaysTag.stdlib.test.ts:240-251`. Every effect declared
  in the stdlib needs a row in its table. This one bites in Task 5, when
  `std::sessionInput` is declared (finding 11).
- The doc build. `make` runs `agency doc` over the stdlib, so it will write
  about 46 new pages under `docs/site/stdlib/agents/session/`.
  `stage-stdlib-docs` (`Makefile:31-39`) then copies them into
  `stdlib/docs/`, where the agent's docs tools read them. Someone has to
  decide whether these internal modules get public reference pages. A
  generated page with `<word>` outside code also breaks the docs build.

**Recommendation.** Add a step to Task 2 that runs these three vitest files
and a full `make` (with `doc`), with the output saved to a file. Allow tag
and doc-comment fixes in a second commit, so the move commit stays a pure
move. Decide about the doc pages before Task 2.

### 5. `static` initializers that read the user's environment and files

These top-level values in modules on the move list run when the module
loads:

| File | Line | What it reads |
| --- | --- | --- |
| `shared.agency` | 88 | `env("AGENCY_AGENT_HOME") with approve` |
| `lib/config.agency` | 26 | the same variable |
| `lib/globalInstructions.agency` | 28 | the global `AGENTS.md` |
| `lib/claudeSkills.agency` | 194 | `loadSkillSources(cwd(), os.homedir())` |
| `lib/commandPalette.agency` | 7, 11 | `${cwd()}/.claude/commands`, and the init file under `cwd()` |
| `lib/cliTools.agency` | 28 | the bundled skills folder |

This causes two problems.

**Safety.** `lib/stdlib/agentBrainStatics.test.ts` exists to keep exactly
this out of the stdlib agents. Its header says that every program that
imports `std::agents/agency` runs those modules' top-level variables, "and
a handler in the program's own code cannot see what they read." The test
only scans `stdlib/agents/brains/` and `stdlib/agents/agency.agency`, so it
will not notice the new folder. Once these modules are in the stdlib, any
program that imports `std::agents/session` reads the user's
`.claude/commands` and Claude skills at load, before any handler exists.

**Handoff correctness.** Statics run again when the modules load in the
resuming process. There, `cwd()` is that process's folder. When Perry's
engine resumes a terminal session, the user commands, the Claude skills and
the init file come from the engine's folder, not the session's project.
`sessions.agency:42` (`projectDir`) and `resume.agency:238` also use the
process `cwd()` rather than `getAgentCwd()`. Task 6 cannot catch this,
because both of its programs run in the same folder. Perry's own doc
covers the related case: "The host is given again on every resume ... A
resume with no host would go on in the process's folder"
(`perry/docs/dev/agent-run.md:200`).

**Recommendation.** In Plan 1, extend `agentBrainStatics.test.ts` to
`stdlib/agents/session/`. Then either move each read into a function that
startup calls, or list it as an exception with its reason. The ones that
depend on `cwd()` have to become functions eventually anyway. Write the
folder problem into `session-core.md` and the spec's "Each process's own
setup", so Plan 3 starts from it. The spec's sort of these modules as
"front-end-neutral" was made from imports and terminal calls (spec, "Not
verified yet", item 4). It did not consider statics.

---

## Fix in the named task

### 6. Task 1 misses an import

`lib/sessionSearch.agency:8` imports `currentSessionId` from
`./resume.agency`. That name moves to `record.agency`, but
`sessionSearch.agency` is not in Task 1's Modify list. The seven crossing
imports are:

- `answer.agency:18`, `budget.agency:10` and `cliTools.agency:23` import
  from `trace`.
- `grounding.agency:8` imports from `args`.
- `sessionSearch.agency:8` imports from `resume`.
- `turn.agency:20` imports from `policy`, and `turn.agency:22` from
  `resume`.

Step 2's grep would catch the miss, but the list should name the file.

### 7. Job tools and `isInteractive` in the core (Task 5)

Task 5 says `answerTurn` "passes no job tools". The Global Constraints say
`agency agent` must behave the same, and the agent calls the same
`answerTurn`. Job tools come in through two places, both gated on
`isInteractive()`: `cliSettings().coderTools` (`answer.agency:57`) and
`jobAndSpillTools()` in `cliTools` (`cliTools.agency:47-62`). Spill tools
are dropped together with job tools. `_isInteractive` defaults to `true`
(`trace.agency:26`), and nothing in the core's program sets it. As
written, a core run gets job tools.

`isInteractive()` gates three things in the moved modules:
`answer.agency:41` (the reply style), `budget.agency:22` (the budget-stop
line), and `cliTools.agency:48` (job and spill tools).

**Recommendation.** Add a separate flag to `mode.agency`, such as
`setJobTools(on)`, which the agent's `runSession` turns on and the core
leaves off. Task 5 already makes the reply style its own setting, so after
this the core never needs `isInteractive()`. Say in the plan what the core
does with each of the three call sites.

### 8. `switchModel` cannot report failure (Task 4)

Task 4 says `applyModelSpec` returns `Result<...>`, and that "A failed
switch returns the failure". But `switchModel`
(`lib/agents/agency-agent/lib/session.agency:269`) returns
`{ session, resolved, changes }`. Each of its three failure branches
(lines 287, 301, 324) prints a line and returns the old session with no
changes. A caller cannot tell that apart from a switch to the model already
in use.

Task 4 has to change `switchModel` to return a `Result` and update
`modelSlashCommand` (`repl.agency:189`) to match. Name that body change in
Task 4's Files and Interfaces. Task 3 turns the same three lines into
notices first, so Task 4 should say the notice stays and the failure is
returned as well.

### 9. The tests need the model startup (Tasks 4 and 5)

`switchModel` resolves against `_startupModelSettings` and
`startupDefaultSlots()` (`session.agency:315-317`), which the agent's
startup sets. Task 5's `program.agency` only calls `setBrainName("simple")`.
So `getResolvedSlots()` is empty, the pause reports `models: {}`, and
`badModelKeptMainSlot` compares `null` with `null`. That check cannot fail.

**Recommendation.** Have `program.agency` run the same model setup as the
spec's outline of a session program (`startPreset`, `pickModels`). Have the
test first assert that the main slot is not null. Task 4's two tests need
the same setup. Check what the existing agent tests do for this.

### 10. `approvingInstructionReads` needs a policy handler (Task 5, Global Constraints)

The plan lists `approvingInstructionReads` as one of the core's two
handlers. Its signature is `approvingInstructionReads(policyHandler, rules,
intr)`, and it passes every interrupt that is not an instruction read to
`policyHandler` (`lib/agents/agency-agent/lib/projectContext.agency:93-101`).
The core has no policy handler to give it.

It also does nothing in the core. `projectContextText` already reads the
instruction files under `with approve` (`projectContext.agency:125`). The
helper exists because the agent's `cliPolicyHandler` would otherwise ask
the user. In the core, nothing asks, because a run policy handler stays
silent on effects it has no rule for (`lib/runtime/runPolicyHandler.ts:59-61`).
`with approve` is then the only answer, so the read is approved.

**Recommendation.** Drop `approvingInstructionReads` from the core and from
the Global Constraint. If the plan keeps it, say what it adds over
`with approve`.

### 11. Declaring `std::sessionInput`, and an answer of `null` (Task 5)

The plan never says where `effect std::sessionInput { ... }` is declared,
or with what fields. Put it in `stdlib/agents/session.agency`, with the
pause's fields, and add its row to `alwaysTag.stdlib.test.ts` (finding 4).

An answer of `null` makes the core loop forever. When a run policy has an
approve rule that matches a raise expecting a value, it answers with `null`
(`lib/runtime/runPolicyHandler.ts:47-66`). A program run under a `"*"`
approve rule without the `propagate` pin would get `null` at every pause.
The core then emits `session.error` and raises again, forever, without ever
pausing. The pin works when a front-end adds it, because a rule for the
effect itself takes precedence over `"*"` (`lib/runtime/policy.ts:68-89`).
But the core should not rely on every caller remembering it.

**Recommendation.** Treat `null` as "end the session": the node returns,
and the driver sees the run finish. Add a case for it to the Task 5
fixture.

### 12. The first node exported from the stdlib (Task 5)

No stdlib module exports a node today (`grep '^export node' stdlib` finds
nothing). The spike imports its core with
`import node { session } from "./core.agency"`, which is a relative path.
Task 5's `program.agency` will need
`import node { session } from "std::agents/session"`, a path no test
covers yet.

**Recommendation.** Write the import into Task 5. Then make Step 1 a
two-line program that only does `goto session(...)` into a stub node, and
run it before writing the rest. Otherwise Step 2's expected failure ("has
no `session`") could hide a problem with the import itself.

### 13. `Answer.attachments` goes nowhere (Task 5)

The `message` answer has `attachments: Attachment[]`, but the core's
behaviour never uses it, and `runTurn(target, userMsg)` has no parameter
for it. Attachments come from scanning the message text for file paths
(`turn.agency:144-179`). `/image` saves the image and adds a note with its
path (`slashCommands/image.agency:12-25`).

**Recommendation.** Drop the field. A front-end sends an image as a note
with its path, as the terminal does now.

### 14. Automatic compaction is not in the core (Task 5, or Plan 2)

After every turn, the REPL compacts the conversation when it is due
(`compactIfDue`, `repl.agency:399-407`, called at line 435). The core does
not do this, and the spec only lists manual `compact` as an answer, which
waits for Plan 4. Once the terminal moves onto the core in Plan 2, long
sessions stop compacting.

**Recommendation.** Have the core call `compactIfDue` after a turn and
report through notices, either in Task 5 or as a named item in Plan 2.

### 15. The budget-stop line would change one-shot output (Task 3)

`guardStopHandler` prints only when the run is interactive
(`budget.agency:22`). Task 3 makes it emit `session.budgetStop` in every
case and has `trace.agency` print the line. Then `-p` runs would start
printing it. Have `trace.agency` print it only when `isInteractive()`.

### 16. Task 3's check leaves out `print` and `_exit`

The Global Constraint names `pushMessage`, `chooseOption`, `print`,
`clearScreen` and `_exit`. Step 5's grep checks only `pushMessage`,
`chooseOption` and `clearScreen`. The moved modules still call `print` or
`_exit` in these places:

- `session.agency:252` (`maybeEnableMemory`) and `session.agency:459-507`.
- `settings.agency:65, 86, 95, 201, 221`. Line 221 is in `saveSettings`,
  which `setSearchBackend` reaches (`search.agency:272`).
- `capabilities.agency:271-311`, `mcp.agency:83`,
  `globalInstructions.agency:19`, `presets.agency:235-240`,
  `shared.agency:588-630`, and `search.agency:366-375`.

Most of these run only at startup. Extend the grep to the full list, and
name each startup-only exception in the expected output, as Step 5 already
does for `pickGuidedLocalModel`.

---

## Minor

- **Task 2, "Delete the stale compiled files under `brains/`".** Git
  ignores them (`.gitignore:28`). They exist only in the main checkout, so
  the worktree has nothing to delete and the commit has nothing to record.
  Remove the line.
- **The pause's `record` type.** The spec gives `record: SessionRecord`,
  but `start.record` can be `null` for a session that is not saved. Use
  `SessionRecord | null` in the effect's declaration and in the spec.
- **Terminal wording in the record functions.** `forkSession` returns
  "reopen it with: agency agent --resume <id>" (`resume.agency:140`), and
  `renameSession` returns "Usage: /rename <title>" (`resume.agency:84`).
  Perry will show both as notices. That is fine for Plan 1. Plan 3 should
  fix it.
- **Task 8 waits on Task 7, and Task 7 needs the owner at a terminal.** Let
  Task 8 land with "not run yet" under "The terminal: what the check
  found", so the PR does not wait on it.
- **Tests stay in the agent's folder.** Tests for the moved stdlib modules
  stay in `lib/agents/agency-agent/tests/`. That works, because
  `import test` from a `std::` path is already used
  (`tests/imageTool.agency:2`). Say in `session-core.md` that they live
  there for now.
- **Perry's edit diffs.** The spec moves `reportEdit` into the core as
  `session.editDiff`, which means a third handler in the core. Plan 1
  leaves it out, and its Global Constraint allows only two handlers. Note
  that Plan 3 adds it, so the constraint is not read as final.

## Checked and correct

- Fingerprint keys have the form the Task 2 check expects
  (`stdlib/agents/brains/settings.js` registers
  `"stdlib/agents/brains/settings.agency"`).
- Only modules with a live frame on the saved stack are fingerprinted
  (`docs/dev/runtime/checkpoint-code-fingerprints.md`), so
  `firstPauseModules` and `pauseModulesAllStdlib` are fair checks.
- The invocation options take a `policy` (`lib/runtime/invocationOptions.ts:28`).
- A module and a folder with the same name already sit side by side
  (`stdlib/agents/agency.agency` and `stdlib/agents/agency/`).
- Every name Task 5 consumes exists, with the signature the plan gives,
  except `approvingInstructionReads` (finding 10).
- The pushMessage lines Task 3 lists in `session.agency` (172, 287, 301,
  324, 354, 369, 378) match the file.
- `const answer: Answer! = raise ...` works on a raise. Perry's core does
  it (`perry/src/agency/core.agency:35`).
- The branch is `adit/shared-session-core`, as the plan says.
