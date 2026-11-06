# Review: git through safeBash, and no git tools in the coding agent

Date: 2026-11-06

Plan reviewed: `docs/superpowers/plans/2026-11-06-safebash-git-commands.md`

## Short answers

You asked three questions.

**Is this the right way to implement it?** The direction is right. Flag
tables that are allowlists, the existing `std::git::*` effects, no new
policy, and three pull requests in that order are all sound. One part of
the design should change. The plan classifies a git command and then runs
the text the model wrote. Git reads that text with its own rules, and in
two places those rules disagree with safeBash's reading. safeBash should
write the git command it runs, the way the git tools build their argument
lists. Findings 1 to 4 explain why and how.

**How much complexity does it add?** About 500 to 550 lines in the
standard library, about 300 lines of tests, and about 120 lines of docs.
The plan says about 300 lines of code, which is low. The details are in
"Complexity" below.

**Does it introduce security holes or incorrect behavior?** Yes, two, and
I reproduced both by running the spike's `planFor` and real git:

1. `git diff /dev/null /Users/me/.ssh/id_rsa` is approved as a git read
   and prints the file. The `recommended` policy approves it with no
   prompt.
2. `git checkout '*.py'` is approved as a branch checkout and throws away
   the uncommitted changes to every Python file.

The plan also says the bash path and the git tools run git the same way.
They do not. The tools turn off `core.fsmonitor`, remove the `GIT_*`
environment variables, and set a timeout. Finding 4 lists the
differences.

All three have one fix, and it is small.

## How I checked

- I read the plan, `docs/dev/stdlib/safe-bash.md`, the spike's rules in
  `stdlib/safeBash.agency`, the git tools in `stdlib/git.agency`, their
  argument builders in `lib/stdlib/gitCore.ts`, and
  `lib/runtime/builtinPolicies.ts`.
- I ran real git (2.39.5, the version macOS ships) in a scratch
  repository for every claim below about what git does.
- I ran the spike's `planFor` on the same commands, in this worktree, to
  see what it would ask.
- I ran the tarsec 0.5.7 parser from `~/tarsec` on the `--` spellings.

The plan's line numbers for `main` are correct. I checked them against
`origin/main` at `16e0baf16`.

## Must fix before pull request 2

### 1. `git diff` can read any file on the machine with no prompt

```
git diff /dev/null /Users/me/.ssh/id_rsa
```

The spike plans this as one narrow effect:

```
std::git::diff { ref: "/dev/null", ref2: "", staged: false,
                 path: "/Users/me/.ssh/id_rsa" }
```

`recommended` approves `std::git::diff` outright, so nothing is asked.
Git then prints the whole file as a diff.

Here is why:

1. When `git diff` gets exactly two words and one of them is a path
   outside the repository, git stops comparing commits. It compares the
   two files, as `git diff --no-index` does. The plan leaves out the
   `--no-index` flag for this reason, but git turns the mode on by
   itself.
2. The disk rule reads `/dev/null` as a ref. `resolveTarget` fails for a
   device, so `onDisk` is false. One ref and one path fits the row "at
   most two refs and one path".

A second spelling needs no device. A file that an earlier command in the
same line creates is not on disk when the plan is made:

```
echo q > made; git diff made /Users/me/.ssh/id_rsa
```

The spike plans a `std::write` for `made` and a `std::git::diff` with
`ref: "made"`. Under the policy that accepts edits, both are approved.
`safe-bash.md` already warns about this gap in "Resolving the path when
the plan is made".

`recommended` prompts for a read outside the current directory. This
command gets around that.

The `gitDiff` tool has the same hole on `main` today.
`gitDiff(ref: "/dev/null", ref2: "/Users/me/.ssh/id_rsa")` runs
`git diff --patch -M --end-of-options /dev/null /Users/me/.ssh/id_rsa`,
and I confirmed that git prints the file. That deserves its own ticket,
whatever happens to this plan.

The plan's design carries the hole over unchanged, because its rule is
the spike's rule: "a word that names a file or folder on disk is a path.
Any other word is a ref."

### 2. `git checkout <word>` can discard work under a branch-checkout approval

The plan says a checkout gets its rule "only when the word is not on
disk", and calls this "the one place where the disk rule guards a write".
The guard has three gaps. Each of these is planned by the spike as
`std::git::checkout { target, force: false }`, and each ran in my scratch
repository:

| Command | What git did |
|---|---|
| `git checkout '*.py'` | "Updated 2 paths from the index". Both edited files lost their changes. |
| `git checkout ':/'` | Discarded every change in the repository. |
| `git checkout gone.py`, where `gone.py` is tracked and was deleted | Restored the file. |

When the word is not a ref, git reads it as a pathspec. A pathspec is a
pattern git matches itself, so a quoted `'*.py'` is literal text to bash
and to safeBash, and a glob to git. No file on disk is named `*.py`, so
the disk rule calls it a ref.

The policy that accepts edits approves `std::git::checkout` when `cwd` is
inside the project. So these run with no prompt.

The tool and the plan disagree about this case. The `gitCheckout` tool's
own docstring says its target is "the branch/commit/path", so the tool on
`main` already discards a file's changes under this effect. The plan
takes the stricter position, that a file discard must not be approved as
a checkout. I agree with the plan. But then the guard has to hold, and
the tool should follow in a later change.

### 3. The fix for both: safeBash writes the git command it runs

Git has a spelling that removes the guess. Words before `--` are refs,
and words after it are paths:

```
git diff /dev/null -- /Users/me/.ssh/id_rsa     fatal: bad revision '/dev/null'
git diff made /Users/me/.ssh/id_rsa --          fatal: bad revision 'made'
git checkout '*.py' --                          fatal: invalid reference: *.py
git checkout main --                            Already on 'main'
```

I ran all four. With the `--` in place, git reads each word the way
safeBash classified it, or it fails.

So the rule should be: for a subcommand whose words are refs and paths,
safeBash does not run the model's text. It runs

```
git <subcommand> <flags> <refs> -- <paths>
```

built from the parts it classified. The `--` is always written, including
when there are no paths.

This is the tools' own approach. `logArgs`, `diffArgs`, `blameArgs`,
`addArgs`, and `restoreArgs` in `lib/stdlib/gitCore.ts` each put `--`
before the paths.

The mechanism exists. `classify` already returns a rewritten command
beside the effects, and `cdTo` uses it to replace the word after `cd`
with the directory the classifier resolved. The doc gives the reason:
"Bash would otherwise decide for itself where the word leads, and it can
disagree with the classifier." Git is the same case. The change to the
plan is that `gitEffects` returns the rewritten `SimpleCommand` with the
effects, and `classifySimple` passes it on. Today `effectsFor` returns
effects only, so this needs a small amount of plumbing. I estimate 40
lines.

The fix changes three things in the plan's text:

1. The disk rule stops being a guess about what git will do. It only
   picks which question to ask, and git is then made to agree. The "Refs
   and paths" section should say so.
2. The two wrong-guess cases behave differently. For `git log docs`,
   where `docs` is both a branch and a folder, git no longer fails with
   "ambiguous argument". safeBash asks about the path `docs` and runs
   `git log -- docs`. The approval matches what ran, which is the first
   rule. The model may have meant the branch, so the dev doc should
   mention it.
3. The risk "The disk rule guards one write" goes away. `git checkout
   <ref> --` cannot touch a file.

Add tests for the commands in findings 1 and 2 to `gitStaysBroad` or a
new node. With the fix they are narrow and harmless, so the test should
pin the rebuilt text: `planFor("git checkout '*.py'")` runs
`git checkout '*.py' --`.

### 4. The bash path and the tool path do not run git the same way

The plan's section "What git itself can run" says:

> The git tools run the same `git` with the same configuration, under the
> same effects. A policy that approves `gitStatus` already approves
> whatever `core.fsmonitor` names.

That is not what the code does. `gitRunImpl` in `lib/stdlib/git.ts`
prepends `GIT_HARDENING_FLAGS` and passes the environment through
`scrubEnv`:

| | Git tool | Git through safeBash |
|---|---|---|
| `core.fsmonitor` | turned off with `-c core.fsmonitor=false` | runs the program the repository's config names |
| `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE` | removed | inherited, so git can act on a repository other than `cwd` |
| `GIT_EXTERNAL_DIFF`, `GIT_CONFIG*` | removed | inherited |
| Refs and paths | separated with `--end-of-options` and `--` | as the model wrote them |
| Time limit | 30 seconds | none (`_bash` is called with timeout 0) |
| Index refresh | `--no-optional-locks` | takes the index lock |
| `destructive` mark on a write | yes | no, by the decision in `safe-bash.md` |

I confirmed the first two rows. With `core.fsmonitor` set in a
repository's config, plain `git status` ran the named program, and the
same command with `-c core.fsmonitor=false` did not. With `GIT_DIR` set
in the environment, `git log` printed another repository's history.

This gap exists on `main` today for the four git spellings safeBash
already knows. The plan widens it from four spellings to about
twenty-five, and pull request 3 then removes the hardened tools from the
coder, so all of the coder's git would run on the weaker path.

I did not find a way to exploit the `core.fsmonitor` row without a write
to `.git/config`, and I did not check whether the policy that accepts
edits approves such a write. If it does, a write followed by `git status`
runs a program with no prompt. Someone should check that before pull
request 3.

The fix is the same rewrite as finding 3. The rebuilt command starts with
the tool's flags:

```
git -c core.pager=cat -c core.fsmonitor=false --no-optional-locks log --oneline -- src
```

Take the flags from `GIT_HARDENING_FLAGS`, so the two paths cannot drift
apart. The environment variables need a decision, because the command
text cannot remove them. The simplest place is `SHELL_ENV_REMOVED` in
`lib/host/node/nodeSubprocess.ts`, which already removes the variables
"that would make bash run something the text does not say". `GIT_DIR`
and `GIT_WORK_TREE` fit that description: with either set, the `cwd` in
every git payload is false. `GIT_SSH_COMMAND` should stay, because a
broad `git push` may need it.

The dev doc paragraph the plan proposes should then describe what is
left: hooks, `diff.external`, textconv filters, and `gpg.program` still
run on both paths.

## Should fix

### 5. The verifier can commit after pull request 2

The plan says of the four agents with read-only git tools: "This plan
does not change them." The verifier also carries `shellTools()`, which
includes `safeBash` (`stdlib/agents/verifier.agency`, line 39).

Today the verifier's `git commit -m "x"` asks `std::bash`, so a person
decides. After pull request 2 it asks `std::git::commit`, and the policy
that accepts edits approves it. The test
`historyReadersHaveGitButCannotCommit` still passes, because it checks
tool names.

This may be acceptable. It is the same change as the plan's risk "A saved
policy that approves a git write now approves it from bash", seen from
the agent's side. But it is a decision for the owner, and the plan should
state it. After this work, any agent that carries `safeBash` can write
to git when the policy approves the effect.

### 6. `git restore --staged -- a.py` is refused, and the table allows it

The plan's `paths` word kind says "every word is a path, on either side
of a `--`", so the `restore` row accepts `git restore --staged -- a.py`.

The refusal list runs first. Pull request 2, step 6 says "`restore` is
refused unless its only flag is `--staged`". tarsec 0.5.7 returns `--` as
a flag word, and the spike's `onlyUnstages` counts flags:

```
  const flags = flagNames(command)
  return flags.length == 1 && flags[0] == "--staged"
```

So the `--` form has two flags and is refused. The plan should say that
`--` does not count, and `gitRestoreStaged` should include the `--` form.

### 7. The table fits nine subcommands and not the other four

The plan says the rules become "a table and two functions", and that the
functions for `branch`, `stash`, `commit`, and `checkout` "hold only that
decision". For those four, the allowed word counts depend on the
decision, so one row cannot state them:

- `branch` has three shapes. A listing takes no names, or one ref after
  `--merged`. A create takes exactly one name and no flag. A delete takes
  one or more names and only `-d`. The spike's `gitBranchRule` checks all
  of this by hand, and it must, because `git branch -v newname` creates a
  branch.
- `stash` takes a word that is a second subcommand (`push`, `pop`,
  `list`). That is none of `refsAndPaths`, `paths`, or `names`.
- `checkout -b <name>` takes a new branch name. The plan's row reads it
  as `refsAndPaths`, so `git checkout -b src` is broad in any project
  with a `src` folder. The spike checked `-b` first and did not have this
  problem.

I suggest the plan say this plainly: the table covers the nine
single-shape subcommands, and the four others each keep a function that
checks its own counts. That is still an improvement on thirteen
functions. Claiming one check for all thirteen will send the implementer
looking for a row shape that does not exist.

### 8. Quoted flag values parse, and they are broad for a different reason

The plan says a quoted flag value is rejected by tarsec. In 0.5.7 it
parses:

```
git log --author="Dana X"        one word, tag "interpolatedVariable"
git log --since='2 weeks ago'    one word, tag "interpolatedVariable"
git log --format=%h              rejected
```

The word is not a flag word, so `splitFlags` reads it as a positional,
`literalWordText` fails, and the command is broad. The result is the one
the plan expects.

It matters for the allowlist, though. The plan adds `--author`, `--grep`,
`--since`, and `--until` as valued flags. A model nearly always quotes
those values. So most uses of those four flags stay broad, and so does
`-S"foo"`. If the eval data shows them, `splitFlags` could read a word
made of a literal `--name=` and one quoted literal as a valued flag, with
no tarsec change. If the data does not show them, leave it, and correct
the sentence in "What tarsec 0.5.7 changed".

### 9. Pull request 1 changes more than the refusal list

Step 3 checks `cat a~b`, `ls -- src`, and `rm -- file`. I traced `--`
through every reader of `command.args` that does not go through
`splitFlags`:

| Reader | What `--` does there | Result |
|---|---|---|
| `execEffects` | `execArgText` renders it as `--` | `pnpm test -- --watch` becomes a narrow `std::exec`. Today it does not parse and asks `std::bash`. |
| `echoText` | `ECHO_FLAGS` does not list it | not shell-free, runs through bash |
| `cdTarget` | two arguments | unrecognized |
| `agencyCommandPlan` | `echoWords` fails on a flag word | as any other flag |

None of these is wrong. The first is a real change in behavior: a saved
rule for `pnpm test` now covers `pnpm test -- <anything>`. That matches
what `safe-bash.md` already says a saved rule covers. The pull request
description should mention it, and each row should get a pinned test, so
the plan's sentence "This pull request changes no rule" stays true in the
sense it intends.

Add `--`, `HEAD~1`, and `HEAD^` to the `astToBash` round-trip cases in
`lib/stdlib/safeBash.test.ts`. I ran them through tarsec's own
`astToBash` and each comes back as written.

### 10. Test the claims about git against real git

The plan's tests go through `planFor`, and none approves a git write.
That keeps the repository safe, and it leaves out the claims the design
rests on: what git does with a given spelling. Both holes above come from
those claims. The classifier did what it was written to do.

I suggest one node that makes a temporary repository, runs the rebuilt
commands with real git, and removes it with `safeDeleteDirectoryWithin`:

- The rebuilt `git diff` with a path outside the repository fails.
- The rebuilt `git checkout '*.py' --` fails and changes no file.
- `git checkout main --` switches.

It runs in its own folder, so it cannot touch the checkout the tests run
in. It will also catch a git version that reads a spelling differently.
That is a real risk: `git checkout --end-of-options main`, which is what
the `gitCheckout` tool runs, fails on git 2.39.5 with "pathspec
'--end-of-options' did not match any file(s) known to git". So the
`gitCheckout` tool does not work with the git macOS ships. That is a
separate bug on `main`.

## Complexity

The spike changed `stdlib/safeBash.agency` by 462 added and 73 removed
lines, with no tests, no docs, and inline payloads. My estimate for pull
request 2 as planned, with the rewrite from finding 3:

| Part | Lines |
|---|---|
| Eleven payload types, fourteen union variants, fourteen constructors | 130 |
| Fourteen raise arms | 110 |
| `GIT_VERBS` with its comment | 100 |
| `gitEffects`, `gitPayloads`, the four shape functions, two helpers | 160 |
| The rewrite: build the command, return it from `classifySimple` | 40 |
| Tests | 300 |
| Dev doc | 120 |

That puts `stdlib/safeBash.agency` near 3,800 lines. The plan's reason
for not splitting the file is sound, and I would not split it in this
work.

Most of the new code is data and is easy to review. The cost that
continues is the allowlist: about sixty flags, each a claim about how git
reads it. The rewrite lowers that cost. Without it, every row is also a
claim about how git reads the positions of words. With it, the row is a
claim about flags only.

The four shape functions are where a mistake is most likely, and
`branch` is the hardest of them. Its tests should cover every pairing of
a listing flag with a name.

## The open decisions

1. **`git log --all`.** I agree with option A, no rule.
2. **`git checkout <file>`.** I agree with option B. I would also refuse
   `git checkout` with two or more plain words and no `-b`, such as `git
   checkout main utils.py`. That form always overwrites files, it is the
   same act as the refused `git restore --source main utils.py`, and the
   check reads words only. With the plan as written it is broad, which is
   safe, so this is for consistency.
3. **One pull request or three.** Three, in the plan's order. Finding 4
   adds a condition: pull request 3 should not merge until the rebuilt
   command carries the hardening flags.

## Smaller notes

- `git commit -a` as two effects is fine. `add { all: true }` describes
  more than `-a` does, which is the safe direction.
- `git add ':/'` and `git add '*.py'` are narrow with the paths as
  written, and git expands them. The `gitAdd` tool does the same, and the
  policy matches on `cwd`, so I would leave this.
- A git write through bash is never marked destructive, by the existing
  decision in `safe-bash.md`. The tools do mark it. The plan's "Risks"
  section should list this as a known difference.
- Step 10 of pull request 2 measures broad approvals with the tools still
  present. Tally `Plan.broadReason` details from the `safeBash plan`
  debug events as well. They will show whether finding 8 is worth doing.
