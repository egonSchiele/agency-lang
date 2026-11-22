# Review: a command after `cd x && a;` gets narrow questions

Date: 2026-11-22. This reviews `2026-11-22-safebash-cd-then-semicolon-design.md`, the version that already takes the architecture review's findings.

**Verdict:** the design is right and the spec can go to the owner after the fixes below. One test expectation is wrong, and one test cannot fail. The other findings are small corrections to the text. I did not reopen the two decisions the architecture review settled.

## What I checked in the code, and found true

These claims in the spec hold on main (`03cfb2521`):

1. **The two folders can be compared as text.** `approvedPlan` passes the same `dir` to `planFor` (`stdlib/safeBash.agency:6071`) and `runPlanned` passes it on to `runSteps` (`:6135`). The planner starts from `freshLine(cwd)`, and the runner starts from `cwd: dir`. After a `cd`, the planner sets `line.cwd` to the folder `cdTarget` returned, and `runCd` sets `state.cwd` to `step.dir`, which is that same string (`:7334`). Neither side resolves links, so the "folder reached through a link" test row should pass.
2. **Groups agree.** The planner puts the folder back after parentheses (`classifyGroup`, `:5563`), and so does the runner (`runGroup`, `:7193`). So `(cd sub && ls); ls` plans and runs the last `ls` in the starting folder, and the new check does not fire.
3. **A step that is skipped is never checked.** `runStepList` skips a step by its join before it calls `runOneStep` (`:7171`). In `pnpm build && cd dist && ls; cat out.txt`, a failed build skips the `cd` and the `ls`, and the check runs only for `cat`.
4. **Jobs are not affected.** A job is one step, or a `cd` and then one step (`jobShape`, `:6163`). The `cd` comes first in the job's line, so nothing before it can cause it to be skipped.
5. **The runner raises nothing.** Every question is raised in `approvedPlan`. The change adds a comparison and a stop, and no interrupt, so no handler can be skipped.
6. **The stop's label has one reader.** `lib/stdlib/agentToolTrace.ts:327` matches `[stopped: the plan changed]`. Nothing else reads the `planChanged` failure type.
7. **The test lines plan narrow today, apart from the refusal being deleted.** `false` is a quiet verb (`QUIET_VERBS`, `:594`), and `safeBashSteps.agency:61` already uses `false &&`. `ls | wc -l` runs through bash, because `inProcessPipeline` takes only `cat`, `head`, `tail`, and `grep` after the first stage (`:5462`).

## Findings

### 1. The `rm` test row expects a refusal, and the line asks `std::bash` instead

The spec says that `cd .. && ls; rm -rf <the starting folder's name>` "is still refused". The code does something else.

The refuse wall in `planLine` checks every `rm` with the line's starting folder (`:5023`). From `/parent/proj`, the target `proj` means `/parent/proj/proj`. That folder is usually missing, so the wall does not refuse the line.

The second check is in `removeEffects` (`:5821`), which runs in the folder `classify` gives it. Here that is `/parent`, so it finds the starting folder. But a failure in `removeEffects` makes the line ask the broad question. It does not refuse the line. Its comment says so: "A target refused from this folder gets no std::remove … and the line asks std::bash."

Change the test row to expect `std::bash` with no `std::remove`. Then fix the bullet under "Interrupts and safety" to describe the same outcome.

This spec does not change how that line is handled. Today the `;` refusal makes it broad, and after the change `removeEffects` does. The behaviour is the same before and after, so this finding is about the text and the test. It is not a new hole.

### 2. The test for a step bash runs passes without the new check

The spec has two run tests for a skipped `cd`:

```
false && cd sub; cat one.txt
false && cd sub; ls | wc -l
```

The second one is meant to cover a step bash runs. That step already goes through `folderChange` in `checkedStep`, which compares real paths. After a skipped `cd`, the line is in the starting folder and the step was planned in `sub`, so `folderChange` stops the line today, with the sentence "that folder now leads to…". The architecture review says the same thing in its "80/20" section.

As written ("stops the same way"), the test would pass if the new check were deleted. Make it assert the new sentence, "planned to run in … and the line is still in …". Then it fails without the check.

A second, smaller problem: `ls | wc -l` is a bash step only because `wc` is not an in-process filter yet. If `wc` is added to `stdinFilter`, the test quietly becomes a second copy of the `cat` test. Either pick a step no rule will take in process, or have the test also plan the line and check that the step's `inProcess` is null.

### 3. A second `cd` after a skipped one stops with the wrong reason

The spec says a skipped `cd` followed by a second `cd` "needs no new code". That is true for whether the line stops. The reason the line gives is wrong for a relative `cd`:

```
false && cd sub; cd other && ls
```

The planner resolves `other` from `sub` and approves `/repo/sub/other`. At run time, `runCd` resolves `other` from `/repo` and finds either nothing or `/repo/other`. The line stops with "it was approved to enter /repo/sub/other, and that folder now leads to /repo/other" (`:7331`). That message tells the model the disk changed, and the disk did not change.

The fix is to run the same check before a `cd` step as well as before a run step: one helper, called from `runOneStep` and from `runCd`. A `CdStep` already records the folder it was planned in (`cwd: line.cwd`, `:5731`). This follows the spec's own rule, which says "a command", and a `cd` is a command.

There is one cost. The test row `false && cd /absolute/sub; cd /absolute/other && ls` would stop instead of running `ls`. No logged line has that shape. The paragraph "A `cd` that was skipped and is followed by a second `cd` needs no new code" then goes away, and "`runCd` does not change" becomes "`runCd` calls the same check".

### 4. The bullet on a `cd` to the right of `||` gives the wrong reason

"What does not change" says `test -d out || cd lib; ls` stays broad because the new rule would stop the line on its normal path. That is a reason not to relax the rule, but nothing relaxes it. The line is broad today for a separate reason: a `cd` on the right of `||` is treated as a plain builtin, and `execEffects` refuses it. The dev doc says this in the `cd` section. The next bullet, about `cd lib || echo no`, already gives this reason.

Merge the two bullets into one: a `cd` on either side of `||` is a plain builtin and stays broad.

### 5. "A `cd` that fails does not let the line carry on" is true only for a missing or moved folder

`runCd` stops the line when the folder is gone or now leads elsewhere. It does not check that the folder can be entered. When the folder exists and cannot be entered, `runCd` moves the line there, and the later commands fail to start in it. For a step bash runs, the line carries on with status 1, because `missingFolderStops` is false after `cd x &&`. For a step safeBash runs itself, the stdlib tool fails to open its path.

No question is false in either case, because each command runs in the folder its question named, or fails there. Add one sentence to "What has changed since the rule was written", or point at the "A shell that cannot start in the line's folder" bullet.

### 6. List the comments the change has to update

"The code" lists the two edits but not the comments that describe the old rule. Each of these would be wrong after the change:

1. `classifyAnd`, `:5585`: "`;` and `||` after it are refused by `classifyAll` and `classifyOr`". Only `||` stays.
2. `classifyAll`, `:5124`: the comment on the refusal, which is deleted with it.
3. `tests/agency/safeBash.agency:2517`: the comment over `cdOnItsOwnLineStaysStrict` ends with "and `cd x && a; b`".
4. `tests/agency/safeBash.agency:2549`: "After `;` or `||` the directory depends on whether the `cd` worked".

The dev doc's `cd` section also says that "after `;` or a newline … safeBash adds a guard that ends the script". The architecture review found that this guard never runs. The spec leaves `cdOrExit` in the code, but the rewritten section should say that the runner stops the line. It should present the guard only as text that appears in the log record.

## Size

The spec says half a day. With finding 3 taken, the change is one deletion and one check that runs in two places. The estimate still holds.
