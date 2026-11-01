# Review: `agency workflow run`

Plan: `docs/superpowers/plans/2026-11-01-workflow-cli-run.md`

## Verdict

The plan has one blocker. As written, every run that the person's policy does not cover with a `"*"` rule fails before the workflow starts. The fix is one more start rule. The policy design is otherwise correct, and I checked it against `policy.ts` and `runPolicyHandler.ts`. The other findings are small.

## 1. The catch-all reject also rejects `loadWorkflow`'s prompt (blocker)

`wfRunNode` starts with this:

```
const wfEntry = wfLoad(name, dir) with approve
```

`loadWorkflow` raises `std::workflow::scan` with `dir: "<real project dir>/workflows"` (`stdlib/workflow.agency:628`). The run's policy is installed at the root of the driver as a handler in the chain (`lib/runtime/runPolicyHandler.ts`). The policy has no rule for `std::workflow::scan`, so `checkPolicyExplicit` falls through to the `"*"` rule the command added, which rejects. A rejection beats the `with approve`, so `loadWorkflow` fails and nothing runs.

Spawn case 1 (`--approve test::lists::add`) would fail on this, so the plan's own tests would catch it. The design should be fixed before then.

Recommended fix: add a fourth start rule.

```json
"std::workflow::scan": [{ "match": { "dir": "<real dir>/workflows" }, "action": "approve" }]
```

`loadWorkflow` builds that `dir` from `_realDir(dir)`, which follows symlinks. So the CLI must spell it with `fs.realpathSync(path.resolve(dir))`, not `path.resolve(dir)`. On macOS the spawn tests' temp folder sits under `/var`, which is a link to `/private/var`, so the wrong spelling would fail there and pass on Linux. Run the value through `escapeGlob` like the others. Add it to `StartPrompts`, to the Task 2 tests, and to the spec's list of start prompts.

The other option is to pass the workflow into `wfRunNode` as an argument and drop the load. That removes the prompt and the second read of the file. It also moves `loadWorkflow`'s check that the file name matches the workflow's name into the CLI. The extra rule is the smaller change.

## 2. "`unanswered` can happen only under a `"*"` rule" is wrong (small)

Step 6 says an unanswered interrupt "can happen only under a person's `"*"` rule that propagates". A per-effect rule can do it too. Take this policy:

```json
{ "test::lists::add": [{ "action": "propagate" }] }
```

`uncoveredEffects` counts `test::lists::add` as covered, so there is no prompt. At run time the rule matches and propagates, the run has no terminal (`interactive: false`), and the driver returns the interrupt unanswered. Fix the sentence, and add this policy as a unit test for the `unanswered` branch.

## 3. The prompt and the table go to stdout, so they break `--json` (small)

`confirmQuestion` (`lib/cli/remote/confirmation.ts:34`) writes its question to `process.stdout`, and the plan prints the table with `io.out`. With `--json`, a script reading stdout gets the table and `Approve all of them for this run? [y/N]` before the JSON. Print the table, the `NO_TERMINAL` line, and `Did not run.` to stderr. For the question, give `confirmQuestion` an output stream parameter that defaults to stdout, and pass stderr. Add one unit test: with `--json`, `out` holds only the JSON.

## 4. A budget trip: exit code and message (check while implementing)

`agency run` exits 3 when a budget runs out, with `Exceeded time limit` on stderr (`lib/cli/budgetRun.spawn.test.ts:73-90`). The plan exits 1, and the spec's exit code table has no 3. Either exit 3 here as well, so scripts treat both commands alike, or say in the user doc why `workflow run` differs. I would match `agency run`.

The root budget never raises an interrupt (`lib/runtime/rootBudget.ts:43`). I did not trace how a trip leaves the evaluate script that `runAgencyNode` spawns. If it throws, `runEvaluation()` rejects, Node exits 1, and `runDriver`'s message is the child's whole stderr, stack trace included. Case 7 checks only that the message "mentions the time budget", which a stack trace would pass. Make case 7 check the first line of what the command prints, so a raw stack trace fails the test.

## 5. Smaller notes

- **`prepareContainedPath` is async.** Step 4 calls it per module. Say `await` in the step, and note that it throws for a module that escapes `dir` or is a symlink. `plan.imports` holds only modules that described, so neither should happen, but a throw there should become exit 1 with a message, not a crash.
- **Tool modules with local imports.** The basic-commands review explains that `describe` cannot read a module that imports another local file. `run` inherits that limit, because `runWorkflow` checks the workflow first.
- **The `std::run` start rule is narrow enough.** It pins `node: "main"` and `depth: "1"`, not the module. I checked that this approves nothing extra: the only depth-1 `run` in the driver is `runWorkflow`'s, and a tool that calls `run` does so inside the child, at depth 2.
- **Task 3's `runSettings(options, input)`.** `applyCliFlags` uses `input` only to name a default trace file (`lib/config/config.ts:914`). `workflow run` takes no trace flag, so pass the driver's path or leave it out, and say which.

## What I checked and found correct

- **The policy engine.** Keys are exact effect names, with no globs or set names. An effect's own rules come first and the first match wins. `"*"` applies only when the effect's own rules matched nothing (`lib/runtime/policy.ts:57-88`). A number in the data is compared as `String(value)`, so `depth: "1"` matches. `escapeGlob` covers `*`, so test 5 in Task 2 is right.
- **The policy reaches the driver.** `runAgencyNode` spawns a plain `node` process, not an IPC child, so `installRunPolicyHandler` does not skip it. `withRootCarriers` puts `policyJson` in `AGENCY_RUN_POLICY`.
- **A rejection from the root policy wins.** `makeRunPolicyHandler` returns `reject()` for a reject rule, and the chain lets any rejection win. That is why item 1 blocks, and also why a person's `--reject std::workflow::run` stops the run in case 3.
- **The `std::read` spelling.** `read` gets its `dir` and `filename` from `locateSync`: the real root, and the path relative to it (`lib/host/node/nodeFiles.ts:197-216`). `prepareContainedPath` calls the same function, so the CLI's rules match what `read` raises. `std::workflow::run`'s `dir` is `resolve(dir)`, with no realpath, so `path.resolve` is the right spelling for that rule.
- **What `runWorkflow` raises before the first step.** `std::read` per local module, then `std::workflow::run`, then `std::run`. The `isPlumbing` helper in `tests/agency/workflow/runMealPlan.agency` lists exactly these three, and its tests would fail on any other. The new `std::workflow::scan` comes from the driver's `loadWorkflow`, not from `runWorkflow`.
- **The flag groups.** The seven groups in Task 3 cover every option inside `addRunOptions`, in order. `--trace`, `-i`, and `--capture-workdir` are added outside it, so splitting it does not move them.
- **`confirmQuestion` exists** and accepts `y` and `yes` in any case, which matches the spec.
