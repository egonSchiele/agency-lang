# `glob` and recursive `ls` skip what `.gitignore` ignores: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. In this repository, the "How to test" section below overrides the skills' test-after-every-step rhythm.

**Goal:** `glob` and a recursive `ls` skip files that git ignores, the way `grep` already does, and any of the three tools searches a folder the caller names even when git ignores that folder.

**Architecture:** All three tools walk folders through one function, `walkDir` in `lib/stdlib/shell.ts`, which already knows how to skip ignored entries. `glob` and `ls` start passing it the option. One check in the walk's setup stops the `.gitignore` rules above a named folder from hiding everything in it. `glob` starts its walk at the folder its pattern names. safeBash drops a check that the named-folder rule makes unnecessary.

**Tech Stack:** TypeScript (`lib/stdlib/`), Agency (`stdlib/*.agency`), vitest, the Agency test runner.

**Spec:** `/Users/adityabhargava/agency-lang/packages/agency-lang/worktree-glob-gitignore/packages/agency-lang/docs/superpowers/specs/2026-11-10-glob-gitignore.md`. Its review is the file beside it, `2026-11-10-glob-gitignore-review.md`. All paths below are relative to `packages/agency-lang` in the worktree `/Users/adityabhargava/agency-lang/packages/agency-lang/worktree-glob-gitignore`, on the branch `worktree-glob-gitignore`.

## How to test

Read this before you start. It changes how the tasks below are run.

The owner's rule for this repository is to batch. Write the code and the tests for every task first. Then run one `make`, and one run of the test files named below, with the output saved to a file. Fix every failure in one pass, and rerun only the files that failed. Do not build or run tests after each task. CI runs the full suite once the PR is open.

Each test below says which change it depends on, so a reviewer can see what would make it fail. You do not need to run anything to watch a test fail first.

The commands, from `packages/agency-lang` in the worktree. `LOGS` is any folder outside the repository, such as your scratchpad.

```bash
make > $LOGS/make.log 2>&1

pnpm vitest run lib/stdlib/shell.test.ts lib/stdlib/gitignore.test.ts \
  lib/stdlib/skills.test.ts lib/stdlib/grepDialect.test.ts \
  lib/sourceIsText.test.ts > $LOGS/unit.log 2>&1

for t in tests/agency/stdlib/gitignore-search tests/agency/stdlib/glob-basic \
  tests/agency/stdlib/glob-no-match tests/agency/stdlib/glob-single-star \
  tests/agency/stdlib/glob-question tests/agency/stdlib/glob-malformed \
  tests/agency/stdlib/ls-basic tests/agency/stdlib/ls-missing \
  tests/agency/stdlib/ls-recursive tests/agency/stdlib/search-paths \
  tests/agency/stdlib/grep-basic tests/agency/stdlib/grep-flags \
  tests/agency/stdlib/grep-max-results \
  tests/agency/safeBash tests/agency/agents/toolkits tests/agency/skills-claude \
  tests/agency/skills-dir tests/agency/skills-subdirs tests/agency/commands-dir \
  tests/agency/workflow/save; do
  pnpm run agency test $t.test.json --check-capabilities
done > $LOGS/agency.log 2>&1

# The regression test for a recursive ls that once sent 48 MB to a model.
# `agency test js` does not take --check-capabilities.
pnpm run agency test js tests/agency-js/ls-recursive-cap > $LOGS/ls-cap.log 2>&1

pnpm run typecheck > $LOGS/typecheck.log 2>&1
pnpm run lint:structure > $LOGS/lint.log 2>&1
```

Then `grep -E "FAIL|failed|Error" $LOGS/*.log` to find what failed.

Before the final commit, format the TypeScript files you changed, by name. Do not run `pnpm run fmt:ts`, which formats every file:

```bash
pnpm exec prettier --write lib/stdlib/shell.ts lib/stdlib/gitignore.ts \
  lib/stdlib/grepDialect.ts lib/stdlib/shell.test.ts \
  lib/stdlib/gitignore.test.ts lib/stdlib/skills.test.ts \
  lib/stdlib/grepDialect.test.ts
```

Leave hand smoke tests to the owner. The PR description lists them.

## Global Constraints

- Change files with the Edit and Write tools. Do not edit files with `sed`, `python`, or a heredoc.
- Write Agency code with the syntax in `docs/site/guide/basic-syntax.md`: `def`, `node`, parentheses around every condition, braces around every body, `let` or `const` before a variable's first use.
- The new parameter is named `respectGitignore` everywhere, and it defaults to `true` on `glob`, `ls`, `_glob`, and `_ls`, the same as on `grep` and `_grep`.
- No interrupt payload changes. `std::glob` stays `{ pattern, dir, maxResults }`, `std::ls` stays `{ dir, recursive, maxResults }`, and `std::grep` keeps its fields.
- A plain `ls` (not recursive) lists every entry of its folder, ignored ones included.
- Do not add code to follow symlinks. A symlink below the root stays refused.
- Use types, not interfaces. Use objects and arrays, not maps and sets. No dynamic imports.
- Do not hand-edit `docs/site/`. `make` regenerates it. Do not touch `CHANGELOG.md`.
- Write each commit message and the PR description in a file, and pass the file to `git` or `gh`. End each commit message with the attribution line your own session gives you. Never amend a commit or force push.

## Review Focus

These five cases are not in the spec's examples. Each is most likely to bite a person, and each has a test in the task that owns the code.

1. A glob prefix that passes through a symlink partway, such as `linked/sub/*.md`. It should return `[]`, as today, because the walk never enters a link. Test in Task 2.
2. A glob prefix that names a file or passes through one (`a.md/*`, `a.md/sub/*.md`), or starts with `~` (`~/notes/*.md`). Each should return `[]`, as today, with no error about `dir`. Test in Task 2.
3. A recursive `ls` with `maxResults` of 0 or less, after the listing moves onto `walkDir`. It should return `[]`, as today. Test in Task 3.
4. An ignored folder that holds other repositories, which is the trace's own layout. Each folder in `.worktrees` has its own `.git` file and `.gitignore`. A search of `.worktrees` should apply each inner `.gitignore`. Test in Task 1.
5. A glob with both a `dir` and a prefix, such as `_glob(root, "keep", "sub/*.js")`. The results should stay relative to `dir` (`sub/x.js`), not to the prefix. Test in Task 2.

---

## Background: how the code works today

### The three tools

`ls`, `grep`, and `glob` are Agency functions in `stdlib/shell.agency`. Each one does three things in order:

1. It calls `_searchTarget` to check the path it was given. A missing path, or a file given to `ls` or `glob`, fails here with a message for the model.
2. It raises its interrupt (`std::ls`, `std::grep`, or `std::glob`), which asks a person or a policy to approve the call.
3. It calls a TypeScript function in `lib/stdlib/shell.ts` that does the work: `_ls`, `_grep`, or `_glob`.

The public tools always call the TypeScript function the same way. They pass the folder to search as the first argument, `rootDir`, and `"."` as the second, `dir`:

```ts
_grep(target.value.dir, ".", query, maxResults, allowedPaths, respectGitignore, target.value.file)
_glob(target.value.dir, ".", pattern, maxResults, allowedPaths)
_ls(target.value.dir, ".", recursive, maxResults, allowedPaths)
```

Other callers, such as the tests and the skills scans, sometimes pass a subfolder as `dir`, for example `_grep(root, "sub", ...)`. Keep both shapes in mind, because the code that reads `.gitignore` files treats them differently.

### The walk

`walkDir` (`lib/stdlib/shell.ts:437`) visits every file and folder under a starting folder and calls a visitor function for each one. `_grep` and `_glob` use it. `_ls` does not, because it has its own walk (`shell.ts:327`).

`walkDir` always skips the six names in `SKIP_DIRS` (`node_modules`, `.git`, `dist`, `build`, `.next`, `.cache`) when it finds them below the starting folder. It never skips the starting folder itself.

When its `respectGitignore` option is on, `walkDir` also skips whatever git would ignore:

1. Before it starts, it calls `ancestorIgnoreFiles` (`shell.ts:405`) to collect the `.gitignore` files in the folders above the starting folder, up to the repository root. The repository root is the nearest folder with a `.git` entry. With no repository above, it collects nothing.
2. In each folder it enters, it adds that folder's own `.gitignore`.
3. It asks `isIgnored` (`lib/stdlib/gitignore.ts:173`) about each entry, and skips the entry if the answer is yes. It never enters a skipped folder.

`ancestorIgnoreFiles` finds the files above in two places. Files above the approved root come from `repositoryAncestors` and `readGitignore` in `gitignore.ts`. Files between the approved root and `dir` are read under the root. The public tools pass `dir` as `"."`, so for them every file above comes from the first place.

### Why a named ignored folder comes back empty

A `.gitignore` rule that matches a folder also matches everything under it. `parseGitignore` gives each rule a second pattern, `matchesUnder`, for exactly that. Git works the same way: once a folder is ignored, nothing inside it can be un-ignored.

In this repository, the root `.gitignore` holds `.*`. Suppose the model calls:

```ts
grep("needle", path: ".worktrees")
```

The walk starts in `.worktrees` and collects the root `.gitignore` as a file above. For the entry `.worktrees/foo/a.md`, the `.*` rule's under-pattern matches, because `.worktrees` starts with a dot. The same is true of every entry, so the walk skips them all and `grep` returns `[]`.

### safeBash's check

When the model runs `grep -rn x node_modules` through the bash tool, safeBash can run it through the grep tool's search, which asks `std::grep`, or through the real `grep` program, which asks `std::bash`. Before it uses the tool's search, `tryShellFreeGrep` calls `_ignoredFromAbove` (`stdlib/safeBash.agency:1181`). That function is true when the files above the folder ignore the folder itself, or a made-up name inside it (`PROBE_NAME`). A rule that ignores only some entries, such as `*.js`, leaves it false. When it is true, safeBash sends the command to real grep, because the tool's search would find nothing.

### The agent toolkit

`readOnlyFileTools` (`stdlib/agents/lib/toolkits.agency:128`) gives the agent its file tools. It binds `respectGitignore: true` on `grep` with partial application, so the model cannot pass `false`.

## What changes

The spec has the full reasoning. In short:

1. `glob` and a recursive `ls` take `respectGitignore`, default `true`, and pass it to the walk. A recursive `ls` moves onto `walkDir`.
2. `ancestorIgnoreFiles` returns no files when the files above the starting folder ignore all of it. The test for "all of it" is the one `ignoredFromAbove` uses today, moved into a function named `ignoresWholeDirectory` that takes the list of files.
3. `glob` starts its walk at the pattern's fixed prefix, so `glob(".claude/**/*.md")` names `.claude` the same way `glob("**/*.md", dir: ".claude")` does.
4. safeBash's check goes, along with `ignoredFromAbove`, `_ignoredFromAbove`, and `readAncestorGitignores`, which lose their only caller.

## Files

| File | What changes |
|---|---|
| `lib/stdlib/gitignore.ts` | Adds `ignoresWholeDirectory`. Deletes `ignoredFromAbove`, `_ignoredFromAbove`, `readAncestorGitignores`. |
| `lib/stdlib/shell.ts` | `ancestorIgnoreFiles` applies the named-folder rule. `_glob` takes the option and starts at the fixed prefix. `_globIncludingIgnored` is the call for a folder the program owns. `_ls` takes the option and walks with `walkDir`. `walkDir` gains `failOnUnreadableStart`. |
| `lib/stdlib/grepDialect.ts` | The note after a shell-free grep gives advice the agent can follow. |
| `stdlib/shell.agency` | The parameter, docstrings, and doc comments on `ls`, `grep`, and `glob`. |
| `stdlib/skills.agency`, `stdlib/workflow.agency` | The four internal `_glob` calls become `_globIncludingIgnored`. |
| `stdlib/safeBash.agency` | The check and its import go. |
| `stdlib/agents/lib/toolkits.agency` | Binds the parameter on `ls` and `glob`. |
| Tests | `lib/stdlib/{gitignore,shell,skills,grepDialect}.test.ts`, `tests/agency/safeBash.*`, `tests/agency/agents/toolkits.*`, the skills fixture, and a new `tests/agency/stdlib/gitignore-search.*` with its fixture. |
| Docs | `docs/dev/stdlib/grep-flags.md`, `docs/dev/stdlib/safe-bash.md`, the index line in `CLAUDE.md` and in `.claude/skills/agency-stdlib-docs/SKILL.md`. |

---

### Task 0: Commit the spec, the plan, and their reviews

- [ ] **Step 1: Commit the five documents**

```bash
git add docs/superpowers/specs/2026-11-10-glob-gitignore.md \
  docs/superpowers/specs/2026-11-10-glob-gitignore-review.md \
  docs/superpowers/plans/2026-11-10-glob-gitignore.md \
  docs/superpowers/plans/2026-11-10-glob-gitignore-review.md \
  docs/superpowers/plans/2026-11-10-glob-gitignore-review-2.md
git commit -F <message file>
```

Message: `Spec, plan, and reviews: glob and recursive ls skip what .gitignore ignores`.

### Task 1: The named-folder rule in the walk

**Files:**
- Modify: `lib/stdlib/gitignore.ts:91-114`
- Modify: `lib/stdlib/shell.ts:400-432`
- Test: `lib/stdlib/gitignore.test.ts`, `lib/stdlib/shell.test.ts`

**Interfaces:**
- Produces: `export function ignoresWholeDirectory(absoluteDir: string, files: GitignoreFile[]): boolean` in `lib/stdlib/gitignore.ts`. It reads nothing from disk. It is true when `files` ignore `absoluteDir` itself, or ignore both a file and a folder named `PROBE_NAME` inside it.
- Produces: `ancestorIgnoreFiles(walkRoot, dir)` returns `[]` when `ignoresWholeDirectory(path.join(walkRoot.base, dir), files)` is true for the files it collected. Every walk that respects `.gitignore` gets the named-folder rule from here.

- [ ] **Step 1: Write the `ignoresWholeDirectory` tests**

Add a `describe("ignoresWholeDirectory")` block to `lib/stdlib/gitignore.test.ts`, after the `parseGitignore + isIgnored` block. It uses the file's existing `root` and `at` helpers, so it needs no disk:

```ts
describe("ignoresWholeDirectory", () => {
  const rules = (text: string) => [parseGitignore(root, text)];

  it("is true for a folder a rule names, and for one inside it", () => {
    expect(ignoresWholeDirectory(at("dist"), rules("dist/\n"))).toBe(true);
    expect(ignoresWholeDirectory(at("dist/lib"), rules("dist/\n"))).toBe(true);
    expect(ignoresWholeDirectory(at("src"), rules("dist/\n"))).toBe(false);
  });

  it("is true when the rules ignore everything inside a folder but not the folder", () => {
    expect(ignoresWholeDirectory(at("node_modules"), rules("**/node_modules/*\n"))).toBe(true);
    expect(ignoresWholeDirectory(at("src"), rules("src/*\n"))).toBe(true);
  });

  it("is true for a dot folder under a .* rule", () => {
    expect(ignoresWholeDirectory(at(".worktrees"), rules(".*\n"))).toBe(true);
  });

  it("is false when the rules ignore only some entries", () => {
    expect(ignoresWholeDirectory(at("src"), rules(".*\n*.log\n**/*.js\n"))).toBe(false);
  });

  it("is false for a folder an allow-list .gitignore keeps", () => {
    // `*` ignores every file, and `!*/` un-ignores every folder so git can
    // look inside. The made-up file is ignored and the made-up folder is not.
    expect(ignoresWholeDirectory(at("src"), rules("*\n!*/\n!*.ts\n"))).toBe(false);
  });

  it("is false with no files", () => {
    expect(ignoresWholeDirectory(at("dist"), [])).toBe(false);
  });
});
```

Add `ignoresWholeDirectory` to the import from `./gitignore.js`. Leave the `ignoredFromAbove` tests alone. Task 5 deletes them.

- [ ] **Step 2: Write the walk tests**

Add a `describe` block to `lib/stdlib/shell.test.ts` after `_grep honours .gitignore`. Name it `a folder named as the search root is searched whatever the .gitignore files above it say`. Its `beforeEach` builds this tree in a fresh temp folder, using the same `mkdtempSync` and `safeDeleteDirectory` pattern as the block above it. The `.gitignore` files hold the rules shown, the `.git` file holds the text shown, and every other file holds the line `needle`.

```
root/
  .git/                       (a folder; without it no .gitignore above applies)
  .gitignore                  "*.js\nout/\n.*\n"
  out/b.txt
  out/c.js
  out/f.log
  out/.gitignore              "*.log\n"
  .hidden/d.txt
  src/e.js
  src/e.txt
  .worktrees/wt/.git          (a file holding "gitdir: elsewhere\n", like a real worktree)
  .worktrees/wt/.gitignore    "*.log\n"
  .worktrees/wt/a.txt
  .worktrees/wt/a.log
```

Use the `filesOnly` query from the block above. Each case runs in both shapes: the public tools' shape, with the folder as the root and `"."` as `dir`, and the shape with the folder as `dir` below the root. Two helpers in the `describe` block name the shapes:

```ts
/** The files holding "needle", searched the way the public tools call _grep. */
async function foundAsRoot(folder: string): Promise<string[]> {
  const hits = (await _grep(path.join(root, folder), ".", query, 100)) as string[];
  return hits.sort();
}

/** The same search, with the folder as `dir` below the root. */
async function foundBelowRoot(folder: string): Promise<string[]> {
  const hits = (await _grep(root, folder, query, 100)) as string[];
  return hits.sort();
}

it("searches a folder a rule above it ignores, and keeps that folder's own .gitignore", async () => {
  // Depends on change 2. Today both return [].
  expect(await foundAsRoot("out")).toEqual(["b.txt", "c.js"]);
  expect(await foundBelowRoot("out")).toEqual(["b.txt", "c.js"]);
});

it("searches a dot folder under a .* rule", async () => {
  // Depends on change 2. Today both return [].
  expect(await foundAsRoot(".hidden")).toEqual(["d.txt"]);
  expect(await foundBelowRoot(".hidden")).toEqual(["d.txt"]);
});

it("keeps the rules above a folder they ignore only part of", async () => {
  // Passes before and after: the guard against a rule that is too broad.
  expect(await foundAsRoot("src")).toEqual(["e.txt"]);
  expect(await foundBelowRoot("src")).toEqual(["e.txt"]);
});

it("applies each repository's own .gitignore inside an ignored folder of repositories", async () => {
  // Depends on change 2. Today it returns [].
  expect(await foundAsRoot(".worktrees")).toEqual(["wt/a.txt"]);
});
```

`c.js` is found in `out` because every file above `out` stops applying, `*.js` included. `f.log` is not found, because `out/.gitignore` still applies.

- [ ] **Step 3: Add `ignoresWholeDirectory` to `lib/stdlib/gitignore.ts`**

Move the three `isIgnored` calls out of `ignoredFromAbove` into `ignoresWholeDirectory(absoluteDir, files)`, and join the two probe calls with `&&`:

```ts
return (
  isIgnored(absoluteDir, true, files) ||
  (isIgnored(probe, false, files) && isIgnored(probe, true, files))
);
```

Today the probes are joined with `||`. That was safe while the answer only chose between two greps in safeBash. Now it decides whether the rules above a folder apply at all, and a wrong `true` returns ignored files. An allow-list `.gitignore` (`*`, `!*/`, `!*.ts`) ignores the made-up file but not the made-up folder, so `||` would call `src` wholly ignored. Say this in the doc comment on `ignoresWholeDirectory`. Every rule in the existing `ignoredFromAbove` tests gives the same answer with `&&`: `dist/` and `.*` match the folder itself, and `**/node_modules/*`, `src/*`, and `*` ignore both probes.

Then `ignoredFromAbove` returns `ignoresWholeDirectory(path.resolve(host.system.cwd(), dir), await readAncestorGitignores(host, dir))`. Its early return for an empty list goes, because `isIgnored` with no files is already false. Move the doc comment's explanation of the probe onto `ignoresWholeDirectory`, and drop its sentence that says a search of such a folder "finds nothing", which stops being true.

- [ ] **Step 4: Apply the rule in `ancestorIgnoreFiles`**

In `lib/stdlib/shell.ts`, rename today's `ancestorIgnoreFiles` to `gitignoreFilesAbove`, unchanged. Add a new `ancestorIgnoreFiles(walkRoot: WalkRoot, dir: string): Promise<GitignoreFile[]>` that calls it and returns `[]` when `ignoresWholeDirectory(path.join(walkRoot.base, dir), files)` is true. Its doc comment says, in one sentence each, that a folder the files above ignore entirely is searched, the way `grep` searches a file named on its command line, and that the folder's own `.gitignore` files still apply. Import `ignoresWholeDirectory` beside the other `gitignore.js` imports.

- [ ] **Step 5: Commit**

```bash
git add lib/stdlib/gitignore.ts lib/stdlib/gitignore.test.ts lib/stdlib/shell.ts lib/stdlib/shell.test.ts
git commit -F <message file>
```

Message: `Search a folder the caller names even when .gitignore above it ignores the whole folder`.

### Task 2: `glob` skips ignored files and starts at the pattern's fixed prefix

**Files:**
- Modify: `lib/stdlib/shell.ts:614-638` (`_glob`), plus three new functions beside it and `globToRegExp` (`shell.ts:640`)
- Modify: `stdlib/shell.agency:320-348` (`glob`)
- Modify: `stdlib/skills.agency:9-16`, `:265`, `:505`, `:909`, and `stdlib/workflow.agency:12`, `:795`
- Modify: `lib/stdlib/skills.test.ts:4`, `:24-25`, `lib/stdlib/grepDialect.test.ts:180-189`
- Create: `.gitignore` files in four existing fixtures: `tests/agency/skills-claude-fixture/`, `tests/agency/skills-dir-fixture/std/`, `tests/agency/commands-dir-fixture/`, and `tests/agency/workflow/fixtures/saved/renamed/workflows/`
- Test: `lib/stdlib/shell.test.ts`

**Interfaces:**
- Consumes: Task 1's named-folder rule, through `walkDir`.
- Produces: `_glob(rootDir: string, dir: string, pattern: string, maxResults: number, allowedPaths?: string[], respectGitignore: boolean = true): Promise<string[]>`.
- Produces: `export async function _globIncludingIgnored(rootDir: string, dir: string, pattern: string, maxResults: number): Promise<string[]>`. It returns `_glob(rootDir, dir, pattern, maxResults, [], false)`. The four scans of folders the program owns call it, so the decision that `.gitignore` never hides a file from them is written once.
- Produces: `export function globFixedPrefix(pattern: string): string`, exported so its table can be tested directly. It returns `""` when the pattern has no fixed prefix.
- Produces: `function isPlainSegment(segment: string): boolean`, not exported. It asks the glob parser whether a segment names one folder and matches nothing else.
- Produces: `async function globStart(host: Host, approved: Root, dir: string, pattern: string): Promise<string>`, not exported. It returns the folder a glob's walk starts in.
- Produces: `glob(pattern, dir, maxResults, allowedPaths, useAgentCwd, respectGitignore: boolean = true)` in `stdlib/shell.agency`.

- [ ] **Step 1: Write the `_glob` tests**

Add `describe("_glob honours .gitignore")` to `lib/stdlib/shell.test.ts`. Its `beforeEach` builds:

```
root/
  .git/
  .gitignore                "*.js\nout/\n.*\n"
  a.md
  a.js
  out/b.md
  keep/.gitignore           "!*.js\n"
  keep/c.js
  keep/sub/x.js
  .hidden/d.md
  node_modules/pkg/package.json
  linked -> root/out        (a symlink, made with fs.symlinkSync)
```

```ts
it("skips ignored files and folders, and lets a nested .gitignore un-ignore", async () => {
  // Depends on change 1. Today the result also holds a.js, out/b.md, and .hidden/d.md.
  expect((await _glob(root, ".", "**/*.{md,js}", 100)).sort()).toEqual([
    "a.md",
    "keep/c.js",
    "keep/sub/x.js",
  ]);
});

it("returns everything with the option off", async () => {
  // Passes before and after.
  expect((await _glob(root, ".", "**/*.{md,js}", 100, [], false)).sort()).toEqual([
    ".hidden/d.md",
    "a.js",
    "a.md",
    "keep/c.js",
    "keep/sub/x.js",
    "out/b.md",
  ]);
});

it("searches a folder named as the root, in both shapes", async () => {
  // Passes today, because _glob reads no .gitignore. Fails with change 1 alone.
  expect(await _glob(root, "out", "**/*.md", 100)).toEqual(["b.md"]);
  expect(await _glob(path.join(root, "out"), ".", "**/*.md", 100)).toEqual(["b.md"]);
  expect(await _glob(path.join(root, ".hidden"), ".", "*.md", 100)).toEqual(["d.md"]);
});

it("searches a folder named at the start of the pattern", async () => {
  // The first two depend on change 3: with change 1 alone they return [].
  expect(await _glob(root, ".", "out/*.md", 100)).toEqual(["out/b.md"]);
  expect(await _glob(root, ".", ".hidden/**/*.md", 100)).toEqual([".hidden/d.md"]);
  // A SKIP_DIRS name in the prefix is searched. Today this returns [].
  expect(await _glob(root, ".", "node_modules/pkg/*.json", 100)).toEqual([
    "node_modules/pkg/package.json",
  ]);
  // The walk now starts inside keep and never visits keep itself. The
  // pattern never matched the bare folder, so the result is unchanged.
  expect(await _glob(root, ".", "keep/**", 100, [], false)).not.toContain("keep");
});

it.each([
  [".claude/**/*.md", ".claude"],
  ["src/lib/*.ts", "src/lib"],
  ["src/app.ts", "src"],
  ["**/*.md", ""],
  ["{src,lib}/*.ts", ""],
  ["../other/*.md", ""],
  ["./src/*.ts", ""],
  ["{src/lib,test}/*.ts", ""],
])("globFixedPrefix(%s) is %j", (pattern, prefix) => {
  expect(globFixedPrefix(pattern)).toBe(prefix);
});

it("keeps results relative to dir when dir and a prefix are both given", async () => {
  expect(await _glob(root, "keep", "sub/*.js", 100)).toEqual(["sub/x.js"]);
});

it("matches nothing for a prefix that is not a folder under the root", async () => {
  // Passes before and after. The walk starts at dir for each of these.
  expect(await _glob(root, ".", "missing/*.md", 100)).toEqual([]);
  expect(await _glob(root, ".", "../out/*.md", 100)).toEqual([]);
  expect(await _glob(root, ".", "a.md/*", 100)).toEqual([]);
  expect(await _glob(root, ".", "linked/*.md", 100)).toEqual([]);
  expect(await _glob(root, ".", "linked/sub/*.md", 100)).toEqual([]);
  // stat throws for these two, with ENOTDIR and with "outside dir".
  expect(await _glob(root, ".", "a.md/sub/*.md", 100)).toEqual([]);
  expect(await _glob(root, ".", "~/out/*.md", 100)).toEqual([]);
});

it("_globIncludingIgnored lists ignored files", async () => {
  expect(await _globIncludingIgnored(root, ".", "out/*.md", 100)).toEqual(["out/b.md"]);
  expect(await _globIncludingIgnored(root, ".", "*.js", 100)).toEqual(["a.js"]);
});
```

Add `_globIncludingIgnored` and `globFixedPrefix` to the import from `./shell.js`.

The existing `_glob and symlinks` tests stay as they are and must still pass.

- [ ] **Step 2: Extend the docstring test to all three tools**

`lib/stdlib/grepDialect.test.ts:180` checks that `grep`'s docstring names every `SKIP_DIRS` folder. Turn it into a `describe.each(["ls", "grep", "glob"])`, splitting the source on `` `export idempotent def ${tool}(` ``. The `ls` docstring passes today. The `glob` docstring passes once Step 5 lists the names.

- [ ] **Step 3: Implement `globFixedPrefix` and `globStart`, and use them in `_glob`**

The glob parser beside `globToRegExp` (`globParser`, `shell.ts:668-691`) is the one definition of which characters are wildcards. Ask it, so a form added to the parser later, such as `[abc]`, is covered here too:

```ts
/** True when a pattern segment names one folder and matches nothing else. */
function isPlainSegment(segment: string): boolean {
  return globParser(segment).result === escapeRegex(segment);
}
```

The parser turns a plain character into its escaped text with `escapeRegex`, so a segment with no wildcard comes back as exactly `escapeRegex(segment)`.

`globFixedPrefix(pattern)` splits the pattern on `/` and drops the last segment, because the last segment names what to match. It keeps the leading segments up to the first one that is empty, is `.` or `..`, holds `{`, or is not `isPlainSegment`, and joins them with `/`.

The `{` check is there because a brace group is the one form that can hold a `/`. In `{src/lib,test}/*.ts`, the first segment after the split is `{src`, half a brace group, which the parser reads as plain text. Stopping at the first `{` ends the prefix before any brace group, split or not. The spec's table in change 3, plus this pattern, is the full list of cases:

| Pattern | Result |
|---|---|
| `.claude/**/*.md` | `.claude` |
| `src/lib/*.ts` | `src/lib` |
| `src/app.ts` | `src` |
| `**/*.md` | `""` |
| `{src,lib}/*.ts` | `""` |
| `../other/*.md` | `""` |
| `./src/*.ts` | `""` |
| `{src/lib,test}/*.ts` | `""` |

`globStart(host, approved, dir, pattern)` holds the one rule for where the walk starts. It returns `joinRel(dir, prefix)` when the prefix is not `""` and `host.files.stat(approved, joinRel(dir, prefix))` returns an entry whose `kind` is `"dir"`. In every other case it returns `dir`. Do not call `joinRel` with an empty prefix, because `joinRel(".", "")` returns `""`.

`stat` returns `null` for a missing path and for a path through a symlink, and throws for anything else. Two other prefixes reach it:

- A prefix through a file, such as `a.md/sub`, throws `ENOTDIR`.
- A prefix that starts with `~`, such as `~/notes`, throws, because the host expands `~` to the home folder, which is outside the root. `isPlainSegment("~")` is true, since `escapeRegex` leaves `~` alone, and models often put a `~` path in the pattern.

Treat a thrown error the same as `null`, and start at `dir`. Model the `try` on `hasGitEntry` in `lib/stdlib/gitignore.ts:148`, which also reads an error from `stat` as "not there". The `catch` says why in a comment: here the error is an expected answer, so there is nothing to log. Every one of these cases then gets today's result, because the walk starts where it does today.

In `_glob`, add the `respectGitignore` parameter, and call `walkDir` from `await globStart(host, approved, dir, pattern)` with `{ respectGitignore }`. Leave the visitor alone. It already tests `relativeTo(dir, rel)` against the whole pattern, so results stay relative to `dir`.

Add `_globIncludingIgnored` below `_glob`. Its doc comment says it lists every match whatever `.gitignore` says, for a folder the program owns, such as a skills or workflows folder, where no `.gitignore` rule should hide a file.

- [ ] **Step 4: Point the four internal scans at `_globIncludingIgnored`**

Each call keeps its arguments and changes its name:

- `stdlib/skills.agency:265`: `_globIncludingIgnored(root, sub, pattern, maxFiles)`
- `stdlib/skills.agency:505`: `_globIncludingIgnored(real, ".", "*/SKILL.md", MAX_SKILL_FILES)?`
- `stdlib/skills.agency:909`: `_globIncludingIgnored(real.value, ".", "*.md", MAX_SKILL_FILES)`
- `stdlib/workflow.agency:795`: `_globIncludingIgnored(root, WORKFLOWS_DIR, "*${FILE_SUFFIX}", MAX_WORKFLOWS + 1)?`

Change the imports at `stdlib/skills.agency:16` and `stdlib/workflow.agency:12` from `_glob` to `_globIncludingIgnored`, and the comment at `stdlib/skills.agency:9` that names `_glob`. Then search the workspace for other callers of `_glob`, and confirm that only `stdlib/shell.agency` and the tests remain:

```bash
grep -rn "_glob(" ../../packages --include=*.agency --include=*.ts | grep -v node_modules
```

In `lib/stdlib/skills.test.ts`, the two calls at lines 24-25 and the import at line 4 change to `_globIncludingIgnored` too, so the test calls the function the docs scan calls.

- [ ] **Step 5: Pin each of the four scans with an ignore rule in its fixture**

Each scan already has a test over a committed fixture. Give each fixture a `.gitignore` that names one entry the test already expects. If that scan went back to calling `_glob`, which respects `.gitignore`, the entry would disappear and the existing test would fail. So these four files are the tests for Step 4, and no new test case is needed.

Each file starts with the same comment line, so the next person to edit the fixture knows why files under it no longer show up in `git status`:

```
# A test checks that the scan still lists what this file ignores. Add a file this file names with `git add -f`.
```

| File | Its rule after the comment | The test that fails without `_globIncludingIgnored` |
|---|---|---|
| `tests/agency/skills-claude-fixture/.gitignore` | `word/` | `namesAreEverySkill` in `tests/agency/skills-claude.agency` expects `word` (scan at `skills.agency:505`) |
| `tests/agency/skills-dir-fixture/std/.gitignore` | `hello-world/` | `standardHasNamedSkill` in `tests/agency/skills-dir.agency` expects `hello-world` (scan at `skills.agency:265`) |
| `tests/agency/commands-dir-fixture/.gitignore` | `simple.md` | `entriesCount` in `tests/agency/commands-dir.agency` counts every command file (scan at `skills.agency:909`) |
| `tests/agency/workflow/fixtures/saved/renamed/workflows/.gitignore` | `renamed.json` | `renamedFileFailsToLoadAndList` in `tests/agency/workflow/save.agency` expects `listWorkflows` to read `renamed.json` and fail (scan at `workflow.agency:795`) |

None of the scans' patterns (`*/SKILL.md`, `*.{md,markdown}`, `*.md`, `*.json`) matches the name `.gitignore`, so the new files do not change any result. The repository's `.*` rule ignores all four, so commit them with `git add -f` (Step 7).

- [ ] **Step 6: Update `glob` in `stdlib/shell.agency`**

Add the parameter last, after `useAgentCwd`, and pass it to `_glob`:

```ts
export idempotent def glob(
  pattern: string,
  dir: string = ".",
  maxResults: number = 500,
  allowedPaths: string[] = [],
  useAgentCwd: boolean = false,
  respectGitignore: boolean = true,
): Result raises <std::glob> {
```

```ts
  return try _glob(target.value.dir, ".", pattern, maxResults, allowedPaths, respectGitignore)
```

Add a doc comment above its `@capabilities(fileRead)` line, matching the ones on `ls` and `grep`:

```
/**
Searches skip node_modules, .git, dist, build, .next, and .cache, plus paths
ignored by .gitignore when `respectGitignore` is true. To search an ignored
folder, pass it as `dir` or start the pattern with it. Symlinked entries are
omitted.
*/
```

Replace the docstring with this text, which becomes the tool description:

```
  """
  Find files matching a glob such as "src/**/*.ts". The search skips
  node_modules, .git, dist, build, .next, and .cache, and anything .gitignore
  ignores. To search an ignored folder, pass it as dir or start the pattern
  with it. Symlinked entries are omitted.

  @param allowedPaths - Restrict searches to these directories, or leave empty for no restriction.
  @param useAgentCwd - Resolve a relative dir against the agent working directory when set.
  @param respectGitignore - Skip what .gitignore ignores; false includes ignored files.
  """
```

- [ ] **Step 7: Commit**

```bash
git add lib/stdlib/shell.ts lib/stdlib/shell.test.ts lib/stdlib/skills.test.ts \
  lib/stdlib/grepDialect.test.ts stdlib/shell.agency stdlib/skills.agency stdlib/workflow.agency
git add -f tests/agency/skills-claude-fixture/.gitignore \
  tests/agency/skills-dir-fixture/std/.gitignore \
  tests/agency/commands-dir-fixture/.gitignore \
  tests/agency/workflow/fixtures/saved/renamed/workflows/.gitignore
git ls-files '*/.gitignore' | grep fixture   # must print all four paths
git commit -F <message file>
```

Message: `glob skips what .gitignore ignores and starts its walk at the folder its pattern names`.

### Task 3: A recursive `ls` walks with `walkDir`

**Files:**
- Modify: `lib/stdlib/shell.ts:304-354` (`_ls`), `:370-374` (`WalkOptions`), `:437-471` (`walkDir`)
- Modify: `stdlib/shell.agency:204-238` (`ls`)
- Test: `lib/stdlib/shell.test.ts`

**Interfaces:**
- Consumes: Task 1's named-folder rule, through `walkDir`.
- Produces: `_ls(rootDir: string, dir: string, recursive: boolean, maxResults: number = DEFAULT_LS_MAX_RESULTS, allowedPaths?: string[], respectGitignore: boolean = true): Promise<LsEntry[]>`.
- Produces: `WalkOptions.failOnUnreadableStart?: boolean`. When it is true, `walkDir` throws the error from listing its starting folder instead of yielding nothing. Below the start, an unreadable folder is still skipped.
- Produces: `ls(dir, recursive, maxResults, allowedPaths, useAgentCwd, respectGitignore: boolean = true)` in `stdlib/shell.agency`.

- [ ] **Step 1: Write the `_ls` tests**

Add `describe("_ls honours .gitignore on a recursive listing")` to `lib/stdlib/shell.test.ts`, and add `_ls` to the import from `./shell.js`. Its `beforeEach` builds:

```
root/
  .git/
  .gitignore        "*.js\nout/\n"
  a.agency
  a.js
  out/b.txt
```

Compare the sorted `path` fields. Import the `LsEntry` type from `./shell.js` too:

```ts
const paths = (entries: LsEntry[]) => entries.map((entry) => entry.path).sort();

it("skips ignored entries on a recursive listing", async () => {
  // Depends on change 1. Today the result also holds a.js, out, and out/b.txt.
  expect(paths(await _ls(root, ".", true))).toEqual([".gitignore", "a.agency"]);
});

it("lists everything with the option off", async () => {
  // Passes before and after.
  expect(paths(await _ls(root, ".", true, 1000, [], false))).toEqual([
    ".gitignore",
    "a.agency",
    "a.js",
    "out",
    "out/b.txt",
  ]);
});

it("shows every entry on a plain listing, SKIP_DIRS and ignored ones included", async () => {
  // Passes before and after.
  expect(paths(await _ls(root, ".", false))).toEqual([".git", ".gitignore", "a.agency", "a.js", "out"]);
});

it("lists a folder named as the root, in both shapes", async () => {
  // Passes today, because _ls reads no .gitignore. Fails with change 1 alone.
  expect(paths(await _ls(root, "out", true))).toEqual(["b.txt"]);
  expect(paths(await _ls(path.join(root, "out"), ".", true))).toEqual(["b.txt"]);
});

it("returns nothing for a maxResults of 0 or less, and stops at maxResults", async () => {
  // Passes before and after: the guard for the move onto walkDir.
  expect(await _ls(root, ".", true, 0)).toEqual([]);
  expect(await _ls(root, ".", true, -3)).toEqual([]);
  expect(await _ls(root, ".", false, 0)).toEqual([]);
  expect(await _ls(root, ".", true, 1, [], false)).toHaveLength(1);
});

it("fails when it cannot read the folder it was given", async () => {
  // A file stands in for an unreadable folder. The first two pass before
  // and after. With the option on, the call fails in the .gitignore setup,
  // before the walk lists anything, so it cannot test the walk.
  await expect(_ls(root, "a.agency", true)).rejects.toThrow();
  await expect(_ls(root, "a.agency", false)).rejects.toThrow();
  // Depends on Step 2. With the option off the walk reaches the listing,
  // and without failOnUnreadableStart it would resolve to [].
  await expect(_ls(root, "a.agency", true, 1000, [], false)).rejects.toThrow();
});
```

- [ ] **Step 2: Add `failOnUnreadableStart` to `walkDir`**

Add the field to `WalkOptions` with a one-line doc comment. In `walkDir`'s inner `walk`, the `catch` around `host.files.list` rethrows when the option is on and the folder is the starting one. Otherwise it returns `true`, as today.

- [ ] **Step 3: Move the recursive branch of `_ls` onto `walkDir`**

Add the `respectGitignore` parameter after `allowedPaths`. Keep the plain listing as one `host.files.list` call over `dir`, which shows every entry and stops at the cap, as the loop does today. For a recursive listing, call `walkDir(host, approved, dir, visitor, { respectGitignore, failOnUnreadableStart: true })`. The visitor returns `false` without pushing once `out.length >= cap`. Otherwise it pushes `{ name, path: relativeTo(dir, rel), type, size }` and returns `true`. Delete `_ls`'s own recursive `walk` and its `SKIP_DIRS` check, since `walkDir` skips those names. Update `_ls`'s doc comment to say that a recursive listing skips what `.gitignore` ignores, unless `respectGitignore` is false. Drop its sentence about `isRoot`, which names the deleted walk's flag.

The comment in `_grep` at `shell.ts:573`, "An unreadable file during a walk is skipped, as in `_ls`.", points at the walk this step deletes. Make it `An unreadable file during a walk is skipped.`

The cap check comes before the push so that a cap of 0 or less returns `[]`. The comment about coercing a non-finite cap stays.

- [ ] **Step 4: Update `ls` in `stdlib/shell.agency`**

Add the parameter last and pass it to `_ls`:

```ts
export idempotent def ls(
  dir: string = ".",
  recursive: boolean = false,
  maxResults: number = 1000,
  allowedPaths: string[] = [],
  useAgentCwd: boolean = false,
  respectGitignore: boolean = true,
): Result raises <std::ls> {
```

```ts
  return try _ls(target.value.dir, ".", recursive, maxResults, allowedPaths, respectGitignore)
```

Replace the doc comment above it:

```
/**
Recursive listings skip node_modules, .git, dist, build, .next, and .cache,
plus paths ignored by .gitignore when `respectGitignore` is true. To list an
ignored folder, pass it as `dir`. Non-recursive listings include every entry.
Symlinked entries are omitted.
*/
```

Replace the docstring:

```
  """
  List directory entries, optionally including subdirectories. A recursive
  listing skips node_modules, .git, dist, build, .next, and .cache, and
  anything .gitignore ignores. To list an ignored folder, pass it as dir.
  Narrow dir or raise maxResults when the listing reaches its limit.

  @param allowedPaths - Restrict searches to these directories, or leave empty for no restriction.
  @param useAgentCwd - Resolve a relative dir against the agent working directory when set.
  @param respectGitignore - Skip what .gitignore ignores in a recursive listing; false includes ignored files.
  """
```

- [ ] **Step 5: Update the `grep` text in `stdlib/shell.agency`**

`grep`'s code does not change. Its text gains the named-folder rule. In the doc comment above it (`shell.agency:246-249`), the second sentence becomes:

```
Directory searches skip common build and dependency directories, plus paths
ignored by .gitignore when `respectGitignore` is true. A directly named file
is always searched. To search an ignored folder, pass it as `path`. Symlinked
entries are omitted.
```

In its docstring, the second sentence becomes:

```
  A directory search skips node_modules, .git, dist, build, .next, and .cache,
  and anything .gitignore ignores. To search an ignored folder, pass it as path.
```

- [ ] **Step 6: Commit**

```bash
git add lib/stdlib/shell.ts lib/stdlib/shell.test.ts stdlib/shell.agency
git commit -F <message file>
```

Message: `A recursive ls skips what .gitignore ignores, through the walk grep and glob use`.

### Task 4: The agent toolkit binds the parameter

**Files:**
- Modify: `stdlib/agents/lib/toolkits.agency:126-137`
- Test: `tests/agency/agents/toolkits.agency`, `tests/agency/agents/toolkits.test.json`

**Interfaces:**
- Consumes: the `respectGitignore` parameter on `ls` (Task 3) and `glob` (Task 2).

- [ ] **Step 1: Write the binding test**

In `tests/agency/agents/toolkits.agency`, generalize `isCwdBound(tool)` into `isBoundTrue(tool: any, name: string): boolean`, which looks up the parameter `name` where it now looks up `"useAgentCwd"`. `fileAndShellToolsAreCwdBound` then calls `every(shouldBeBound, \tool -> isBoundTrue(tool, "useAgentCwd"))`. Add a node:

```
// The model cannot include ignored files by passing respectGitignore: false.
node searchToolsRespectGitignore(): boolean {
  const searchToolNames = ["ls", "glob", "grep"]
  const searchers = filter(readOnlyFileTools(), \tool -> searchToolNames.includes(tool.name))
  const allPresent = searchers.length == searchToolNames.length
  return allPresent && every(searchers, \tool -> isBoundTrue(tool, "respectGitignore"))
}
```

Add its case to `tests/agency/agents/toolkits.test.json`:

```json
{
  "nodeName": "searchToolsRespectGitignore",
  "description": "ls, glob, and grep in the agent toolkit are bound to respectGitignore: true, so the model cannot turn it off",
  "input": "",
  "expectedOutput": "true",
  "evaluationCriteria": [{ "type": "exact" }]
}
```

This test depends on this task. Without it, `ls` and `glob` are not bound.

- [ ] **Step 2: Bind the parameter and update the comment**

```ts
    read.partial(useAgentCwd: true),
    ls.partial(useAgentCwd: true, respectGitignore: true),
    glob.partial(useAgentCwd: true, respectGitignore: true),
    grep.partial(useAgentCwd: true, respectGitignore: true),
```

The doc comment above `readOnlyFileTools` becomes:

```
/** ls, glob, and grep always respect `.gitignore`. The setting is bound so
the model cannot include ignored files by changing an argument. The model can
still search an ignored folder by naming it as the folder to search. */
```

- [ ] **Step 3: Commit**

```bash
git add stdlib/agents/lib/toolkits.agency tests/agency/agents/toolkits.agency tests/agency/agents/toolkits.test.json
git commit -F <message file>
```

Message: `Agent toolkit: ls and glob always respect .gitignore, like grep`.

### Task 5: safeBash runs a grep of an ignored folder through the tool

**Files:**
- Modify: `stdlib/safeBash.agency:69` (import), `:1176-1188` (the check)
- Modify: `lib/stdlib/gitignore.ts:74-89`, `:95-119`
- Modify: `lib/stdlib/grepDialect.ts:213`
- Modify: `tests/agency/safeBash.agency:875-882`, `tests/agency/safeBash.test.json:629-639`
- Modify: `lib/stdlib/gitignore.test.ts:85-190`
- Modify: `docs/dev/stdlib/safe-bash.md:437-464`

**Interfaces:**
- Consumes: Task 1, which makes the tool's search find an ignored folder's files.
- Removes: `ignoredFromAbove`, `_ignoredFromAbove`, `readAncestorGitignores`. Nothing else calls them. Confirm with `grep -rn "ignoredFromAbove\|readAncestorGitignores" lib stdlib tests ../../packages --include=*.ts --include=*.agency` after the change. Only `ignoresWholeDirectory` and its own tests should remain.

- [ ] **Step 1: Update the safeBash test**

In `tests/agency/safeBash.agency`, the comment above `grepOfIgnoredFolder` becomes:

```
  // A lone grep of a folder .gitignore ignores runs the tool's search like a
  // grep of any other folder, because the tool searches a folder it is given
  // whatever the .gitignore files above it say.
```

In `tests/agency/safeBash.test.json`, its case becomes:

```json
"description": "A lone grep of a folder .gitignore ignores runs the tool's search and asks std::grep, like a grep of any other folder.",
"expectedOutput": "[\"grep\",[\"std::grep\"],null]",
```

This test depends on this task. Today it expects `std::bash`.

- [ ] **Step 2: Retarget the `readAncestorGitignores` tests and drop the `ignoredFromAbove` ones**

In `lib/stdlib/gitignore.test.ts`, delete the `describe("ignoredFromAbove")` block. Task 1's `ignoresWholeDirectory` tests cover its rule cases. Its two cases about reading files are covered elsewhere. A search of the repository root is covered by Task 2's `_glob` tests, whose root holds `.git`. A folder outside any repository is covered by the first `_grep honours .gitignore` test, whose root holds no `.git`.

Rename `describe("readAncestorGitignores")` to `describe("repositoryAncestors")`, and point its three tests at the function they exercise:

```ts
it("lists the folders between a subdirectory and its repository root, outermost first", async () => {
  const outer = repo();
  mkdirSync(join(outer, ".git"));
  mkdirSync(join(outer, "lib", "deep"), { recursive: true });
  expect(await repositoryAncestors(host, join(outer, "lib", "deep"))).toEqual([outer, join(outer, "lib")]);
});

it("stops at a nested repository root, where an enclosing repository's rules do not reach", async () => {
  const outer = repo();
  mkdirSync(join(outer, ".git"));
  const inner = join(outer, "inner");
  mkdirSync(join(inner, ".git"), { recursive: true });
  mkdirSync(join(inner, "src"));
  expect(await repositoryAncestors(host, inner)).toEqual([]);
  expect(await repositoryAncestors(host, join(inner, "src"))).toEqual([inner]);
});

it("is null outside any repository", async () => {
  expect(await repositoryAncestors(host, repo())).toBeNull();
});
```

Fix the import list: drop `ignoredFromAbove` and `readAncestorGitignores`, and add `repositoryAncestors`.

- [ ] **Step 3: Remove the check from safeBash**

In `stdlib/safeBash.agency`, delete the comment and the `if (target.file == null) { ... }` block at lines 1176-1188, and the `_ignoredFromAbove` import at line 69.

- [ ] **Step 4: Delete the three functions from `lib/stdlib/gitignore.ts`**

Delete `ignoredFromAbove`, `_ignoredFromAbove`, and `readAncestorGitignores`. Keep `PROBE_NAME`, `ignoresWholeDirectory`, `repositoryAncestors`, `_repositoryAncestors`, and `readGitignore`. The agent still imports `_repositoryAncestors` from `lib/agents/agency-agent/lib/claudeSkills.agency` and `projectContext.agency`, and `shell.ts` uses the other two. Remove any import that is now unused.

- [ ] **Step 5: Give the note after a shell-free grep advice the agent can follow**

In `_skippedDirsNote` (`lib/stdlib/grepDialect.ts:213`), the last sentence becomes `To search a folder or file .gitignore ignores, give that folder or file as grep's path.` Ignored files often sit outside any ignored folder, as with `**/*.js` in this repository, and then the model has to name the file. The agent toolkit binds `respectGitignore`, so the agent could not follow today's advice to pass `respectGitignore: false`. The existing test only checks that the note names each `SKIP_DIRS` folder, so it does not change.

- [ ] **Step 6: Update the "grep" section of `docs/dev/stdlib/safe-bash.md`**

In the paragraph that starts "`tryShellFreeGrep` applies to a grep" (line 437), delete the clause `whose directory target is not wholly ignored by the `.gitignore` files above it,`.

Replace the two paragraphs at lines 448-464, from "The `.gitignore` check matters" to "nearly every grep would go back to `std::bash`.", with:

```markdown
The tool's search skips what `.gitignore` ignores, so it can find fewer
matches than grep would. The note at the end of the output says what it
skipped. A folder the command names is searched even when git ignores it, so
`grep -rn x node_modules` runs the tool's search and asks `std::grep`, like a
grep of any other folder. See "`.gitignore`" in
`docs/dev/stdlib/grep-flags.md`.

The `SKIP_DIRS` names still apply below the folder, and most published
packages keep their code in `dist`. So `grep -rn x node_modules/some-package`
skips that package's `dist` folder. Naming the folder searches it:
`grep -rn x node_modules/some-package/dist`.
```

- [ ] **Step 7: Commit**

```bash
git add stdlib/safeBash.agency lib/stdlib/gitignore.ts lib/stdlib/gitignore.test.ts \
  lib/stdlib/grepDialect.ts tests/agency/safeBash.agency tests/agency/safeBash.test.json \
  docs/dev/stdlib/safe-bash.md
git commit -F <message file>
```

Message: `safeBash runs a grep of an ignored folder through the grep tool, which now searches it`.

### Task 6: One Agency test through the public tools

**Files:**
- Create: `tests/agency/stdlib/gitignore-search.agency`, `tests/agency/stdlib/gitignore-search.test.json`
- Create: `tests/agency/stdlib/gitignore-fixtures/.gitignore`, `kept.md`, `ignored.md`, `out/inside.md`

**Interfaces:**
- Consumes: `glob` (Task 2), `ls` (Task 3), and `grep` (Task 1), through `std::shell`.

- [ ] **Step 1: Create the fixture**

Each `.md` file holds the line `needle`. The `.gitignore` names itself, so the expected lists do not depend on the repository's own `.*` rule:

```
.gitignore
ignored.md
out/
```

- [ ] **Step 2: Write the test**

`tests/agency/stdlib/gitignore-search.agency`:

```
import { glob, ls, grep } from "std::shell"
import { sortBy } from "std::array"

// The fixture's .gitignore names itself, ignored.md, and out/. Those files
// are committed with `git add -f`, because a plain `git add` skips them.
def fixtures(): string {
  return __dirname + "/gitignore-fixtures"
}

def sortedPaths(paths: string[]): string[] {
  const sorted = sortBy(paths) as item {
    return item
  }
  return sorted
}

def globIn(pattern: string, dir: string, respectGitignore: boolean = true): string[] {
  const results = glob(pattern, dir, respectGitignore: respectGitignore) catch [] with approve
  return sortedPaths(results)
}

def lsIn(dir: string, recursive: boolean = true, respectGitignore: boolean = true): string[] {
  const entries = ls(dir, recursive, respectGitignore: respectGitignore) catch [] with approve
  return sortedPaths([entry.path for entry in entries])
}

node globSkipsIgnored() {
  return globIn("**/*.md", fixtures())
}

node globIncludesIgnoredWhenAsked() {
  return globIn("**/*.md", fixtures(), respectGitignore: false)
}

node globSearchesNamedIgnoredFolder() {
  return globIn("*.md", fixtures() + "/out")
}

node globSearchesFolderNamedInPattern() {
  return globIn("out/*.md", fixtures())
}

node lsRecursiveSkipsIgnored() {
  return lsIn(fixtures())
}

node lsRecursiveIncludesIgnoredWhenAsked() {
  return lsIn(fixtures(), respectGitignore: false)
}

node lsPlainShowsIgnored() {
  return lsIn(fixtures(), recursive: false)
}

node lsRecursiveListsNamedIgnoredFolder() {
  return lsIn(fixtures() + "/out")
}

node grepSearchesNamedIgnoredFolder() {
  const hits = grep("needle", fixtures() + "/out", filesOnly: true) catch [] with approve
  return hits
}
```

`tests/agency/stdlib/gitignore-search.test.json` has one case per node, each with `"input": ""` and `"evaluationCriteria": [{ "type": "exact" }]`:

| Node | `expectedOutput` | Depends on |
|---|---|---|
| `globSkipsIgnored` | `["kept.md"]` | change 1 |
| `globIncludesIgnoredWhenAsked` | `["ignored.md","kept.md","out/inside.md"]` | passes before and after |
| `globSearchesNamedIgnoredFolder` | `["inside.md"]` | change 2, once change 1 is in |
| `globSearchesFolderNamedInPattern` | `["out/inside.md"]` | change 3, once change 1 is in |
| `lsRecursiveSkipsIgnored` | `["kept.md"]` | change 1 |
| `lsRecursiveIncludesIgnoredWhenAsked` | `[".gitignore","ignored.md","kept.md","out","out/inside.md"]` | passes before and after |
| `lsPlainShowsIgnored` | `[".gitignore","ignored.md","kept.md","out"]` | passes before and after |
| `lsRecursiveListsNamedIgnoredFolder` | `["inside.md"]` | change 2, once change 1 is in |
| `grepSearchesNamedIgnoredFolder` | `["inside.md"]` | change 2 |

Write each `expectedOutput` as a JSON-encoded string, as in `tests/agency/stdlib/glob-basic.test.json`. Give each case a one-sentence `description` that says what the node checks.

- [ ] **Step 3: Commit, force-adding the ignored files**

```bash
git add tests/agency/stdlib/gitignore-search.agency tests/agency/stdlib/gitignore-search.test.json \
  tests/agency/stdlib/gitignore-fixtures/kept.md
git add -f tests/agency/stdlib/gitignore-fixtures/.gitignore \
  tests/agency/stdlib/gitignore-fixtures/ignored.md \
  tests/agency/stdlib/gitignore-fixtures/out/inside.md
git ls-files tests/agency/stdlib/gitignore-fixtures   # must print all four files
git commit -F <message file>
```

Message: `Test glob, ls, and grep over a fixture whose .gitignore hides files`.

### Task 7: Docs

**Files:**
- Modify: `docs/dev/stdlib/grep-flags.md:81-89`, `:100-112`
- Modify: `docs/dev/stdlib/safe-bash.md:820-830`
- Modify: `CLAUDE.md:345`, `.claude/skills/agency-stdlib-docs/SKILL.md:19`

- [ ] **Step 1: Rewrite the `.gitignore` section of `grep-flags.md`**

Replace the section at lines 81-89 with:

```markdown
## `.gitignore`

`grep`, `glob`, and a recursive `ls` skip what `.gitignore` ignores, so
compiled output and other ignored trees do not crowd out source. They read
the `.gitignore` files in the folder they search and below it. They also read
the ones above it, up to the repository root, which is the nearest folder
holding a `.git` entry. The walk is `walkDir` in `lib/stdlib/shell.ts`. The
matcher is `lib/stdlib/gitignore.ts`, which handles comments, negation,
directory-only rules, anchoring, and nested files refining their parents. It
does not read `.git/info/exclude` or the global excludes file.

Each of the three tools has a `respectGitignore` parameter, true by default.
The agent toolkits bind it with partial application, so the model cannot
turn it off. A plain `ls` lists every entry of its folder, ignored ones
included, so the model can see an ignored folder and name it.

A folder the caller names is searched even when git ignores it. When the
`.gitignore` files above the search folder ignore that folder, or every name
in it, the walk does not apply them. `ignoresWholeDirectory` decides this, and
`ancestorIgnoreFiles` applies it. It is true when the rules ignore the folder
itself, or ignore both a made-up file and a made-up folder inside it. So
`dist/`, `**/node_modules/*`, and `.*` (for `.worktrees`) count, and `*.js`
above `src` does not. An allow-list `.gitignore` (`*`, `!*/`, `!*.ts`) does
not count either, because it keeps folders. The `.gitignore` files in the
search folder and below it still apply.

| Call, with `.*` and `out/` in the root `.gitignore` | Result |
|---|---|
| `glob("**/*.md")` | skips `.worktrees` and `out` |
| `grep("x", path: ".worktrees")` | searches `.worktrees` |
| `glob(".worktrees/**/*.md")` | searches `.worktrees` |
| `ls(".")` | shows `.worktrees` and `out` |
| `grep("x", path: "src")`, with `*.js` ignored | skips the `.js` files in `src` |

`glob` starts its walk at the pattern's fixed prefix. The fixed prefix is the
leading folder names before the first segment that the glob parser reads as
a pattern, or that holds `{`, since a brace group can hold a `/`. When the
prefix is not a folder under the search root, the walk starts at the root as
before. A folder named at the start of the pattern is then the search folder,
and the rule above applies to it. A `SKIP_DIRS` name in the prefix is
searched too, because `SKIP_DIRS` applies below the start of the walk.
Braces are not expanded into several starting folders, so
`glob("{out,src}/*.md")` still skips an ignored `out`.
```

In the "Tests" list at the end, replace the `gitignore.test.ts` bullet with:

```markdown
- `lib/stdlib/gitignore.test.ts` covers the ignore rules and
  `ignoresWholeDirectory`. The `.gitignore` cases for `_grep`, `_glob`, and
  `_ls` in `lib/stdlib/shell.test.ts` cover the walk, the named-folder rule,
  and the fixed prefix. `tests/agency/stdlib/gitignore-search.agency` runs
  the three public tools over a fixture whose ignored files are committed
  with `git add -f`.
```

- [ ] **Step 2: Update "What a recursive listing shows" in `safe-bash.md`**

Replace the paragraph at lines 822-830 with:

```markdown
The `ls` tool's recursive walk and the `glob` tool's walk skip `SKIP_DIRS`
(`node_modules`, `.git`, `dist`, `build`, `.next`, `.cache`) and what
`.gitignore` ignores. Real `ls -R`, `du`, `tree`, and `find` skip nothing. A
recursive listing through bash is still narrow under the same payload. It
shows the names the tools leave out, and no file's contents. The names are
not what decided grep, where a directory search through bash asks
`std::bash` because real grep reads the contents the tool skips.
```

- [ ] **Step 3: Update the index line in two places**

In `CLAUDE.md:345` and `.claude/skills/agency-stdlib-docs/SKILL.md:19`, the `grep-flags.md` entry ends today with "instead of an empty success." Append before the final period:

```
; and `.gitignore`: which tools skip what it ignores, the rule that a folder the caller names is searched even when git ignores it, and `glob`'s fixed prefix
```

Both files must end up with the same line.

- [ ] **Step 4: Commit**

```bash
git add docs/dev/stdlib/grep-flags.md docs/dev/stdlib/safe-bash.md CLAUDE.md \
  .claude/skills/agency-stdlib-docs/SKILL.md
git commit -F <message file>
```

Message: `Docs: which tools skip what .gitignore ignores, and the named-folder rule`.

### Task 8: Build, test, and open the PR

- [ ] **Step 1: Run the batch from "How to test"**

Run every command in that section once, with output in `$LOGS`. Fix all failures in one pass, then rerun only the files that failed. `make` regenerates `docs/site/stdlib/`. Commit those generated pages with the fixes.

- [ ] **Step 2: Format and check**

Run the `prettier` command from "How to test". Run `git diff --stat` and confirm that only the files this plan names changed, plus `docs/site/stdlib/`.

- [ ] **Step 3: Audit the diff against the anti-patterns**

Read `docs/dev/contributing/anti-patterns.md` and check the branch's diff against it. Fix what it finds.

- [ ] **Step 4: Commit any fixes, push, and open the PR**

```bash
git push -u origin worktree-glob-gitignore
gh pr create --title "glob and recursive ls skip what .gitignore ignores" --body-file <body file>
```

The PR body explains the trace in two or three sentences and lists the four changes. It also gives the owner these hand smoke tests. They need this branch's build, not whatever `agency` is on the path, so they start from the main checkout's `packages/agency-lang` folder and run the worktree's build:

```bash
node <worktree>/packages/agency-lang/dist/scripts/agency.js agent
```

1. Ask the agent to find files matching `**/*benchmark*`. The listing should hold no paths under `.venv-laya`, `.worktrees`, or `worktree-*`.
2. Ask it to grep for a word inside `.worktrees`. It should find matches.
3. Ask it to list `.claude/skills` with a glob pattern such as `.claude/**/SKILL.md`. It should list the skills.
4. Ask it where a function is defined inside a dependency whose code is in `dist/`. A bash `grep -rn` of the package folder now skips `dist` (see the "grep" section of `docs/dev/stdlib/safe-bash.md`). Check whether the agent reads the note and searches `dist` directly.

End the body with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`. Then stop. The owner merges.
