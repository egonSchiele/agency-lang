# Review: the learntest brain plan

Reviewed: `docs/superpowers/plans/2026-11-25-learntest-brain.md`, with its architecture review beside it.

**Summary.** The plan is sound and most of its claims about the code check out. It has two gaps worth fixing before the build: a name collision the model cannot get around, and no test that resumes from a checkpoint inside the `learn` handoff. It also has one open step that is already settled, one review-focus item whose reasoning is wrong, and a handful of smaller corrections.

Findings are ordered by how much they matter.

---

## 1. A collision tells the model to do something it cannot do

Two of the index candidates export a function with the same name:

```
search    wikipedia, web/search
```

I checked every candidate in decision 5 against `lib/stdlib/stdlibModules.data.ts`. This is the only shared name, and no candidate exports `read`, `bash`, `edit`, `write`, or `learn`.

A model that learns `search` from one module and then from the other gets this failure from `_addLearnedRecords` (`lib/stdlib/sessionTools.ts:103`):

```
A tool named 'search' is already available. Choose another namespace.
```

The new `learn` tool passes an empty namespace and has no namespace parameter, so the model cannot follow that advice. It will retry, or give up on a task that needed both.

**Fix:** in `learnFromFile`, check the result of `learnSessionTools` and replace that message with one the model can act on. For example: "A tool named 'search' is already available, so this function cannot be learned in this conversation. Use the tool you have, or the bash tool." Test 12 should assert the new text.

## 2. No test resumes from a checkpoint inside the handoff

Every call of a learned tool raises `std::run`. When the brain runs under a TypeScript caller or a served agent, and no handler answers that interrupt, the run pauses inside the handoff's `llm` call. At that point `learnSessionTools` has already added the records to the global.

On resume, the handoff body must not run `learnSessionTools` again. If it did, the second run would refuse the name as already available, and the resumed turn would fail. Step counters should prevent this, but no test covers it. The coordinator's tests answer every interrupt with `with approve`, so they never pause, and `tests/agency-js/learned-tools-resume` only resumes between turns.

**Fix:** add a fourth scenario to `tests/agency-js/learntest-brain`:

1. The scripted model calls `learn` on the fixture file, then calls the learned tool.
2. A handler approves the inspection's `std::run` (its `function` is `<inspect>`) and leaves the learned call's `std::run` unanswered, so it reaches the JavaScript side with a checkpoint.
3. The test resumes that checkpoint with approve.
4. It asserts that the learned tool ran, that its result reached the model, and that the records hold the tool once.

## 3. The "two stdlib folders" check is already settled

Task 2 asks the implementer to confirm that `_stdlibDir()` and `getStdlibDir()` return the same folder. Finding 4.3 of the architecture review asks the same for an npm install. Both are already true by construction:

- The node host's `installDir()` returns `getPackageRoot()` (`lib/host/node/nodeHost.ts:244`).
- `stdlibDir()` in `lib/stdlib/skills.ts:7` joins that with `"stdlib"`.
- `getStdlibDir()` in `lib/importPaths.ts:82` joins the same root with `"stdlib"`.

**Fix:** replace the "confirm" paragraph in task 2 with one sentence citing these lines. Keep test 11, because it guards against someone changing either function later.

## 4. Review focus item 1 describes the wrong risk

The plan says a file outside the stdlib folder that is labeled as a stdlib module "would be approved by a rule written for that module." That cannot happen. A module source never loads the file at the path the model gave. `resolveSource` rebuilds the path from the module name under `getStdlibDir()` and refuses a name that points outside it (`lib/stdlib/agencyFunctions.ts:69-77` and `:90-99`). So a mislabeled outside file would load the real stdlib module of that name, and the approval would name what actually runs.

Rule 4 matters for two other reasons:

1. The approval prompt and policy rules see `module: "std::..."`.
2. A module source skips the closure validator, because installed stdlib code is trusted (`agencyFunctions.ts:93-94`). A stdlib file labeled as a file source would go through the validator instead. That changes how the file is checked. The approval still names the file that runs.

**Fix:** rewrite focus item 1 to say this. A reviewer should then check that a stdlib path becomes a module source, so approvals name it, and that `_learnSource` builds a module source only from `stdlibModuleName`, never from text the model wrote. The tests stay as they are.

## 5. Say why rule 1 exists

`learn` reads and parses the file in the parent process before it raises the first `std::run` (`stdlib/agency.agency:431`: `_prepareFunctions` runs before `_runProgram`). That read raises no `std::read`, as far as I can see. The coordinator's `learnTools` already allows this, so the plan does not create it. But the new tool makes any absolute path one argument away.

Rule 1 ("the path must end in `.agency`") is what limits that read to Agency files. The plan presents it as input checking.

**Fix:** add one sentence to decision 2, and to the dev doc section in task 6, saying that rule 1 also limits what the parent reads before any approval. That keeps a later change from relaxing it.

## 6. Name the file helpers `_learnSource` uses

Rule 3 checks whether a file exists in two places. The plan does not say how. The rest of `lib/stdlib` checks files through the host's helpers, for example `stat(located.root, located.target)` after `wholePath(...)` in `agencyFunctions.ts:83-84`, not through `fs` directly (`docs/dev/stdlib/contained-files.md`).

**Fix:** name those helpers in task 2's interface section.

## 7. A path that starts with `~` fails

The plan's own Perry example is "learn the Chrome tools from `~/demo-tools/chrome.agency`". Under rules 2 and 3, `~/demo-tools/chrome.agency` is a relative path. It is looked up as `<cwd>/~/demo-tools/chrome.agency` and then under the stdlib folder, and it fails. Models write `~` paths often.

**Fix:** expand a leading `~/` to the user's home folder, through the host, before rule 2. Add a test: `~/x.agency` with a fixture home gives a file source in that home folder.

## 8. The build and test order does not work as written

Three statements conflict:

- "Build with `make` once, in task 4b."
- "Each task that changes behavior starts with its test, which is run and seen to fail."
- Task 4b "waits for the owner's go-ahead."

The Agency tests in tasks 1, 3, and 4 import stdlib modules that exist only after `make`. Run before the build, they fail at import, which proves nothing. And if the owner holds back task 4b, `make` never runs and the task 4 tests never pass.

**Fix:** write tasks 1 to 4, run `make` once, then run the task 1, 3, and 4 tests, then do task 4b. Only task 2's vitest file can usefully be seen to fail first. Task 5 changes no `.agency` file, so it needs no second build.

## 9. The manual run in task 4b would not look like a user's run

Task 4b runs `pnpm run agency agent` inside the worktree. There, the stdlib folder is inside the working directory. That changes three things the experiment depends on:

1. Reading the index and grepping the stdlib raise no outside-the-working-directory prompts.
2. The model can find tools by grepping the repo's own source and docs, which an installed user does not have.
3. Rule 3 finds relative paths in the working directory before it tries the stdlib folder.

**Fix:** run the built CLI from an empty folder outside the repo:

```
cd <an empty folder outside the repo>
node <worktree>/packages/agency-lang/dist/scripts/agency.js agent --brain learntest -p "What are the top five stories on Hacker News right now?"
```

The plan also says this run "needs a policy that approves reads under the stdlib folder and `std::run`" but does not give one. Write the policy file into task 4b, so the run that tests the main risk does not depend on the implementer getting the rule globs right.

## 10. Smaller points

1. **The primer's categories come before the index.** The primer names "data sources, the web, images, OCR, speech, GitHub, calendar, and weather." Task 5 may drop some of these modules. Add a last step to task 5: make the primer's list match the final index.
2. **Task 1's import change is a split.** `cliTools.agency:16` also imports `learnSkill` and `writeToolFor` from `./learn.agency`, so that line becomes two imports, not a replaced one.
3. **Tests 4 and 5 reach `learn` only through the scripted model.** `learnFromFile` is not exported, so a test in `tests/agency/` cannot call it directly. Say so in task 4, so the implementer does not export it for the test's sake.
4. **Phase 2's run C differs from run B in more than timing.** Run C passes the stdlib functions in directly, so its calls run in the same process, with no `std::run` and no 0.4-second start. Run B's learned tools run in a child process. So B against C also measures call overhead and approvals. If run C builds its tools with the library `learn` before the first turn, the only difference left is up front against on demand. The phase 2 plan can decide this. The outline's table should say which version of run C it means.

---

## Claims I checked and found correct

- `.partial` and `.rename` both keep the handoff marker. Every derivation copies all options (`lib/runtime/agencyFunction.ts:294`), and the coordinator already offers a partial handoff (`cliTools.agency:96`).
- The caller's `context` is still present in the handoff's request. `minimalBrain` pushes it with `expires: "llmCall"`, the outer call claims it, and only that outer call removes it (`docs/dev/runtime/expiring-messages.md`). Test 8 checks the right thing.
- `agency agent --brain learntest` works with no harness change. The name is checked against `agencyAgentBrains()` (`lib/agents/agency-agent/agent.agency:193`), and the trace name is built from the brain name (`lib/agents/agency-agent/lib/agentName.agency:6`).
- The statics test scans only `stdlib/agents/brains/` and `stdlib/agents/agency.agency`. `learnedState` calls no function, and building the primer in a function avoids the test.
- `stdlib/agents/prompts/**/*.md` ships (`package.json:59`), and `_agentPromptsDir()` exists (`lib/stdlib/skills.ts:70`).
- All 25 index candidates are in `STDLIB_MODULES`.
- `std::math` exports `add`, which test 11 uses.
- An Agency file may define `def read`, as test 12 needs (`tests/agency-js/agent-tool-trace/agent.agency:21`).
- Other stdlib modules keep run state in a top-level `let`, for example `stdlib/index.agency:111`, so moving `learnedState` into the stdlib breaks no convention.

## On the owner questions in the plan

I agree with the plan's recommendations on questions 2, 3, and 5. Question 4 changes slightly if finding 9 is taken: the manual run should come from an empty folder, with the policy file in the plan.
