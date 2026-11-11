# Second review: glob and recursive ls skip what .gitignore ignores

Plan reviewed: `docs/superpowers/plans/2026-11-10-glob-gitignore.md`, as it
stands after the first review (`2026-11-10-glob-gitignore-review.md`).

Paths below are relative to `packages/agency-lang` in the worktree.

## Summary

The plan took in every finding from the first review: the `ls` tests are in
the run, the unreadable-folder test now has a case that fails without
`failOnUnreadableStart`, `isPlainSegment` asks the parser, all four internal
scans are pinned by a fixture `.gitignore`, and the dependency-folder
consequence is written into `safe-bash.md` and the smoke tests.

I traced every new test in Tasks 1, 2, and 3 through the code by hand
(`walkDir`, `ancestorIgnoreFiles`, `isIgnored`, `refuseLinksBelow`, the glob
parser), and each one comes out as the plan says, including the "today it
returns" comments. I also checked that each of the four fixture pins can
actually fail. They can, because in all four the new `.gitignore` sits in the
folder the scan starts in, so the walk applies it as the folder's own file and
the named-folder rule never drops it.

These two findings should change the plan before the build:

1. `globStart` can throw where today's `_glob` returns `[]`, for a pattern
   that starts with `~` or that passes through a file.
2. Now that the probe decides what gets searched, its `||` treats a common
   "ignore everything except" `.gitignore` as ignoring whole folders.

## Findings

### 1. `globStart` throws for a `~` prefix or a prefix through a file

The plan says `globStart` keeps today's result in every case where the prefix
is not a folder, because `stat` returns `null`. That holds for a missing
prefix and for a symlink, but `stat` (`lib/host/node/nodeFiles.ts:613`) turns
only `ENOENT` and the "is a symlink" refusal into `null`. Everything else is
thrown. Two cases reach it:

- **A prefix that passes through a file.** For `_glob(root, ".", "a.md/sub/*.md")`
  the prefix is `a.md/sub`. `refuseLinksBelow` calls `lstat` on `a.md/sub`, which
  fails with `ENOTDIR`, and `stat` throws it. Today this call returns `[]`.
  The plan's test covers `a.md/*`, where the prefix is the file itself and
  `stat` succeeds, but not this one.
- **A prefix that starts with `~`.** `isPlainSegment("~")` is true, because
  `escapeRegex` leaves `~` alone. So `glob("~/notes/**/*.md")` gets the prefix
  `~/notes`. The public tools pass `dir` as `"."`, so `joinRel` returns
  `~/notes` unchanged, and `resolveUnder` (`nodeFiles.ts:85`) expands it to the
  home folder and throws `refused: "~/notes" is outside dir ...`. A segment
  like `~foo` throws a different error, from `expandPath`, about `~user` not
  being supported. Today both return `[]`.

The `~` case is the one a model will hit. Models often pass a path with `~` as
the glob pattern instead of as `dir`. After this change, that call fails with
an error about `dir`, which the model never set.

The fix is one `try` in `globStart`. Any error from `stat` means "start at
`dir`", the same as a `null`:

```ts
let info: FileStat | null = null;
try {
  info = await host.files.stat(approved, joinRel(dir, prefix));
} catch {
  // A prefix through a file, or one starting with ~, is not a folder
  // under the root. Start at dir, where nothing will match it.
}
```

Add both cases to the "matches nothing" test in Task 2 Step 1:

```ts
expect(await _glob(root, ".", "a.md/sub/*.md", 100)).toEqual([]);
expect(await _glob(root, ".", "~/out/*.md", 100)).toEqual([]);
```

Both pass today and both fail with the plan as written, so they are real
guards for the move. Update the bullet list under `globStart` in Task 2 Step 3
to say that any error from `stat` falls back to `dir`.

### 2. The probe treats an "ignore everything except" file as ignoring whole folders

`ignoresWholeDirectory` keeps today's test: the folder is ignored, or a file
named `agency-ignore-probe` inside it is ignored, **or** a folder with that
name is. Today that test only picks between the grep tool and real grep in
safeBash, so a wrong answer costs one `std::bash` prompt. After this plan it
decides whether the rules above a search folder are applied at all. A wrong
`true` means the search quietly returns ignored files.

Some repositories write their `.gitignore` as an allow list:

```
*
!*/
!*.ts
```

This ignores every file except `.ts` files. The `!*/` line un-ignores folders,
so that git can look inside them. Take a search of `src`:

- `src` itself: `*` ignores it, `!*/` un-ignores it. Not ignored.
- A folder `src/agency-ignore-probe`: same as above. Not ignored.
- A file `src/agency-ignore-probe`: `*` ignores it, and nothing un-ignores it.
  Ignored.

With `||`, the third line makes `ignoresWholeDirectory` true. The walk of
`src` then drops the root `.gitignore`, and `grep("x", path: "src")` returns
the `.js` files that git ignores. Today `grep` gets this right. This would be
a regression for `grep`, and the new `glob` and `ls` behavior would have the
same hole.

Requiring both probes fixes it, and every case the plan tests still passes:

```ts
return (
  isIgnored(absoluteDir, true, files) ||
  (isIgnored(probe, false, files) && isIgnored(probe, true, files))
);
```

I checked each existing and planned case against the `&&` form. `dist/` and
`.*` match the folder itself. `**/node_modules/*`, `src/*`, and a bare `*` ignore
both probes. `*.log` and `**/*.js` ignore neither. The `ignoredFromAbove`
tests that live until Task 5 also pass unchanged.

Add the allow-list case as a row in the Task 1 Step 1 tests:

```ts
it("is false for a folder an allow-list .gitignore keeps", () => {
  expect(ignoresWholeDirectory(at("src"), rules("*\n!*/\n!*.ts\n"))).toBe(false);
});
```

It fails with `||` and passes with `&&`. Also change Step 3's instruction
("Move the three `isIgnored` calls...") to say the two probe calls are joined
with `&&`, and say why in the doc comment on `ignoresWholeDirectory`. The
`grep-flags.md` paragraph in Task 7 says "It tests the folder itself and a
made-up name inside it". Make it say "a made-up file and a made-up folder
inside it, and both must be ignored".

## Smaller points

- **A brace group that holds a `/`.** Task 2 Step 3 says an unmatched brace in
  a segment cannot happen, because `globToRegExp` already refuses one. That is
  true for the whole pattern, but not for one segment. The pattern
  `{src/lib,test}/*.ts` has balanced braces, so `globToRegExp` accepts it.
  Split on `/`, though, its first segment is `{src`, which the parser reads as
  plain text, so the prefix comes out as `{src/lib,test}`. The result is still
  right, because no such folder exists and `stat` returns `null`. But the
  stated reason is wrong, and it rests on `stat`. The simplest fix is for
  `globFixedPrefix` to stop at the first segment that holds `{` or `}`, since
  braces are the one form that can span a `/`. Add
  `["{src/lib,test}/*.ts", ""]` to the `globFixedPrefix` table test, and
  correct the sentence in Step 3.

- **The new grep note only helps with folders.** Task 5 Step 5 changes the
  note to "To search inside a folder .gitignore ignores, give that folder as
  grep's path." Ignored files are often not in an ignored folder. In this
  repository `**/*.js` ignores `.js` files everywhere. For those, the model
  has to name the file. Say "give that folder or file as grep's path".

- **"Always searched" reads as "no rules apply".** The new `glob` docstring
  says "A folder named in dir or at the start of the pattern is always
  searched." A model may read that as "the `.gitignore` rules do not apply
  inside it". They still do: `glob("src/**/*.js")` with `*.js` ignored above
  `src` still skips the `.js` files. The `ls` docstring has the clearer form,
  "To list an ignored folder, pass it as dir." Use the same form for `glob`:
  "To search an ignored folder, pass it as dir or start the pattern with it."
  The doc comment above `glob` and the new sentence in `grep`'s doc comment
  have the same wording and could change the same way.

- **Two more test files cover the code Task 1 changes.** Task 1 changes the
  walk setup that every `_grep` call goes through, and Task 2 renames the call
  in `scanEntries`. Neither `grep-basic`, `grep-flags`, `grep-max-results`, nor
  `skills-subdirs` is in the test loop. They are cheap. Add
  `tests/agency/stdlib/grep-basic`, `tests/agency/stdlib/grep-flags`,
  `tests/agency/stdlib/grep-max-results`, and `tests/agency/skills-subdirs` to
  the loop in "How to test".

- **Commit this review too.** Add `2026-11-10-glob-gitignore-review-2.md` to
  the `git add` list in Task 0.

## What I checked and found correct

So the builder does not re-verify these:

- **Every expected result in Tasks 1, 2, and 3.** I traced each case through
  `ancestorIgnoreFiles`, the walk, and the glob regex, including
  `keep/sub/x.js` (un-ignored by `keep/.gitignore`'s unanchored `!*.js`), the
  `linked/sub` case (refused by `refuseLinksBelow`, so `stat` returns `null`),
  and the `dir` plus prefix case (results stay relative to `keep`).
- **The four fixture pins can fail.** `scanClaudeSkills` and `commandsDir`
  start their walk in the fixture folder itself, `skillsDir` in
  `skills-dir-fixture/std`, and `savedWorkflowNames` in `workflows`. So each
  new `.gitignore` is the walk's own file. If a scan went back to `_glob`, the
  named entry would disappear.
- **No tracked fixture file is newly hidden.** I ran `git check-ignore` over
  the tracked files in `glob-fixtures`, `grep-fixtures`, and the four scan
  fixtures. The only matches are `skills-dir-fixture/empty/.gitkeep` and
  `workflow/fixtures/saveElsewhere.js`, and no test globs or lists either of
  them with the option on.
- **The 48 MB regression test is unaffected by the new default.** Its tree is
  in the system temp folder and holds a `.git` folder and no `.gitignore`, so
  `ancestorIgnoreFiles` returns nothing.
- **No other caller changes behavior.** Outside `shell.agency` and the tests,
  the public `glob` and `ls` are called by `stdlib/toolbox.agency:370` (a plain
  `ls`, unchanged) and the two scheduled agents in `agents/scheduled/`, which
  glob `docs/site/stdlib` and `docs/dev`. Neither folder is ignored. safeBash
  raises `std::ls` and `std::glob` for its listings but runs them with bash,
  so it does not call `_ls` or `_glob`.
- **The toolkit binding covers the coding agent.** `writableFileTools` spreads
  `readOnlyFileTools()`, so binding the parameter in one place covers both.
- **Searching an ignored folder gives the agent no new access.** The
  recommended policy already approves `std::read` anywhere in the launch
  folder (`lib/agents/agency-agent/tests/readPolicy.agency`), so a file in an
  ignored folder there could already be read by name.
- **The Agency in Tasks 4 and 6** uses forms existing tests use: `\tool ->`
  block shorthand, list comprehensions, named arguments after positional
  ones, and `catch [] with approve`.
- **No CI step checks for tracked files that git ignores**, so the
  `git add -f` fixtures will not trip a guard.
