# Second review: git through safeBash, and no git tools in the coding agent

Date: 2026-11-06

Plan reviewed: `docs/superpowers/plans/2026-11-06-safebash-git-commands.md`,
as revised after the first review
(`docs/superpowers/plans/2026-11-06-safebash-git-commands-review.md`).

## Short answer

The revision adopts the right design. safeBash now writes the git command
it runs, and that closes the `git checkout` hole completely. I tested
the rewritten commands against git 2.39.5.

One hole is still open. The rewritten `git diff` still prints a file
outside the repository when the working directory is not inside a
repository, and a `cd` puts the command there. Finding 1 has the test and
a fix I also tested.

After that there are five smaller gaps. Each is a place where the plan
says what happens and does not yet say how, and the obvious way to build
it is wrong or cannot be built.

## What I checked this time

- I ran each rewritten form with the fixed flags in a scratch repository:
  `log`, `diff`, `show`, `blame`, `status`, `add`, `restore --staged`, and
  `checkout <ref> --`. Each behaves as the plan says.
- `git checkout feature --` still creates a local branch from
  `origin/feature`, so the common "check out a remote branch" command
  keeps working.
- The plan's new claim holds: `git diff -- /dev/null <outside file>`
  prints the file, so the one-path limit on `diff` is needed.
- tarsec 0.5.7 parses the fixed flags, and its printer quotes a word built
  from text. A literal word holding `x; touch PWNED` prints as
  `'x; touch PWNED'`, and `it's` prints as `'it'\''s'`. So the plan's
  sentence "a word that needs quotes is quoted by that printer" is true.
- The Agency verifier does carry `safeBash`
  (`stdlib/agents/agency/verifier.agency`, line 35), as the plan says.

## Must fix

### 1. Outside a repository, the rewritten `git diff` still prints the file

```
cd /tmp && git diff /dev/null /Users/me/.ssh/id_rsa
```

The plan rewrites the second command to

```
git -c core.pager=cat -c core.fsmonitor=false --no-optional-locks diff /dev/null -- /Users/me/.ssh/id_rsa
```

Inside a repository, git answers "bad revision". In a directory with no
repository above it, git prints the whole file. I ran it. Git compares
files whenever it finds no repository, and in that mode it drops the `--`
and reads both words as paths.

`cdTarget` accepts `cd /tmp`, so the model chooses the directory.
`recommended` approves `std::git::diff` for any `cwd`. So this is the
first review's finding 1 again, with a `cd` in front.

Only `diff` has this mode. I ran the other twelve subcommands in the same
directory, and each one fails with "not a git repository".

**The fix I tested.** Ask git itself, at the moment the command runs:

```
(git <fixed flags> rev-parse --is-inside-work-tree >/dev/null && git <fixed flags> diff /dev/null -- /Users/me/.ssh/id_rsa)
```

Outside a repository the first command fails with "not a git repository"
and the diff never runs. Inside one, the diff runs as before. The
parentheses let the pair stand as one stage of a pipe, as in
`git diff main | head`. `classifySimple` already returns a `Command`, so
it can return a `parens` node holding an `and`. I estimate 15 lines.

**The weaker fix, which I would not use.** safeBash could look for a
`.git` folder in the directory or a parent while it plans. An empty
folder named `.git` fools that check. I made one in a directory with no
repository above it. Git still printed the file, and the `rev-parse`
guard still refused. Git also treats a repository owned by another user
as no repository, which is common with a folder mounted into Docker. I
did not test that case, but the guard asks git, so it gives git's answer
there too.

**What to change in the plan:**

- "Two ways git reads a word differently" says "`--` settles both". Add
  the third fact: outside a repository `--` settles nothing for `diff`.
- "safeBash writes the git command it runs" gets the guard, for `diff`
  only.
- The real-git test gets a case in a directory with no repository above
  it. A folder under the test checkout will not do, because the checkout
  is a repository. It has to be a folder in the system's temp directory.

## Should fix

### 2. Step 4a can skip the checks that `effectsFor` makes before it looks at the verb

Step 4a says `classifySimple` "calls `gitEffects` directly for a `git`
command" and calls `effectsFor` for everything else.

`effectsFor` does four things before its `match` on the verb, and a git
command needs every one:

```
  if (name.tag != "literal") { ... }               // `/bin/git` is not `git`
  if (command.assignments.length > 0) { ... }      // GIT_DIR=/x git status
  const redirect = redirectEffect(command.redirects, cwd)
  ...
  return success([...git.value, ...redirect.value])
```

A direct call to `gitEffects` skips all of them unless they are copied.
The redirect check matters most. The comment above `redirectEffect` says
that without it, a redirect "would be classified as a Git read, and any
rule that approves Git reads would approve the write". With the checks
skipped, `git log > ~/.zshrc` would ask only `std::git::log`.

The spike's `gitEffects` also builds its inner command with
`redirects: []`. The rewritten command has to keep the model's
redirects, or `git diff > out.patch` writes no file.

I suggest one internal function that does the shared checks and returns
the effects with the command to run. `effectsFor` stays exported with its
signature, and becomes a call to that function that drops the command.
Then there is one path, and no check can be skipped.

Add two cases to `gitRunsWhatItAsked`:

- `git diff > out.patch` asks `std::write` and `std::git::diff`, and the
  text that runs ends in `> out.patch`.
- `git log > /etc/hosts` asks a `std::write` for `/etc/hosts`.

### 3. A failed command shows the model the rewritten text

`exitFailure` builds the failure the model reads, and its `command` field
is the text that ran. After this change a failed checkout reads:

```
{"command":"git -c core.pager=cat -c core.fsmonitor=false --no-optional-locks checkout '*.py' --",
 "exitCode":128, "stderr":"fatal: invalid reference: *.py", ...}
```

Git commands fail often: a commit with nothing staged, a checkout of a
branch that does not exist. A model that reads this spelling may write it
next time. `git -c ...` has no rule, because the first word after `git`
is a flag, so the copy asks `std::bash`. The rewrite would then cost
prompts.

Two fixes would work. The failure can report the model's own text, which
`runBash` already has as `source`. Or `gitEffects` can accept exactly the
fixed flags it writes. I prefer the first, because the model never sees a
spelling it did not write. Either way, pin it with a test.

There is a related loss. Plain git answers `git log removed.py` with "Use
'--' to separate paths from revisions". The rewritten command answers
"bad revision 'removed.py'", which does not say what to do. The dev doc
lists the fix, but the model does not read the dev doc. The git section
of the coder's prompt, in pull request 3 step 3, should say: put `--`
before a path that does not exist on disk.

### 4. The real-git test cannot be written where the plan puts it

The plan puts the test in `lib/stdlib/safeBash.test.ts` and has it run
"the exact text `planFor` produced". That file imports two TypeScript
functions:

```
import { _bashParser, _astToBash } from "./safeBash.js";
```

`planFor` is Agency code in `stdlib/safeBash.agency`, so a vitest file
has no direct way to call it.

Put the test in `tests/agency/safeBash.agency`. That file already makes
folders with `std::fs` and runs real commands, as `chainMatchesBash`
does. The test makes a repository in a temp folder and calls
`safeBash(command, dir) with approve` for each case. This is also a
stronger test: it goes through the rewrite, the environment cleaning,
and bash, where `execFileSync` on the planned text would skip the last
two.

### 5. Say where `gitCommand` gets its flag words

Step 8 of `gitEffects` builds the command from "the flag words as the
model wrote them". `splitFlags` does not keep them. It returns:

```
export type SplitArgs = {
  plain: string[];        // letters and long names
  values: FlagValue[];    // { flag, value } as text
  positionals: Word[]
}
```

So the flag words have to come from somewhere, and the plan should say
where. I suggest building them from `plain` and `values`, since those are
the checked data. I checked that the printer handles both shapes: a flag
word with the value `Dana X` prints as `'--author=Dana X'`, and a literal
value after `-m` is quoted.

Pin the spellings that differ between what was written and what is
built: `-n5`, `-n 5`, `-5`, `--max-count=5`, and `-am "x"`.

For the refs and paths, use the `Word` values in `positionals` and do not
rebuild them from text. A word built from the text `~/x` prints with no
quotes, so bash expands it even when the model wrote `'~/x'` in quotes.
The disk check and the rewritten command should read the same `Word`.

### 6. Open decision 3 needs two small changes to be buildable

I agree with option C. Two details:

- `SCRUB_ENV_KEYS` in `lib/stdlib/gitCore.ts` is not exported, and it is
  one list with comments marking groups (a) and (b). Option C takes all
  of (b) and part of (a), so the list has to become three named lists:
  the variables that retarget git, the ones that run code, and the SSH
  ones.
- `lib/host/node/nodeSubprocess.ts` imports only Node's own modules and
  `../host.js`. Everything else in that direction is the stdlib importing
  the host. An import from `lib/stdlib/gitCore.ts` would be the first one
  the other way. Put the three lists in the host layer and have
  `gitCore.ts` import them, or check that the structural linter allows
  the import as planned.

The test the plan calls "the existing `shellEnvironment` test" is in
`lib/host/node/nodeSubprocess.test.ts`.

### 7. The extra `checkout` refusal has to count every kind of word

Step 6 of pull request 2 refuses "`checkout` with two or more plain words
and no `-b`". The existing helper, `hasLiteralArg`, looks only at words
tagged `literal`. tarsec tags a word with a slash as `path`:

```
git checkout main src/utils.py     literal(main) path(src/utils.py)
```

A count of `literal` words finds one here and does not refuse. The check
should count every word that is not a flag, whatever its tag, quoted
words included. It should also let `-B` through as it does `-b`.

## Small notes

- Step 8 of pull request 2 still says the dev doc holds the ref and path
  rule "with its two wrong-guess cases". The revised design has three.
- With the guard from finding 1, the plan's estimate of about 540 lines
  becomes about 555.

## The open decisions

1. **`git log --all`.** Option A, as before.
2. **`git checkout <file>`.** Option B with the extra refusal, built as in
   finding 7.
3. **Environment variables.** Option C, built as in finding 6.
4. **Any agent with `safeBash` can write to git.** Option A is
   reasonable, and the rename of the test is right. This one is the
   owner's decision.
5. **Three pull requests.** Yes, with the condition the plan states.
