# Export the agent's compiled modules: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an Agency program outside this package import the compiled modules of `agency agent`, so Perry can run a session program of its own that reuses them.

**Architecture:** One new entry in the `exports` map of `package.json`. Nothing in the agent changes. A new agency-js test imports two of the modules the way an outside program would and calls them.

**Tech stack:** `package.json` exports, Agency `pkg::` imports, the agency-js test runner, vitest.

**Spec:** There is no separate spec. The Background section below records the decisions from the design discussion on 2026-11-24.

## Background

### Why Perry needs this

Perry is a native Mac app whose agent is written in Agency. Today Perry has no agent code of its own. Every Perry session is a run of `lib/agents/agency-agent/program.agency`, which this package exports as `agency-lang/agent-session`. `agency agent` runs the same program. The two were tied together so that either could resume a session the other saved. A saved session is a checkpoint, and a checkpoint can be resumed only by a process that has the same compiled code for every module on its saved stack.

The owner has decided to stop sharing sessions between the two agents. In practice he never moved a session from one to the other. The cost was high: Perry could not have tools of its own, and every change to Perry's agent needed a change here, a release, and a version bump in Perry.

The next step is for Perry to own its session program. Perry will keep a copy of `core.agency` and `program.agency` in its own repo. Those two files import about 25 other modules from `lib/agents/agency-agent/`: settings, presets, compaction, the turn, the session record, and so on. Perry will not copy those. It will import them from this package, and replace them with its own code one at a time, later, as it needs to.

### What blocks that today

An Agency file imports Agency code from an npm package with the `pkg::` prefix:

```ts
import { applyEffortAnswer, askedEffort } from "pkg::agency-lang/dist/lib/agents/agency-agent/lib/session"
```

The compiler turns the part after the package name into a file path inside the package. It reads `dist/lib/agents/agency-agent/lib/session.agency` to learn what the module exports. The generated JavaScript then imports `agency-lang/dist/lib/agents/agency-agent/lib/session.js`.

The package already ships those files. `dist/lib/agents/agency-agent/` holds every module of the agent, as `.agency` source beside its compiled `.js`. But Node refuses to load a file from a package unless the package's `exports` map lists it, and the map lists only the program:

```json
"./agent-session": {
  "import": "./dist/lib/agents/agency-agent/program.js"
},
```

So the import compiles and then fails when the program runs:

```
Error [ERR_PACKAGE_PATH_NOT_EXPORTED]: Package subpath './dist/lib/agents/agency-agent/lib/session.js' is not defined by "exports"
```

### What was tried

Both of these were run on 2026-11-24 against a copy of the published 0.44.2 package, in a folder outside the package.

1. A small program imported `applyEffortAnswer`, `askedEffort` and `modelChoices` from `lib/session`, and `getResolvedSlots` from `shared`. With the map as published, it failed with the error above. With the entry this plan adds, it ran: `askedEffort()` returned `""`, then `low` after `applyEffortAnswer("low")`. It also passed the strict type checker.
2. Copies of `core.agency` and `program.agency`, with their relative imports rewritten to `pkg::` imports, compiled under the strict type checker. The session driver started that program, read its pause, sent it an `effort` answer through a JSON round trip of the pause, and read `low` back at the next pause. The only module on the saved stack was the copy of `core.agency`.

### Why the path is long

The import names the real folder, `dist/lib/agents/agency-agent/`. A shorter alias would not work. The compiler resolves `pkg::agency-lang/<subpath>` to the file `<package folder>/<subpath>.agency`, so the subpath has to be where the file is. `lib/importPaths.ts` holds that rule.

### What this export promises, and what it does not

These modules stay the agent's own. They are not a documented API, they get no generated docs, and a release may rename or remove anything in them. An outside program that imports one finds out at its next compile, because the compiler reads the module's exports from the shipped `.agency` file and reports a name that is gone.

`docs/dev/agents/session-core.md` says today that the program export "is the one public thing". Task 2 changes that sentence.

## Global constraints

- Change nothing under `lib/agents/agency-agent/`. This PR adds an export and a test.
- Do not edit `CHANGELOG.md` and do not bump the version. The owner does both at release.
- Do not hand-edit anything under `docs/site/`.
- Format only the file this PR adds, with `pnpm exec prettier --write <file>`. Do not run `pnpm run fmt:ts`: its script formats every `.ts` file in the worktree, whatever names follow it. Do not run `agency fmt` on any file.
- Save test output to a file each time you run tests, and read the file if a run fails.
- Write the commit message and the PR description in a file and pass the file to `git commit -F` and `gh pr create --body-file`.

## Review focus

1. **The export reaches every agent module, including the terminal's.** `agent.agency`, `lib/repl.agency` and `lib/trace.agency` become importable too. Loading `lib/trace.agency` registers callbacks that print every tool call. A program that imports only what it needs never loads them, and `lib/stdlib/agentSessionImports.test.ts` already keeps the session program's own imports away from them. No test in this plan covers an outside program importing one by mistake. The doc sentence in Task 2 says so.
2. **The compiler does not check this kind of import against the `exports` map.** For a `pkg::` import with a path after the package name, `toCompiledImportPath` in `lib/importPaths.ts` returns `<package>/<subpath>.js` without reading the map. The map is checked only for an import of the bare package name, through `compiledPkgEntry` and `exportsMapExposes`. That is why the failure in the Background shows only at run time. This plan does not add a compile-time check. The test in Task 1 runs the program, so it would catch a wrong entry.
3. **The shipped `.agency` files must stay beside the `.js` files.** The compiler reads `session.agency` from `dist/`. If a build change stopped copying the agent's `.agency` files into `dist/`, an outside import would fail at compile time with a file-not-found message. The test in Task 1 compiles against `dist/`, so it would catch that too.

---

### Task 1: Add the export, with a test that imports through it

**Files:**
- Modify: `package.json` (the `exports` map, next to the `./stdlib-lib/*` entry)
- Create: `tests/agency-js/agent-modules-import/agent.agency`
- Create: `tests/agency-js/agent-modules-import/test.js`
- Create: `tests/agency-js/agent-modules-import/fixture.json`
- Create: `tests/agency-js/agent-modules-import/useTestLLMProvider` (an empty file)

**Interfaces:**
- Consumes: `applyEffortAnswer(effort: string): Result<boolean>` and `askedEffort(): string`, both exported today by `lib/agents/agency-agent/lib/session.agency`.
- Produces: the package subpath `agency-lang/dist/lib/agents/agency-agent/*`. Perry's plan depends on it.

- [ ] **Step 1: Write the agency-js test, which fails today**

`tests/agency-js/agent-modules-import/agent.agency`:

```ts
import { applyEffortAnswer, askedEffort } from "pkg::agency-lang/dist/lib/agents/agency-agent/lib/session"

node main() {
  const before = askedEffort()
  const applied = applyEffortAnswer("low")
  return {
    before: before,
    applied: isSuccess(applied),
    after: askedEffort()
  }
}
```

`tests/agency-js/agent-modules-import/test.js` calls `main()` and writes `result.data` to `__result.json`, in the form `tests/agency-js/set-agent-name/test.js` uses.

`tests/agency-js/agent-modules-import/fixture.json`:

```json
{
  "before": "",
  "applied": true,
  "after": "low"
}
```

`tests/agency-js/agent-modules-import/useTestLLMProvider` is an empty file. When a test folder holds it, the test runner gives the test's process its own `AGENCY_AGENT_HOME` and deletes that folder when the test ends (`runTsTestDir` in `lib/cli/test.ts`). So the test never reads the developer's settings. Without it, a developer whose active preset sets an effort would get that effort as `before`. The marker also turns on the fake model client, which this test never calls.

The folder needs no `agency.json`, and `test.js` sets up no environment.

- [ ] **Step 2: Run it and confirm it fails for the right reason**

Run from this package's folder:

```bash
make
pnpm run agency test js tests/agency-js/agent-modules-import > /tmp/agent-modules-import-1.log 2>&1; echo $?
```

Expected: a non-zero exit, and the log holds `ERR_PACKAGE_PATH_NOT_EXPORTED`. The compiler finds the package from inside its own repo: `findPkgDir` in `lib/importPaths.ts` resolves the package's main entry and walks up to its folder, and Node lets a package import itself by name.

- [ ] **Step 3: Add the entry**

In `package.json`, directly after the `"./stdlib-lib/*"` line:

```json
"./dist/lib/agents/agency-agent/*": "./dist/lib/agents/agency-agent/*",
```

- [ ] **Step 4: Run the test and confirm it passes**

```bash
pnpm run agency test js tests/agency-js/agent-modules-import > /tmp/agent-modules-import-2.log 2>&1; echo $?
```

Expected: `0`.

- [ ] **Step 5: Confirm the existing program export still works**

```bash
pnpm run agency test js tests/agency-js/session-core-handoff > /tmp/session-core-handoff.log 2>&1; echo $?
```

Expected: `0`. That test imports `agency-lang/agent-session`, the entry directly above the new one.

- [ ] **Step 6: Format and commit**

```bash
pnpm exec prettier --write tests/agency-js/agent-modules-import/test.js
git add package.json tests/agency-js/agent-modules-import
git status --short tests/agency-js/agent-modules-import
git commit -F <message file>
```

The status must list four added files: `agent.agency`, `test.js`, `fixture.json` and `useTestLLMProvider`. The repo's `.gitignore` ignores every `.js` file except one named `test.js`, and `git add` skips an ignored file without a warning. The compiled `agent.js` is ignored on purpose.

### Task 2: Say what the export is in the dev doc

**Files:**
- Modify: `docs/dev/agents/session-core.md` (the two sentences that start "The export is the one public thing")

**Interfaces:**
- Consumes: the subpath from Task 1.
- Produces: nothing a later task uses.

- [ ] **Step 1: Delete the two sentences, and add a section**

Delete these two sentences, which end the section `## Why a session can cross`:

```
The export is the one public thing. The modules behind it are the agent's
own and can change.
```

Then add a new section between `## Why a session can cross` and `## The interface`. Its heading is `## The agent's modules, from outside the package`, and its text is:

```
The package also exports every compiled module of the agent, by its real
path:

    import { askedEffort } from "pkg::agency-lang/dist/lib/agents/agency-agent/lib/session"

A program outside the package can import them to build a session program
of its own. The path must be the real folder, because a `pkg::` import
resolves the part after the package name to a file in the package.

These modules are the agent's own, with the same standing as the files
under `agency-lang/stdlib-lib/`. They have no generated docs, and any
release can rename or remove a function in them. The importing program
learns of it at its next compile. Moving the agent's folder, in the
source or in `dist/`, breaks every such import.

Perry imports these modules from its own copy of the core. The import
list at the top of `src/agency/core.agency` in the Perry repo shows
which functions it uses.

Import only the modules the program needs. Loading one of the terminal's
modules, such as `lib/trace.agency`, registers callbacks that print to the
terminal for every run in the process.
```

- [ ] **Step 2: Run the structural linter**

```bash
pnpm run lint:structure > /tmp/lint-structure.log 2>&1; echo $?
```

Expected: `0`. The doc is already in the index in `CLAUDE.md`, so no index line changes.

- [ ] **Step 3: Commit**

```bash
git add docs/dev/agents/session-core.md
git commit -F <message file>
```

## After this PR

The owner merges it and publishes a release. Perry's plan, `docs/superpowers/plans/2026-11-24-own-session-program.md` in the Perry repo, starts by moving Perry to that release.
