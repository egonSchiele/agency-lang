# `ls`, `tree`, `du` ask `std::ls`; `find` asks `std::glob` (ADI-246)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A directory listing in a safeBash line asks the question the `ls` tool asks, and a `find` asks the question the `glob` tool asks, so `recommended` approves both under the launch directory with no prompt, and `ls /etc` or `find ~ -name '*.pem'` still reaches a person.

**Architecture:** The same shape as the read family: a table of verbs (`LIST_VERBS`) with a `FlagSpec` per row, one effect per path, every path resolved with `_searchTargetIn` and required to be a directory. `find` gets its own rule because its "flags" are a path list followed by an expression of whole words (`-name`, `-type`), so `readFlagWord` learns to match a short flag whole before splitting it into letters. Everything runs through bash; nothing here is shell-free.

**Tech Stack:** Agency (`stdlib/safeBash.agency`, `stdlib/safeBash/actions.agency`), the Agency test runner, `make`.

**Spec:** `docs/superpowers/specs/2026-10-30-safebash-reads-pipes-scripts-design.md`, Part 5, the `ls`, `tree`/`du`, and `find` rows of the table and the "What the table refuses" list. Ticket ADI-246.

## A decision the owner made (2026-11-01): a recursive listing through bash is narrow

The `ls` tool's recursive walk and the `glob` tool's walk skip `SKIP_DIRS` (`node_modules`, `.git`, `dist`, `build`, `.next`, `.cache`), and `_glob` also honors `.gitignore` (`lib/stdlib/shell.ts`, the `SKIP_DIRS` set and `walkDir`). Real `ls -R`, `du`, `tree`, and `find` skip nothing. So a policy that approves `std::ls` under the launch directory approves what the tool does, and the bash spelling with the same payload lists more: the names under `.git` and `node_modules`. For grep (ADI-242) the owner chose accuracy: a directory search through bash asks `std::bash`, because real grep reads file contents the tool skips.

The owner chose the other way for listings: `ls -R`, `du`, `tree`, and `find` through bash raise `std::ls` or `std::glob` and are narrow. A listing prints names and sizes, not contents, and the names under `.git` and `node_modules` are not the secret that decided grep. The dev doc (Task 4) states the rule and the difference, so a policy author knows that a recursive listing through bash shows entries the tool's walk leaves out.

## Background for the implementer

Read `docs/dev/stdlib/safe-bash.md` whole, with care for "The read family" (this plan copies its shape) and "Stages that read a pipe". Then in `stdlib/safeBash.agency`: `effectsFor`, `otherVerbEffects`, `READ_VERBS`, `ReadVerb`, `readFileVerb`, `resolveReadPath`, `splitFlags`, `readFlagWord`, `readLongFlag`, `nextWordValue`, `raiseOne`, `READ_TOOL_FOR_VERB`; in `stdlib/safeBash/actions.agency`: `Effect`, `ReadPayload`, `readEffect`; in `stdlib/shell.agency`: the `ls` and `glob` tools and the `std::ls` and `std::glob` effect declarations (`@alwaysUnder(dir)` is what lets `recommended` approve them under the launch directory); in `lib/stdlib/shell.ts`: `_searchTarget` and `_searchTargetIn`.

The `ls` tool raises `std::ls("Are you sure you want to list this directory?", { dir, recursive, maxResults })` with `dir` the realpath of a directory; `_searchTarget(given, "ls")` fails on a file ("is a file, not a directory. Call read to see its contents."). The `glob` tool raises `std::glob("Are you sure you want to glob files?", { pattern, dir, maxResults })`. safeBash's payloads copy those fields, plus the full command line, the way the `std::read` arm of `raiseOne` does.

How the parser hands these over, checked with tarsec: `ls -la src` is the flag `-la` then the literal `src`; `find . -name '*.ts'` is the literal `.`, the flag `-name`, and a single-quoted `*.ts`; `find src -type f -name *.ts` has a glob word `*.ts` as `-name`'s value; `find . -delete` is a flag `-delete`; `find . -exec rm {} \;` does not parse at all ("Unexpected input after commands"). `readFlagWord` today reads a short flag letter by letter, so `-name` would be `n`, `a`, `m`, `e`; `readLongFlag` matches a `--` flag whole against `spec.plain` and `spec.valued`.

`_searchTargetIn(text, cwd, tildeMode)` resolves a path against safeBash's cwd and returns `{ dir, file, argument }`: `file` is `null` for a directory and the file's name for a regular file; a missing path or a special file throws, which `try` turns into a failure. The read family refuses `file == null`; listings refuse the opposite.

What is refused and why:

- `ls -L`, `find -L`, `du -L`: follow symlinks, so the listing reads outside what `dir` names.
- `find -exec -execdir -ok -delete -fprint -fls`: run or write. The flag list is an allowlist, so an unlisted `find` flag is unrecognized, which is what protects against the ones this list forgot. `-delete` reaches `std::bash`, where a person sees it; it is not on the refuse wall, as the spec says.
- `find -newer FILE`: reads another file's time. Left out of the allowlist; the spec lists it, and this plan departs there, recorded in Task 4.
- `ls` of a file: the payload needs a directory. `ls one.txt` is unrecognized.
- A glob word as a path or as `-name`'s value: bash expands it before the program runs. ADI-247 handles globs; here they are unrecognized.
- A `find` with no path: BSD `find -name x` is a usage error, GNU reads `.`. Refused, so one rule holds on both.
- A `find` positional after the first flag: `find . -name x foo` is a usage error in find's grammar (paths come first).

## Global Constraints

- Never force-push or amend. Commit messages and PR bodies go in a file and are passed with `-F`.
- Run `make` after any `.agency` edit and commit `docs/site/stdlib/safeBash.md` and `docs/site/stdlib/safeBash/actions.md`. Never hand-edit `docs/site`.
- `pnpm run typecheck` and `pnpm run lint:structure` after every edit.
- Save test output to a file and read it. Run `pnpm run agency test tests/agency/safeBash.agency` and the vitest files named here, not the suite.
- Dev docs state the mechanism and the rule, with no history or dates.
- Agency: no lambdas; an `isFailure` guard does not narrow a `Result` over a union (match through a helper def); `!=` on a tag does not narrow (use `is`); no if-else as a match arm value; records built field by field.
- `.claude/skills/agency-stdlib-docs/SKILL.md` is tracked but gitignored: `git add -f` it in its own command.
- Objects, arrays, and types; never maps, sets, or interfaces.
- Every message a refusal produces is a value in a table or a template over one; no prose branches per verb.

## Review Focus

1. `ls -R .` run through bash where `.` holds a symlink to a folder outside the launch directory. Expected: GNU and BSD `ls -R` do not descend into a symlinked directory unless `-L` is given, so the listing stays under `dir`. `-L` is not in the table. Test in Task 2 (a symlink fixture built in its own folder, as `readPayloadNamesTheRealParent` does).
2. `find . -name '*.ts' -o -name '*.js'`. Expected: `splitFlags` refuses a valued flag given twice, so the line asks `std::bash`. Pinned in Task 3 so the limit is visible, not silent.
3. `ls src` where `src` is a symlink to a folder. Expected: the payload names the real folder, so a policy judges where the entries really are. Test in Task 2.
4. `git log | ls`. Expected: `ls` ignores its stdin; the plan asks `std::git::log` and `std::ls` for `.`. Test in Task 2.
5. `find . -maxdepth x`. Expected: refused, `-maxdepth` must be a number. Test in Task 3.

---

### Task 1: Short flags that match whole

**Files:**
- Modify: `stdlib/safeBash.agency` (`FlagSpec`, `readFlagWord`, `readLongFlag`)
- Modify: `tests/agency/safeBash.agency`, `tests/agency/safeBash.test.json`

**Interfaces:**
- Produces: `FlagSpec` gains `wholeWords?: boolean`. When true, a single-dash flag is one word: `readFlagWord` looks `word.flagName` up whole in `spec.plain` and `spec.valued` (a valued one takes the next word through `nextWordValue(verb, word.flagName, next)`), an unknown one fails with its whole name (`"find does not take `-iname`"`), and the letter loop never runs. When absent or false, nothing changes. The check sits after the `--` branch, the digit branch, and the existing `flagValue != null` refusal: the parser hands `-name=x` over as flag `-name` with `flagValue: "x"` (checked), GNU find rejects that spelling, and the refusal must come first or the lookup would take the next word as the value and drop the `=x`. No verb mixes letters and whole words (`ls`, `tree`, `du` list letters; `find` lists words), so the two kinds never share a table. `flagDisplay` already prints a name that starts with `-` as is.
- Produces: `readLongFlag`'s refusal of an unknown `--` flag prints `written` (the whole flag as typed, `--color=always`) instead of `word.flagName` (`--color`), so a refused `--color=always` is not mistaken for a refusal of `--color=never`. This changes the message for grep too; find the grep rows that pin a `--` refusal and update them.

- [ ] **Step 1: Write the failing test**

The test file reaches `splitFlags` through `import test`. Find the node that exercises it (grep for `splitFlags(` in the test file) and add a row set with a find-shaped spec written in the test:

```agency
static const WHOLE_FLAGS: FlagSpec = {
  plain: ["-print"],
  valued: ["-name"],
  optionsFirst: false,
  wholeWords: true
}

node wholeShortFlags() {
  return [
    splitSummary("x -name foo -print f", WHOLE_FLAGS),
    splitSummary("x -name", WHOLE_FLAGS),
    splitSummary("x -nam f", WHOLE_FLAGS),
    splitSummary("x -name=foo f", WHOLE_FLAGS),
    splitSummary("x -n f", WHOLE_FLAGS),
  ]
}
```

where `splitSummary(source, spec)` parses the source, runs `splitFlags` on its first simple command, and returns `[plain, values as "flag=value" strings, positional texts]` or the failure text. Expected: `[[ "-print" ], ["-name=foo"], ["f"]]`; `"x's `-name` needs a value"`; `"x does not take `-nam`"` (a near miss is refused whole, not read as letters); `"x does not take `-name=foo`"` (the joined-value refusal, with whatever text `renderFlag` gives; pin it); `"x does not take `-n`"`.

Add one row to the node that pins grep's `--` refusals (grep for `does not take \`--` in the `.test.json`): `grep --color=always x one.txt` expecting `"grep does not take `--color=always`"`, and update any existing row whose message changes.

- [ ] **Step 2: Run to verify it fails**

The agency test into `$SCRATCH/t1.txt`. Expected: the first row fails with a letter message, since `-name` is split into letters today; the `--color` row fails on the shorter message.

- [ ] **Step 3: Implement, `make`, run, verify pass, commit**

Message: `safeBash: a short flag listed whole in a flag table matches whole`.

---

### Task 2: `ls`, `tree`, and `du` ask `std::ls`

**Files:**
- Modify: `stdlib/safeBash/actions.agency` (`Effect`, `LsPayload`, `lsEffect`)
- Modify: `stdlib/safeBash.agency` (`LIST_VERBS`, `ListVerb`, `listEffects`, `checkCountFlags` pulled out of `readFileVerb`, `resolveReadPath` becoming `resolvePath` with a `want`, `resolvePaths`, `otherVerbEffects`, `raiseOne`, `safeBash`'s `raises` clause, `READ_TOOL_FOR_VERB`)
- Modify: `tests/agency/safeBash.agency`, `tests/agency/safeBash.test.json`

**Interfaces:**

In `actions.agency`:

```agency
/** The fields the ls tool's own std::ls interrupt is keyed on. */
export type LsPayload = {
  dir: string;
  recursive: boolean;
  maxResults: number
}

export def lsEffect(payload: LsPayload): Effect
```

`Effect` gains `{ name: "std::ls"; payload: LsPayload }`.

In `safeBash.agency`:

```agency
/** A verb that lists directories: its flags, and whether it always walks
 * the tree or only with -R. */
export type ListVerb = {
  flags: FlagSpec;
  /** The valued flags whose value must be digits, such as `-L` on tree. */
  countFlags: string[];
  recursive: "always" | "withR"
}

export static const LIST_VERBS: Record<string, ListVerb> = {
  ls: {
    flags: { plain: ["l", "a", "A", "h", "1", "t", "r", "S", "R", "d", "p", "F", "--color=never"], valued: [], optionsFirst: true },
    countFlags: [],
    recursive: "withR"
  },
  tree: {
    flags: { plain: ["a", "d", "--noreport"], valued: ["L", "I"], optionsFirst: true },
    countFlags: ["L"],
    recursive: "always"
  },
  du: {
    flags: { plain: ["s", "h", "a", "c"], valued: ["d"], optionsFirst: true },
    countFlags: ["d"],
    recursive: "always"
  }
}
```

`optionsFirst` is true for all three: BSD `ls src -la` reads `-la` as a file name. `-G` is out: on macOS it turns on color, on GNU it hides the group column. `tree` is not on macOS by default; a line with it is recognized and the shell reports it missing, as `tac` is in the read family (say so in the table comment). `tree -L N` and `du -d N` must be digits, which is what the row's `countFlags` says, the same field `ReadVerb` has. `-I pat` on `tree` takes a literal pattern; a glob word there is refused by `nextWordValue` already.

Two pieces of the read family are needed again here and in Task 3, so they become shared helpers. Do that in this task and keep `readVerbsReadFiles` and `inputRedirectIsARead` green as the proof that the read family still behaves.

```agency
/** The valued flags whose value must be digits, checked once for every
 * verb table: head's -n, tree's -L, find's -maxdepth. */
def checkCountFlags(split: SplitArgs, countFlags: string[]): Result
```

This is the loop in `readFileVerb`. Its message uses `flagDisplay(entry.flag)`, not `` `-${entry.flag}` ``: a letter prints as `-n`, and a whole flag such as `-maxdepth` prints as itself instead of `--maxdepth`. `splitFlags`' repeated-flag message already does this.

```agency
/** What a path must name. */
type PathKind = "file" | "dir"

/** Why a path of the other kind is refused, by what was wanted. */
static const WRONG_KIND: Record<PathKind, string> = {
  file: "would read a directory",
  dir: "of a file is not a listing"
}

@capabilities(fileRead)
def resolvePath(text: string, word: Word, cwd: string, subject: string, want: PathKind): Result<GrepTarget>

@capabilities(fileRead)
def resolvePaths(verb: string, words: Word[], cwd: string, want: PathKind): Result<GrepTarget[]>
```

`resolvePath` is today's `resolveReadPath` with one more parameter: it resolves through `_searchTargetIn`, and refuses with `"${subject} ${WRONG_KIND[want]}"` when the target's `file` is null and a file was wanted, or not null and a folder was wanted. It returns the target; `readFileVerb` and `inputRedirectRead` build their `ReadPath` or `ReadPayload` from it as they do now, passing `"file"`. `resolvePaths` is `readFileVerb`'s loop over positionals (`literalWordText`, the failure `"the ${verb} path is not literal"`, then `resolvePath` with the verb as subject), moved out so the listings and `find` call it with `"dir"`. One resolver for the read verbs, `<`, the listings, and `find`. The target type is what `_searchTargetIn` returns (`{ dir, file, argument }`); if `safeBash.agency` declares an Agency type for it under a grep-specific name, rename it `PathTarget`, since the read verbs, `<`, the listings, and `find` now hold it too. The TypeScript side in `lib/stdlib/shell.ts` keeps its name.

```agency
@capabilities(fileRead)
def listEffects(verb: string, command: SimpleCommand, cwd: string, spec: ListVerb, redirects: Effect[]): Result<Effect[]>
```

`splitFlags`, `checkCountFlags`, then `resolvePaths(verb, positionals, cwd, "dir")`, with a literal `.` word in place of the positionals when there are none (build the `Word` as `{ tag: "literal", text: "." }`; check the `Word` type for the exact shape). One `lsEffect({ dir, recursive, maxResults: 0 })` per target, `recursive` true when the row says `always` or the split's `plain` includes `R`; then the redirects. `readsStdin` is not consulted: a listing ignores its stdin, so `git log | ls` is a listing of `.`.

Dispatch: `otherVerbEffects` is already "the verb with no arm of its own in `effectsFor`". It looks the verb up in `LIST_VERBS` first and returns `listEffects` when a row exists, then in `READ_VERBS` as today, then fails with `"no rule for `${verb}`"`. Two lookups, each an `if (row != null) { return ... }`, one failure at the end.

`raiseOne` gains a `"std::ls"` arm raising `std::ls("Are you sure you want to list this directory?", { dir, recursive, maxResults, command: fullCommand })`. `safeBash`'s `raises` clause gains `std::ls`. `READ_TOOL_FOR_VERB` gains `ls: "ls"` and `tree: "ls"`, not `du`: the ls tool reports each entry's size and no folder total, which is what `du -sh` asks for, the same reason the table leaves out `wc`.

Rows that use `ls` today as "a command with no rule", all planned in `/repo`, which does not exist: `classifyOneCommand`'s `effectNamesFor("ls")`, `wholeStringPlans`' `git status; ls`, `ls`, and `git status && ls`, `rebuiltVersusOriginal`'s `ls    -la`, and `agencyCommandLines`' `ls agency-lang`. After this task they still pass, but for a different reason (the `.` path does not resolve in `/repo`), so the tests stop testing what their names say. Swap `ls` for `xargs` in each, a verb the wrapper rule keeps on `std::bash` (the file already uses `xargs rm x` that way), keep the expected values, and list the swaps in the ledger.

- [ ] **Step 1: Write the failing tests**

```agency
node listingsAskStdLs() {
  return [
    grepNames("ls"),
    grepNames("ls -la ."),
    grepNames("ls -R ."),
    grepNames("ls . .."),
    grepNames("tree -L 2 ."),
    grepNames("du -sh ."),
    grepNames("git log | ls"),
    grepNames("ls one.txt"),
    grepNames("ls nope"),
    grepNames("ls -L ."),
    grepNames("ls . -la"),
    grepNames("ls --color=always ."),   // "ls does not take `--color=always`", from Task 1's readLongFlag change
    grepNames("tree -L x ."),
    grepNames("ls $D"),
    grepNames("ls *.txt"),
  ]
}
```

`grepNames` returns `[effect names, broadReason]`. Expected: `[["std::ls"],null]` for the first six (two for `ls . ..`), `[["std::git::log","std::ls"],null]`, then unrecognized with details `"ls of a file is not a listing"`, the resolver's "No file or directory at" text (use `startsWith` as `readVerbsReadFiles` does for that row), `"ls does not take `-L`"`, `"an option after the first argument is a file name to some versions of ls"`, `"ls does not take `--color=always`"`, `"the value of `-L` is not a number"`, `"the ls path is not literal"`, `"the ls path is not literal"`.

A payload node:

```agency
def lsPayloads(source: string): any {
  // A for loop with an `if` on the name, the shape readPayloadNamesTheRealParent
  // uses: a comprehension filter may not narrow `payload` to LsPayload.
  let out: any[] = []
  for (effect in planFor(source, FIXTURES).effects) {
    if (effect.name == "std::ls") {
      out.push([effect.payload.dir == FIXTURES, effect.payload.recursive])
    }
  }
  return out
}

node lsPayloadFields() {
  return [lsPayloads("ls"), lsPayloads("ls -R ."), lsPayloads("tree ."), lsPayloads("du -s .")]
}
```

Expected `[[[true,false]],[[true,true]],[[true,true]],[[true,true]]]`. `FIXTURES` is already an absolute path; if `_searchTargetIn` realpaths it differently (a `/private` prefix on macOS), compare against `resolve`d or realpathed text the way the symlink test does, and pin that.

A symlink node in its own folder, copying `readPayloadNamesTheRealParent`: `inside/link` points at `../outside`; `planFor("ls link", LINK_FOLDER + "/inside")` names `.../outside` as `dir`. Expected `[true]`.

End to end:

```agency
node listingUnderRecommendedNeedsNoPrompt()
```

Same shape as `readUnderRecommendedNeedsNoPrompt`: `safeBash("ls " + FIXTURES)` under a handler that approves only what `recommendedAutoApprovePolicy` approves, returning whether the output names `one.txt`. Expected `true`.

```agency
node listingOutsideTheLaunchDirIsUndecided()
```

`planFor("ls /etc", FIXTURES)`, the first `std::ls` effect through `checkPolicy`. Expected `"propagate"`.

```agency
node listingAsksOneQuestion()
```

`safeBash("ls -1", cwd: FIXTURES)` with one approve handler for "Are you sure you want to list this directory?". Expected: `"one.txt\ntwo.txt\n"`.

`rejectedListingNamesTheTool`: `safeBash("ls -L .", cwd: FIXTURES)` with a reject handler for the shell question. Expected text follows `rejectedReadNamesTheTool`'s with "Call the ls tool instead".

- [ ] **Step 2: Run to verify they fail**

The agency test into `$SCRATCH/t2.txt`. Expected: every listing row says `std::bash` with "no rule for `ls`".

- [ ] **Step 3: Implement, `make`, run, verify pass**

Then `pnpm vitest run lib/stdlibCapabilities.test.ts` (a new def reaching `_searchTargetIn` needs `@capabilities(fileRead)`).

- [ ] **Step 4: Commit**

Message: `safeBash: ls, tree, and du ask std::ls per directory`.

---

### Task 3: `find` asks `std::glob`

**Files:**
- Modify: `stdlib/safeBash/actions.agency` (`GlobPayload`, `globEffect`, `Effect`)
- Modify: `stdlib/safeBash.agency` (`FIND_FLAGS`, `findEffects`, `leadingPositionals`, `effectsFor`, `raiseOne`, `raises`, `READ_TOOL_FOR_VERB`)
- Modify: tests

**Interfaces:**

```agency
export type GlobPayload = {
  pattern: string;
  dir: string;
  maxResults: number
}
export def globEffect(payload: GlobPayload): Effect
```

`Effect` gains `{ name: "std::glob"; payload: GlobPayload }`.

```agency
/** find's expression, as whole words. An allowlist: an unlisted word is
 * unrecognized, which is what keeps -exec, -delete, -fprint, -L, and the
 * ones this list forgot on the std::bash path. -newer is out because it
 * reads another file's time. -iname is out because the glob tool's
 * pattern is case-sensitive and the payload would say so. -H and -P are
 * out because find takes them only before its paths, where the ordering
 * rule below refuses them. */
static const FIND_FLAGS: FlagSpec = {
  plain: ["-not", "-o", "-a", "-prune", "-print", "-print0"],
  valued: ["-name", "-path", "-type", "-maxdepth", "-mindepth", "-size"],
  optionsFirst: false,
  wholeWords: true
}

/** The expression words that widen or invert what -name selects. With
 * any of them the pattern is `**`, because `-not -name x` lists the
 * opposite of x and `-name x -o -type d` lists more than x. */
static const FIND_WIDENING_WORDS: string[] = ["-not", "-o", "-prune"]

static const FIND_COUNT_FLAGS: string[] = ["-maxdepth", "-mindepth"]
```

```agency
@capabilities(fileRead)
def findEffects(command: SimpleCommand, cwd: string, redirects: Effect[]): Result<Effect[]>
```

`splitFlags("find", command, FIND_FLAGS)`; `checkCountFlags(split, FIND_COUNT_FLAGS)`; a `-maxdepth` of `0` is `"find -maxdepth 0 lists only the path itself"` (refused, the smaller rule, since no pattern describes it); `positionals.length == 0` is `"find needs a path before its tests"`; `leadingPositionals(command) != positionals.length` is `"find takes its paths before its tests"`, where `leadingPositionals` counts the args before the first flag word. `resolvePaths("find", positionals, cwd, "dir")`. One `globEffect({ pattern, dir, maxResults: 0 })` per folder, then the redirects. (`maxResults: 0` is the spec's value: the payload describes a search with no cap. It is never handed to `_glob`, which would return nothing for 0.)

The pattern must describe the search find runs, or a wider one, never a narrower one. `find -name '*.txt'` matches the last part of the path at any depth; the glob tool's pattern is matched against the whole relative path, anchored at both ends, with `*` stopping at `/` (`globToRegExp` in `lib/stdlib/shell.ts`), so `*.txt` would describe a top-level search. And `-not -name '*.txt'` lists the opposite of `*.txt`, `-name '*.txt' -o -type d` lists more than it, and `-path ./node_modules -prune -o -name '*.txt'` lists `./node_modules` as well, so with any of `FIND_WIDENING_WORDS` in the split's `plain` the name is not a description of the search. `findPattern(split: SplitArgs): string` gives:

| `-name` | widening word | `-maxdepth` | pattern |
|---|---|---|---|
| given | none | absent, or more than 1 | `**/` + the value |
| given | none | `1` | the value |
| absent, or any | present | absent, or more than 1 | `**` |
| absent, or any | present | `1` | `*` |

`**` says the search may list anything under `dir`, which is true for every expression the allowlist accepts, and it keeps the common `-not -path '*/node_modules/*'` idiom narrow. Write it as two booleans (`named`: `-name` given and no widening word; `depthOne`) and one small table keyed by them, not as a chain of ifs.

`effectsFor` gains a `"find"` arm. `raiseOne` gains `"std::glob"` raising `std::glob("Are you sure you want to glob files?", { pattern, dir, maxResults, command: fullCommand })`. `raises` gains `std::glob`. `READ_TOOL_FOR_VERB` gains `find: "glob"`.

- [ ] **Step 1: Write the failing tests**

Each row with its expected value beside it, so the numbering cannot drift. `G` stands for `[["std::glob"],null]` and `U(detail)` for `[["std::bash"],{"kind":"unrecognized","detail":detail}]`:

```agency
node findAsksStdGlob() {
  return [
    grepNames("find . -name '*.txt'"),                         // G
    grepNames("find . -iname '*.TXT' -type f"),                // U("find does not take `-iname`")
    grepNames("find . -type f -not -path '*/node_modules/*'"), // G
    grepNames("find . -H -name x"),                            // U("find does not take `-H`")
    grepNames("find . . -name x"),                             // [["std::glob","std::glob"],null]
    grepNames("find . -maxdepth 2 -print0"),                   // G
    grepNames("find . -name *.txt"),                           // U("the value of `-name` is not literal")
    grepNames("find . -delete"),                               // U("find does not take `-delete`")
    grepNames("find . -exec rm {} \\;"),                       // unparseable; pin the parser's text
    grepNames("find . -L -name x"),                            // U("find does not take `-L`")
    grepNames("find -name x"),                                 // U("find needs a path before its tests")
    grepNames("find . -name x foo"),                           // U("find takes its paths before its tests")
    grepNames("find . -name a -o -name b"),                    // U("find takes `-name` only once")
    grepNames("find . -maxdepth x"),                           // U("the value of `-maxdepth` is not a number")
    grepNames("find . -maxdepth 0"),                           // U("find -maxdepth 0 lists only the path itself")
    grepNames("find . -newer one.txt"),                        // U("find does not take `-newer`")
    grepNames("find one.txt -name x"),                         // U("find of a file is not a listing")
    grepNames("find . -name '*.txt' | head"),                  // G (head with no path in a pipe adds nothing)
  ]
}
```

Payload node, one row per line of the pattern table and one per widening word: `find . -name '*.txt'` gives `"**/*.txt"`; `find . -maxdepth 1 -name '*.txt'` gives `"*.txt"`; `find . -type f` gives `"**"`; `find . -maxdepth 1` gives `"*"`; `find . -maxdepth 3 -name x` gives `"**/x"`; `find . -not -name '*.txt'` gives `"**"`; `find . -name '*.txt' -o -type d` gives `"**"`; `find . -path ./node_modules -prune -o -name '*.txt'` gives `"**"`; `find . -maxdepth 1 -not -name x` gives `"*"`; `dir` is the fixtures folder in each. Use the for-and-if shape of `lsPayloads`.

End to end: `findUnderRecommendedNeedsNoPrompt` (`find <FIXTURES> -name '*.txt'`, output names `one.txt`), `findOutsideTheLaunchDirIsUndecided` (`find /etc -name hosts`, `"propagate"`), `findAsksOneQuestion` (one approve for "Are you sure you want to glob files?"; expected output from a first run, after checking it is `./one.txt\n./two.txt\n` in some order; sort with `| sort` is not in process, so pin BSD and GNU order if they differ by reading `find`'s output on both: if they do differ, assert on the set of lines instead).

The spec's acceptance line: `find . -delete` is broad and `find . -exec rm {} \;` is broad (unparseable); both are in the rows above.

- [ ] **Step 2: Run to verify they fail**

Expected: "no rule for `find`" on every row.

- [ ] **Step 3: Implement, `make`, run, verify pass, capabilities test, commit**

Message: `safeBash: find asks std::glob per path`.

---

### Task 4: Docs, index lines, checks, PR

**Files:**
- Modify: `docs/dev/stdlib/safe-bash.md`, the spec's Part 5, `CLAUDE.md`, `.claude/skills/agency-stdlib-docs/SKILL.md`

- [ ] **Step 1: Dev doc**

New section "Listings" after "The read family", with: the `LIST_VERBS` table (verbs, flags, recursive rule) and `FIND_FLAGS`; the path rule (a directory, realpathed, `.` when none; a file, a missing path, or a glob is unrecognized), with one sentence that `ls -l link` lists the link itself and does not descend, while the payload names the target folder, so the question names more than runs and fails safe; what is refused and why (the list from Background, as rules, not history); the owner's decision from the top of this plan, as the rule it became (a recursive listing through bash shows entries under `.git` and `node_modules` that the tool's walk leaves out, and no file's contents); the whole-word short flag rule in `readFlagWord` and why `find` needs it; `find`'s two ordering rules; the pattern table, why `**/` is in it, and why a widening word (`-not`, `-o`, `-prune`) makes the pattern `**` (so `find . -name a -o -path b` is narrow with pattern `**`, while `find . -name a -o -name b` is refused because `-name` may appear once); that `-maxdepth 0` is refused; that a listing ignores its stdin. Add `std::ls` and `std::glob` to "What the payload fields mean": `maxResults: 0` describes an uncapped search on the bash path, while the tools' own `maxResults` caps results and `_glob` returns nothing for 0, so a policy author must not read 0 as "nothing". Update "Outcomes" (`bash`, narrow: add "a listing of named directories, a find"), the "In process when it translates" table (`ls src` runs real ls through bash, raises `std::ls`), "What the model reads on a rejection" if it lists `READ_TOOL_FOR_VERB`, and "Files and tests".

Spec Part 5: a "Departures for listings (ADI-246)" note beside the read-family one: `-newer`, `-iname`, `-H`, `-P`, and `ls -G` are out; the `std::glob` pattern is `**/` plus the `-name` value, not the bare value; `find` with no path is refused; a file given to `ls` or `find` is unrecognized; `-name` may appear once; a glob word anywhere is unrecognized until ADI-247.

- [ ] **Step 2: Index lines**

`CLAUDE.md` and the skill file: the `safe-bash.md` line gains "the listings (`LIST_VERBS`, `std::ls` per directory, `find` and `std::glob`, whole-word short flags)". Skill file with `git add -f`, alone.

- [ ] **Step 3: Checks**

`pnpm run typecheck`, `pnpm run lint:structure`, `pnpm vitest run lib/stdlibCapabilities.test.ts`, the safeBash agency test, `make` with no drift in `docs/site`. Each saved to a file, each green.

- [ ] **Step 4: Commit and PR**

Commit docs and index lines. Push. PR body in a file: before/after table (`ls src`, `ls -R .`, `tree -L 2`, `find . -name '*.ts'`, `find . -delete`, `ls /etc`), where to look (`LIST_VERBS`, `findEffects` and `findPattern`, the whole-word branch of `readFlagWord`, `resolvePath`'s `want`), departures from the spec, what is left out (`-newer`, `-iname`; `find . -name a -o -name b`, the common way to ask for two extensions, is refused because `-name` may appear once; globs until ADI-247; `column`, `stat`, `file` not in any table). Link ADI-246. End with the attribution line. The owner merges.
