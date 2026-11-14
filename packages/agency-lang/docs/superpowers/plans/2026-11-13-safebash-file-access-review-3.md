# Review 3: saved output as files, and file access as data

Date: 2026-11-13. This reviews the spec and plan as revised after review 2:

- Spec: `docs/superpowers/specs/2026-11-13-safebash-file-access-design.md`
- Plan: `docs/superpowers/plans/2026-11-13-safebash-file-access.md`

I checked the claims below against `origin/main` at `a80b90157`. I did not run any code.

## Summary

The revision takes up all twelve findings from review 2, and the owner decisions settle the open questions. The design is now one rule function (`savedOutputRules`), one source type (`ReadSource`), and one list on the plan (`savedPaths`). Taking the reader check out of the runtime leaves `lib/runtime/` knowing less about tools than it does today, which I think is the best outcome of the three options.

What is left is mostly where the pieces meet. The two findings to fix before starting:

1. The order of `savedOutputRules` and `bashPlan` in the plan does not work as written, and the right order makes plan step 7 unnecessary (finding 1).
2. A read verb on a saved output still needs an effect with a path when the line does more than read, but a `saved` source has no path to build one from (finding 2).

Findings 3 to 6 are smaller corrections. Findings 7 to 9 are details.

## Fix before starting

### 1. `savedOutputRules` has to run after `bashPlan`, and then step 7 is not needed

Plan step 6 says to call `savedOutputRules` "once in `planFor`, on the effects every kind of plan ends with". Step 7 says to change `bashPlan` so that it keeps an empty effect list empty when `savedPaths` is not empty.

These two steps do not fit together. Follow `wc -l <saved output>`:

- The `wc` rule builds `[std::read <copy>]`.
- `bashPlan` sees one effect, so it leaves the list alone.
- `savedOutputRules` runs on the finished plan, sees that the line only reads, and drops the read. The list is now empty.

That is the result the owner wants, and `bashPlan` never needed to change. The change in step 7 would only matter for a line whose rules produced no effects in the first place, such as `echo /tmp/agency-spill-1000/x.log` or `cd /tmp && true /tmp/agency-spill-1000/x.log`. For those lines step 7 removes the `std::bash` question, because `savedPaths` is not empty, even though nothing about saved output was dropped. That is wider than decision 3 says. The decision is about a line that "reads only saved output".

So I would:

- Leave `bashPlan` as it is.
- Run `savedOutputRules` last in `planFor`, on the finished effect list. Say so in step 6.
- State the new rule as: a shell plan has no effects only when `savedOutputRules` dropped at least one read of a saved output. That is checkable: `savedOutputRules` can return how many it dropped, and a test can assert that `echo <saved path>` still asks `std::bash`.

The test "a shell line with no effects and no saved paths still asks `std::bash`" should become "with no saved-output read", and use `echo <saved path>` as the example.

The comments in `bashPlan` and `runBash` still need rewriting, since both state that every shell start raises an effect.

### 2. A read of a saved output in a mixed line needs an effect, and a `saved` source has no path

The spec says that when a line does more than read, "every effect is kept", and the `ln` example "keeps its `std::read`". `savedOutputRules` only drops or keeps effects, so that `std::read` must have been built by the `cat` rule.

The `cat` rule builds its `std::read` from what `resolveReadPath` returns. After this change `resolveReadPath` returns a `ReadSource`, and the spec gives the `saved` variant only a name: "A `saved` source has no folder and no file name". So there is no `dir` and `filename` for the rule to put in a `ReadPayload`, and the `ln` line has no `std::read` to keep.

The spec should say what the read rule emits for a `saved` source. I would give it a `std::read` with `dir` set to the folder as written in the command and `filename` set to the name. That is the path of the copy that the shell will read, and it is what a person would expect to see in the question. Then `savedOutputRules` matches it against `savedPaths` by the same folder and name. This means the `saved` variant carries the folder too: `{ kind: "saved"; folder: string; name: string }`. `textOf` still ignores the folder, so no executor can read the disk with it.

The same applies to `grep`, whose `std::grep` payload needs `dir` and `file`.

A related claim in the spec and plan is wrong. The spec says `python parse.py <saved output>` "asks `std::exec` for the program and `std::read` for the copy's path", and the "Known gaps" section says the same for `sed -n`. Plan test line 146 expects it for `sed`. Nothing produces that `std::read`. `python` and `sed` have no rule, so their only effect is `std::exec`, and safeBash does not add a `std::read` for a file argument of a program with no rule today. `savedOutputRules` never adds effects.

I think the current behavior is right and the text should change, not the code. An approved `sed` can already read any file with the same `std::exec` approval, so a `std::read` for the copy would protect nothing. The goal on spec line 30 already says this: a program with no rule "asks its own question as it does for any file". Change the `python` sentence on line 166, the `sed -n` known gap on line 267, and the plan's `sed` test so they expect only `std::exec`.

## Smaller findings

### 3. grep does not resolve its path through `resolveReadPath`

The spec says `resolveReadPath` is "the one path resolver the read verbs and grep share". On main it has two callers: the read verbs (`safeBash.agency:1855`) and input redirects (line 409). grep resolves its path through `resolveTarget` (line 1044), because a grep target can be a folder and `resolveReadPath` fails on a folder ("would read a directory").

Plan step 3 hedges this ("if the grep rules resolve their path anywhere other than through `resolveReadPath`, make them use it"). That instruction would break `grep -rn x src`. The plan should say that grep calls `resolveTarget`, and that the saved-output check goes at grep's call site or in a small function both callers share. It should not route grep through `resolveReadPath`.

Input redirects already go through `resolveReadPath`, so `wc -l < <saved output>` gets the saved source for free. Add it as a test, since it is a common way to count lines.

### 4. The folder rules need a second recognizer

`savedOutputRules` refuses a `write`, `remove`, `list` or `find` access "inside a saved-output folder". The only recognizer in the spec is `spillPathParts`, which matches a folder and a saved-output name together. Three of the refusals it should cover do not match that shape:

- `ls /tmp/agency-spill-1000`: the path is the folder itself, with no name.
- `echo x > /tmp/agency-spill-1000/notes.txt`: the name is not a saved-output name.
- `cd /tmp/agency-spill-1000 && ls`: the `std::ls` payload's `dir` is the folder.

The spec should add a second function beside `spillPathParts`, for example `inSpillFolder(path)`: true when the path is an `agency-spill-<id>` folder or anything below one. It should use the same named prefix constant. Add `echo x > <folder>/notes.txt` and `ls <folder>` to the safety tests. The current test list has `ls <folder>` but not the write.

The effect paths for a write or a listing are resolved to their real spelling at plan time, so on a Mac they start `/private/var/folders/…`. A recognizer that looks only at the last parts of the path, as `spillPathParts` does, handles that.

### 5. Reading a large saved output can push other saved outputs out of the store

`cat <saved output>` in process now goes through `runRead`, which calls `keepOutput` on the text (`safeBash.agency:5273`). When the text is long, `keepOutput` stores it again under a new name. The store holds at most 1,000,000 characters (`MAX_STORE_CHARS`), and it drops the oldest entries to make room. So reading a 600,000-character saved output with `cat` stores a second copy and evicts the first, along with whatever else was saved before it.

The same happens with `read`. `readSpill` is protected by `isSpillReader`, which stops the tool loop saving its result a second time. `read` is not on that list, and decision 5 rules out adding it. A `read` of a saved output with no limit can return up to 1,000,000 characters, which is over the agents' `spillToolResultsOver` of 100,000, so the loop saves it again.

Nothing breaks: the new notice names the new copy. But each read of a large saved output costs the model every older saved output.

The smallest fix I see is in `storeOutput`: when an entry with the same text is already in the store, return its name and store nothing. That is one comparison in one place, it covers `cat`, `read`, and any later reader, and it adds no tool names to the runtime. Add a test: save a large output, `cat` it, and check that the store still holds one entry.

### 6. A line that only mentions an evicted saved output fails

`savedPaths` takes every word that is a saved-output path, "whatever the command". `prepareSpillFiles` then fails the line when a name is not in the store. So `echo "see /tmp/agency-spill-1000/old.log"`, where the word is the whole path, or `git log -- /tmp/agency-spill-1000/old.log`, fails with "no longer available" when that output has been evicted.

That is probably fine. A model that names an old path is usually about to read it. The spec should state it as intended so an implementer does not add a special case, and the dev doc should list it beside the other-machine case.

## Details

### 7. Inconsistencies inside the documents

- Plan, "The shape to keep": "handled in five places" is followed by "it belongs in one of the four".
- Plan, Part 2 "Files": lists `stdlib/agents/lib/toolkits.agency` (`readCapped`), but step 10 says no bundle changes. It does not list `stdlib/index.agency`, which step 10 changes.
- Spec, "A host with no disk": "`prepareSpillFiles` is only reached before `_bash`". It is now reached before `_bash` and `_startJob`.
- Spec, "What it costs": the table has not changed since the first revision. Part 2 now adds `savedPaths`, `ReadSource`, `textOf`, `savedOutputRules`, a folder check, and a change to `read`. Part 3 now removes code from the runtime. The numbers may still be right, but they should be looked at again.

### 8. `userId()` on Windows

The Node host's user id comes from `process.getuid()`, which does not exist on Windows. The spec should say what the Node host answers there. A fixed value is fine, because the Windows temp folder is already per user.

### 9. The folder check when the folder is ours but open to others

`writeCopy` fails when the folder is owned by this user but has the wrong mode. That can happen if the user created it by hand, or if an older build made it with a different mode. The message should say what to do, for example "remove `/tmp/agency-spill-1000` or run `chmod 700` on it". Failing is the right choice. A `chmod` by `writeCopy` would come after anyone with access had already had the chance to plant a file.

## What I checked

- `read` is in `stdlib/index.agency:204`. It calls `_prepareContainedPath` (which refuses an absolute path) and then raises `std::read`. Step 10's "before the check that refuses an absolute path" means before `_prepareContainedPath`, which is the first statement after `applyAgentCwd`. `index.agency` already imports TypeScript helpers from `agency-lang/stdlib-lib/…`, so the import step is the existing pattern.
- `_readSpill` returns the whole text when `limit` is 0 (`lib/stdlib/spill.ts:48`), with no cap of its own. That is why finding 5 applies to `read`.
- `isSpillReader` is the only place the tool loop still looks at a tool's identity once `spillReaders` is removed (`toolInvocation.ts:228`).
- `nodeHost.tempDir()` is `os.tmpdir()` (`lib/host/node/nodeHost.ts:223`), so setting `TMPDIR` for a test run should work as the plan suggests.
- `bashPlan` (`safeBash.agency:3575`) and `runBash`'s comment (line 5135) are the two places that state the every-shell-start-raises-an-effect rule.
