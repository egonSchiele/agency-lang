# Review: glob and recursive ls skip what .gitignore ignores

Plan reviewed: `docs/superpowers/plans/2026-11-10-glob-gitignore.md`

Paths below are relative to `packages/agency-lang`.

## Summary

The plan is close to ready. I checked its claims against
`lib/stdlib/shell.ts`, `lib/stdlib/gitignore.ts`, `lib/host/node/nodeFiles.ts`,
`stdlib/shell.agency`, `stdlib/safeBash.agency`, the toolkit, and the tests it
names. The line numbers match, the helpers it reuses exist (`root`, `at`,
`repo`, `host`, `isCwdBound`), `stat` returns a `kind` field as the plan says,
and the fixture trees give the results the tests expect. I traced each
`shell.test.ts` case in Task 1 and Task 2 through `ancestorIgnoreFiles` by
hand, and they come out as written.

The design sits at the right level. The named-folder rule goes into the one
function every walk calls, the recursive `ls` moves onto the shared walk and
loses its own, and the plan deletes three functions that lose their caller.

Five findings should change the plan before the build:

1. The existing tests for the `ls` code that Task 3 rewrites are not in the
   test run.
2. One new `_ls` test passes without the code it is there to guard.
3. `globFixedPrefix` keeps a second list of which characters are wildcards.
4. Three of the four `false` arguments in Task 2 Step 4 have no test.
5. After Task 5, a grep of a dependency folder quietly searches much less
   than it does today.

Smaller points follow.

## Findings

### 1. The existing `ls` tests are missing from the test run

Task 3 replaces the recursive branch of `_ls`. Four existing tests cover
that function, and none is in the "How to test" list:

- `tests/agency/stdlib/ls-recursive.test.json`
- `tests/agency/stdlib/ls-basic.test.json`
- `tests/agency/stdlib/ls-missing.test.json`
- `tests/agency-js/ls-recursive-cap/`

The last one is the regression test for the bug that once sent a 48 MB
listing to a model. It checks that a recursive `ls` skips `node_modules` and
`.git`, stops at `maxResults`, returns nothing for `maxResults: 0`, and fails
on a missing folder. Those are the behaviors most at risk when the walk is
swapped.

Add the three `.test.json` files to the loop, and add this line:

```bash
pnpm run agency test js tests/agency-js/ls-recursive-cap > $LOGS/ls-cap.log 2>&1
```

`agency test js` does not take `--check-capabilities`.

### 2. The "cannot read the folder" test passes without `failOnUnreadableStart`

Task 3 Step 1 has this test, marked "passes before and after":

```ts
await expect(_ls(root, "a.agency", true)).rejects.toThrow();
```

It is the only test for the new `failOnUnreadableStart` option. With
`respectGitignore` on, which is the default, `walkDir` calls
`ancestorIgnoreFiles` before it lists anything. That function calls
`host.files.stat(approved, "a.agency/.git")`. `stat` in
`lib/host/node/nodeFiles.ts:613` turns only `ENOENT` into `null`, and a path
below a file fails with `ENOTDIR`, so it throws. The plan relies on this same
fact in Task 2 Step 3.

So the call rejects before the walk starts, whether or not the option exists.
If someone forgot to pass `failOnUnreadableStart`, this test would still
pass.

Add the same call with the option off, which skips the `.gitignore` setup and
reaches the listing:

```ts
await expect(_ls(root, "a.agency", true, 1000, [], false)).rejects.toThrow();
```

Without `failOnUnreadableStart`, `walkDir` catches the list error and that
call resolves to `[]`. Mark it as depending on Task 3 Step 2.

### 3. `globFixedPrefix` has its own list of wildcard characters

The glob syntax is defined once, by the parser at `lib/stdlib/shell.ts:668-691`:
`**`, `*`, `?`, and `{a,b}`. `globFixedPrefix` splits the pattern by hand and
checks each segment for `*`, `?`, `{`, or `}`. That is a second definition of
the same thing.

They agree today. If the parser later gains a new form, for example
`[abc]`, the prefix function will treat a segment holding it as a plain
folder name. The walk then starts at a folder that does not exist and the
glob returns `[]`, with no error.

Let the parser decide. A segment is a plain name when the parser turns it
into nothing more than its own escaped text:

```ts
/** True when a pattern segment names one folder and matches nothing else. */
function isPlainSegment(segment: string): boolean {
  return globParser(segment).result === escapeRegex(segment);
}
```

`globFixedPrefix` then keeps the leading segments that are plain and are not
`""`, `.`, or `..`. There is one list of wildcard characters, and a new form
in the parser is covered without anyone remembering this function.

Also export `globFixedPrefix` through whatever the file uses for test-only
exports, and test the seven rows of the spec's table directly. Today the
table is only checked through `_glob` results, and three of its rows
(`{src,lib}/*.ts`, `./src/*.ts`, `src/app.ts`) have no test at all.

### 4. Three of the four `false` arguments are untested

Task 2 Step 4 passes `false` at four `_glob` calls so that the scans keep
listing ignored files. Step 5 says the new fixture file "is the test for
Step 4". It covers one call, `stdlib/skills.agency:505`. The other three have
nothing that would fail if the argument were left off:

- `stdlib/skills.agency:265`, the skills-directory scan
- `stdlib/skills.agency:909`, the commands scan
- `stdlib/workflow.agency:795`, the workflows scan

Leaving `false` off does not break the build, because the parameter has a
default. The result would be a skill, command, or workflow that vanishes for
a user whose `.gitignore` happens to name it, and no test would notice.

`tests/agency/skills-dir`, `tests/agency/commands-dir`, and
`tests/agency/workflow/save` already exist and are already in the test run.
Give each fixture the same treatment as Step 5: a `.gitignore` that names one
entry the test already expects.

One caution about the Step 5 approach itself. The new
`tests/agency/skills-claude-fixture/.gitignore` is a real ignore file. After
it lands, a new file added under `word/` is skipped by `git add` with no
message. Say so in a comment line at the top of each such `.gitignore`, so
the next person to edit the fixture knows to use `git add -f`.

### 5. A grep of a dependency folder searches less after Task 5

This one is a consequence of a decision the spec already made, so I am not
asking to reopen it. The plan should say it plainly and give the owner a way
to see it.

Today `grep -rn x node_modules/some-package` through safeBash goes to the
real grep program, because git ignores the whole folder. Real grep reads
every file. After Task 5 the same command runs the tool's search, which
starts at `node_modules/some-package` and skips any `dist`, `build`, and
nested `node_modules` below it. Most published packages keep all of their
code in `dist/`. So the common case of searching a dependency's code goes
from complete results with a `std::bash` prompt to almost no results with a
`std::grep` prompt.

The note after the output does name the skipped folders, and the model can
then grep `node_modules/some-package/dist` directly, which is searched. That
may be enough. Two additions would make it visible:

- A fourth hand smoke test in the PR body: ask the agent to find where a
  function is defined inside a dependency whose code is in `dist/`, and see
  whether it gets there.
- One sentence in the replacement paragraph for `safe-bash.md` (Task 5
  Step 6) saying that a package's `dist` folder is among what the tool skips,
  with the way around it.

## Smaller points

- **The commit trailer names a model.** Global Constraints says to end each
  commit with `Co-Authored-By: Claude Opus 5.5`. Whoever runs the plan should
  use the attribution line their own session gives them.
- **The hand smoke tests need the branch's build.** They say "in the main
  checkout, run `agency agent`". That runs whatever `agency` is on the path.
  To test this branch against the main checkout's folders, the body should
  give the command that runs the worktree's build with the main checkout as
  the working directory.
- **A stale comment.** `lib/stdlib/shell.ts:573` says an unreadable file
  "is skipped, as in `_ls`". After Task 3 `_ls` has no walk of its own. The
  `_ls` doc comment's sentence about `isRoot` goes for the same reason.
- **`src/**` and the folder itself.** With a pattern like `src/**`, the walk
  now starts inside `src` and never visits `src` as an entry. Today the walk
  visits it. The regex for `src/**` should not match the bare path `src`, so
  the results should be the same, but nothing tests it. One line in the
  prefix test would settle it:
  `expect(await _glob(root, ".", "keep/**", 100, [], false)).not.toContain("keep")`.
- **Task 0 commits before anything is built.** That is fine, but it means
  this review should be committed too. Add this file to the `git add` list.
- **`_searchTarget` is not mentioned for the prefix.** The public `glob`
  checks `dir` before its interrupt and fails with a message for a missing
  path. A missing prefix returns `[]` with no message. The spec chose this
  ("gives `[]`, as today"), and I agree, but the `glob` docstring could save
  the model a round by saying that a pattern naming a folder that does not
  exist matches nothing.

## What I checked and found correct

So the builder does not re-verify these:

- `_ls` has one caller, the public `ls`. `_ignoredFromAbove` has one caller,
  `stdlib/safeBash.agency:1181`. `readAncestorGitignores` is called only by
  `ignoredFromAbove`.
- No other toolkit binds `ls`, `glob`, or `grep`. The only `.partial` calls
  on them are in `stdlib/agents/lib/toolkits.agency:134-136`.
- `PROBE_NAME` is `agency-ignore-probe`, which does not start with a dot, so
  a `.*` rule above a folder does not make `ignoresWholeFolder` true for it.
  The "keeps the rules above a folder they ignore only part of" test relies
  on that.
- The existing glob and grep fixtures (`tests/agency/stdlib/glob-fixtures`,
  `grep-fixtures`) hold no file that git ignores, so the new default does not
  change the existing glob tests.
- The Agency in Task 6 uses forms that existing tests use: `catch [] with
  approve`, `sortBy(...) as x { ... }`, `__dirname`, and named arguments
  after positional ones.
- A session that runs inside a worktree is unaffected by the outer
  checkout's rules. `repositoryAncestors` stops at the worktree's own `.git`
  file.
