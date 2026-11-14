# Review 2: saved output as files, and file access as data

Date: 2026-11-13. This reviews the revised spec and plan:

- Spec: `docs/superpowers/specs/2026-11-13-safebash-file-access-design.md`
- Plan: `docs/superpowers/plans/2026-11-13-safebash-file-access.md`

The first review, of the first version, is in `2026-11-13-safebash-file-access-review.md` beside this file. I left it unchanged.

I checked every claim below against `origin/main` at `a80b90157`, which includes PR #1472. I did not run any code.

## Summary

The revision is much smaller and easier to follow than the first version. Writing a real copy at the moment a real program needs it removes the pipeline runner and the mount table, and Part 1 is now two pure functions. I agree with the direction.

The weak point is the rule that makes it safe to leave out the read question on the bash path. The spec states it as: "a path gets this treatment only when the bytes the command reads are the store's", and it argues that `prepareSpillFiles` makes this true. It holds in the plain case, but four cases break it (findings 1 to 4). Each has a small fix, and none of them changes the design.

Two more findings change what the user sees. A `bash` line that reads only saved output would ask the broad `std::bash` question, because of an existing rule in `bashPlan` the spec does not mention (finding 5). And the notice change in Part 3 reaches `keepOutput`, which `jobOutput` and user programs also call (finding 6).

Fix findings 1 to 6 in the spec and plan before work starts. Findings 7 to 12 are smaller.

## Fix before starting

### 1. Another user can own the folder on Linux

On Linux `/tmp` is shared, and the folder name `agency-spill-<user id>` is easy to guess. Another user can create `/tmp/agency-spill-1000` before user 1000 does, with mode `0777`. Then:

1. `prepareSpillFiles` finds the folder, sees that it is a real folder and not a link, and writes the copy into it.
2. The other user replaces the copy with a symlink to `/home/victim/.ssh/id_rsa`. They own the folder, so they can rename and delete files in it. The sticky bit on `/tmp` does not protect files inside a subfolder.
3. bash runs `cat /tmp/agency-spill-1000/x.log` as the victim. `cat` follows the link and prints the key. No `std::read` was asked, because the path is a saved output.

The spec's defence is that the contained-files layer refuses a symlink below its root. That stops a link at write time. It does not stop a link that appears after the write and before bash reads the file, and it does nothing about who owns the folder.

The fix is a check in `writeCopy`: after it creates or finds the folder, it requires that the folder is owned by this user and that no one else can write to it (`lstat`, then compare the owner and the mode). If either fails, the line fails with a message and bash does not run. The plan's safety tests should plant a folder with the wrong owner or mode, as well as a symlink.

On a Mac the temp folder is already private to the user, so this matters on Linux, which is where the SWE-bench runs and most servers are.

The spec also says the folder and each copy are "readable by the user only". The host's `WriteOptions` has `fileMode` for the file and `makeFolders`, but no mode for the folders it makes (`lib/host/host.ts:67`). The plan should say how the folder gets mode `0700`: either a new option or an explicit `chmod` through the host.

### 2. An earlier command in the same line can change the copy

`prepareSpillFiles` writes the copies once, before the whole line runs. A command earlier in the line can then change a copy before a later read verb reads it:

```
ln -sf ~/.ssh/id_rsa /tmp/agency-spill-1000/x.log; cat /tmp/agency-spill-1000/x.log
```

`ln` has no rule, so it asks `std::exec` with `ln` and its arguments. A person reading that question might approve it, and a policy that always approves `std::exec` for `ln` would approve it with no person involved. The `cat` then reads the key, and no `std::read` question was asked for it. The approval was for making a link, and it became a read of a private file.

The same works with `cp`, `mv`, `tee`, a `python` one-liner, or anything else that can write.

The spec says "an opaque program can still write to a copy. That changes nothing, because the copy is rewritten from the store before the next line that names it." That is true across lines. It is false inside one line.

The smallest fix I can see: leave out the read question for a saved-output path only when every other effect in the plan is a read-family effect (`std::read`, `std::grep`, `std::ls`, `std::glob`). A line that also raises `std::exec`, `std::bash`, `std::write`, `std::remove`, or any git or gh effect keeps the ordinary `std::read` for the copy's path. `python parse.py <path>` then asks two questions, `std::exec` and a `std::read` for a temp path. That is one extra question on a line that already asks one, and the common read-only lines (`wc -l`, `tail`, `grep … | head`) stay free.

A background job started earlier could do the same thing in the gap between `writeCopy` and the read, but only after its own `std::bash` or `std::exec` question was approved for a command that names the folder. I would accept that and say so in the dev doc.

Add a safety test for the `ln` line above, with `std::exec` approved and `std::read` rejected: the line must fail.

### 3. The plan and `prepareSpillFiles` can disagree about which paths are saved outputs

Two different functions decide whether a path is a saved output:

- The plan uses the parsed words (Part 2, step 4). When it sees a saved-output path in a read verb, it leaves out the read question.
- `prepareSpillFiles` uses `spillPathsIn`, a scan of the raw command text (spec, "Three ways a saved output is read", case 2).

These can disagree. In `cat /tmp/agency-spill-1000/'x'.log` the parsed word is the full saved-output path, but the raw text never contains that path in one piece. The plan leaves out the read question, and `prepareSpillFiles` writes nothing. bash then reads whatever is on disk at that path: an old copy, a copy an earlier line changed, or a link from finding 2. The same applies to `"$D"/x.log` after an assignment, and to backslash escapes.

The fix: on a line that parses, `prepareSpillFiles` takes its list of paths from the plan, which is the same list that decided which reads were free. The raw-text scan is used only for a line that did not parse. That line asks the broad question anyway, so nothing is free on it. Add the quoted example above as a test.

The plan's step 6 check ("a search for `_bash(` should find exactly one call outside that function") would then pass a list of paths, not the command text.

### 4. `startJob` does not call `_bash`

The spec says every path into `_bash` goes through `prepareSpillFiles`, "including the bash a background job starts". The plan's step 6 checks this by searching for `_bash(`.

`startJob` calls `_startJob` (`stdlib/safeBash.agency:4625` on main), not `_bash`. `runBash` holds the only `_bash` call (line 5144). So the search the plan gives would pass with the job path left out. On that path, a job that runs `wc -l <saved output>` gets the free read and no copy, so it reads whatever is on disk.

The plan should name both calls, `_bash` in `runBash` and `_startJob` in `startJob`, and the check should search for both. A small function that both call before they start a shell would do it. `prepareSpillFiles` is cheap, so it can run in both places.

### 5. A `bash` line that reads only saved output asks the broad question

`bashPlan` (`stdlib/safeBash.agency:3575-3579` on main) turns an empty effect list into `[BASH_EFFECT]`:

```
// Spawning a shell always raises at least one effect, so a log of
// effects is a complete audit of shell invocations.
const raised = if effects.length == 0 then [BASH_EFFECT] else effects
```

`runBash`'s comment relies on the same rule: "Every plan raises at least one effect, so no classification bug can turn into an ungated shell call."

So `wc -l <saved output>`, with its read left out, becomes a plan with no effects, and `bashPlan` gives it the broad `std::bash` question. The spec's own example ("`wc -l <saved output>` raises nothing") does not hold, and the plan's test "`wc -l <path>` … raises nothing" would fail. The same is true of `grep -c x <path> | cat`, `tail -50 <path> | head`, and any other line that reads only saved output and goes to bash.

The spec needs to decide this. The choices I see:

1. Keep the rule, and accept that these lines ask `std::bash`. That defeats the main goal.
2. Drop the rule for a line whose only reads are saved outputs. The audit property in the comment then becomes "every shell start raises an effect or reads only saved output", and the comment in `runBash` has to change with it.
3. Add a narrow effect for these lines, such as `std::readSaved`, that the agents' shipped policy approves. The audit property holds. A user program with no handler would then be asked about it, which goes against "reading saved output never asks for approval".

I would choose option 2, because the store's text is already the model's and the line is fully recognized. It changes a stated safety rule in safeBash, so it should be an owner decision in the spec's list, with the new rule written out.

### 6. Part 3 changes `keepOutput` for callers that are not `safeBash`

Part 3, step 1 says "`_keepOutput` always writes the path wording". The spec's reason is that "whoever called `safeBash` can call it again".

`_keepOutput` is behind `keepOutput`, a public stdlib function, and `safeBash` is not its only caller:

- `jobOutput` in `stdlib/jobs.agency:82-83` calls it for a job's stdout and stderr.
- The coordinator's main agent gets the job tools and `spillTools()` (`coordinator.agency:160-168`) and no shell. After this change its job notices would name a path that it has nothing to read with. Its `read` comes from `writableFileTools()`, which is plain `read`, not `readCapped`.
- `keepOutput`'s doc comment tells user programs to include `readSpill` and `grepSpill`. A user program that followed that advice would get notices that name neither tool.

The plan should keep `keepOutput` as it is and give `safeBash` its own way to ask for the path wording: a parameter, or a separate function that `safeBash`'s executors call. Then decide separately whether `jobOutput` should use the path wording. The job's output is often what a model would want to `tail`, so it probably should, but only for agents that carry a shell.

## Smaller findings

### 7. The `read` the notice names is not always `readCapped`

The notice says "read it with read". Only the coding bundle's `read` is `readCapped`. The verifier gets `readOnlyFileTools()` and `shellTools()` (`stdlib/agents/verifier.agency:39`), and its `read` is plain `read.partial(useAgentCwd: true)`. That `read` refuses an absolute path. So a verifier model that follows the notice gets an error and spends a round.

Two ways to fix it:

- Put the saved-output check in `std::fs`'s `read`, before it raises `std::read`, and not in `readCapped`. Every agent's `read` then works, and `readCapped` gets it for free because it calls `read`. The rule about leaving out the read question then lives in one stdlib function, and the reader identity in Part 3 becomes `read` from `std::fs`, which is a stdlib module and not an agents library.
- Or the notice names `read` only when the call's tools include `readCapped`. For a `safeBash` notice, which does not know the tools, that means naming only bash commands.

I prefer the first. Either way, step 8 should say that `readCapped` calls `readSpill` for the store read, so the offset and limit handling is not written twice.

### 8. `sed -n` asks a question

The goal says "reading saved output never asks for approval, whichever command reads it". The notice in the spec suggests `sed -n`. `sed` has no rule in safeBash, so `sed -n '100,200p' <path>` asks `std::exec` for `sed`, like any program with no rule. `awk`, `less` and `python` do the same.

That is the right behavior given the "Not goals" section. The goal should say "whichever recognized read verb reads it", and the notice should suggest only commands that are free: `read`, `tail`, `head`, `grep`, `wc`. Otherwise the first thing a model tries from the notice asks a question. The plan's test for `sed -n '2,3p'` should expect the `std::exec` question.

### 9. The reader identity in Part 3 adds tool names to `lib/runtime/`

Part 3, step 2 adds `safeBash` and `readCapped` to the module-and-name list that `isReader` matches in `lib/runtime/toolOutputStore.ts`. The spec calls this "the existing convention, in the existing place". It is the existing convention for `readSpill` and `grepSpill`. It is also the shape the owner turned down in #1458, a runtime branch on one tool's identity, and `readCapped` lives in `stdlib/agents/lib/`, which the runtime has not named before.

`ToolMarkers` in `lib/runtime/agencyFunction.ts:96` is how a function carries a fact the tool loop reads (`handoff` uses it). The plan should either use a marker or say why a name list is right here. If finding 7's first fix is taken, the list holds only stdlib names (`safeBash` and `read`), which is closer to what is there today.

### 10. The tests that write copies need a way to set the temp folder

The plan says copy-writing tests must use "the memory host or a scratch folder the test creates". The memory host has no `_bash`, so the real-program tests cannot use it. The Node host's `tempDir()` comes from `os.tmpdir()`, which reads `TMPDIR`. The plan should say how an Agency test sets that: an environment variable on the test run, a config option, or a host override. Without it, the tests write into the real `/tmp` on every CI run.

### 11. `exec` does not write copies

`shellTools()` also hands out `exec` (`toolkits.agency:222`). `exec("wc", ["-l", "<path>"])` does not go through safeBash, so no copy is written and the program fails with "No such file". It asks `std::exec`, so nothing is read without a question. The model only loses a round. The spec should list this as a known gap, or have `exec` call the same preparation step.

### 12. Details

- **Two spellings of the folder.** `spillFolder` has a trailing separator. `spillPathParts` returns a `folder`. The comparison `folder !== here` works only if the two use the same spelling, including the trailing separator, and on a Mac the same choice between `/var/folders/…` and `/private/var/folders/…`. `root()` realpaths its argument, so a path built from `root()` and one built from `tempDir()` will differ on a Mac. The plan should say that both come from `host.system.tempDir()` without a realpath, and test that a path from the notice passes the check on a Mac.
- **Part 1 test for `find`.** `find . -name '*.py'` raises `std::glob`, and the access path is `dir`. The plan's table drops the pattern. That is fine for a "which folders" question, but the doc should say that a `find` access names the folder searched and not the files found.
- **Plan: the merge of main.** PR #1472 merged at `a80b90157`. The "Before you start" step can say that `main` is ready to merge in.
- **`printRead` and the store.** Step 3 says to read the store "where the path is a saved output". `ReadExec` carries resolved paths from plan time. The plan should say which field marks a path as a saved output in the execution, so the executor never has to look at the path text again. That keeps the rule from finding 3 on the in-process side too: the plan decides once, and everything after reads that decision.

## What I checked

- `isOutputName`, `findOutput`, `missingOutputMessage`, `outputNotice`, `tailNotice`, `spillReaders`, `spillSettings`, `_keepOutput`, `planRecord`, `resolveReadPath`, `_searchTargetIn`, `readCapped`, `startJob` and `runBash` exist on main with the shapes the documents describe.
- The effect payloads in Part 1's table match `stdlib/safeBash/actions.agency`: `std::read` has `dir` and `filename`, `std::grep` has `dir` and `file`, `std::write` has `dir` and `filename`, `std::remove` has `target`, `std::ls` has `dir`, `std::glob` has `dir` and `pattern`.
- `Plan` has `broadReason`, so "the plan is not broad" in Part 1, step 2 is `plan.broadReason == null`.
- `lookupOf` in `actions.agency` is already an exhaustive match over effect names, so Part 1's `accessesOf` can follow the same pattern.
- `HostSystem` has `tempDir()` and no user id. The browser and memory hosts answer `/tmp`.
