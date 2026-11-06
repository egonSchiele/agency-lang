# Plan: git through safeBash, and no git tools in the coding agent

Date: 2026-11-06

Revised the same day after the review in
`docs/superpowers/plans/2026-11-06-safebash-git-commands-review.md`. The
review found two holes in the first version, and one fix for both:
safeBash writes the git command it runs.

Revised a second time after
`docs/superpowers/plans/2026-11-06-safebash-git-commands-review-2.md`.
That review found the rewritten `git diff` still prints a file when the
working directory is not inside a repository, and six places where the
plan did not say how a step is built. "What the reviews changed", near
the end, lists every change from both.

## Summary

The coding agent carries eighteen git tools. They cost about 2,800 tokens
on every model call. This plan teaches `safeBash` to read git commands and
ask the same approval each git tool asks today, and then removes the
eighteen tools from the coding agent.

The work is three pull requests:

1. Move to tarsec 0.5.7, and fix the refusal list for the commands that
   0.5.7 makes readable.
2. Add the git rules to `safeBash`.
3. Remove the git tools from the coding agent, and add the git eval suite.

A spike of parts 2 and 3 exists on the branch `adit/safebash-git`. It was
measured, and the numbers are in "What we measured" below. This plan
describes the real version. It differs from the spike in seven ways,
listed in "How this differs from the spike". Two of the seven close holes
the spike has, so the spike must not be merged as it is.

## Background

This part describes how things work today. Nothing in it is a proposal.

### How the coding agent does git today

`buildTools()` in `stdlib/agents/coding.agency` gives the coding agent the
bundle `gitTools()` from `stdlib/agents/lib/toolkits.agency`. The bundle
holds eighteen functions from `stdlib/git.agency`:

- Nine reads: `gitIsRepo`, `gitStatus`, `gitLog`, `gitDiff`, `gitShow`,
  `gitBranchList`, `gitRemoteList`, `gitBlame`, `gitStashList`.
- Nine writes: `gitAdd`, `gitCommit`, `gitCheckout`, `gitSwitch`,
  `gitBranchCreate`, `gitBranchDelete`, `gitStashPush`, `gitStashPop`,
  `gitRestore`.

Every tool raises its own effect before it runs git. For example,
`gitCommit("Fix the parser")` raises `std::git::commit` with the payload
`{ cwd, message }`. The effects are declared in `stdlib/git.agency`, lines
91 to 124. There are seventeen, because `gitIsRepo` and `gitStatus` share
`std::git::status`.

Policies answer those effects. The built-in policies in
`lib/runtime/builtinPolicies.ts` approve the eight read effects outright
(lines 178 to 185). The policy that accepts edits approves the nine write
effects when the payload's `cwd` is inside the project (lines 227 to 235).

Each tool's description and parameter schema is sent to the model on every
call. Measured on `main` at `49d99f9f5`, the eighteen come to 11,136
characters, about 2,800 tokens.

Four other agents carry the read-only half, `readOnlyGitTools()`: the
verifier, the TypeScript reviewer, the Agency writer, and the Agency
verifier. This plan does not change their tools. Two of them, the
verifier and the Agency verifier, also carry `safeBash`, and "Any agent
with safeBash can write to git" below says what that means.

### How a git tool runs git

A git tool does not hand the model's words to git. It builds the argument
list itself, in `lib/stdlib/gitCore.ts`, and runs it through `gitRunImpl`
in `lib/stdlib/git.ts`. Four things in that path matter here:

1. **Fixed flags come first.** `GIT_HARDENING_FLAGS` is put before every
   subcommand. It turns off `core.fsmonitor`, which is a setting in the
   repository's config that names a program git runs on `git status`. It
   also sets the pager to `cat` and passes `--no-optional-locks`.
2. **Refs and paths are separated.** `logArgs`, `diffArgs`, `blameArgs`,
   `addArgs`, and `restoreArgs` each write `--` before the paths, so git
   cannot read a path as a ref or a ref as a path.
3. **The environment is cleaned.** `scrubEnv` removes the variables in
   `SCRUB_ENV_KEYS`: the ones that make git run a program
   (`GIT_EXTERNAL_DIFF`, `GIT_SSH_COMMAND`, `GIT_CONFIG*`, and others) and
   the ones that point git at another repository (`GIT_DIR`,
   `GIT_WORK_TREE`, `GIT_INDEX_FILE`, and others).
4. **There is a 30 second limit** and a cap on output size.

safeBash does none of these for the four git spellings it knows today. It
runs the command text through bash.

### How safeBash decides what to ask

`safeBash` is the shell tool the coding agents carry. The full design is
in `docs/dev/stdlib/safe-bash.md`. The parts this plan relies on:

1. `planFor(source, cwd)` parses the command with tarsec's bash parser and
   classifies every simple command in it. Nothing runs while it decides.
2. For each command, `effectsFor` returns either the list of effects that
   describe it, or a failure. A failure means "I have no rule for this".
3. If every command in the string has a rule, the plan is **narrow**:
   safeBash raises each effect, and when all are approved it runs the
   command through bash. The text it runs is printed back from the parsed
   tree, not the original string.
4. If any command has no rule, or the string does not parse, the plan is
   **broad**: safeBash raises one `std::bash` for the whole string. No
   policy can safely approve `std::bash` in advance, because its payload
   is a string that could do anything. So a broad plan means a person is
   asked.
5. Before any of that, the **refusal list** (`isRefused`) matches a few
   destructive spellings, such as `rm` and `git reset --hard`. A refused
   command raises nothing and does not run.

The first rule in the design doc governs everything below: **the payload
tells the truth.** A narrow effect's payload must describe what bash is
about to do. When safeBash cannot fill a payload that describes the
command, the command has no rule.

### What safeBash knows about git today

`gitEffects` in `stdlib/safeBash.agency` (line 598) recognizes four
spellings and nothing else:

| Command | Effect |
|---|---|
| `git status` | `std::git::status` |
| `git log` | `std::git::log` with an empty `ref` and `path` |
| `git diff` | `std::git::diff` |
| `git diff --staged` | `std::git::diff` with `staged: true` |

Any argument and any other flag is a failure. `git log -5`, `git diff
HEAD`, `git show`, `git add`, and `git commit -m` all ask `std::bash`.

The refusal list has four git entries (`isDestructiveGit`, line 2727):
`git clean`, `git restore` in every form, `git reset --hard`, and `git
checkout` with a `.` argument.

### What tarsec 0.5.7 changed

Until today the parser rejected three spellings that git commands use
constantly. A rejected string is broad, whatever it says.

| Input | tarsec 0.5.6 | tarsec 0.5.7 |
|---|---|---|
| `git checkout -- file.txt` | rejected | `--` is a flag word whose name is `--` |
| `git diff HEAD~1` | rejected | `HEAD~1` is a literal word |
| `git show HEAD^` | rejected | `HEAD^` is a literal word |

Two things are still rejected and so still broad: `@` (`stash@{0}`) and
`%` in an unquoted flag value (`--format=%h`).

A flag with a quoted value parses, and is broad for another reason.
`--author="Dana X"` comes back as one word made of two parts, the text
`--author=` and the quoted text. It is not a flag word, so `splitFlags`
reads it as an argument, the argument is not plain literal text, and the
command has no rule. This matters for the flags below that take a value:
a model nearly always quotes the value of `--author`, `--grep`,
`--since`, and `--until`, so most uses of those four stay broad until
`splitFlags` learns that shape. That is left for later, and step 10 of
pull request 2 measures whether it is worth doing.

Agency pins tarsec at `0.5.6` in `package.json`.

### A hole that exists today

The refusal list reads the parsed tree. It cannot see inside a string the
parser rejects. So today:

- `git restore utils.py` is refused.
- `git restore -- utils.py` is not refused. It does not parse, so it asks
  `std::bash`, and a person who approves it loses their changes to
  `utils.py`.

The same is true of `git checkout -- utils.py` and `git checkout -- .`.
The comment at line 2738 records this as known. In the spike's eval run
the agent wrote both `git restore -- utils.py` and `git checkout --
utils.py`. Moving to tarsec 0.5.7 is what lets the refusal list see them.

### Two ways git reads a word differently from what it looks like

The review found these, and I reproduced both with git 2.39.5, the
version macOS ships. They are facts about git. The design below exists
because of them.

**`git diff` compares two files outside the repository when given the
chance.** When `git diff` gets two words and one is a path outside the
repository, it stops comparing commits and compares the two files, as
`git diff --no-index` does:

```
$ git diff /dev/null /Users/me/.ssh/id_rsa
diff --git a/Users/me/.ssh/id_rsa b/Users/me/.ssh/id_rsa
new file mode 100644
...the whole file...
```

No `--no-index` flag is written, so leaving that flag out of an allowlist
does not stop it.

**`git checkout <word>` discards work when the word is not a ref.** Git
then reads the word as a pathspec, a pattern git matches itself:

| Command | What git did |
|---|---|
| `git checkout '*.py'` | "Updated 2 paths from the index". Both edited files lost their changes. |
| `git checkout ':/'` | Discarded every change in the repository. |
| `git checkout gone.py`, where `gone.py` was tracked and deleted | Restored the file. |

A quoted `'*.py'` is literal text to bash and to safeBash, and a glob to
git. No file is named `*.py`, so a check of the disk says it is not a
path.

**`--` settles both.** Words before `--` are refs and words after it are
paths, and git fails when a word is not what its side says:

```
$ git diff /dev/null -- /Users/me/.ssh/id_rsa
fatal: bad revision '/dev/null'
$ git diff main -- /Users/me/.ssh/id_rsa
fatal: /Users/me/.ssh/id_rsa: '/Users/me/.ssh/id_rsa' is outside repository
$ git checkout '*.py' --
fatal: invalid reference: *.py
$ git checkout main --
Already on 'main'
```

One spelling survives `--`: two paths after it, `git diff -- /dev/null
/Users/me/.ssh/id_rsa`, still prints the file. So a `git diff` with two
paths must never get a rule.

**Outside a repository, `--` does not help `git diff`.** The second
review found this. When git finds no repository above the working
directory, `git diff` always compares files, and it drops the `--`:

```
$ cd /tmp
$ git diff /dev/null -- /Users/me/.ssh/id_rsa
diff --git a/Users/me/.ssh/id_rsa b/Users/me/.ssh/id_rsa
...the whole file...
```

The model chooses the working directory with `cd`, so the `--` alone is
not enough for `diff`. Only `diff` has this mode. `status`, `log`, `show`,
`blame`, `branch`, `remote`, `stash`, `add`, `commit`, `checkout`,
`switch`, and `restore` each fail there with "not a git repository".

Git can be asked whether it sees a repository, and the answer can gate
the diff:

```
$ cd /tmp
$ (git rev-parse --is-inside-work-tree >/dev/null && git diff /dev/null -- /Users/me/.ssh/id_rsa)
fatal: not a git repository (or any of the parent directories): .git
```

Looking for a `.git` folder while planning is not a substitute. An empty
folder named `.git`, with no repository above it, passes that check, and
git still prints the file. The `rev-parse` guard refuses there, because
git gives the answer.

Two bugs on `main` came out of the same checks. They are separate from
this plan and each needs a ticket:

- The `gitDiff` tool has the first hole. `gitDiff(ref: "/dev/null",
  ref2: "/Users/me/.ssh/id_rsa")` prints the file, and `recommended`
  approves `std::git::diff` with no prompt.
- The `gitCheckout` tool does not work with git 2.39.5. It runs `git
  checkout --end-of-options main`, and that git answers "pathspec
  '--end-of-options' did not match any file(s) known to git".

### What we measured

Three versions of the agent were run on two sets of tasks, with GLM 5.3
hosted by Z.AI.

**The git suite** (`evals/agency-agent-git`, written for this work):
fourteen small git tasks, three trials each. Five are reads, eight are
writes, and one is a bug fix that ends in a commit.

| | Git tools in the coder (`main`) | Git tools in a separate git agent | Git through safeBash (the spike) |
|---|---|---|---|
| Trials passed | 42 of 42 | 40 of 42 | 42 of 42 |
| Total cost | $3.29 | $4.69 | $2.20 |
| Mean time per task | 97s | 172s | 61s |
| Mean model calls per task | 12.1 | 13.5 | 9.2 |
| Broad bash approvals per task | 1.3 | 1.5 | 1.2 |

The separate git agent was the alternative to this plan. It cost 43% more
than `main` and took 77% longer, because the coder writes the git steps
out as a task, the git agent writes a report, and the coder restates it.
The owner set it aside.

In the spike run, safeBash raised a narrow git effect 220 times and
`std::bash` 49 times. The 49 broad commands fall into four groups:

| Group | Examples | What fixes it |
|---|---|---|
| A `--` separator | `git log --oneline -- settings.py` | tarsec 0.5.7 and the rule in "Refs and paths" below |
| A format string | `git log -1 --format='%H%n%s'` | nothing in this plan; see the note on quoted flag values above |
| A flag the spike left out | `git log --follow`, `git log --all` | `--follow` is added here; `--all` is a decision below |
| No effect exists | `git revert`, `git rev-parse`, `git merge-base`, `git rm --cached` | nothing in this plan; they stay broad |

**SWE-bench Verified**, ten tasks: these runs were still in progress when
this plan was written. Step 1 of pull request 3 reads their results.

## Goal

After this work:

- A git command the coding agent writes in `safeBash` asks the same effect
  the matching git tool asks today, with a payload that describes the
  command. A policy that approves `gitCommit` in a project approves `git
  commit -m "..."` in that project, with no change to the policy.
- A recognized git command runs the way the git tools run git: with the
  same fixed flags, with refs and paths separated, and without the
  environment variables that point git somewhere else.
- The coding agent has no git tools. Its tool list is eighteen shorter.
- The refusal list covers the `--` spellings.

## What this plan does not do

- It does not change the git tools in `stdlib/git.agency`, or the four
  agents that carry the read-only ones.
- It does not add effects. A git command with no existing effect, such as
  `git revert` or `git push`, keeps asking `std::bash`.
- It does not change any policy.
- It does not run git in process. A recognized git command runs through
  bash, like every other narrow command that is not a read or a grep.

## Decisions already made

The owner decided these in conversation on 2026-11-06.

1. **Git goes through safeBash, not a subagent.** The git agent was built
   and measured, and it was slower and more expensive.
2. **A plain shell with no rules is not acceptable**, because every git
   command would ask the broad approval.
3. **Refs and paths are told apart with `--`**, and by looking at the disk
   when there is no `--`. The rule is in "Refs and paths" below.

I also proposed three smaller rules and the owner did not object. They are
restated here so they can be checked:

4. `git restore --staged <paths>` gets a rule. `git restore <paths>`,
   which discards work, stays refused.
5. `git checkout -f` and `git branch -D` get no rule, so they ask
   `std::bash`.
6. `git commit -m` and `git commit -am` get a rule. `--amend` and
   `--no-verify` do not.

## Decisions made after the review

The owner agreed with all five recommendations below on 2026-11-06. The
options are kept so the reasoning can be read.

1. `git log --all` gets no rule.
2. `git checkout` is refused with a `--`, and with two or more words
   that are not flags and no `-b` or `-B`.
3. The shell loses the variables that point git at another repository and
   the ones that make git run a program, except the SSH ones (option C).
4. An agent with `safeBash` can write to git when the policy approves
   (option A), and the test is renamed.
5. Three pull requests, and the third waits for the second's fixed flags.

### 1. Should `git log --all` have a rule?

The agent wrote `git log --all` six times in 42 trials. The `std::git::log`
payload is `{ cwd, ref, path }`. With `--all`, git shows every branch and
tag, and the payload has no way to say so: `ref` would be empty, which a
reader takes to mean the current branch.

- **Option A: no rule.** `git log --all` asks `std::bash`. The payload
  never understates.
- **Option B: a rule, with `ref: "--all"`.** The payload says what was
  asked. But `ref` is documented as a ref, and a policy that matches
  `ref` would see a value that is not one.

I recommend A. It costs a broad prompt on a command that is uncommon
outside history searches, and it keeps the payload honest.

### 2. Should `git checkout <file>` be refused?

`git checkout utils.py` discards the uncommitted changes to `utils.py`. It
is the same act as `git restore utils.py`, which is refused. Today the
refusal list only refuses `git checkout` with a `.` argument, so `git
checkout utils.py` asks `std::bash`.

- **Option A: leave it.** It keeps asking `std::bash`.
- **Option B: refuse `git checkout` when a `--` is present.** `git
  checkout -- utils.py` is the unambiguous "discard" spelling. `git
  checkout utils.py` with no `--` stays broad, because the refusal list
  must not read the disk.

I recommend B. It makes `checkout --` match `restore`, and it is one line.

The review agreed, and suggested one more refusal: `git checkout` with
two or more words that are not flags, and no `-b` or `-B`, such as `git
checkout main utils.py`. That form always overwrites files, and it is the
same act as the refused `git restore --source main utils.py`. Without the
refusal it is broad, which is safe. I recommend adding it, for
consistency. The check reads the words only.

The count has to include every word that is not a flag, whatever tag the
parser gave it. tarsec tags a word with a slash as `path` and a quoted
word as `singleQuoted` or `doubleQuoted`:

```
git checkout main src/utils.py     literal(main) path(src/utils.py)
```

The existing helper `hasLiteralArg` sees only `literal` words, and would
count one word here. So the refusal uses a new helper, `plainWordCount`,
which counts the words whose tag is not `flag`.

### 3. Which environment variables does the shell lose?

A git tool runs without `GIT_DIR`, `GIT_WORK_TREE`, and the rest of
`SCRUB_ENV_KEYS`. A command through `safeBash` inherits them. With
`GIT_DIR` set in the environment the agent was started from, `git log`
prints another repository's history, and the `cwd` in every git payload
is false. The command text cannot remove a variable, so the fix has to be
in the environment the shell is given.

`SHELL_ENV_REMOVED` in `lib/host/node/nodeSubprocess.ts` is the list of
variables removed from every shell command, "because each makes bash do
something the script does not say". It applies to `safeBash` and to the
plain `bash` tool, narrow or broad.

- **Option A: add the variables that retarget git.** `GIT_DIR`,
  `GIT_WORK_TREE`, `GIT_INDEX_FILE`, and the others in group (b) of
  `SCRUB_ENV_KEYS`. With one set, a git payload's `cwd` is false.
- **Option B: add all of `SCRUB_ENV_KEYS`.** This also removes
  `GIT_SSH_COMMAND`, which a person may have set so that `git push` uses
  a particular key. A broad `git push` through the shell would then stop
  working for them.
- **Option C: add group (b), and the code-running ones except the SSH
  ones.** That is `GIT_EXTERNAL_DIFF`, `GIT_PAGER`, `GIT_EXEC_PATH`,
  `GIT_EDITOR`, `GIT_SEQUENCE_EDITOR`, `GIT_ATTR_SOURCE`, and
  `GIT_CONFIG*`, and it leaves `GIT_SSH`, `GIT_SSH_COMMAND`, and
  `GIT_PROXY_COMMAND`.

I recommend C. A narrow git approval then describes what runs, and the
one thing a person plausibly set on purpose keeps working.

Two things have to change for any option to be built:

1. `SCRUB_ENV_KEYS` is one list today, not exported, with comments
   marking groups (a) and (b). Option C takes all of (b) and part of (a).
   So it becomes three named, exported lists: `GIT_RETARGET_ENV` (group
   b), `GIT_CODE_ENV` (group a without the SSH ones), and `GIT_SSH_ENV`.
   `SCRUB_ENV_KEYS` is then the three joined, so the git tools remove
   exactly what they remove today.
2. The lists move to the host layer, in a new file
   `lib/host/gitEnvironment.ts`. `lib/host/node/nodeSubprocess.ts`
   imports only Node's own modules and `../host.js`, and every other
   import between the two layers goes from the stdlib to the host. So
   `gitCore.ts` imports the lists from the host, and `nodeSubprocess.ts`
   imports the first two. Both read the same entries, so they cannot
   drift.

This changes the plain `bash` tool too. A user whose own scripts rely on
`GIT_DIR` from the environment would see them act on the working
directory's repository. I think that is rare and is the right behavior
for an agent's shell, and the pull request description should say it.

### 4. Any agent with safeBash can write to git

The verifier and the Agency verifier carry read-only git tools and also
`safeBash`. Today the verifier's `git commit -m "x"` asks `std::bash`, so
a person decides. After pull request 2 it asks `std::git::commit`, and
the policy that accepts edits approves that inside the project. The test
`historyReadersHaveGitButCannotCommit` keeps passing, because it checks
tool names.

- **Option A: accept it.** The policy is the control. A user who approved
  git commits in the project approved them, whichever agent asks.
- **Option B: give the read-only agents a shell without the git write
  rules.** `safeBash` would take a parameter that turns the write rules
  off, bound by the toolkit. This is new surface for one case.

I recommend A, with the test's name and description changed to say what
it checks: that those agents carry no git write tool. The review calls
this a decision for the owner, and I agree.

### 5. One pull request or three?

Each of the three parts can be reviewed and merged alone, and each leaves
`main` working. Part 1 changes what safeBash refuses. Part 2 changes what
it asks. Part 3 changes the agent. I recommend three, in that order. If
you prefer one, the steps below still apply in the same order.

One condition holds either way: part 3 must not merge before part 2's
rebuilt command carries the fixed flags. Part 3 takes the hardened tools
away from the coder, so everything the coder does with git then runs on
the shell path.

## Design

### The one rule

A git command gets a rule only when an existing `std::git::*` effect
describes it completely. The rule fills that effect's payload from the
command's own words. A flag is allowed only when it leaves the payload
true.

That gives three kinds of flag:

- **A flag that changes how the result is shown.** `--oneline`, `--stat`,
  `--name-only`. The payload says "the log of this ref and this path", and
  that stays true. Allowed.
- **A flag that shows less.** `-n 5`, `--author=dana`, `--since=...`. The
  payload describes a superset of what is shown. Allowed.
- **A flag that shows more, or does something else.** `--all` shows other
  branches. `--no-index` makes `git diff` compare two files outside the
  repository. `--output=file` makes `git diff` write a file. Not allowed.

Every table below is an allowlist. A flag that is not listed makes the
command broad. This is the existing convention: `GREP_FLAGS` at line 721
is written the same way, with a comment naming the flags left out and why.

### safeBash writes the git command it runs

The first version of this plan classified a git command and then ran the
text the model wrote. That is unsafe, for the reason in "Two ways git
reads a word differently": git reads the text with its own rules, and
they can disagree with the classifier.

So for a recognized git command, safeBash builds the command it runs:

```
git <fixed flags> <subcommand> <flags> <refs> -- <paths>
```

- The **fixed flags** are `GIT_HARDENING_FLAGS`, the same list the git
  tools use, imported from `lib/stdlib/gitCore.ts` so the two paths
  cannot drift.
- The **flags** are built from what `splitFlags` returned, and not copied
  from the model's text. "Where the flag words come from" below says why
  and how.
- The **refs** and **paths** are the model's own words, as the classifier
  sorted them. Each is the `Word` the parser produced, so its quoting is
  kept.
- The **`--`** is always written for a subcommand whose words are refs
  and paths, including when there are no paths. `git checkout main`
  becomes `git ... checkout main --`.
- The model's **redirects** stay on the command. `git diff > out.patch`
  still writes `out.patch`.

For example, with `git ...` standing for `git` and the fixed flags:

| The model wrote | safeBash asks | safeBash runs |
|---|---|---|
| `git log --oneline src` | `log { ref: "", path: "src" }` | `git -c core.pager=cat -c core.fsmonitor=false --no-optional-locks log --oneline -- src` |
| `git checkout '*.py'` | `checkout { target: "*.py" }` | `git ... checkout '*.py' --`, which fails: invalid reference |
| `git diff /dev/null /Users/me/.ssh/id_rsa` | `diff { ref: "/dev/null", path: "/Users/me/.ssh/id_rsa" }` | `(git ... rev-parse --is-inside-work-tree >/dev/null && git ... diff /dev/null -- /Users/me/.ssh/id_rsa)`, which fails: bad revision, or not a git repository |

With the `--` in place, git reads each word the way the classifier did,
or it fails and changes nothing. The disk rule in "Refs and paths" then
only picks which question to ask. It is no longer a guess about what git
will do.

**`git diff` runs behind a check that git sees a repository.** Outside a
repository `git diff` ignores the `--` and compares files, as "Two ways
git reads a word differently" shows. So a recognized `git diff` runs as
two commands in parentheses:

```
(git <fixed flags> rev-parse --is-inside-work-tree >/dev/null && git <fixed flags> diff <flags> <refs> -- <paths>)
```

When git sees no repository, `rev-parse` fails with "not a git
repository" and the diff never runs. Its message goes to standard error,
so the model reads why. Its one line of output goes to `/dev/null`, so
the group prints only what the diff prints.

The parentheses make the pair one unit. The parser's `parens` node is
allowed as a stage of a pipe, so `git diff main | head` becomes `(... &&
git ... diff main --) | head`. The model's redirects go on the diff
inside the group. No other subcommand needs the check, because each of
the others fails by itself outside a repository.

The check runs when the command runs, and git answers it. A check made
while planning, such as looking for a `.git` folder, would be a second
guess about what git will do, and the section above shows one way it is
wrong.

**Where the flag words come from.** `splitFlags` checks the model's flags
and returns them as data:

```
export type SplitArgs = {
  plain: string[];        // letters and long names: "p", "--oneline"
  values: FlagValue[];    // { flag: "n", value: "5" }
  positionals: Word[]
}
```

It does not keep the flag words themselves. So the command's flags are
built from `plain` and `values`, which are the checked data:

| In `SplitArgs` | Word built |
|---|---|
| a plain letter, `"p"` | the flag word `-p` |
| a plain long name, `"--oneline"` | the flag word `--oneline` |
| a letter with a value, `{ flag: "n", value: "5" }` | the flag word `-n`, then a literal word `5` |
| a long name with a value, `{ flag: "--author", value: "Dana X" }` | one flag word with the name `--author` and the value `Dana X` |

The printer, tarsec's `astToBash`, quotes what needs quoting. I checked
it: a literal word holding `it's` prints as `'it'\''s'`, a literal
holding `x; touch PWNED` prints as `'x; touch PWNED'`, and the flag word
above prints as `'--author=Dana X'`. So a value can never become a second
command.

Several spellings of one flag therefore run as one spelling. `-n5`, `-n
5`, `-5`, and `--max-count=5` are all checked by `splitFlags` today, and
`-am "x"` is read as `-a` and `-m "x"`. A test pins what each one runs.

The refs and paths are not built from text. They are the `Word` values in
`positionals`. A word built from the text `~/x` would print with no
quotes, and bash would expand it even where the model wrote `'~/x'` in
quotes. The disk check reads the same `Word`, so the check and the
command agree about `~`. The spike built a fresh literal word for the
disk check, and that is dropped.

This is the tools' own approach, and the mechanism for it exists in
safeBash. `classify` already returns a command beside the effects, and
`cdTo` uses that to replace the word after `cd` with the directory the
classifier resolved. The dev doc gives the reason: "Bash would otherwise
decide for itself where the word leads, and it can disagree with the
classifier." Git is the same case.

**What changes in the code.** `effectsFor` returns effects only, and the
git arm needs to return a command too. `effectsFor` also does four things
before it looks at the verb, and a git command needs every one:

```
  if (name.tag != "literal") { ... }               // `/bin/git` is not `git`
  if (command.assignments.length > 0) { ... }      // GIT_DIR=/x git status
  const redirect = redirectEffect(command.redirects, cwd)
  ...
  return success([...git.value, ...redirect.value])
```

If `classifySimple` called `gitEffects` directly, it would skip them
unless they were copied, and `git log > ~/.zshrc` would ask only
`std::git::log`. So there is one path, and no second caller of
`gitEffects`:

- A new private function, `simpleCommandRule(command, cwd, readsStdin)`,
  holds what `effectsFor` holds today: the four checks, then the `match`
  on the verb. It returns `{ effects, command }`. For every verb but git
  the command is the one it was given. For git it is the command
  `gitEffects` built, with the model's redirects copied onto it.
- `effectsFor` keeps its name, its signature, and its tests. Its body
  becomes a call to `simpleCommandRule` that returns the effects.
- `classifySimple` calls `simpleCommandRule` and passes both on.

**What the person and the model see.** The payload's `command` field
keeps the text the model wrote, as it does for every effect today. The
person approving reads their agent's words, and the typed fields beside
it say how safeBash read them.

A failure also names the model's text. Today `exitFailure` puts the text
that ran in the failure's `command` field. After this change that would
be the rewritten command:

```
{"command":"git -c core.pager=cat -c core.fsmonitor=false --no-optional-locks checkout '*.py' --",
 "exitCode":128, "stderr":"fatal: invalid reference: *.py", ...}
```

Git commands fail often, and a model that reads this spelling may write
it next time. `git -c ...` has no rule, because the first word after
`git` is a flag, so the copy would ask `std::bash`. `runBash` already
holds the model's text as `label`. It passes `label` to `exitFailure` as
the command, and to the "was not run" message. The model then never
reads a spelling it did not write. This also changes the failure of a
line with a rewritten `cd`, which now shows the folder as the model
wrote it.

### The effects

Fourteen effects are added to the `Effect` union in
`stdlib/safeBash/actions.agency`. Each has the payload its declaration in
`stdlib/git.agency` has. Each payload gets a named type, as the existing
`GitDiffPayload` has. Four effects share one shape, so there are eleven
new types:

```
/** The payload of an effect that names only the repository. */
export type GitRepoPayload = {
  cwd: string
}

export type GitShowPayload = {
  cwd: string;
  ref: string
}

export type GitBlamePayload = {
  cwd: string;
  path: string
}

export type GitAddPayload = {
  cwd: string;
  paths: string[];
  all: boolean
}

export type GitCommitPayload = {
  cwd: string;
  message: string
}

export type GitCheckoutPayload = {
  cwd: string;
  target: string;
  force: boolean
}

export type GitSwitchPayload = {
  cwd: string;
  branch: string;
  create: boolean
}

export type GitBranchCreatePayload = {
  cwd: string;
  branch: string
}

export type GitBranchDeletePayload = {
  cwd: string;
  branch: string;
  force: boolean
}

export type GitStashPushPayload = {
  cwd: string;
  message: string
}

export type GitRestorePayload = {
  cwd: string;
  paths: string[];
  staged: boolean
}
```

and the union gains:

```
  | { name: "std::git::show"; payload: GitShowPayload }
  | { name: "std::git::blame"; payload: GitBlamePayload }
  | { name: "std::git::branchList"; payload: GitRepoPayload }
  | { name: "std::git::remoteList"; payload: GitRepoPayload }
  | { name: "std::git::stashList"; payload: GitRepoPayload }
  | { name: "std::git::add"; payload: GitAddPayload }
  | { name: "std::git::commit"; payload: GitCommitPayload }
  | { name: "std::git::checkout"; payload: GitCheckoutPayload }
  | { name: "std::git::switch"; payload: GitSwitchPayload }
  | { name: "std::git::branchCreate"; payload: GitBranchCreatePayload }
  | { name: "std::git::branchDelete"; payload: GitBranchDeletePayload }
  | { name: "std::git::stashPush"; payload: GitStashPushPayload }
  | { name: "std::git::stashPop"; payload: GitRepoPayload }
  | { name: "std::git::restore"; payload: GitRestorePayload }
```

The two existing inline payloads, for `status` and `log`, are left as they
are. This plan changes only what it adds.

`raiseOne` in `stdlib/safeBash.agency` matches on the effect name with no
catch-all. So each new variant is a type error until it has an arm that
raises it. That is the existing safeguard, and it is why the arms cannot
be forgotten. Each arm copies the payload fields and adds `command`, the
full text, as the three existing git arms do:

```
    "std::git::commit" => {
      raise std::git::commit("Commit the staged changes", {
        cwd: effect.payload.cwd,
        message: effect.payload.message,
        command: fullCommand
      })
      return success(null)
    }
```

The fourteen names are also added to the `raises` clause of `safeBash`.

Fourteen arms that differ only in a name look like something a table
should replace. They cannot be: the comment above `raiseOne` records that
an effect is raised at a named site and not by a name held in data, so
that the compiler checks each payload against its declaration and so that
`safeBash` can list every effect in its `raises` clause. The arms follow
that existing rule.

The payload types are written twice: once in the `effect` declarations in
`stdlib/git.agency` and once in the `Effect` union. The three existing git
variants already do this, and the `raise` site checks the two against each
other: a payload with a wrong field is a type error at the `raise`. So the
duplication cannot drift silently. Removing it would mean deriving the
union from the effect declarations, which the language cannot do today.

### Refs and paths

Three effects have separate fields for a ref and a path: `log`, `diff`,
and `blame`. Git itself decides which a word is by looking at the
repository. safeBash runs nothing while it decides, so it needs a rule.

The rule has two parts.

**With `--`:** every word before `--` is a ref, and every word after it is
a path. This is what git does.

```
git diff main -- src/app.ts        ref "main", path "src/app.ts"
git log -- settings.py             no ref, path "settings.py"
```

**Without `--`:** a word that names a file or folder on disk is a path.
Any other word is a ref.

```
git diff main                      "main" is not on disk: ref "main"
git log src                        "src" is a folder: path "src"
git diff HEAD~1 package.json       ref "HEAD~1", path "package.json"
```

Reading the disk while deciding is established practice in this file. The
read family resolves its paths this way (`resolveReadPath`), and so does
grep. The helper is `resolveTarget`, which fails for a path that does not
exist. It also fails for a device such as `/dev/null`, so a device is
sorted as a ref, and git then rejects it as a ref. The check reads the
`Word` the parser produced, so a quoted `'~/x'` is looked up as a folder
named `~`, the way bash will pass it.

Because safeBash writes the `--` itself, a wrong sort cannot make git do
something other than what was asked. It can only make git fail, or answer
a different question than the model meant. There are three such cases,
and the dev doc should list them:

- **A word that is both a branch and a folder**, such as `docs`. Plain
  git refuses `git log docs` as ambiguous. safeBash asks about the path
  `docs` and runs `git log -- docs`. The approval matches what ran. The
  model may have meant the branch, and its fix is to write `git log docs
  --`.
- **A path that no longer exists**, such as a deleted file. `git log
  removed.py` reads as a ref, and git fails with "bad revision". The
  model's fix is `git log -- removed.py`.
- **A path made earlier in the same command line.** `echo q > made; git
  diff made other.py` sorts `made` as a ref, because the plan is made
  before anything runs. Git then fails with "bad revision". The dev doc
  already describes this gap under "Resolving the path when the plan is
  made".

The second and third cases cost the model a hint. Plain git answers `git
log removed.py` with "Use '--' to separate paths from revisions". The
command safeBash runs already has a `--`, so git answers "bad revision
'removed.py'" and does not say what to do. The model does not read the
dev doc. So the git section of the coder's prompt says it: put `--`
before a path that does not exist on disk. That is step 3 of pull request
3.

After `--`, a word is a path whether or not it exists, because git treats
it as one.

**How the code sees `--`.** tarsec returns `--` as `{ tag: "flag",
flagName: "--" }`. `splitFlags`, the helper every flag table goes
through, would report it as an unknown flag. So the git code splits the
command's words at the first `--` before it calls `splitFlags`, and passes
only the words before it. The words after it go through the same
word-to-text helper as every other word. That helper fails for a word
tarsec tagged as a flag, so `git log -- -x` is broad. No extra check is
written for it.

No other verb's rule changes. For every other command, `--` reaches
`splitFlags` as a flag the table does not list, and the command is broad,
as it is today when the string does not parse.

### The reads

One table row per subcommand. "Words" means the arguments that are not
flags.

| Subcommand | Flags allowed | Words allowed | Effect and payload |
|---|---|---|---|
| `status` | `-s`, `-b`, `--short`, `--branch`, `--porcelain`, `--porcelain=v1` | none | `status { cwd }` |
| `log` | `-p`, `--patch`, `--oneline`, `--stat`, `--name-only`, `--name-status`, `--graph`, `--decorate`, `--no-color`, `--reverse`, `--no-merges`, `--follow`; valued: `-n`, `--max-count`, `-S`, `-G`, `--author`, `--grep`, `--since`, `--until`; `-5` as `-n 5` | at most one ref and one path | `log { cwd, ref, path }` |
| `diff` | `-w`, `--staged`, `--cached`, `--stat`, `--shortstat`, `--numstat`, `--name-only`, `--name-status`, `--no-color` | at most two refs and one path | `diff { cwd, ref, ref2, staged, path }` |
| `show` | `-s`, `--no-patch`, `--stat`, `--name-only`, `--name-status`, `--oneline`, `--no-color` | at most one ref, no path | `show { cwd, ref }`, with `HEAD` when no ref is given |
| `blame` | none | exactly one path, no ref | `blame { cwd, path }` |
| `branch` (listing) | `-a`, `-r`, `-v`, `--all`, `--remotes`, `--list`, `--show-current`, `--merged`, `--no-merged` | none; one ref after `--merged` or `--no-merged` | `branchList { cwd }` |
| `remote` | `-v` | none | `remoteList { cwd }` |
| `stash list` | none | the word `list` | `stashList { cwd }` |

Notes on the rows:

- **`log --follow`** needs exactly one path, and git checks that itself.
  It shows the same file's history across renames. The payload's `path`
  is that file, so the payload stays true.
- **`show` with a path** (`git show HEAD -- slug.py`) has no rule, because
  `std::git::show` has no `path` field. It asks `std::bash`. The agent
  wrote this six times in 42 trials. Adding a `path` field to the effect
  would fix it, and that is a change to `stdlib/git.agency` and to every
  saved policy that names the effect, so it is left for a follow-up.
- **`blame` with a ref** has no rule for the same reason.
- **`diff` with a range** (`git diff main..feature`) is one word and reads
  as one ref, `"main..feature"`. The payload shows the range as written.
- **`diff` takes at most one path, and that limit is a safety rule.** Two
  paths after `--` is the one spelling that still compares files outside
  the repository. `git diff -- a.py b.py` therefore has no rule, even
  though it is harmless when both files are in the repository. The table
  row carries a comment saying so, and a test pins it.
- **`diff` runs behind the repository check.** It is the one subcommand
  that does something outside a repository, so it is the one that runs as
  `(git ... rev-parse --is-inside-work-tree >/dev/null && git ... diff
  ...)`. See "safeBash writes the git command it runs".
- **`git status <path>`** has no rule, because `std::git::status` has no
  `path` field.

### The writes

| Command | Effect and payload |
|---|---|
| `git add <paths>` | `add { cwd, paths, all: false }` |
| `git add -A`, `git add --all`, with or without paths | `add { cwd, paths, all: true }` |
| `git commit -m <msg>`, also `-q` | `commit { cwd, message }` |
| `git commit -am <msg>`, `git commit -a -m <msg>` | `add { cwd, paths: [], all: true }`, then `commit { cwd, message }` |
| `git checkout <ref>` | `checkout { cwd, target, force: false }` |
| `git checkout -b <name>` | `switch { cwd, branch, create: true }` |
| `git switch <name>` | `switch { cwd, branch, create: false }` |
| `git switch -c <name>`, `--create` | `switch { cwd, branch, create: true }` |
| `git branch <name>` | `branchCreate { cwd, branch }` |
| `git branch -d <names>`, `--delete` | one `branchDelete { cwd, branch, force: false }` per name |
| `git stash`, `git stash push`, with `-m <msg>` | `stashPush { cwd, message }` |
| `git stash pop` | `stashPop { cwd }` |
| `git restore --staged <paths>` | `restore { cwd, paths, staged: true }` |

Notes on the rows:

- **Paths for `add` and `restore`** are passed as written and need not
  exist. `git add .` has `paths: ["."]`. A glob (`git add *.py`) is not
  literal text, so the command is broad: bash expands the glob, and
  safeBash cannot know to what.
- **The commit message** must be literal: a quoted word with no variable
  in it. `git commit -m "$MSG"` is broad. A message given twice (`-m a -m
  b`) is broad, because the payload has one `message`.
- **`git commit -a`** stages every tracked file that changed, and then
  commits. The `add` effect with `all: true` describes staging everything,
  which is slightly more than `-a` does, since `-a` leaves untracked files
  alone. The approval covers at least what happens. I chose two effects
  over one because a policy that wants to see every staging gets to.
- **`git checkout <ref>`** reads its words as refs and paths, and its
  table row allows exactly one ref and no path. A word that names a file
  or folder is a path, the row does not allow one, and the command is
  broad. A word that is not on disk is a ref, and the command safeBash
  runs is `git checkout <word> --`. If the word is not a real ref, such
  as `'*.py'` or `':/'` or a deleted file's name, git fails with "invalid
  reference" and no file is touched. So a discard can never run under a
  checkout approval.
- **`git checkout -b <name>`** is handled before the words are sorted,
  because the word is a new branch name and not a ref or a path. `git
  checkout -b src` works in a project with a `src` folder.
- **`git checkout -b <name> <start>`** and **`git branch <name> <start>`**
  have no rule, because neither effect has a start point field.
- **`git branch -D`**, **`git checkout -f`**, **`git stash drop`**, **`git
  stash -u`** have no rule.
- **`git add -u`** has no rule: it stages tracked changes only, and the
  payload has no way to say that.

### What stays broad

For clarity, these keep asking `std::bash` after this work: `git push`,
`pull`, `fetch`, `merge`, `rebase`, `revert`, `cherry-pick`, `reset`
without `--hard`, `rm`, `mv`, `tag`, `rev-parse`, `merge-base`,
`ls-files`, `config`, `submodule`, `worktree`, any `git -C <dir>`, any
`git -c <setting>`, and any command with a `--format` or `--pretty`
value.

`git --no-pager <subcommand>` is common in other agents' transcripts. It
is not in the eval data, so it is left broad until it shows up.

### The refusal list

The changes, all in `isDestructiveGit`:

1. `restore` is refused unless its only flag is `--staged`, not counting
   a `--` separator. Today every `restore` is refused. `git restore
   --staged a.py` and `git restore --staged -- a.py` then reach the rule
   above. The spike counted `--` as a flag and refused the second form.
2. `checkout` is refused when it has a `--` word, as well as when it has a
   `.` argument. This is decision 2. The check is the existing
   `hasFlag(command, "--")`, since tarsec returns `--` as a flag word.
3. `checkout` is refused when it has two or more words that are not
   flags, and neither `-b` nor `-B`. `git checkout main src/utils.py` is
   refused, and `git checkout -b fix origin/main` is not. The count comes
   from a new helper, `plainWordCount`, which counts every argument whose
   tag is not `flag`. The subcommand is the first argument, so the test
   is a count of three or more. `hasLiteralArg` is not used for this,
   because it sees only words tagged `literal`, and `src/utils.py` is
   tagged `path`.
4. Nothing else. `clean` and `reset --hard` are unchanged.

The refusal list does not read the disk. It is called on every command
before classification, and it must stay a check on the words alone.

With tarsec 0.5.7 these become refused, where today they ask `std::bash`:
`git restore -- utils.py`, `git checkout -- utils.py`, `git checkout --
.`.

### What git itself can run

Approving `std::git::status` approves running the `git` program, and git
can run other programs. The first version of this plan said the shell
path and the tool path were equal here. They were not: see "How a git
tool runs git". The table says where they are equal after this work and
where they still differ.

| | Git tool | Git through safeBash, after this work |
|---|---|---|
| `core.fsmonitor`, the pager, optional locks | fixed flags | the same fixed flags, from the same list |
| Refs and paths | separated with `--` | separated with `--` |
| `git diff` outside a repository | compares files; the `gitDiff` bug on `main` | does not run, because of the `rev-parse` check |
| `GIT_DIR` and the other variables | removed | removed, by decision 3 |
| Time limit | 30 seconds | none; `_bash` is called with no limit |
| Output size | capped at 2 MB | saved by the spill tools past a preview |
| `destructive` mark on a write | yes | no, by the existing decision in `safe-bash.md` |

What still runs on both paths, from the repository's own config: hooks on
commit and checkout, `diff.external`, textconv filters, and
`gpg.program`. A policy that approves a git effect in a repository
approves whatever that repository's config names for those. This is
true of the tools today.

That makes a write to `.git/config` or `.git/hooks` the thing to guard.
`docs/dev/agents/approval-policies.md` records that `**` in a policy rule
never matches a path segment that starts with a dot, and that this "is
what shields `.git` from broad approve rules". So the policy that accepts
edits does not approve a write under `.git`. Pull request 3 pins that
with a test before it removes the tools.

Two things safeBash already does stay as they are:

- A leading assignment makes a command unrecognized, so `GIT_DIR=/x git
  status` is broad.
- The command word must be the literal `git`. `/usr/bin/git` and
  `./git` are broad.

### How the code is shaped

The spike wrote one function per subcommand, and each function checked
its own word counts by hand:

```
  if (found.refs.length > 1 || found.paths.length > 1) {
    return failure("`git log` with more than one ref or path has no rule")
  }
```

Thirteen functions held thirteen versions of that check. The real version
states a subcommand's shape as a table row wherever one row can state it,
and checks those rows with one function. Nine subcommands have one shape:
`status`, `log`, `diff`, `show`, `blame`, `remote`, `add`, `switch`, and
`restore`. Four do not, and "The four that keep their own function" below
covers them. This is how the read family and the listings are already
written: `READ_VERBS` and `LIST_VERBS` are tables keyed by verb, and
`readFileVerb` and `listEffects` hold the code.

**The table.** `GIT_VERBS`, in `stdlib/safeBash.agency` beside the other
two:

```
/** How a git subcommand's words are read.
 - `refsAndPaths`: words before `--` are refs and words after it are
   paths. With no `--`, a word that names something on disk is a path.
 - `paths`: every word is a path, on either side of a `--`.
 - `names`: every word is a plain name, such as a branch. A `--` has no
   rule. */
type GitWords = "refsAndPaths" | "paths" | "names"

/** A git subcommand's flags, how its words are read, and how many of
 each kind it takes. */
type GitVerb = {
  flags: FlagSpec;
  words: GitWords;
  refs: CountRange;
  paths: CountRange;
  names: CountRange
}

static const NONE: CountRange = { least: 0, most: 0 }
static const EXACTLY_ONE: CountRange = { least: 1, most: 1 }
static const AT_MOST_TWO: CountRange = { least: 0, most: 2 }
static const AT_LEAST_ONE: CountRange = { least: 1, most: null }

static const GIT_VERBS: Record<string, GitVerb> = {
  log: {
    flags: {
      plain: ["p", "--patch", "--oneline", "--stat", "--name-only", "--name-status", "--graph", "--decorate", "--no-color", "--reverse", "--no-merges", "--follow"],
      valued: ["n", "S", "G", "--max-count", "--author", "--grep", "--since", "--until"],
      optionsFirst: false,
      digitFlag: "n"
    },
    words: "refsAndPaths",
    refs: AT_MOST_ONE,
    paths: AT_MOST_ONE,
    names: NONE
  },
  diff: {
    flags: {
      plain: ["w", "--staged", "--cached", "--stat", "--shortstat", "--numstat", "--name-only", "--name-status", "--no-color"],
      valued: [],
      optionsFirst: false
    },
    words: "refsAndPaths",
    refs: AT_MOST_TWO,
    // A safety rule, not a convenience: two paths make git compare files
    // outside the repository.
    paths: AT_MOST_ONE,
    names: NONE
  },
  add: {
    flags: { plain: ["A", "--all"], valued: [], optionsFirst: false },
    words: "paths",
    refs: NONE,
    paths: ANY_NUMBER,
    names: NONE
  },
  switch: {
    flags: { plain: ["c", "--create"], valued: [], optionsFirst: false },
    words: "names",
    refs: NONE,
    paths: NONE,
    names: EXACTLY_ONE
  },
  // ... one row for each of the nine single-shape subcommands
}
```

`CountRange`, `ANY_NUMBER`, `AT_MOST_ONE`, `countFits`, and
`describeCount` exist already, at line 1273. They were written for the
read family's path counts and `tr`'s set counts.

A comment above the table names the flags left out and why, as the
comment above `GREP_FLAGS` does.

**The one function that holds the checks.** `gitEffects(command, cwd)`
replaces the function of that name. It returns the effects and the
command to run. Its one caller is the `git` arm of `simpleCommandRule`,
which has already checked the command word, refused a leading
assignment, and worked out the redirect effects. For a subcommand with a
row, `gitEffects` does these steps, each a `const` computed from the one
before:

1. Read the subcommand, the first word, and look up its row.
2. Split the remaining words at the first `--`.
3. Run `splitFlags` over the words before it, against the row's flags.
4. Turn the words on both sides into text with `echoWords`, the existing
   helper that fails when any word is not literal. It gains a second
   caller, so it is renamed `literalWords`.
5. Sort the words into refs, paths, and names, by the row's `words`. Each
   sorted word keeps its `Word` beside its text, as a `GitWord`. The disk
   check for a `refsAndPaths` row is `resolveTarget(text, word, cwd)` on
   that pair.
6. Check each count against the row with `countFits`, and fail with
   `describeCount`'s wording: ``git log takes at most 1 ref``.
7. Call `gitPayloads` with the result, for the effects. It reads the
   texts.
8. Build the command to run, with `gitCommand`. It reads the `Word`
   values and the checked flags.

`gitCommand(args, redirects)` is the one place a git command is
assembled. It returns a `SimpleCommand`, the parser's own type, so the
text that runs is printed by `astToBash` like every other narrow command.
Its arguments, in order:

1. The fixed flags, as words. `GIT_HARDENING_FLAGS` is a list of strings,
   and `fixedFlagWords` turns each into a flag word when it starts with
   `-` and a literal word otherwise. tarsec parses the same text into the
   same words.
2. The subcommand, a literal word.
3. The flags, built from `args.plain` and `args.values` by `flagWords`,
   following the table in "Where the flag words come from".
4. The ref words and the name words, each the model's own `Word`.
5. A `--` flag word, when the row's `words` is `refsAndPaths` or `paths`.
6. The path words, each the model's own `Word`.

The command's `redirects` are the model's, passed in by the caller.

For `diff`, `gitEffects` then wraps the result with `insideRepository`,
which returns the `parens` node described above: a `rev-parse` command
with the same fixed flags and a redirect to `/dev/null`, joined by `and`
to the diff. I checked that `astToBash` prints that node, alone and as a
stage of a pipe.

**The one function that says what each command asks.** `gitPayloads(args)`
is a `match` on the subcommand. Each arm builds the effects from words
that have already been checked, so most arms are one expression:

```
    "log" => success(
      [gitLogEffect({ cwd: args.cwd, ref: firstText(args.refs, ""), path: firstText(args.paths, "") })],
    )
    "switch" => success(
      [gitSwitchEffect({ cwd: args.cwd, branch: args.names[0].text, create: hasAny(args.plain, ["c", "--create"]) })],
    )
```

`gitLogEffect` and `gitSwitchEffect` are constructors in
`stdlib/safeBash/actions.agency`, one per git effect. Each takes the
payload and returns the `Effect`, as the existing `readEffect`,
`lsEffect`, and `grepEffect` do. `firstText(words, fallback)` and
`hasAny(items, wanted)` are two new three-line helpers. The file has no
equivalent today: it reads a flag with an inline comprehension, such as
`[entry.value for entry in args.values if entry.flag == "e"]`, and the
git arms would repeat that twenty times.

**The four that keep their own function.** For `branch`, `stash`,
`commit`, and `checkout`, the allowed words depend on the flags, so one
row cannot state them:

- `branch` has three shapes. A listing takes no name, or one ref after
  `--merged`. A create takes exactly one name and no flag. A delete takes
  one or more names and only `-d`. `git branch -v newname` creates a
  branch, so a listing flag beside a name must have no rule.
- `stash` takes a word that is a second subcommand: `push`, `pop`, or
  `list`.
- `commit` raises one effect or two, by `-a`.
- `checkout -b <name>` takes a new branch name, and `checkout <ref>`
  takes a ref and is rebuilt with `--`.

Each of the four has a flag list in `GIT_SHAPED_FLAGS`, a table of
`FlagSpec` keyed by subcommand, and one function that checks its own
words and returns effects and the command, using the same `splitFlags`,
`literalWords`, `countFits`, and `gitCommand`. `gitEffects` looks in
`GIT_VERBS` first and then in a `match` over these four. A subcommand in
neither has no rule.

`branch` is where a mistake is most likely. Its tests cover every pairing
of a listing flag with a name.

`args` is the checked command:

```
/** One of a git command's words: its text, for a payload, and the word
 the parser produced, for the command that runs. */
type GitWord = {
  text: string;
  word: Word
}

/** A git command after its flags and words were checked against its row. */
type GitArgs = {
  sub: string;
  plain: string[];
  values: FlagValue[];
  refs: GitWord[];
  paths: GitWord[];
  names: GitWord[];
  cwd: string
}
```

**Adding a single-shape subcommand** is then one table row and one
`match` arm. Adding a flag is one string in a row.

**Why the rules stay in `stdlib/safeBash.agency`.** The file is 3,337
lines, and this adds about 570: 130 for the payload types, union variants
and constructors, 110 for the raise arms, 100 for the tables, 160 for
`gitEffects`, `gitPayloads`, the four shaped functions and the helpers,
55 to build the command with its flag words and pass it out through
`simpleCommandRule`, and 15 for the repository check around `diff`. That
puts the file near 3,900 lines. I considered a separate file,
`stdlib/safeBash/git.agency`. It would need `FlagSpec`, `FlagValue`,
`CountRange`, and the count helpers, all of which are declared in
`safeBash.agency`, which in turn would import the new file. Breaking that
circle means moving five declarations, two of them exported and listed on
the generated docs page. Every other verb family lives in this file, with
its table. So the git rules go beside them, and splitting the file by
family is listed under "What is deliberately left for later", as one
change that moves all the families.

## How this differs from the spike

The spike is commit `1994d9502` on `adit/safebash-git`. The real version
changes seven things. The first two close holes, so the spike must not be
merged as it stands.

1. **safeBash writes the command it runs**, with `--` between refs and
   paths, and with a check that git sees a repository before a `diff`.
   The spike runs the model's text, so `git diff /dev/null <any file>`
   prints the file under a `std::git::diff` approval, and `git checkout
   '*.py'` discards work under a `std::git::checkout` approval.
2. **The command carries the git tools' fixed flags**, and the shell
   loses the variables that point git elsewhere.
3. **`--` from the model is handled.** The spike predates tarsec 0.5.7.
4. **Nine subcommands are table rows.** The spike wrote one function per
   subcommand, each with its own count checks.
5. **`log --follow` and `-G`** are added, from the eval data.
6. **The refusal list covers `checkout --`**, and `restore --staged --
   <paths>` is not refused.
7. **Tests and docs.** The spike has neither, and one existing test
   fails.

The spike's flag lists and raise arms carry over as written. Its effect
variants carry over with named payload types.

## Pull request 1: tarsec 0.5.7 and the refusal list

Branch from `origin/main`. This pull request changes no rule. It changes
what parses, and makes the refusal list correct for it.

**Step 1. Bump the pin.** `package.json`: `"tarsec": "0.5.6"` becomes
`"0.5.7"`. Run `pnpm install` and commit the lockfile.

**Step 2. Find every test the new parser changes.** Run
`tests/agency/safeBash.test.json` and `lib/stdlib/safeBash.test.ts`, with
the output saved to a file. Expect failures where a test pins a string as
unparseable. `planReasons` pins the parser's message for one such string;
if that string now parses, pick another that still does not, such as `echo
$(date)`.

**Step 3. Check the read and list rules against the new words.** A
literal word can now hold `~` or `^` after its first character. Add cases
to the existing plan tests for:

- `cat a~b`: a read of a file named `a~b`. `tildeModeFor` returns
  `"expand"` for a literal word, and `expandPath` must leave an inner `~`
  alone. Confirm by reading `expandPath`, then pin it.
- `ls -- src`: `--` is an unknown flag to the `ls` table, so the plan is
  broad. Pin it, so a later change that teaches `ls` about `--` is
  deliberate.
- `rm -- file`: refused, by command word. Pin it.
- `pnpm test -- --watch`: this one changes. Today it does not parse and
  asks `std::bash`. With 0.5.7 it parses, `execEffects` renders the `--`
  as an argument, and it asks a narrow `std::exec`. A saved rule for
  `pnpm test` then covers `pnpm test -- <anything>`. That matches what
  `safe-bash.md` says a saved rule covers, under "Programs with no rule".
  Pin it, and name it in the pull request description, so "this pull
  request changes no rule" is read correctly: no rule's text changes, and
  more command lines now reach the rules.
- `echo -- hi` and `cd -- src`: not shell-free and unrecognized, as any
  unknown flag. Pin both.

Add `git checkout -- file.txt`, `git diff HEAD~1`, and `git show HEAD^`
to the `astToBash` round-trip cases in `lib/stdlib/safeBash.test.ts`.

**Step 4. The refusal list.** In `isDestructiveGit`, refuse `checkout`
when `hasFlag(command, "--")` holds. Update the comment at line 2738,
which says a bare `--` does not parse.

Add to the `refuseWall` test: `git restore -- utils.py`, `git checkout --
utils.py`, and `git checkout -- .` are refused; `git checkout main` is
not.

**Step 5. The doc.** `docs/dev/stdlib/safe-bash.md`: the "Outcomes"
section names the refused git spellings; add the `--` forms. The
"Pipelines, dup redirects, and glob words" section describes what the
parser produces; add a paragraph on `--` and on `~` and `^` inside a word.

**Step 6. Checks before pushing.** `pnpm run typecheck`, `pnpm run
lint:structure`, the two safeBash test files, and
`--check-capabilities` on the Agency test.

## Pull request 2: the git rules

Branch from `main` after pull request 1 merges.

**Step 1. Tests first.** Add a node per group to
`tests/agency/safeBash.agency`, each a list of `planFor` results, in the
style of `classifyOneCommand`:

- `gitReads`: one accepted spelling per row of the reads table, and the
  payload for each. Payloads matter more than names here: `git log
  --oneline -n 5 src` must give `{ ref: "", path: "src" }`.
- `gitRefsAndPaths`: the `--` cases and the disk cases, run in a fixture
  folder that has a file and a folder with known names. Include a word
  after `--` that does not exist.
- `gitWrites`: one row per line of the writes table, with payloads.
- `gitStaysBroad`: every spelling the design says has no rule. This is the
  test that keeps the allowlists honest: `git log --all`, `git diff
  --no-index a b`, `git diff --output=x`, `git commit --amend -m x`, `git
  commit` with no message, `git commit -m "$MSG"`, `git branch -D x`, `git
  checkout -f main`, `git checkout <existing file>`, `git add *.py`, `git
  add -u`, `git stash drop`, `git stash -u`, `git show HEAD -- a.py`, `git
  status src`, `git -C /tmp status`, `GIT_DIR=/x git status`,
  `/usr/bin/git status`, `git push`.
- `gitInChains`: `git add a.py && git commit -m "x"` is narrow with both
  effects in order; `git status | head -5` is narrow; `git add a.py &&
  git push` is broad with one `std::bash`.
- `gitRestoreStaged`: `git restore --staged a.py` and `git restore
  --staged -- a.py` are narrow; `git restore a.py`, `git restore --
  a.py`, and `git restore --staged --worktree a.py` are refused.
- `gitRunsWhatItAsked`: the text each plan runs. This is the test for the
  holes. Every command it checks starts with the fixed flags.
  - `planFor("git checkout '*.py'")` runs a command that ends `'*.py'
    --`.
  - `git log src` runs a command that ends `-- src`.
  - `planFor("git diff /dev/null /etc/hosts")` runs a group in
    parentheses: the `rev-parse` check, `&&`, and a diff with `/dev/null`
    before `--` and `/etc/hosts` after it.
  - `git diff main | head -5` runs that group as the first stage of the
    pipe.
  - `git diff -- a.py b.py` is broad.
  - Redirects are kept and asked about. `git diff > out.patch` asks
    `std::write` and `std::git::diff`, and the diff inside the group ends
    `> out.patch`. `git log > /etc/hosts` asks a `std::write` for
    `/etc/hosts`.
  - Each spelling of a flag runs as the built one: `git log -n5`, `git
    log -n 5`, `git log -5`, and `git log --max-count=5`; `git commit -am
    "x"`; `git log --author=dana`; `git commit -m "it's a fix"`, whose
    message is printed inside quotes.
  - A quoted `git add '~/x'` runs with the word still quoted.
- `gitBranchShapes`: every pairing of a listing flag with a name, of `-d`
  with another flag, and of a name with a second word.

Every node above goes through `planFor`, `effectsFor`, or `isRefused`,
and uses the existing helpers `effectNamesFor`, `planSummary`, and
`refusedFor`. None of them runs a command. This matters for the refusal
cases: a test that called `safeBash("git checkout -- .")` to see it
refused would, on the day the refusal broke, discard every uncommitted
change in the checkout the tests run in.

Add two end-to-end runs with interrupt expectations, in the style of the
existing `safeBash("git status")` test at line 253:

- A read, `git log -1 --oneline`, approved. It checks the effect raised
  and that git's output came back.
- A write, `git commit -m "x"`, rejected. It checks that
  `std::git::commit` was raised with the message in its payload, and that
  the failure is marked rejected. Nothing runs, so the test cannot commit
  to the repository it runs in.

No test approves a git write in the checkout the tests run in.

**One test runs real git, in folders of its own.** The claims this design
rests on are claims about git: what it does with a `--`, with a path
outside the repository, with a pathspec, with no repository at all. Every
hole the reviews found came from getting one of those claims wrong, and
no `planFor` test can catch that.

The test is a node in `tests/agency/safeBash.agency`, `gitRunsSafely`.
It cannot be a TypeScript test in `lib/stdlib/safeBash.test.ts`: that
file imports the parser and the printer, and `planFor` is Agency code a
vitest file has no direct way to call. The Agency test file already
makes folders with `std::fs` and runs real commands, as
`chainMatchesBash` does.

Each case is `safeBash(command, folder) with approve`. That goes through
the whole path: the plan, the rewrite, the cleaned environment, and
bash. Before each call the test also checks `outcomeOf(planFor(command,
folder))` is `"narrow"`. Without that, `with approve` would approve a
`std::bash` for the model's own text, and the test would pass while
testing nothing.

It uses two folders.

**A repository.** `GIT_FIXTURE` is `__dirname +
"/stdlib/__safebash_git__"`, beside the file's other fixtures. The test
removes and remakes it, runs `git init -q -b main` in it through `bash(...)
with approve`, writes `a.py` and `b.py`, commits them with a name and
email given by `-c`, and edits both. Then:

- `git checkout '*.py'` is a failure, and both files still hold their
  edits. The failure's `command` field is `git checkout '*.py'`, the
  text the model wrote, with no fixed flags in it.
- `git diff /dev/null <the file in the second folder>` is a failure, and
  the file's text is in neither its output nor its error.
- `git checkout main` succeeds.
- `git log --oneline` prints the commit.
- `git diff > out.patch` succeeds, and `out.patch` holds the diff.

**A folder with no repository above it.** `GIT_NO_REPO` is
`/tmp/__safebash_git_norepo__`. It has to be outside the checkout,
because every folder under the checkout has the checkout's repository
above it. `/tmp` exists on the CI runner and on macOS. Confirm on the
first run that the test runner lets a test make a folder there. The
folder holds one file with a marker line. Then:

- `git diff /dev/null <that file>`, run with this folder as the working
  directory, is a failure whose error says "not a git repository", and
  the marker line is in neither its output nor its error.

Both folders are removed with `remove(...) with approve`, as the file's
other fixtures are. If a case fails, the damage is inside a folder the
test made. The test also guards against a git version that reads a
spelling differently, which is a real risk: see the `gitCheckout` bug
under "Two ways git reads a word differently".

Update `classifyOneCommand`, which expects `git log --graph` and `git
diff --staged --stat` to be unrecognized. Both now have a rule.

**Step 2. The effects.** Add the eleven payload types and the fourteen
variants to `Effect`. The build now fails in `raiseOne`, which is the
intended reminder. Add the fourteen arms and the fourteen names in the
`raises` clause.

**Step 3. The table.** `GitWords`, `GitVerb`, the four new count
constants, and `GIT_VERBS`, with the comment naming the flags left out.

**Step 4. `gitEffects`, `gitPayloads`, and `gitCommand`.** As described
in "How the code is shaped". Rename `echoWords` to `literalWords` at its
one existing call site. Import `GIT_HARDENING_FLAGS` from
`agency-lang/stdlib-lib/git.js`, which re-exports it. `gitCommand` comes
with its three helpers: `fixedFlagWords`, `flagWords`, and
`insideRepository`, which wraps a `diff`.

**Step 4a. One path for every simple command.** Move the body of
`effectsFor` into a private function, `simpleCommandRule(command, cwd,
readsStdin)`, that returns `{ effects, command }`. It keeps the four
checks `effectsFor` makes before its `match`: a command word, a literal
command word, no leading assignment, and the redirect effects. Its `git`
arm calls `gitEffects`, adds the redirect effects, and returns the
command `gitEffects` built. Every other arm returns the command it was
given.

`effectsFor` keeps its name, its signature, and its tests, and becomes a
call to `simpleCommandRule` that returns the effects. `classifySimple`
calls `simpleCommandRule` and passes on both. `gitEffects` has no other
caller, so no path reaches a git rule without the four checks.

**Step 4b. The shell's environment.** This is decision 3, option C.

1. Make `lib/host/gitEnvironment.ts` with three exported lists:
   `GIT_RETARGET_ENV`, `GIT_CODE_ENV`, and `GIT_SSH_ENV`. Their entries
   are today's `SCRUB_ENV_KEYS`, split by the comments already in that
   list, with `GIT_SSH`, `GIT_SSH_COMMAND`, and `GIT_PROXY_COMMAND` in
   the third.
2. In `lib/stdlib/gitCore.ts`, `SCRUB_ENV_KEYS` becomes the three lists
   joined. The git tools remove what they remove today, and
   `lib/stdlib/gitCore.test.ts` should pass unchanged.
3. In `lib/host/node/nodeSubprocess.ts`, `shellEnvironment` also removes
   the first two lists. `GIT_CONFIG*` is a prefix, and
   `SHELL_ENV_REMOVED_PREFIX` holds one prefix today, so it becomes a
   list of prefixes.
4. Add cases to the `shellEnvironment` tests in
   `lib/host/node/nodeSubprocess.test.ts`: `GIT_DIR`,
   `GIT_EXTERNAL_DIFF`, and `GIT_CONFIG_COUNT` are removed, and
   `GIT_SSH_COMMAND` is kept.
5. Update the list of removed variables in `docs/dev/runtime/host.md` and
   in "Which shell runs the text" in `safe-bash.md`.

**Step 4c. A failure names the model's text.** In `runBash`, pass `label`
to `exitFailure` as the command, and use it in the "was not run"
message. `label` is the model's text, which `runBash` already computes.
Update any existing test that pins the rewritten text in a failure, such
as one with a `cd` in it.

**Step 5. Remove what the new code replaces.** The old `gitEffects` goes.
`literalArgs` and `flagNames`, which it used, both have another caller
and stay.

**Step 6. The refusal list.** `restore` is refused unless its only flag is
`--staged`, not counting `--`. `checkout` is refused with two or more
words that are not flags and neither `-b` nor `-B`, counted by the new
`plainWordCount`. Add to `refuseWall`: `git checkout main src/utils.py`,
`git checkout main "utils.py"`, and `git checkout HEAD~1 .` are refused;
`git checkout -b fix origin/main` and `git checkout -B fix origin/main`
are not.

**Step 7. The rejection hint.** `READ_TOOL_FOR_VERB` names the tool to
call when a broad command is rejected. It has no git entry, and it should
not get one: after pull request 3 the coder has no git tool to be pointed
at. Confirm the table is unchanged.

**Step 8. The doc.** A new section in `docs/dev/stdlib/safe-bash.md`,
"git", holding: the one rule, the two tables, why safeBash writes the
command it runs and where its flag words come from, the repository check
around `diff` and why it runs when the command runs, the ref and path
rule with its three wrong-guess cases, the list of what stays broad and
why, and the table on what git itself can run. "What the model reads on
a rejection" gains a paragraph on the failure's `command` field. Update the "Outcomes" section, which
lists the four old spellings, and "Files and tests". Add the doc's new
sections to the index line in `CLAUDE.md` and to the `agency-stdlib-docs`
skill.

**Step 9. Checks before pushing.** As in pull request 1, plus the
anti-pattern audit of the diff against
`docs/dev/contributing/anti-patterns.md`.

**Step 10. Measure.** Build an eval image from the branch and run the git
suite against it, with the coder still carrying its git tools. This run
shows what the rules do to a `main` agent: the model already runs git in
the shell about 1.4 times per task. Record the count of broad approvals
against the 1.3 on `main`.

Also tally `Plan.broadReason.detail` from the `safeBash plan` debug
events in that run, for commands whose first verb is `git`. The tally
says which missing rule costs the most prompts, and in particular whether
quoted flag values are worth the follow-up.

## Pull request 3: the coding agent

Branch from `main` after pull request 2 merges.

**Step 1. Read the SWE-bench results.** Three ten-task runs were started
on 2026-11-06: `fw-agency-main-c0f0f91ac`, `fw-agency-git-agent`, and
`fw-agency-safebash-git`, in `~/bench-agency/jobs`. Compare the first and
the third. If the spike passes fewer tasks than `main` by more than one,
stop and look at the failed trials before going on: one trial per task
swings by about one task between runs.

**Step 1a. Pin the guard on `.git`.** Before the hardened tools leave the
coder, add a test that the policy that accepts edits does not approve a
write to `.git/config` or to a file under `.git/hooks` inside the
project, through the `write` tool and through a `safeBash` redirect. The
policy doc says a `**` rule cannot reach a dot-led folder. This test
makes that a checked fact, because after this pull request a write there
followed by `git commit` would run a hook with no prompt.

**Step 2. Remove the tools.** In `stdlib/agents/coding.agency`, drop
`...gitTools()` from `buildTools()` and the import.

**Step 3. The prompts.** Two places tell the coder how to do git.

- `stdlib/agents/coding.agency`: the system prompt has a section headed
  "Avoid safeBash and exec when possible". Add a section after it that
  says git is the exception, lists the subcommands with a rule, and shows
  one chained example. The spike's wording is the starting point. Add one
  sentence the spike does not have: put `--` before a path that does not
  exist on disk, as in `git log -- removed.py`. Without it the model gets
  "bad revision" for such a path and no hint about the fix.
- `lib/agents/agency-agent/brains/coordinator/prompts/code.md`, item 7:
  it names the git tools. Replace it with the same guidance.

The owner is rewriting the agent's system prompts separately. Keep this
change to those two passages so the two pieces of work do not collide.

**Step 4. The tests that pin the tool lists.**

- `tests/agency/agents/toolGaps.agency`: `codingReachesGithubThroughThe
  Handoff` and its neighbours list what the coder carries. Add a node,
  `codingHasNoGitTools`, that fails if any name starting with `git` is in
  `buildTools()` other than `githubAgent`.
  `historyReadersHaveGitButCannotCommit` covers the four agents that keep
  the read-only tools. Its name now promises more than it checks, since
  two of those agents can commit through `safeBash` when the policy
  approves. Rename it `historyReadersCarryNoGitWriteTool` and fix its
  description, by decision 4.
- `tests/agency/agents/toolkits.agency`: it pins the bundles. The bundles
  do not change.
- `lib/stdlib/agentToolTrace.ts`: the trace table has a row per git tool.
  The rows stay, because the other four agents still call those tools.

**Step 5. The eval suite.** Bring `evals/agency-agent-git` over from
`adit/git-agent-eval`: the fourteen tests, `lib/checks.ts`,
`lib/checks.test.ts`, `run-in-docker.sh`, and `compare.mjs`. Add `git` to
`evals/agency-agent/docker/Dockerfile`. Add a `README.md` to the suite
with the run command, and a section to
`docs/dev/evals/agency-agent-suite.md` on why each test builds its
repository with a script.

One check in the suite is too strict: `commit-all` requires a clean tree
after the commit, and an agent that runs Python leaves `__pycache__`
behind. Add a `.gitignore` to that test's repository, as `fix-and-commit`
has.

**Step 6. Measure.** Run the git suite and the ten SWE-bench tasks on the
branch. The expected result on the git suite is what the spike showed:
all trials pass, at lower cost than `main`. Put the numbers in the pull
request description.

**Step 7. The docs.** `docs/dev/agents/why-the-agent-writes-tools.md`
discusses what a tool costs in context; add the git tools as a worked
example with the measured numbers. Update the module comment in
`stdlib/agents/coding.agency`.

## Risks

**The model's git output is longer.** A git tool returns trimmed,
structured output. `git log` through bash returns git's text. Long output
is saved by the spill tools and the model sees a preview, so it cannot
flood the context. In the spike run, input tokens per task fell from 166k
to 105k, so this did not show up as a cost.

**A saved policy that approves a git write now approves it from bash.** A
user who approved `std::git::commit` for a project approved commits made
by the `gitCommit` tool. After pull request 2 the same rule approves `git
commit -m` typed in `safeBash`. The payload is the same and the act is the
same, so I think this is what the user meant. It is still a change in
what an existing rule covers, and the pull request description should say
so.

**The allowlists are claims about git.** There are about sixty flags in
the tables, and each entry says "this flag does not widen what the
payload describes". A flag that is wrong is a hole. Three things limit
the risk. The command safeBash runs fixes the positions of words, so a
row is a claim about flags only. `gitStaysBroad` pins the flags known to
be dangerous. And the real-git test checks the spellings the design
depends on.

**A git write through the shell is not marked destructive.** The git
tools mark their writes, so a failed tool call after a write is not
retried. A bash call is never marked, by the existing decision recorded
in `safe-bash.md` under "Why a bash call is never destructive". After
pull request 3 the coder's git writes are on the unmarked path. This is a
known difference and the plan does not change it.

**No time limit.** A git tool stops after 30 seconds. A git command
through the shell runs until it ends. `git log` on a very large
repository, or a command waiting on a credential prompt, would wait. The
agent's own budget is the limit.

**Two effects for `commit -a`.** A user answering prompts by hand sees two
questions for one command. That is how every chained command already
behaves.

## What the reviews changed

### The first review

The review is `docs/superpowers/plans/2026-11-06-safebash-git-commands-review.md`.
I ran every git command it cites, in a scratch repository with git
2.39.5, and each behaved as it says.

| Finding | What changed in this plan |
|---|---|
| 1. `git diff` reads any file | "safeBash writes the git command it runs". The `diff` row's one-path limit is marked as a safety rule. |
| 2. `git checkout <word>` discards work | The same section. `checkout <ref>` is rebuilt with a trailing `--`. |
| 3. The fix: write the command | Adopted as the design. `gitCommand` builds it and `classifySimple` passes it on. |
| 4. The shell path is weaker than the tools | The fixed flags are in the rebuilt command. Decision 3 covers the environment variables. The table in "What git itself can run" states what still differs. |
| 5. The verifier can commit | Decision 4. |
| 6. `restore --staged -- a.py` is refused | The refusal does not count `--`. A test covers the form. |
| 7. The table does not fit four subcommands | The plan says nine rows and four functions. `checkout -b` is handled before words are sorted. |
| 8. Quoted flag values parse | The tarsec section is corrected. The follow-up is listed, and step 10 measures it. |
| 9. Pull request 1 changes more than the refusal list | `pnpm test -- --watch` and two more are pinned, and the round-trip cases are added. |
| 10. Test the claims against real git | One test runs the rebuilt commands with real git in a directory of its own. |

One thing I found while checking that the review does not state: two
paths after `--` still compare files outside the repository. That is why
the `diff` row's limit is a safety rule.

I did not adopt one suggestion as written. The review proposes returning
the rewritten command from `effectsFor`. That function is exported and
its tests read a list of effects, so its signature stays. The second
review's finding 2 settles how: one private function returns both, and
`effectsFor` returns its effects.

### The second review

The review is
`docs/superpowers/plans/2026-11-06-safebash-git-commands-review-2.md`. It
tested the rewritten commands against git 2.39.5 and tarsec 0.5.7.

| Finding | What changed in this plan |
|---|---|
| 1. Outside a repository, the rewritten `git diff` still prints the file | A recognized `git diff` runs behind `git rev-parse --is-inside-work-tree`, in parentheses. "Two ways git reads a word differently" states the fact, and "safeBash writes the git command it runs" has the design. The real-git test has a folder with no repository above it. |
| 2. Step 4a can skip the checks `effectsFor` makes | One private function, `simpleCommandRule`, holds the checks and returns effects and command. `gitEffects` has no other caller. The built command keeps the model's redirects, and two tests cover redirects. |
| 3. A failed command shows the model the rewritten text | `runBash` reports the model's text in a failure (step 4c). The coder's prompt says to put `--` before a path that is not on disk. |
| 4. The real-git test cannot be a TypeScript test | It is a node in `tests/agency/safeBash.agency` that calls `safeBash(...) with approve` in folders it makes, and checks each plan is narrow first. |
| 5. Where `gitCommand` gets its flag words | "Where the flag words come from": flags are built from `plain` and `values`. Refs and paths are the parser's own words, as `GitWord`, and the disk check reads the same word. |
| 6. Option C needs two changes | Three exported lists in a new `lib/host/gitEnvironment.ts`, imported by `gitCore.ts` and by `nodeSubprocess.ts` (step 4b). |
| 7. The extra `checkout` refusal must count every kind of word | `plainWordCount` counts every argument that is not a flag. `-B` is let through with `-b`. |
| Small notes | The dev doc step names three wrong-guess cases. The line estimate is 570. |

Two bugs on `main` have tickets of their own: ADI-291, the `gitDiff` tool
prints any file through the same no-index behavior, and ADI-292, the
`gitCheckout` tool fails on git 2.39.5.

## What is deliberately left for later

- A `path` field on `std::git::show`, for `git show <ref> -- <path>`.
- A flag with a quoted value (`--format='%h %s'`, `--author="Dana X"`).
  `splitFlags` would read a word made of a literal `--name=` and one
  quoted literal as a valued flag. No tarsec change is needed. It changes
  a helper every verb uses, so it is its own piece of work.
- Effects for `git revert`, `git rev-parse`, and `git rm --cached`.
- Splitting `stdlib/safeBash.agency` by verb family, with the flag and
  count helpers in a file the families share.
- Converting the four read-only agents. They are not the cost problem: the
  coder is.
