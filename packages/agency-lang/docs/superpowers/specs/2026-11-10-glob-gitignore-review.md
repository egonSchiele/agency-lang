# Review: `glob` skips what `.gitignore` ignores

**Spec:** `/Users/adityabhargava/agency-lang/packages/agency-lang/worktree-glob-gitignore/packages/agency-lang/docs/superpowers/specs/2026-11-10-glob-gitignore.md`

**Verdict:** Approve with revisions. The diagnosis is right, and both changes are the right size. Findings 1 to 3 change what the spec says, so fix them before writing the plan. Findings 4 to 6 and the small items can go straight into the plan.

I checked each claim against the code in this worktree, at commit `4afb3900a`. I also ran ripgrep over a small test repository to compare its rules with the spec's named-folder rule.

## What checks out

- Every file and line reference is right, apart from one off-by-one listed under "Small items".
- The diagnosis of the empty grep is right. The public `grep` calls `_grep(<folder>, ".", ...)`, so `ancestorIgnoreFiles` reads the repository root's `.gitignore` through `repositoryAncestors`. For a path like `.worktrees/x/y.md`, the under-pattern of the `.*` rule (`**/.*/**`) matches, so `isIgnored` is true for every entry.
- The four internal `_glob` calls are the only ones in the workspace. No other package calls `_glob`. safeBash raises `std::glob` for `find` and then runs the real `find`.
- The `std::glob` and `std::grep` payloads carry no `respectGitignore` today. Leaving them alone keeps every saved policy rule working.
- The named-folder rule matches ripgrep for the cases in the spec's table. I made a repository whose `.gitignore` holds `.*`, `out/`, `*.log`, and `**/dist/*`, and searched each folder by name:

  | Command | ripgrep finds | The spec's rule finds |
  |---|---|---|
  | `rg -l needle out` | `out/a.txt` | the same |
  | `rg -l needle .hidden` | `.hidden/sub/b.md` | the same |
  | `rg -l needle logs` | `logs/d.txt`, and skips `logs/c.log` | the same |
  | `rg -l needle dist` | nothing | `dist/e.js` |

  The two differ only for a rule that ignores everything inside a folder. ripgrep returns nothing there, and the spec searches the folder. The spec's choice fits its goal better.
- The change opens nothing new to approval. The `std::grep` payload already names the folder, so a person or a policy approves the real question. A policy rule with `**` never matches a folder whose name starts with a dot (`docs/dev/agents/approval-policies.md`, rule 3). So a search of `.git` or `.worktrees` still asks for approval under a launch-directory rule.

## Finding 1: a folder named in the pattern is not covered

The docstring's own example names a folder at the start of the pattern:

```ts
glob("src/**/*.ts")
```

Models write patterns this way often. Here are three where the first folder is ignored:

```ts
glob(".claude/**/*.md")
glob(".venv/**/requests/*.py")
glob("out/**/*.js")
```

Today each of these returns files, because `_glob` reads no `.gitignore`. After change 1, each returns `[]`. The walk starts at `dir`, finds `.claude` ignored, and never enters it. `lib/stdlib/shell.ts:464` skips the entry before it visits or descends. The named-folder rule does not help, because it only looks at `dir`. In this repository the first call is a real case: the root `.gitignore`'s `.*` rule covers `.claude`.

This is the failure the spec sets out to remove. The model named the folder on purpose, and an empty list reads as "nothing matches". Looking inside `.venv` for a library's source, or inside `.claude` for skills, are ordinary agent tasks.

ripgrep has the same gap. In my test repository, `rg --files -g 'out/**'` printed nothing. Copying ripgrep would not close it.

Recommendation: start the walk at the pattern's fixed prefix. The fixed prefix is the leading path segments that hold no `*`, `?`, `{`, or `}`. For `.claude/**/*.md`, the walk starts at `.claude`. The regex is still tested against the path relative to `dir`, so the results keep their shape. Only the start of the walk moves. Change 2 then covers the pattern case with no extra code, because `ancestorIgnoreFiles` sees `.claude` as the folder being searched. fast-glob also starts its walk at a pattern's fixed prefix. The walk gets faster as well, because a `src/**` pattern no longer visits the rest of the tree.

The plan would need to settle four details:

1. A prefix with a `..` segment. Today such a pattern matches nothing. Do not split it, and the result stays the same.
2. A prefix that does not exist. `walkDir` yields nothing for a missing folder, which is today's result.
3. A prefix that is a symlink. Today the walk omits the link and returns `[]`. `walkDir` refuses a symlinked start folder with an error. The error tells the model more. It is still a change, so the spec should choose.
4. A `SKIP_DIRS` name in the prefix. `glob("node_modules/react/*.json")` returns `[]` today. With the split it returns files, because `SKIP_DIRS` applies only below the start of the walk. That matches the spec's rule for `dir`. The spec should say so under "What does not change".

If the owner prefers to leave this out, the spec should add a row for it to the table. Then the `[]` is a known result, and the docstring can tell the model to pass the folder as `dir`.

## Finding 2: the skills test cannot fail, and the reason for `false` is out of date

The spec says the four internal scans must pass `false`, because "a project's `.claude/skills` is covered by a `.*` rule … If these scans respected `.gitignore`, the agent would lose its skills."

Change 2 makes that reason false. With a `.*` rule above it, `.claude/skills` is a wholly ignored folder. It matches the under-pattern of `.*`, so `ignoredFromAbove` is true for it. Change 2 then drops the files above, and the scan finds every skill whether it passes `false` or not.

So the proposed test, "scans a skills folder ignored by a `.*` rule above it", passes with or without the explicit `false`. It cannot catch the mistake it is meant to catch.

A forgotten `false` breaks a partial rule. Suppose the repository's `.gitignore` holds `.claude/skills/drafts/` and no `.*` rule. The folder `.claude/skills` is not wholly ignored, so the rules above apply. A scan that respected `.gitignore` would lose the `drafts` skill.

Recommendations:

1. Restate the reason. These scans list a folder the program owns, so no `.gitignore` rule should hide a file in it.
2. Build the test on a partial rule such as `.claude/skills/drafts/`, and check that the `drafts` skill is found.
3. State `_glob`'s TypeScript default for the new parameter. The test can only catch a forgotten `false` if the default is `true`. I recommend `true`, to match `_grep`. With a default of `false`, the explicit argument is documentation, and no test checks it.

## Finding 3: open question 1 cannot wait, because change 2 makes its texts false

The spec leaves safeBash's check in place and calls its removal a follow-up. Keeping the check is a valid choice. Its explanation still has to change in this PR. Each of these says the grep tool's search finds nothing in a wholly ignored folder, and change 2 makes that untrue:

- the comment above the check, `stdlib/safeBash.agency:1176-1179`
- the failure message, `stdlib/safeBash.agency:1186` ("so the grep tool's search would find nothing")
- `docs/dev/stdlib/safe-bash.md:448-456`, and the clause at lines 440-441
- the doc comment on `ignoredFromAbove`, `lib/stdlib/gitignore.ts:95-101`
- the `grepOfIgnoredFolder` test: its comment at `tests/agency/safeBash.agency:876-878`, and its description in `tests/agency/safeBash.test.json:630` ("which would come back empty")

Recommendation: remove the check in this PR. After change 2, the one remaining difference between the two greps is that the tool skips nested `SKIP_DIRS` folders. That is equally true of every folder the check already lets through, such as a `src` that holds a `node_modules`. Nothing singles out an ignored folder any more, so the check only adds `std::bash` prompts.

Removing it deletes about a dozen lines in `safeBash.agency` and the doc paragraph. It also deletes the `_ignoredFromAbove` export, because the check is its only caller. `grepOfIgnoredFolder` then expects a shell-free plan that raises `std::grep` with `dir: <package>/node_modules`. Add `tests/agency/safeBash.agency` to the commands under "How to test".

If the owner keeps the check, every text in the list above must be rewritten in this PR, with a reason that still holds.

## Finding 4: the "must fail first" claim is wrong for two tests

The spec says "each of the first four must fail against the current code." Two of them pass today by design, and one passes in part:

- Bullet 2 (`_glob` with the option off returns everything) is today's behaviour. It is a guard.
- Bullet 4 (`_grep` rooted at a partly ignored folder still skips the ignored files) is today's behaviour too. It guards against a rule that is too broad.
- Bullet 3: the `_grep` half fails today. The `_glob` half passes today, because `_glob` reads no `.gitignore` at all.

An implementer who follows the spec will stall, or will bend the guards until they fail. Say instead which tests fail today (bullet 1, the `_grep` half of bullet 3, and bullet 5) and which pass before and after (bullets 2 and 4). The `_glob` half of bullet 3 fails only after change 1 and before change 2. So the plan should make change 1 first, check that failure, and then make change 2.

## Finding 5: test both ways of calling the walk

The public tools call `_grep(<folder>, ".", ...)` and `_glob(<folder>, ".", ...)`. In that shape, the `.gitignore` files above come from `repositoryAncestors`, outside the approved root. The existing test "applies a .gitignore above the search root" uses the other shape, `_grep(root, "sub", ...)`, where those files sit inside the root. `ancestorIgnoreFiles` returns from different places for the two shapes.

The trace hit the first shape, and no current test covers it. Run each change-2 test both ways:

```ts
await _grep(root, "out", query, 100);
await _grep(path.join(root, "out"), ".", query, 100);
```

The fixture also needs a `.git` entry at `root`. Without one, `ancestorIgnoreFiles` returns no files above in either shape (`lib/stdlib/shell.ts:424-425`). The test would then pass against today's code for the wrong reason.

## Finding 6: the Agency test's fixture needs `git add -f`

The Agency test compares `glob` with and without `respectGitignore: false`, so its fixture folder must hold a file that git ignores. `git add` refuses an ignored file named on its command line. When it adds the whole folder, it skips the ignored file without a message. An implementer who runs `git add` on the fixture folder commits it without the ignored file. The test then passes locally, where the file exists, and fails in CI, where it does not.

The plan should say to add the ignored file with `git add -f`, and to check with `git ls-files` that git tracks it. The matcher does not know which files git tracks, so it still skips a tracked file that a rule matches. The test should compare the two exact lists.

## Small items

- `stdlib/agents/lib/toolkits.agency:135` is the `glob` line. The `grep` binding the spec points to is on line 136.
- The doc comment above `readOnlyFileTools` (`stdlib/agents/lib/toolkits.agency:126-127`) says the grep tool respects `.gitignore` and the model cannot include ignored files. After this change it should name both tools, and say that naming an ignored folder searches it.
- The note safeBash adds after a shell-free grep (`_skippedDirsNote`, `lib/stdlib/grepDialect.ts:213`) tells the model to call the grep tool with `respectGitignore: false`. The agent toolkit binds that parameter, so the agent cannot follow this advice. After change 2, the useful advice is to pass the ignored folder as `path`.
- `glob`'s docstring does not mention `SKIP_DIRS`. The `ls` and `grep` docstrings both list them. Add them next to the new `.gitignore` sentence.
- The spec should say in one sentence that no interrupt changes. The `.gitignore` reads happen inside `_glob`, after the `std::glob` approval, as they already do for `grep`.
- A bare `false` in the sixth position, as in `_glob(real, ".", "*/SKILL.md", MAX_SKILL_FILES, [], false)`, does not tell a reader that the scan lists ignored files on purpose. The spec gives that as the reason for making the argument explicit. Add a short comment at each call, or use a named constant.
- The `grep-flags.md` entry in the `CLAUDE.md` index, and the same entry in the `agency-stdlib-docs` skill, describe the doc as covering `std::grep`. If its `.gitignore` section now covers `glob` too, update both descriptions.
- Under "How to test", the commands write `make.log`, `unit.log`, and `agency.log` into the package folder, but the text says to use a scratch folder. The commands also leave out formatting. CI fails on unformatted TypeScript, so add `pnpm exec prettier --write` on the changed `.ts` files.

## Open question 2

I agree with leaving the note out of this change. With finding 1 in place, a pattern that names an ignored folder no longer returns a misleading `[]`, and that is the most common way to get one. What remains is a pattern like `**/*.pyc` whose every match is ignored. The docstring covers that case.
