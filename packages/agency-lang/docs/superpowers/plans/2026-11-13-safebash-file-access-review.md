# Review: safeBash file access, in-process pipelines, saved output as files

Date: 2026-11-13. This reviews two documents together:

- Spec: `docs/superpowers/specs/2026-11-13-safebash-file-access-design.md`
- Plan: `docs/superpowers/plans/2026-11-13-safebash-file-access.md`

**Note, added after the review.** The spec and plan were revised the same day, so this review describes their first version. The revision drops the in-process pipeline runner and the mount table, writes a real copy of a saved output when a real program needs one, and reads file accesses out of a plan's effects. That settles findings 1 to 8 and 10, and applies findings 9, 11 and 12. The spec's last section lists the changes.

## Summary

The four parts are in the right order, and the plan gives a new agent what it needs to start. Every function, type, table and test the two documents name exists in the code, apart from two names that come from PR #1472, which has not merged (finding 9).

Parts 1 and 2 are ready to build once the points below are settled. Part 3 is not. The spec gives it a benefit it does not have, and it sets a rule (output matches the real program) that its own grep source already breaks. Part 4 leaves one design choice to the implementer that I think the plan should make.

There are five things to fix before any work starts (findings 1 to 5) and seven smaller ones.

## Fix before starting

### 1. Part 3 does not reduce approval prompts for files on disk

The spec says the owner's goal is "fewer prompts for commands that read and search", and that Part 3 buys this: "every `grep … | head` and `cat … | tail` on real files now runs with no shell, under the read and grep effects".

A recognized pipeline already raises only those effects today. The dev doc says so in "Pipelines, dup redirects, and glob words": "a pipeline is recognized when every stage is, its effects are the union, and it runs through bash as the rebuilt text". So `grep -n x a.txt | head -3` asks one `std::grep` question before this work and one after. The number of prompts does not change.

What Part 3 does buy is narrower:

- A pipeline can read a mounted path, which a real shell cannot. This is what Part 4 needs.
- The same output on every machine.

That changes the cost argument. Part 3 is the largest and riskiest part (about 900 source lines and 700 test lines in the spec's own table), and its only user is saved output. The spec should say this plainly, and the Part 0 gate in the plan should change to match. The plan now says to warn the owner "if group 2 is under a few percent of commands". The count of pipelines over disk files does not measure the benefit, because those pipelines gain nothing in prompts. Finding 2 says what to measure.

### 2. Part 0 measures the wrong transcripts for the decision it feeds

Part 0 counts the shapes of bash commands in the Agency runs. Those runs never saw a saved-output path, so they cannot show what a model does with one.

The Pi runs can. Pi writes long output to a temp file and names the path, which is the behavior this design copies. The Pi transcripts from the same benchmark show exactly which commands a model runs on such a path. I would add this to Part 0, and make it the main input:

- For every command in a Pi run that names one of Pi's temp output files, record the verb, the flags, and whether it is a lone command or a pipeline.

I expect two results that the current design does not handle, and the count will say how much they matter:

- **`sed -n '100,200p' file`.** The spec's own background lists `sed -n` among the commands models reach for first. It is the usual way a model takes a slice of a file. `sed` is not in `READ_VERBS` and not in the filter list, so on a mounted path it would be refused.
- **Lone `wc -l file`.** Part 2 makes only lone `cat`, `head`, `tail` and `grep` work on a mount. `wc` is a filter in Part 3 but not a lone command, and the dev doc lists "`wc` in process" as left out on purpose.

Each refusal costs the model a round, which is the cost this work is meant to remove. If these two are common in the Pi runs, they belong in Part 2's scope ahead of most of the Part 3 filters.

Part 0 should also count how many candidate pipelines carry `2>&1` or `2>/dev/null`. Models add these often, and a stage with a redirect falls out of the in-process path under the plan's rules.

### 3. The grep source cannot meet "output must match the real program"

The spec's rule for Part 3 is that output matches the real program for every accepted flag. A pipeline's grep source is today's in-process grep (`tryShellFreeGrep`), which does not match real grep in three documented ways:

- It skips what `.gitignore` ignores and the `SKIP_DIRS` names ("A lone grep runs the tool's search" in `safe-bash.md`).
- It stops at a match limit.
- It appends a note saying what it skipped or that it reached the limit (`grepNotes`).

For a lone grep, the model reads the note and understands. In a pipeline the next stage reads the text instead:

- `grep -rn TODO . | wc -l` runs real grep today and prints the true count. In process it would print a smaller count, with no sign that anything was skipped.
- If the note is part of the source's text, `tail -3` would return the note as output lines.

The spec needs a rule for this. I would choose the first of these:

1. A recursive grep is not a pipeline source. Only a grep of named files is, because for those the tool's search and real grep read the same bytes. `grep -rn x src | head` keeps running in bash, as now.
2. Or: the source's notes are held apart from its text and added after the last filter, and the spec states that a count over a recursive grep can be lower than real grep's.

### 4. What a pipeline does when its source fails is not defined

The spec says the exit status is the last stage's, as in bash. It does not say what happens when the first stage fails. In bash:

```
$ cat missing.txt | wc -l
cat: missing.txt: No such file or directory
0
$ echo $?
0
```

The error goes to stderr, the filter runs on empty input, and the line succeeds. In process, a read of a missing file is refused when the plan is made, and `runRead` returns the failure alone. So the same line would fail.

Two more cases need an answer in the spec:

- `grep zzz a.txt | head`: the grep finds nothing. In bash the pipeline exits 0 with no output. In process, `runGrep` returns an exit-1 failure for no matches, and the plan's runner must not pass that on.
- `cat a.txt missing.txt | wc -l`: the doc says a failed read drops the text of the files before it.

The simplest rule that stays truthful is to plan in process only when every source path resolves at plan time, and to send the line down today's path otherwise. Then bash produces bash's own behavior for the failing cases. The no-match grep source still needs its own line in the spec: empty text, and the pipeline continues.

### 5. The size rule turns a working command into a failure

The spec says a source larger than the read tool's bound should "fail with a message". Today `grep ERROR big.log | tail -20` on a large file works, because bash streams it. After Part 3 the same command would fail.

`resolveReadPath` already stats the file when the plan is made, so the size is known before anything is decided. A source over the bound should make the line not eligible for the in-process path, and it then runs in bash as it does now. A failure is only right for a mounted source, which bash cannot read, and the store caps those at about a million characters.

## Smaller findings

### 6. `FileAccess` lets a store access carry a disk path

```
export type FileAccess = {
  mode: ...; dir: string; filename: string; place: Place
}
```

A store access has no `dir` and `filename`, but the type makes it carry both. The danger is a later executor that reads `access.dir` and `access.filename` with `_read` without looking at `place`. `effectFor` returned null for that access, so this would be a disk read that no handler was asked about. That is the kind of mistake the handler rules in `CLAUDE.md` exist to prevent.

A union removes the possibility:

```
export type FileAccess =
  | { mode: FileMode; place: "disk"; dir: string; filename: string }
  | { mode: "read" | "search"; place: "store"; name: string }
```

A store access then has no path to misuse, and it cannot be a write or a remove, which matches the rule that a mount is read-only.

The spec's "Things that are easy to get wrong" section should also state the rule in one sentence: whether an access raises an effect and where its bytes are read from are both decided by `place`, never by the path's text.

### 7. "`plan.accesses` is complete" is not true as written

The spec says a policy helper can ask "does this plan only read, and only under this folder?" from the accesses. It also says the git, gh, `std::exec` and `std::bash` effects are untouched and are not accesses.

So for `cat a.txt && git checkout -- a.txt`, the accesses hold one read, and the plan also overwrites a file. A helper that trusts the accesses alone would give a wrong answer. The spec should define "complete" as "holds every file effect the plan raises", and say that a caller must also check that the plan has no other effects. A small helper that does both checks would keep callers from getting it wrong.

Two gaps in the type itself:

- `find` raises a glob effect (`GlobPayload`), and the mode list has no entry for it. Either add a mode or say `find` maps to `list`.
- Nothing in Parts 2 to 4 reads a `write`, `remove` or `list` access. Their only use is the helper above. That is fine if the owner wants the data for its own sake, which the plan says is the case, but the spec's cost table should not count Part 1 as free for those three.

### 8. "Adding another mount is one row" overstates it

`Place` has one non-disk kind, `{ kind: "store"; name }`, and `bytesOf` and the grep path each have an arm for it. A second mount that is not the spill store needs a new `Place` kind, a new arm in `bytesOf`, and a new arm wherever grep reads stored text. The goal should say "one row and one reader".

### 9. The plan depends on PR #1472, which has not merged

The spec and plan use `tailNotice`, `exitIsFailure`, and `data.type == "commandExit"`. None of these are on the branch this worktree was cut from (`e0d23da8f`). The plan should say to merge `main` in after #1472 lands, before Part 1.

One detail has already changed in that PR. The plan and spec quote the agents' tool as `safeBash.partial(cwd: "", exitIsFailure: false)`. It is now `modelSafeBash().partial(cwd: "")`, and `shellTools()` hands the same binding to every agent, so the point about a no-match `grep` filter applies to all of them, not only the coding agents.

### 10. `wc` reverses an existing decision without saying so

`safe-bash.md` lists "`wc` in process" under what is left out, because "GNU and BSD pad the count column differently". The spec's filter list has `wc` fourth and settles the difference with a new rule: use GNU's behavior under `LC_ALL=C`.

That may be the right call. A model does not care about padding. But the same bullet in the spec opens with "Output must match the real program … on GNU, BSD and busybox", and the two statements disagree. On a Mac, `cat a.txt | wc -l` would print `5` where the real program prints `       5`. The spec should say outright that in-process output may differ from the local program where the three differ, and name this as a change to the dev doc's existing position.

It also affects the comparison suite in the plan. Tests that compare bytes against the real program will fail on a Mac for every such flag. The plan should say the suite runs against GNU tools with `LC_ALL=C` only, which in practice means in CI.

### 11. Part 4 leaves a design choice to the implementer

Step 2 says: "decide how `keepOutput` learns which wording to use". I think the plan can answer this now. Whoever called `safeBash` can call it again, so a notice that `safeBash` writes can always name the path, and it never needs the tool list. Only the tool loop's notice for other tools (a fetched page) needs to choose, and the loop already knows the call's tools.

Step 3 has the same problem in a smaller way. "Extend that same mechanism so a function can declare" does not say how. `spillReaders` matches a fixed module and registered name. `ToolMarkers` in `lib/runtime/agencyFunction.ts` is the existing way for a function to carry a fact that the tool loop reads (`handoff` works this way). The plan should name the marker and say how an Agency function sets it.

One more point on step 1. The `read` tool's description tells the model that absolute paths are refused, and the agent prompt says to use `read` instead of `cat`. So the first thing a model will do with `/tmp/agency-spill/x.log` is call `read` with an absolute `filename`. Step 4 does say to update the description. Add a test for exactly that call, since it is the most likely one.

### 12. Details

- **`PipeExec.source` is typed too widely.** `source: StepExec` allows a write, and once `PipeExec` joins `StepExec` it allows a pipe inside a pipe. The source should be `EchoExec | GrepExec | ReadExec`.
- **The refusal can catch commands that only mention the path.** "A line that names a mounted path and cannot run in process is refused" would refuse `git commit -m "see /tmp/agency-spill/x.log"` and `grep -n "/tmp/agency-spill" notes.md`. For a line that parses, the check should look at words in a path position for the verbs that have a rule, and at any argument for a program with no rule. The raw-text check should apply only to a string that does not parse. Add both examples as tests.
- **Other spellings of the mount.** `cd /tmp/agency-spill && cat x.log`, `/tmp//agency-spill/x.log`, and `/private/tmp/agency-spill/x.log` on a Mac do not match the prefix. They fall through to a disk read, which asks `std::read` and fails with "No such file". That is safe, because nothing is read without a question. The spec should say these are known misses and that missing in this direction is the safe one.
- **The notice should say what works.** `Full output: /tmp/agency-spill/x.log` gives the model no sign that `python` or `less` will be refused. The tool description carries it after Part 4, but the notice is what the model reads at that moment. A few words, such as "read it with read, cat, head, tail or grep", cost little.
- **The Agency snippets in the spec have not been checked.** The nested object pattern in `effectFor`, the function-typed field in a `static const`, and `try _read(...)` should each be run through `pnpm run ast` before an agent copies them, as `CLAUDE.md` asks for plans and specs.

## What I checked

- All 24 names the documents cite in `stdlib/safeBash.agency`, `stdlib/safeBash/actions.agency`, `lib/runtime/`, `lib/stdlib/` and the tests exist, except the two from PR #1472.
- The line counts (5,377 and 2,699) are right. The test file has 134 cases; the plan says about 135.
- `printRead` and `printGrep` already return full text with no `keepOutput`, so a pipeline source has the functions it needs.
- `isOutputName` accepts only `[0-9A-Za-z][0-9A-Za-z_-]*\.log`, so the flat-name rule for `spillPlace` holds with no extra code.
- The agents set `spillToolResultsOver` to 100,000, above what `safeBash` returns, so Part 4 does not cause a result to be saved twice.

I did not run any code or tests for this review.
