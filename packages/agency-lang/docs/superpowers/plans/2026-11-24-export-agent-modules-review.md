# Review: export the agent's compiled modules

A review of `docs/superpowers/plans/2026-11-24-export-agent-modules.md`, written 2026-11-24. I checked each claim in the plan against the code in this worktree. I also read Perry's plan, `docs/superpowers/plans/2026-11-24-own-session-program.md` in the Perry repo, to check that the two plans agree.

## Verdict

The design is right, and it is the right size. One line in `exports`, one test, and one doc section do the whole job. The plan has one bug that would break CI: the test's helper file `env.js` is ignored by git, so the commit leaves it out. Fix that, and the plan is ready to build.

| # | Finding | Severity |
|---|---|---|
| 1 | `env.js` is ignored by git, so CI runs the test without it | Critical |
| 2 | Review focus 2 gives the wrong reason the failure shows only at run time | Important |
| 3 | The new doc section does not name the one program known to import these modules | Important |
| 4 | The test's `agency.json` has nothing to do | Minor |
| 5 | The formatting constraint asks for a command that formats every file | Minor |
| 6 | Task 2 does not say exactly where the new section goes | Minor |

## 1. `env.js` is ignored by git (critical)

The repo's root `.gitignore` has these two lines:

```
**/*.js
!**/test.js
```

`git check-ignore -v tests/agency-js/agent-modules-import/env.js` reports that `**/*.js` matches it. Task 1 Step 6 runs `git add tests/agency-js/agent-modules-import`, and git skips an ignored file without a warning. The test passes on the machine that wrote it, because `env.js` is on disk there. In CI the file is missing, and `test.js` fails on its first import.

The plan also never deletes the folder that `env.js` makes with `mkdtempSync`. Each run leaves one folder behind in the temp directory.

The runner already does what `env.js` was written to do. Look at `runTsTestDir` in `lib/cli/test.ts`, lines 1357 to 1378. When a test folder holds an empty file named `useTestLLMProvider`, the runner gives the test's process a new `AGENCY_AGENT_HOME`, and it deletes that folder when the test ends. 29 agency-js tests already use this marker file. The marker also turns on the fake LLM client, which does no harm here, because the test makes no model call.

The fix:

1. Remove `env.js` from the file list and from Step 1.
2. Add an empty file, `tests/agency-js/agent-modules-import/useTestLLMProvider`.
3. Write `test.js` in the same form as `tests/agency-js/set-agent-name/test.js`, with no environment setup.
4. Replace the paragraph that explains `env.js` with one sentence: the marker file makes the runner give the test its own agent home, so the test never reads the developer's settings.

The sandbox is required, so do not drop it to save a file. Without the marker, the runner sets only `AGENCY_HOME` for an agency-js test (line 1363), not `AGENCY_AGENT_HOME`. The agent's modules would then read the developer's real `~/.agency-agent`. If that folder has an active preset with an effort, `askedEffort()` returns that effort before the test sets one, and `before` no longer matches the fixture.

## 2. Review focus 2 names the wrong cause (important)

The plan says the failure shows only at run time because `exportsMapExposes` lets through any `exports` map that has a `*` key. That function never runs for this import.

Here is the branch of `toCompiledImportPath` in `lib/importPaths.ts`, lines 596 to 600, that handles an import with a path after the package name:

```ts
if (isPkgImport(importPath)) {
  const { packageName, subpath } = parsePkgImport(importPath);
  if (subpath) {
    return `${packageName}/${subpath}.js`;
  }
```

It returns without looking at the `exports` map. `exportsMapExposes` runs only for an import with no path, through `compiledPkgEntry` (line 546). So the compiler never checks an import like `pkg::agency-lang/dist/lib/agents/agency-agent/lib/session` against `exports`, whether or not a `*` key exists.

The plan's conclusion still holds: this PR leaves the compiler alone, and the test's run catches a wrong entry. Only the explanation is wrong. Fix it, so that nobody who later wants a compile-time check edits `exportsMapExposes` and finds that nothing changes.

## 3. The doc should name the program that imports these modules (important)

After Perry's plan ships, Perry's `src/agency/core.agency` imports about 25 of these modules. Suppose someone working in agency-lang renames a function in `lib/session.agency`. Perry's build then breaks at its next version bump. The new doc section says that "any release can rename or remove a function in them". It does not say that a known program depends on them, or where to look to see which functions it uses.

Perry's plan gives that advice ("Whoever plans that change starts from the import list at the top of Perry's `core.agency`"), but only in Perry's repo. A developer of agency-lang will not read it. Add one sentence to the new section in `session-core.md`, for example:

```
Perry imports these modules from its own copy of the core. The import
list at the top of `src/agency/core.agency` in the Perry repo shows
which functions it uses.
```

Two lines of `session-core.md` will become false once Perry's plan lands. The opening says the core exists "so a session can move between front-ends: start one with `agency agent` in a terminal, carry on in an app". Line 9 says "Perry runs it too." Both are still true when this PR merges, so this PR should not change them. Add them to the "agency-lang's side" item in Perry's "After this PR" list, so they get fixed when Perry stops running this program.

## 4. The test's `agency.json` has nothing to do (minor)

The plan's `agency.json` is a copy of `set-agent-name`'s file with observability turned off. That leaves a `log` setting for a log that nobody writes, and a setting that turns off what is already off by default. `tests/agency-js/session-core-handoff` has no `agency.json`. Remove the file from the plan.

## 5. The formatting constraint (minor)

The global constraints say to run `pnpm run fmt:ts` only on the files this PR adds. That command cannot be limited to some files. Its script is `prettier --write "**/*.ts"`, so file names added after it are formatted on top of every `.ts` file in the worktree.

Step 6 already does the right thing: `pnpm exec prettier --write` with the two file names. Change the constraint to say that command, and to forbid `pnpm run fmt:ts`. CI's check, `fmt:ts:check`, looks only at `.ts` files, so formatting `test.js` is good manners and not a CI requirement.

## 6. Where the new doc section goes (minor)

Task 2 says to replace the two sentences "under a new heading ..., placed after the section `## Why a session can cross`". A reader could take that to mean the new heading goes inside that section, in place of the two sentences. Say it in two steps:

1. Delete the two sentences, which are lines 29 and 30 of `session-core.md`.
2. Add the new section between `## Why a session can cross` and `## The interface`.

## What I checked and found correct

- **The package can import itself in the test.** Step 2 worries that `pkg::` might not find `agency-lang` from inside its own repo. It will. `findPkgDir` in `lib/importPaths.ts` asks Node to resolve `agency-lang/package.json`. That path is not exported, so Node throws `ERR_PACKAGE_PATH_NOT_EXPORTED`. The function catches that, resolves the package's main entry instead, and walks up to the package's folder. Node lets a package import itself by name, so Step 2 should show the expected run-time error. It needs `make` first, so that `dist/` exists, and the plan does that.
- **The compiler does not compile the package's files.** `docs/dev/language/pkg-imports.md` says it only reads the `.agency` file to learn the exports. So the test never rewrites anything in `dist/`.
- **A missing name fails the compile.** `lib/preprocessors/importResolver.ts` line 290 throws `Symbol '<name>' is not defined in '<module>'`. The doc claim that an outside program "learns of it at its next compile" is true, and so is Perry's review focus 5.
- **The functions exist with the stated types.** `askedEffort(): string` and `applyEffortAnswer(effort: string): Result<boolean>` are in `lib/agents/agency-agent/lib/session.agency`. With an empty agent home, `askedEffort()` reads only the session's choices, the startup flags and the active preset, so the fixture's `""` and `"low"` do not depend on which API keys the machine has.
- **The entry's key matches the import.** In `"./dist/lib/agents/agency-agent/*"`, Node lets `*` match across slashes, so `lib/session.js` matches. Node picks the longest matching key, so the order in the map does not matter, and the new key does not clash with `./agent-session`.
- **CI runs agency-js tests after a full build**, because `session-core-handoff` already imports from `dist/`. CI does not run agency-js tests with `--check-capabilities`, so the test node needs no `@capabilities` tag.
- **The terminal-module guard is real.** `lib/stdlib/agentSessionImports.test.ts` keeps the program's imports away from `lib/trace.agency` and the other terminal modules, as review focus 1 says.
- **The two plans agree.** Perry's Task 1 Step 2 greps for the exact key this plan adds. Both plans name each other by path. Both say they were tried against 0.44.2. Main is now at 0.45.0, and Perry's Task 1 already plans for the API changes since 0.44.2.
