# `glob` and recursive `ls` skip what `.gitignore` ignores, and a folder you name is searched even when git ignores it

## The problem

In trace `g-4ALvj-hqw9Sl69-etaa` the agent was asked to find some benchmark
results. It ran two tools over the same repository and they disagreed.

First it ran `glob` with the pattern `**/*{benchmark,results,terminal-bench,eval}*`
in the launch directory. The result was 4,600 tokens of paths. Almost all of
them were inside `.venv-laya` (a Python virtual environment) and `.worktrees`
(old git worktrees). Line 4 of the repository's `.gitignore` is `.*`, so git
ignores both folders.

The model picked two files out of that list, both under `.worktrees`, and read
them. Neither had anything to do with the question. Each read cost the user an
approval prompt.

Then it ran `grep` for `pi|agency agent` with `path: .worktrees`. Files under
`.worktrees` do contain those words. The result was an empty list, with no
message.

So one tool sent the model into a folder, and the other tool told it the folder
held nothing.

## Why this happens

`grep` and `glob` share one directory walk, `walkDir` in
`lib/stdlib/shell.ts`. The walk takes an option, `respectGitignore`. When it is
on, the walk skips every entry that a `.gitignore` file ignores. It reads the
`.gitignore` files inside the folder being searched, and also the ones above
it, up to the repository root.

- `_grep` passes the option, and it is on by default
  (`lib/stdlib/shell.ts:541`).
- `_glob` does not pass the option (`lib/stdlib/shell.ts:615`). It skips only
  the six names in `SKIP_DIRS`: `node_modules`, `.git`, `dist`, `build`,
  `.next`, `.cache`.

That explains the glob result.

Recursive `ls` has the same gap. `_ls` does not use `walkDir`. It has its
own walk (`lib/stdlib/shell.ts:327`), and a recursive listing skips only the
`SKIP_DIRS` names. In the main checkout, the package folder holds
`.venv-laya`, `.worktrees`, and 47 `worktree-*` folders, and git ignores all
of them. `.venv-laya` alone holds more than 2,000 files. A recursive `ls`
stops at 1,000 entries, so a listing of the package folder can fill up with
those folders before it reaches `lib/`.

The empty grep has a second cause. The search was rooted at `.worktrees`. The
`.*` rule in the `.gitignore` above it matches `.worktrees`, so it also covers
every path below `.worktrees`. The walk applied that rule to each entry and
skipped all of them.

safeBash already knows about this second case. Before it runs a bash `grep`
through the tool's search, it calls `ignoredFromAbove`
(`lib/stdlib/gitignore.ts:102`). When the folder is wholly ignored, safeBash
sends the command to real grep instead, because "the search finds nothing,
which the model would read as no match" (`docs/dev/stdlib/safe-bash.md`,
"grep"). The `grep` tool itself has no such check.

One more fact: `docs/dev/stdlib/safe-bash.md` says "`_glob` also honors
`.gitignore`" (in "What a recursive listing shows"). That sentence is wrong
today. This change makes it true.

## What changes

There are four changes.

1. `glob` and recursive `ls` skip ignored files.
2. A folder you name is searched even when git ignores it. This fixes the
   empty grep from the same trace. Without it, the first change would give
   `glob` and recursive `ls` the same empty result.
3. A folder named at the start of a glob pattern counts as a named folder.
4. safeBash drops a check that change 2 makes unnecessary.

### 1. `glob` and recursive `ls` skip ignored files by default

`glob` gets a `respectGitignore` parameter, the same as `grep` has:

```ts
export idempotent def glob(
  pattern: string,
  dir: string = ".",
  maxResults: number = 500,
  allowedPaths: string[] = [],
  useAgentCwd: boolean = false,
  respectGitignore: boolean = true,
): Result raises <std::glob>
```

With the default, the glob from the trace returns the files in `docs/`, `lib/`,
and `stdlib/`, and nothing from `.venv-laya` or `.worktrees`.

`ls` gets the same parameter:

```ts
export idempotent def ls(
  dir: string = ".",
  recursive: boolean = false,
  maxResults: number = 1000,
  allowedPaths: string[] = [],
  useAgentCwd: boolean = false,
  respectGitignore: boolean = true,
): Result raises <std::ls>
```

The parameter applies only to a recursive listing. A plain `ls` still shows
every entry of the folder, ignored ones included. That is how the model learns
that a folder like `.worktrees` exists, so that it can name it. A plain `ls`
shows `node_modules` today for the same reason. `grep`'s parameter has the
same shape: it applies to a folder search, and a single file is always
searched.

The agent toolkit locks the parameter on for both tools, the way it already
does for `grep` (`stdlib/agents/lib/toolkits.agency:136`):

```ts
ls.partial(useAgentCwd: true, respectGitignore: true),
glob.partial(useAgentCwd: true, respectGitignore: true),
grep.partial(useAgentCwd: true, respectGitignore: true),
```

The interrupt payloads do not change. `std::glob` stays
`{ pattern, dir, maxResults }`, and `std::ls` stays
`{ dir, recursive, maxResults }`. `std::grep` does not carry
`respectGitignore` either, so the three stay alike, and no saved policy rule
is affected.

### 2. A folder you name is searched, even when git ignores it

Today `grep` has this rule for one file: "A file named outright is searched
whatever `.gitignore` says, the way grep searches a file named on its command
line." This change gives a folder the same rule.

The rule: when the `.gitignore` files above the search folder ignore that
folder, or everything in it, the walk does not apply those files. `.gitignore`
files in the search folder and below it still apply.

Examples, in a repository whose root `.gitignore` holds `.*` and `out/`:

| Call | Today | After |
|---|---|---|
| `glob("**/*.md")` at the root | includes `.worktrees/...` and `out/...` | skips both |
| `glob("**/*.md", dir: ".worktrees")` | lists the files | lists the files |
| `ls(".", recursive: true)` at the root | includes `.worktrees/...` and `out/...` | skips both |
| `ls(".worktrees", recursive: true)` | lists the files | lists the files |
| `ls(".")` at the root | shows `.worktrees` and `out` | shows `.worktrees` and `out` (no change) |
| `grep("needle", path: ".worktrees")` | `[]` | searches `.worktrees` |
| `grep("needle", path: "out")` | `[]` | searches `out` |
| `grep("needle", path: "src")`, with `*.js` ignored | skips `.js` files | skips `.js` files (no change) |

The last row is the partial case. A rule such as `*.js` ignores some entries
of `src` and leaves the rest, so the files above `src` still apply.
`ignoredFromAbove` in `lib/stdlib/gitignore.ts` already draws this line. Its
test moves into a function the walk calls, so there is one test and not two
(see change 4).

The reason for the rule is that the model named the folder on purpose. With
the toolkit locking `respectGitignore` on, naming the folder is the only way
the model has to look inside an ignored one. An empty list in reply reads as
"nothing matches", and the model moves on with a wrong belief.

The walk still skips the `SKIP_DIRS` names below the folder it was given. A
search of `node_modules` reads that folder and skips any `node_modules` nested
inside it.

### 3. A folder named at the start of a glob pattern is a named folder

The `glob` docstring's own example names a folder in the pattern:

```ts
glob("src/**/*.ts")
```

`glob` starts its walk at `dir` and keeps the paths that match the pattern.
The pattern does not decide where the walk goes. So with change 1 alone, this
call returns `[]` in this repository, whose root `.gitignore` holds `.*`:

```ts
glob(".claude/**/*.md")
```

The walk starts at the root, finds `.claude` ignored, and never enters it.
Change 2 does not help, because `.claude` is not `dir`. Today the call returns
files.

So `glob` starts its walk at the pattern's fixed prefix. The fixed prefix is
the leading folder names, up to the first segment that the glob parser reads
as a pattern, or that holds `{`, since a brace group can hold a `/`. The last
segment is never part of it, because it names what to match. For
`.claude/**/*.md` the walk starts at `.claude`, and change 2 applies there.
The regex is still tested against the path relative to `dir`, so the results
keep their shape.

| Pattern | Fixed prefix |
|---|---|
| `.claude/**/*.md` | `.claude` |
| `src/lib/*.ts` | `src/lib` |
| `src/app.ts` | `src` |
| `**/*.md` | none |
| `{src,lib}/*.ts` | none |
| `../other/*.md` | none |
| `./src/*.ts` | none |
| `{src/lib,test}/*.ts` | none |

The prefix also stops at a `.`, `..`, or empty segment. Patterns like those
match nothing today, because the paths the walk produces never hold such a
segment, and they still match nothing.

The walk starts at the prefix only when the prefix names a folder under
`dir`. When it does not exist, names a file, passes through a file or a
symlink, or starts with `~`, the walk starts at `dir`, as today, and the
result is today's: nothing matches.

Starting the walk at the prefix has two other results:

- A `SKIP_DIRS` name in the prefix is searched. `glob("node_modules/react/*.json")`
  returns `[]` today and returns files after. `SKIP_DIRS` applies below the
  start of the walk, the same as for `dir`.
- A `src/**` pattern no longer walks the rest of the tree.

### 4. safeBash runs a grep of an ignored folder through the tool

Before safeBash runs a lone bash `grep` through the grep tool's search,
`tryShellFreeGrep` asks `ignoredFromAbove` whether git ignores the whole
folder. When it does, safeBash sends the command to real grep, which asks
`std::bash`, because the tool's search would find nothing. Change 2 makes the
tool's search find the folder's files, so the check goes. `grep -rn x
node_modules` then raises `std::grep`, like a grep of any other folder.

The two searches still differ. The tool skips nested `SKIP_DIRS` folders and
ignored files inside the folder, and real grep reads everything. That is
already true of every folder the check lets through, and the note safeBash
adds after the output says what the tool skipped.

`ignoredFromAbove` and `_ignoredFromAbove` lose their only caller and go. The
test they hold becomes `ignoresWholeDirectory`, which takes the list of files
the walk already has. It changes in one way. Today the test is true when the
rules ignore a made-up file or a made-up folder inside the folder. It now
needs both. An allow-list `.gitignore` (`*`, `!*/`, `!*.ts`) ignores the
made-up file and keeps the made-up folder. With "or", a search of `src` would
drop those rules and return the files they ignore. `readAncestorGitignores` loses its only caller too and
goes. Its tests move to `repositoryAncestors`, the function they exercise.

## Where the code changes

- `lib/stdlib/shell.ts`
  - `_glob` takes `respectGitignore` and passes it to `walkDir`. Its walk
    starts at the pattern's fixed prefix (change 3).
  - `_globIncludingIgnored` is new. The scans of folders the program owns
    call it (see below).
  - `_ls` takes `respectGitignore`. Its recursive listing uses `walkDir` in
    place of its own walk, so it gets the `.gitignore` rules and the second
    change from the same place as `grep` and `glob`. The plain listing keeps
    its one-folder read.
  - `_ls` still fails when it cannot read the folder it was given. `walkDir`
    skips a folder it cannot read. That is right for a folder below the start
    of the walk. For the start itself, an empty list would read as an empty
    folder.
  - `ancestorIgnoreFiles` leaves out the files above the search folder when
    they ignore the folder or everything in it. This is the one place all
    three tools get the second change from.
- `lib/stdlib/gitignore.ts`: `ignoredFromAbove`'s test becomes
  `ignoresWholeDirectory(absoluteDir, files)`. `ignoredFromAbove`,
  `_ignoredFromAbove`, and `readAncestorGitignores` go (change 4).
- `stdlib/safeBash.agency`: the check in `shellFreeGrepPlan` and its import
  go. The `grepOfIgnoredFolder` case in `tests/agency/safeBash.agency` now
  expects `std::grep`.
- `lib/stdlib/grepDialect.ts`: the note after a shell-free grep tells the
  model to name an ignored folder as the path. Today it says to pass
  `respectGitignore: false`, which the agent toolkit does not allow.
- `stdlib/shell.agency`: the new parameter on `glob` and `ls`, their
  docstrings, and the comments above `ls` and `grep`. The docstrings are tool
  descriptions. Each should tell the model, in one sentence, that ignored
  files are skipped and that naming an ignored folder searches it. For `ls`,
  the sentence says this applies to a recursive listing.
- `stdlib/agents/lib/toolkits.agency`: lock the parameter for `glob` and
  `ls`, and update the doc comment above `readOnlyFileTools`.
- `docs/dev/stdlib/grep-flags.md`: the `.gitignore` section covers all three
  tools and states the named-folder rule and the fixed prefix.
- `docs/dev/stdlib/safe-bash.md`: the "grep" section loses the check. The
  paragraph in "What a recursive listing shows" says that the `ls` and `glob`
  tools both honor `.gitignore`. A recursive listing through bash also shows
  the ignored names. It shows names and no contents, so it stays narrow.
- The `grep-flags.md` entry in `CLAUDE.md` and in the `agency-stdlib-docs`
  skill mentions the `.gitignore` rules.
- `docs/site/stdlib/` is generated. Run `make`; do not edit it by hand.

### Callers of `_glob` that must keep today's behaviour

Four calls use `_glob` directly to scan a folder the program owns:

- `stdlib/skills.agency:265`, `:505`, and `:909` scan skill folders.
- `stdlib/workflow.agency:795` scans `<dir>/workflows`.

These scans list every file in a folder the program owns, so no `.gitignore`
rule should hide a file from them. For example, a repository whose
`.gitignore` holds `.claude/skills/drafts/` would hide the `drafts` skill from
a scan that respected it. A `.*` rule above `.claude/skills` is not the risk:
change 2 searches a wholly ignored folder anyway.

`_glob`'s new parameter defaults to `true`, the same as `_grep`'s. These
calls switch to `_globIncludingIgnored`, a new function in
`lib/stdlib/shell.ts` that calls `_glob` with `respectGitignore: false`. Its
doc comment holds the reason above, once, and its name tells a reader at
each call that the scan lists ignored files on purpose. Before finishing,
search the whole workspace for other `_glob` callers (`packages/*` had none
when this was written).

`_ls` has one caller, the public `ls`, so no internal caller needs the old
behaviour.

safeBash's `find` and `ls -R` are not affected. They raise `std::glob` and
`std::ls`, and then run the real programs, which skip nothing.

## What does not change

- A plain `ls`, which lists one folder. It shows every entry, ignored ones
  included.
- The `SKIP_DIRS` list. It still applies below the start of a walk, and a
  glob's fixed prefix now moves that start (change 3).
- No interrupt changes. The `.gitignore` reads happen inside `_glob` and
  `_ls`, after the `std::glob` or `std::ls` approval, as they already do in
  `_grep`.
- The matcher in `lib/stdlib/gitignore.ts`. It still does not read
  `.git/info/exclude` or the global excludes file.
- A single file given to `grep`.
- Any effect payload or policy rule.

## Left for later

**Telling the model what was skipped.** After this change, a root-level
`glob` like `**/*.pyc` whose every match is ignored returns `[]`. The
docstring says why. A stronger option is a note in the result when the walk
skipped ignored entries that matched. That changes the result's shape from a
list of paths, so this spec does not include it.

**Braces at the start of a pattern.** `glob("{out,src}/*.md")` has no fixed
prefix, so its walk starts at `dir` and still skips an ignored `out`. Covering
it means expanding the braces into one walk per alternative. Models rarely
name an ignored folder inside braces, so this spec does not include it.

## How to test

Make all the changes, then run one `make` and one run of the named test
files, saving the output to a file. The plan lists the tests and the
commands. The tests cover:

- Each tool with the option on, with it off, and rooted at an ignored folder.
  Each folder case runs the way the public tool calls the walk
  (`_grep(<folder>, ".")`), and also with the folder below the root
  (`_grep(root, "out")`). The fixtures hold a `.git` entry. Without one, no
  `.gitignore` above the folder applies, and a test would pass for the wrong
  reason.
- A folder that is only partly ignored, which keeps the rules above it.
- A plain `ls`, which lists ignored entries.
- Glob patterns from the table in change 3.
- Each of the four scans of a folder the program owns. Each scan's fixture
  gets a `.gitignore` naming an entry its test already expects, so the test
  fails if the scan stops listing ignored files.
- The agent toolkit binding `respectGitignore` on `ls`, `glob`, and `grep`.
- safeBash planning `grep -rn x node_modules` as `std::grep`.
- One Agency test through the public `glob`, `ls`, and `grep`. Its fixture's
  ignored files are committed with `git add -f`. A plain `git add` skips an
  ignored file without a message, and the test would then pass locally and
  fail in CI.

Do not run the full Agency test suite locally. CI runs it on the PR.
