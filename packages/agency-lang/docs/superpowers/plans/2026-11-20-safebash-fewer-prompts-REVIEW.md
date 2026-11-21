# Architecture review: safeBash fewer-prompts plan

Reviewed: `2026-11-20-safebash-fewer-prompts.md` at commit 3bd451895.

The plan's goal is that a line of ordinary coding commands asks a question a policy can answer. This review checks the plan against that goal only.

Counts below are out of the 89 distinct commands in the logs, unless a line says "of the 51 broad lines".

## Summary

The plan has the right shape: every change is a rule inside `planFor`, and nothing new is added to how a plan is raised or run. Three things are wrong with it.

1. **It builds rules for commands nobody ran.** About a third of the planned work has zero lines in the logs behind it. The list is in "Effort and impact".
2. **It adds two helpers that already exist** under other names. See "Reusing code".
3. **One change to a shared function reaches far more than the plan says.** `joinedFlag` in `splitFlags` changes every flag table, including the `gh` and `git` ones. See "Major features".

With the cuts below, the plan goes from eight PRs and about 14 days to five PRs and about 8 days. By the tags on each line, the full plan moves about 28 of the 51 broad lines, and the cut plan moves about 23. The plan's own table says 35, but 7 of those need `find` and glob rules that no PR in the plan builds. That table is corrected.

## Major features and API

safeBash is safety infrastructure. It decides what a person is asked. Four parts of the plan change something a user or a saved policy depends on. Each is deliberate, but the plan understates two of them.

**1. What an existing `std::grep` approval covers (PR 1).** Today a saved rule that approves `std::grep` for a folder approves the grep tool's search of it. After PR 1 the same rule also approves real grep run through bash on that folder. No policy file changes, but every saved policy now covers more. The plan argues this is safe, and I think the argument holds. The plan should still say it in these words in Decision 1, because it is the real cost of option A.

**2. `joinedFlag` changes every flag table (PR 1, Task 1.1).** The plan presents this as a grep fix. `splitFlags` is the one function every table goes through: grep, the read verbs, the listings, `find`, `rm`, git, and `gh`. Today a flag with a quoted value fails in all of them. After Task 1.1 a quoted value reaches each table's rule.

A quoted value can hold text a bare value cannot: spaces, a glob character, a comma, a leading dash. Each table's checks were written when those could not arrive. Two examples that need a look before this ships:

- `gh pr list --label="bug,urgent"`. The `gh` rule refuses a value with a quote in it, because `gh` reads a list flag as CSV. `joinedFlag` strips the quotes before that check sees them.
- `find . -name="*.ts"`. The dev doc says `-name=x` is refused as a flag value on purpose.

The fix is to make it opt in. `FlagSpec` gets a field, `quotedValues: boolean`, and only the grep table and the two git rows that need `--format` set it. Each later table that wants it turns it on with its own tests.

**3. A new effect in `recommended` does not reach existing users (PR 3, Task 3.5).** A saved policy does not follow `recommended`. `~/.agency-agent/policy.json` is written once, and a rule added to `recommended` later reaches a user only when they run `/policy` and say yes. So after Task 3.5 ships, a lone `pwd` still prompts for every existing user, now with a question they have not seen before. The plan does not mention this.

**4. The first rule of the dev doc changes (PR 6).** "safeBash never expands a variable or a glob itself" becomes false for globs. The plan says so. This is the largest change of principle in the plan, and it buys the least. See the next section.

## Effort and impact

| Part of the plan | Lines in the logs | Effort | Verdict |
|---|---|---|---|
| PR T, `$?` in tarsec | 14 | half a day and a publish | Do |
| PR 1, grep through bash | 11 of the 51 broad lines; 18 of 22 grep lines are broad | 2 days | Do |
| PR 2, leading flags, `--format`, `rev-parse` | 3 | half a day | Do |
| PR 2, `git grep` | 3, all one session | half a day; the only git rule with two payload shapes | Defer |
| PR 2, `ls-files`, `worktree list` | 1 each | small | Defer |
| PR 2, `merge-base` | 0 | small | Cut |
| PR 3, `pwd`, `which`, `command -v`, `type`, `printf` | 12 | half a day | Do |
| PR 3, ten more quiet verbs | 0 | small each, but ten rows of flags to keep true | Cut |
| PR 3, `/dev/null` | 7 | small | Do |
| PR 3, `TERM=` | 5, one session | small | Do, with a shorter list |
| PR 3, `timeout` | 6, one session | half a day; also touches the refuse wall | Do last in the PR |
| PR 3, Task 3.5, the new effect | 0 | 1 day, and a new concept | Cut |
| PR 4, `sed -n` | 6 | small | Do |
| PR 4, `mkdir` | 1 | small | Do |
| PR 4, `tee` | 0 in the logs, 1 in the saved policy | small | Do |
| PR 4, `cp` and `mv` | 0 | 1 day; the hardest rule in the plan | Defer |
| PR 4, `touch`, `stat`, `file`, checksums | 3, all `file` | small | Cut all but `file` |
| PR 5, missing paths and written files | 4 of the 51 | 2 days; changes every `classify` function | Do |
| PR 6, globs | 4 | 2 days, a new expander, and a changed principle | Defer |
| PR 7, "approve all writes in" | not measured | 1 day | Defer |

Four of these need a sentence each.

**Task 3.5, the new effect.** No line in the logs is made only of quiet commands. Inside a longer line, a quiet command already adds no question, and that part of PR 3 needs no new effect. So the effect would exist for a case that has not happened. It would also be a new concept: a policy author has to learn what it covers, and the answer, "a fixed table of commands in `safeBash.agency`", is not something a payload can show them. I recommend cutting it. A lone `pwd` keeps asking `std::bash`, as a lone `echo "---"` does today. If the logs later show such lines, the name `std::bash::readonly` and the design are ready.

**The ten extra quiet verbs.** `date`, `uname`, `whoami`, `hostname`, `basename`, `dirname`, `sleep`, `true`, `false`, and `:` have no line in the logs. Each row has flags that must mean the same on BSD and GNU. The table should start with the five verbs that were used. Adding a verb later is one row.

**`cp` and `mv`.** The over-approval is real: "always approve" for `cp package.json /tmp/x` saves the pair `cp` and `package.json`. But no session ran either command. The agent has `write`, `edit`, `copy`, and `move` tools, and the logs suggest it uses them. The rule is also the hardest in the plan: it must work out the real destination when the target is a folder, and what happens to a symlink. I recommend deferring it until a log shows the commands in use. The cheap part of the same fix can ship now: add `cp` and `mv` to the list of programs that never ask `std::exec`, so the bad saved rule cannot be made. They would ask `std::bash`, which is what a person should see for a command safeBash cannot describe.

**Globs.** Four lines hold a glob, and each also has another blocker, so fixing globs alone moves none of them. The work is a hand-written copy of bash's expansion, a parity test to keep it honest, and a change to the first rule in the dev doc. That is the most complexity for the least gain in the plan. I recommend deferring it, and leaving ADI-247 open.

**PR 7** does not serve this plan's goal. It changes the approval prompt, and `--policy with-writes` already does more for the launch folder. It should be its own piece of work with its own design, if it is wanted.

### The sizes

Every PR in the plan is sized at "2 days". That is a sign the sizes were not worked out one by one. The earlier safeBash PRs each took a plan, two review rounds, and at least one finding from the BSD and GNU difference. PR 1 has the largest unknown of that kind: all four grep facts were checked on macOS only. A fair size for PR 1 is 2 to 4 days, and for PR 5 the same, because its first task changes the signature of every `classify` function.

## The 80/20 rule

**For the whole plan.** PR T, PR 1, and the five quiet verbs with `/dev/null` cover 42 of the 90 blocker tags and need no new type, no new effect, and no change of principle. That is the 20%. They should merge first, and the corpus test should be read again before PR 5 is built.

**For PR 1.** Decision 1's option A is itself the 80/20 choice. Option B, the in-process pipeline runner, is several days and does not help a line that also holds `ls` or `find`.

**For points 6 and 7.** The plan resolves a missing path in two ways: by its parent (Task 5.2), and by the list of files the line wrote (Task 5.3). There is a cheaper form of 5.3. The model writes to a file because it expects long output. The run already saves long output and tells the model where it is. A line in the tool's docstring would cost nothing. It would not replace the rule, because models do this from habit, but it should be tried first, and it may make 5.3 less urgent.

## Reusing code

**`_realPathOfNew` already exists (PR 4, Task 4.1).** The plan adds a helper to find the real path of a folder that does not exist yet. The `mkdir` tool already does this: it calls `_realTarget(dir)`, which is `host.files.realPath`, on a folder that may be missing (`stdlib/fs.agency:132`). safeBash already wraps the same call for `rm` as `_removeTargetIn(text, cwd, tildeMode)` in `lib/stdlib/safeBashRemove.ts:101`. The `mkdir` rule should call that function. It should be renamed, since it would no longer be only for removal. Using the tool's own resolver also guarantees the payload is the one the `mkdir` tool raises, which is the whole point of the rule.

**`_missingTargetIn` overlaps `_resolveRedirectTarget` (PR 5, Task 5.2).** The plan adds a resolver that returns the real parent folder and the name for a path that does not exist. `_resolveRedirectTarget` returns exactly that pair for the target of `>`, which is usually a file that does not exist. Task 5.3 then compares one resolver's answer with the other's, to see whether a read names a file the line wrote. Two resolvers that must agree is a bug waiting to happen. Task 5.2 should use `_resolveRedirectTarget` and add only the check that the path is missing.

**`FilePath` is `ReadPayload` without two fields (PR 5, Task 5.1).** The new type `{ dir, filename }` is what `std::read` and `std::write` payloads already carry. `LineState.written` can hold the `WritePayload` values the line raised. No new type is needed.

**`unwrapTimeout` is called from two places (PR 3, Task 3.3).** The plan calls it in `simpleCommandRule` and again in `isRefused`. If a third reader of a command is added later and forgets it, `timeout 5 shred x` passes the wall. It is safer to unwrap once, where the parsed tree is first walked, so that both the wall and the classifier see the inner command and neither needs to know about `timeout`. That is a change to `flattenOne` and to `classifySimple`'s input. If that turns out not to fit, this is another reason to do `timeout` last.

**The corpus test repeats existing tests.** `planOutcomes` and `planReasons` in `tests/agency/safeBash.agency` already hold rows of this shape. The new file is worth having because it is the measurement, but it should say at its top that it is not the place to pin a rule's edge cases. Otherwise the same row will be kept in two files.

## Reusing and unifying concepts

The plan adds these concepts. Each is something a future reader of `safeBash.agency` has to learn.

| New concept | Could it be an existing one? |
|---|---|
| Quiet verbs | Yes. `echo` is already one: a verb that adds no effect. The table should include `echo`'s row, so there is one concept, "a command that only prints", and not `echo` plus a table. |
| Quiet assignments | No. It is new, and small. |
| `std::bash::readonly` | Cut. See above. |
| `LineState` | It replaces `cwd`, so it is a wider form of an existing concept. Good. |
| `opaque` | New. It is the hardest idea in the plan to hold in mind, and a wrong value is a security bug in one direction and a lost approval in the other. See below. |
| Glob expansion | Deferred. |
| `FileWriteInFolder` effect set | Deferred with PR 7. A second write set beside `FileWrite` that differs by three members is the kind of near-copy to avoid. |

**`opaque` should be defined by what is safe, not by what is dangerous.** The plan lists the effects that set it: `std::exec`, `std::bash`, `std::move`, and so on. A new effect added to safeBash next month would not be on the list, and a missing path after it would resolve. The list should be the other way round: the line stays clear only while every effect so far is one of the read effects or a `std::write` from a redirect. safeBash already has that list, `READ_EFFECTS`, and a function that checks it, `onlyReads`. Anything else sets `opaque`.

**The dev doc.** `safe-bash.md` is about 2,000 lines. Each PR should add table rows and one short paragraph of reasoning, not a section. The exception is PR 5, whose rule replaces the text under "Resolving the path when the plan is made".

## Tying concepts together

**The exclude list and `SKIP_DIRS` should be tied, and the plan ties them.** `_skipDirNames` reads the constant the grep tool's walk uses. If someone adds a folder to `SKIP_DIRS`, real grep must skip it too, or the payload stops being true. This is a correct tie. The plan should add one test that fails if the two differ, because the tie is the safety argument.

**Git reads mapped onto existing effects ties two things that may later want to part.** This decision is made, and I agree with it. The cost to record: `std::git::log` now also means "may print a commit hash through `rev-parse`", and a person who writes a policy rule on the `ref` field of `std::git::log` is now also deciding `rev-parse`. That is fine while the mapped command shows less than the effect names. `git grep` on a ref, mapped to `std::git::show`, is the one case in the table where that is doubtful: it reads every file in a commit, and `show { ref }` names one commit's patch. That is a second reason to defer `git grep`.

**`sed -n` and the saved `std::exec` rule should not be tied, and the plan leaves them untied.** After PR 4 a range read asks `std::read`, and the owner's saved rule for `sed -n` stops being used. That is the right outcome and needs no migration.

## What I would change in the plan

1. Make `joinedFlag` opt in per table.
2. Cut Task 3.5 and Decision 2. A line of only quiet commands keeps asking `std::bash`.
3. Cut the quiet table to `pwd`, `which`, `command -v`, `type`, and `printf`, and put `echo` in it.
4. Cut `merge-base`. Defer `git grep`, `ls-files`, and `worktree list` to a follow-up ticket.
5. Defer `cp` and `mv`. Add both to the programs that never ask `std::exec`.
6. Cut `touch`, `stat`, and the checksum rows.
7. Defer PR 6 and PR 7. Leave ADI-247 open, and file PR 7 as its own ticket if it is wanted.
8. Reuse `_removeTargetIn`, `_resolveRedirectTarget`, and `WritePayload` in place of the three new names.
9. Define `opaque` from `READ_EFFECTS`.
10. Unwrap `timeout` in one place, and build it last in PR 3.
11. Say in Decision 1 that every saved `std::grep` rule will cover more.
12. Give PR 1 and PR 5 a range of 2 to 4 days.

Items 1, 8, 9, 10, 11, and 12 are corrections and are already made in the plan. Items 2 to 7 remove things the owner has discussed, so they wait for a yes.
