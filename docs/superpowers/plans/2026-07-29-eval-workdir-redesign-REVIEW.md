# Review: Eval workdir redesign — implementation plan

**Plan:** /Users/adityabhargava/agency-lang/docs/superpowers/plans/2026-07-29-eval-workdir-redesign.md
**Spec:** /Users/adityabhargava/agency-lang/docs/superpowers/specs/2026-07-29-eval-workdir-redesign-design.md (v2)
**Reviewed:** 2026-07-29, against `main` at 19b3d02b9.

## Verdict

The plan is executable as written, the task order is right (rename and closure API before the class that needs both; layout last so paths churn once), and the TDD steps contain real tests rather than ceremony. Task 3 is the load-bearing one and its `Workspace.create` is complete enough to type-check by eye.

Spec v2 also resolved every significant finding from the spec review, and did it by *cutting* rather than patching: git tracking is gone with the nested-repo failure cited as the reason and the investigated three-layer design preserved in an appendix; globs are dropped with the base-directory ambiguity named; the workdir/grader/pruning tension is recorded as an explicit constraint on the future deletion decision rather than waved off. That is the right response.

Four things need fixing before execution. One is a gap in the seed model that breaks a documented core feature; one will fail a test that no task claims to touch; one breaks the spec's own first example; one silently diverges from a rule the spec states precisely.

## Significant findings

### 1. The closure walk cannot see TypeScript imports, so TS-interop agents lose their `.js`/`.ts` files

This is the one I would fix before anything else, because it is a hole in the seed model rather than a wiring mistake.

Seeding copies "the agent's `.agency` import closure," computed by `visitFile` → `agencyImportTargets(program, { localOnly: true })`. That helper filters on `isAgencyImport` (`lib/importPaths.ts:265-271`), which is true only for `.agency` paths, `std::` imports, and `pkg::` imports. A TypeScript sibling import — `import { greet } from "./greet.js"`, the documented interop form — is **not** an agency import, so it never enters `parsedFiles` and never reaches `closureFiles`.

Today that does not matter: `copyProjectTree` copies everything, so `greet.ts` arrives incidentally. After Task 3 it does not. The generated JS still emits `import ... from "./greet.js"`, so the failure lands at run time in the subprocess as an unresolved module — inside a workdir, where the seeded-file listing added in Task 3 Step 5 will helpfully print a list that does not contain the file, and the user will be told to add it to `files`. Adding a *TypeScript helper the agent imports* to the *test's fixture files* is the wrong instruction: it belongs to the agent, not the test, and putting it in `files` would also make the test agent-specific — the exact coupling this design exists to prevent.

This is not hypothetical scale: **52 `.agency` files in this repo import a `./…​.js` sibling** (`grep -rl 'from "\.\{1,2\}/[^"]*\.js"' --include=*.agency tests examples lib/agents`), and `docs/site/guide/ts-interop.md:10` advertises the feature as "really easy: just import stuff from TypeScript and use it."

The plan needs a decision here, and it is spec-level, not plan-level. Options, roughly in order of how much I would trust them:

- Extend the closure walk to follow local non-agency relative imports too — collect `./x.js` / `./x.ts` alongside `.agency` files, resolving `.js` → `.ts` where only the source exists (the guide tells users to write `.js` even for TypeScript). This keeps "the agent's files are computed, never declared," which is the property the two-ingredient model rests on.
- Add an explicit per-agent `--agent-files` declaration. Cheaper to implement, but reintroduces hand-listing for the ingredient the design promised to compute.
- Declare TS-importing agents unsupported by seeded eval in v1 and keep them on the legacy clone path. Honest, but it means the flagship interop feature and the flagship eval feature do not compose, which is a bad thing to ship quietly.

Whichever is chosen, Task 3's failure-mode table and the "unseeded read" diagnostics should distinguish "the test forgot a fixture" from "the agent's own non-agency dependency was not seeded," because the fixes differ.

### 2. `baseOptimizer.workdir.test.ts` asserts the old seed shape and appears in no task's file list

`lib/optimize/baseOptimizer.workdir.test.ts:85` asserts:

```ts
expect(call.seed).toEqual({ dir: src, agentRelPath: "agent.agency" });
```

Task 3 changes that object to `RunSeed` — `{ baseDir, agentRelPath, closureFiles }` — which both renames `dir` → `baseDir` and adds a required field. The assertion fails deterministically. The file is named nowhere in the plan: not in the File Structure table, not in Task 3's **Files** list, and not in Task 3 Step 5's rewiring instructions.

Task 3 Step 6 runs `lib/optimize`, so it *will* surface — but as a mystery failure, and Step 6's guidance ("failures here are usually a test that relied on the full project clone") points the implementer at the wrong diagnosis. Add the file to Task 3's Files list with the expected edit.

Two sibling files are worth naming in the same breath: `lib/eval/runWorkdir.test.ts` (Task 3 says "its test file if one exists" — it does exist, so say so definitively) and `lib/cli/eval/run.workdir.test.ts`, whose three tests should survive unchanged (two are `working_dir` validation errors that the legacy `cloneDir` path preserves, one asserts the compiled entry lands inside the workdir, which stays true). Naming it as a verification target rather than a modification target is enough — but it is the file called "workdir test," and leaving it unmentioned in a workdir redesign invites a reader to assume it was missed.

### 3. A git suite whose root holds `inputs.json` fails confusingly — and that is the spec's first git example

Task 7 Step 3 resolves a git `--inputs` and then calls `loadInputs(resolved.dir, …)`. Because `resolved.dir` is a directory, that lands in `loadInputsFromDirectory`, which (after Task 5) handles exactly two shapes: subdirectories containing `test.json`, or loose `.json` files each holding **one input**.

A suite repo whose root contains a single `inputs.json` in the `{ "inputs": [...] }` wrapper form — the shape every existing suite file uses, and what `agency eval run --inputs git@github.com:egonSchiele/agency-evals.git` most plausibly points at — hits the loose-`.json` branch. `normalizeInput` then receives `{ inputs: [...] }`, finds no `goal`, and throws "Eval input goal must be a non-empty string." The user sees a goal-validation error for a file that has goals in it.

The fix is small and belongs in Task 5 or 7: when a directory contains exactly one `inputs.json` (or any single `.json` whose parsed shape has a top-level `inputs` array), treat it as the file form and delegate to `loadInputsFromFile`. Whatever the rule, it needs to exist, because the spec advertises pointing `--inputs` at a bare repo.

### 4. `nextVerifierPath` picks the first gap; the spec says highest + 1

Spec v2 line 209 is precise: `verifier-N` where "N is one more than the highest existing `verifier` or `verifier-N` directory." The plan's implementation (Task 8 Step 2) is:

```ts
let n = 2;
while (fs.existsSync(path.join(runDir, `verifier-${n}`))) n += 1;
```

That is first-gap, not highest-plus-one. With `verifier/`, `verifier-2/`, `verifier-4/` on disk (someone deleted `verifier-3`), the spec says write `verifier-5`; the plan writes `verifier-3`, reusing a slot whose absence may itself have been meaningful. Either implement the stated rule (scan all entries, take the max, add one) or change the spec — but they should not disagree, since the spec bothered to be exact.

## Moderate findings

### 5. `Workspace.run` deviates from the spec's signature, for good reasons, unrecorded

The spec sketches `ws.run(node, args, limits)` with the class owning subprocess execution. The plan's class takes an injected runner: `run(runner: EvalInputRunner, { node, args, statelogPath })`. That is the better choice — it preserves the `EvalInputRunner` seam every existing test injects, and keeps `Workspace` out of the subprocess-limits business — but the plan's "Deliberate deviations" section lists only two items and this is not one of them. Add it, with the reasoning; a reader comparing spec to plan will otherwise think the class lost a capability.

### 6. Why `sources.ts` gets its own git invoker instead of reusing `_gitRun` is left unstated

The plan is admirably firm that `sources.ts` owns "the eval layer's only git invoker," and Task 9's audit checks for exactly that. But `lib/stdlib/git.ts` already exports `_gitRun(cwd, args)`, and the plan never says why it is not reused — which is the first thing a reviewer will ask, given the anti-pattern catalog's "duplicating existing code" entry.

There is a good answer: `_gitRun` is `async`, `loadInputs` is synchronous and three call sites depend on that, and importing stdlib support code up into the eval layer inverts the dependency direction this work has been straightening. One sentence in Task 6 records the decision and inoculates the audit step.

### 7. `nextVerifierPath` creates a directory as a side effect of computing a path

The name says "path"; the function `mkdirSync`s. That also makes the `-o` and default paths behave differently in a way worth being deliberate about: with `-o`, no `verifier-N/` is created (correct, and the spec says so), but the coupling is implicit. Either rename it (`createNextVerifierDir`) or split the mkdir to the call site.

### 8. Provenance is keyed by input id, and ids can be generated

`EvalRunProvenance.files` is `Record<string, { source, sha? }>` keyed by input id. `loadInputs` assigns `makeId()` (nanoid) when a spec omits `id` (`lib/eval/loadInputs.ts:86`). So for id-less inputs the provenance keys are random per run — fine inside one `config.json`, which also records the inputs themselves, but it means provenance cannot be diffed across runs by key. Worth one sentence so nobody later treats those keys as stable identifiers.

## Minor findings

- **`Dirent.parentPath` sets a Node floor.** `listFilesRecursive` and the test's `duBytes` both use `entry.parentPath`, which exists from Node 20.12 / 21.4 (it replaced the undocumented `path`). CI builds on 22.x and 23.x so this is fine — worth a note only because it is the kind of thing that bites a contributor on an older local Node.
- **Legacy `cloneDir` mode inherits a live hazard.** It keeps `copyProjectTree` verbatim, including the self-copy guard that compares `path.relative(srcDir, destDir)` — which fails when `srcDir` is realpath-resolved and `destDir` is not (on macOS, `/private/var` vs `/var`), producing recursive copying until `ENAMETOOLONG`. I hit exactly this earlier while implementing #727. It only affects the deprecated `working_dir` path and is pre-existing, so leaving it is defensible — but a one-line comment in Task 3 noting that legacy mode carries the old hazard would stop someone "fixing" the guard mid-task.
- **The dual-layout fallback is nearly unreachable, and the plan knows it.** Task 8's note that `EvalRunInputResult` carries absolute paths is the important insight: old runs stay readable because their `summary.json` points at the old locations, so the `firstExisting` fallback only fires when `evalRecordPath` is empty (prepare failures). The plan's test forces that case deliberately, which is the right way to test it. Worth stating plainly that the spec's compatibility worry is smaller than it looked — the reader should not expect this code to run often.
- **The size guard is well-specified.** 1 MB budget matching the spec, a 2 MB junk file in the fixture project so the assertion means something, and compiled JS deliberately counted. This is the test the whole design exists to buy; good that it is concrete rather than aspirational.
- **Task 5's "subdirectories without `test.json` are ignored" test is the one I would have asked for.** It pins that a `shared-fixtures/` directory can sit beside loose inputs without being mistaken for a test.

## Claims verified against the code (all hold)

- `lib/optimize/workspace.ts:9` — `export type Workspace = { key: string }`, a cache-partition token. The rename premise is accurate.
- `lib/optimize/targets.ts:93` — `agentClosureBaseDir` walks via `visitFile` and returns only `defaultBaseDir(...)`, discarding the file list, exactly as Task 2 describes. `defaultBaseDir` takes *file* paths and maps `path.dirname` internally, so Task 2's `defaultBaseDir(files)` matches existing usage.
- `lib/eval/runWorkdir.ts` — `prepareRunDir` is synchronous and calls `compile(config, entryAgency, undefined, { importStrategy: new RunStrategy(), quiet: true })`; `resolveWithin` is there to carry over. Task 3's reproduction is faithful.
- `lib/eval/loadInputs.ts:40-48` — `loadInputsFromDirectory` reads `*.json`, sorts, and normalizes each as one input. Task 5's premise and its back-compat promise are correct.
- `lib/eval/grading/gradeRun.ts:156-157` — `workdirFor` builds `runDir/inputs/<id>/workdir`. Since `workdir/` does not move, Task 8's "verify, don't touch" is right.
- `lib/cli/schedule/index.ts:42` — `~/.agency/schedules`, so `~/.agency/cache/git` follows an existing convention rather than inventing one.
- `lib/eval/loadInputs.ts:86` — `id: typeof spec.id === "string" ? spec.id : makeId()`, which is what makes finding 8 true.
- Grading is suite-level: `gradeRun` runs once at the tail of `evalRunLoadedInputs` and produces one `Scorecard` with a `perInput` array. The plan's correction moving `verifier/` to the run root is right, and the spec's per-input sketch (spec line 201) is wrong.
- `lib/stdlib/git.ts` exports `_gitRun` (async) and `_gitIsRepo`, with no clone or cache machinery — so the resolver is genuinely new, and finding 6 is about recording a decision rather than avoiding duplication.

## Limitations of this review

I did not execute any of the plan's tests, so "will fail" in finding 2 is read from the assertion and the new type, not observed. Finding 1 is established from the import-filter source and a repo-wide grep, not by running a seeded eval against a TS-importing agent — the seeding path does not exist yet. I also did not audit what else `compile` reaches for beyond imports (an `agency.json`, a `tsconfig.json`, a `.env`); any of those would be a second instance of the same gap, and Task 3 is the place to check. I also did not review the appendix's three-layer git-tracking design, since it is explicitly out of v1 scope.

---

# Addendum: anti-pattern audit

Checked the plan's code blocks against `packages/agency-lang/docs/dev/anti-patterns.md`. The catalog's second entry — "imperative code everywhere," which asks that the "what" be split from the "how" — is violated in three places. Six other entries are hit as well.

## Imperative where it should be declarative

### A1. `parseSource` (Task 6) — order-dependent mutable state, the catalog's exact shape

`rest` is reassigned three times, `url` twice, and `subdir` is set and then possibly un-set. Reordering any two statements silently changes the result, and `looksLikeGitUrl` is called three times on a value that keeps changing underneath it:

```ts
let rest = raw;
let ref: string | undefined;
const qIdx = rest.indexOf("?ref=");
if (qIdx !== -1) { ref = rest.slice(...); rest = rest.slice(0, qIdx); ... }
if (!looksLikeGitUrl(rest) && ref === undefined) { return { kind: "local", ... }; }
const slashes = rest.indexOf("//", searchFrom);
let subdir: string | undefined;
if (slashes !== -1) { subdir = rest.slice(slashes + 2); rest = rest.slice(0, slashes); if (subdir === "") subdir = undefined; }
let url = rest;
if (!looksLikeGitUrl(rest)) { url = path.resolve(baseDir, rest); }
else if (/^github\.com\//.test(rest)) { url = `https://${rest}`; }
if (/^https:\/\/github\.com\//.test(url) && !url.endsWith(".git")) { url = `${url}.git`; }
```

The grammar in the spec is three independent peels — a ref suffix, a subdir infix, a URL normalization — so the code can say that:

```ts
/** Peel `?ref=` off the end. */
function splitRef(raw: string): { base: string; ref?: string } { … }

/** Peel `//subdir` off, skipping a scheme's own "//". */
function splitSubdir(base: string): { base: string; subdir?: string } { … }

/** A clone URL: a local path resolved, a schemeless github.com form given a
 *  scheme, a GitHub https URL given its .git suffix. */
function cloneUrl(base: string, baseDir: string): string { … }

export function parseSource(raw: string, baseDir: string): ParsedSource {
  const { base: withoutRef, ref } = splitRef(raw);
  if (ref === undefined && !looksLikeGitUrl(withoutRef)) {
    return { kind: "local", path: path.resolve(baseDir, withoutRef) };
  }
  const { base, subdir } = splitSubdir(withoutRef);
  return { kind: "git", url: cloneUrl(base, baseDir), subdir, ref, display: raw };
}
```

Every intermediate is `const`, each helper is independently testable, and the top-level function reads as the grammar. It also removes the two banned conditional spreads (see A4).

### A2. `Workspace.create` (Task 3) — one method doing five jobs

Fifty lines that branch on legacy mode, compute closure destinations, compute test-file destinations, detect collisions, copy both sets, apply overlays, and compile. `let seededFiles` is declared and then assigned in both branches — the catalog's "declare then assign" shape rather than deriving a value. Both path maps are built by mutating an empty `Record` in a `for` loop, which is the catalog's Bad example almost verbatim.

The "what" is one sentence: *a workdir is the closure plus the test files, collisions are errors, overlays win, then compile.* That can be the body:

```ts
static create(args: { workdirPath: string; seed: RunSeed; overlayFiles?: Record<string, string>; config: AgencyConfig }): Workspace {
  const seeded = plan(args.seed);                      // { rel: absSource } — pure
  rejectCollisions(seeded);                            // throws, naming both sources
  materialize(args.workdirPath, seeded);                // the only fs writes
  applyOverlay(args.workdirPath, args.overlayFiles);
  return new Workspace(args.workdirPath, compileEntry(args), Object.keys(seeded).sort());
}
```

with `plan` returning the two maps (or a merged one carrying provenance per entry, which is what `rejectCollisions` needs anyway) built declaratively:

```ts
const closureRels = Object.fromEntries(
  seed.closureFiles.map((abs) => [path.relative(seed.baseDir, abs), abs]),
);
```

This also isolates the legacy `cloneDir` branch into its own `plan` case instead of an `if` wrapped around the real logic.

### A3. `nextVerifierPath` (Task 8) — and the declarative form fixes finding 4 for free

```ts
let n = 2;
while (fs.existsSync(path.join(runDir, `verifier-${n}`))) n += 1;
```

An imperative counter that probes the filesystem once per iteration, and — per finding 4 above — implements first-gap when the spec says highest-plus-one. Read the directory once and take the max, and both problems go away together:

```ts
/** One more than the highest existing verifier dir, per the spec's rule. */
function nextVerifierNumber(runDir: string): number {
  const numbers = fs.readdirSync(runDir)
    .map((name) => (name === "verifier" ? 1 : Number(/^verifier-(\d+)$/.exec(name)?.[1])))
    .filter((n) => Number.isInteger(n));
  return numbers.length === 0 ? 1 : Math.max(...numbers) + 1;
}
```

### A4. `listFilesRecursive` — trivial, same shape

`const out: string[] = []` + `push` + `return out.sort()`, where the declarative form is one expression:

```ts
return fs.readdirSync(dir, { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isFile())
  .map((entry) => path.relative(dir, path.join(entry.parentPath, entry.name)))
  .sort();
```

(No existing repo helper duplicates this — I checked for `listFiles`/`walkDir`/recursive-readdir utilities and found none, so writing it is correct; only its shape is wrong.)

## Other catalog entries hit

### A5. "Ugly code" — the explicitly banned conditional spread

The catalog says *"Please never use this pattern"* for `...(cond ? { x } : {})`. `parseSource`'s return uses it twice:

```ts
return { kind: "git", url, ...(subdir ? { subdir } : {}), ...(ref ? { ref } : {}), display };
```

`strict` is on without `exactOptionalPropertyTypes` in this repo's `tsconfig.json`, so optional properties accept `undefined` directly — `{ kind: "git", url, subdir, ref, display }` typechecks and reads better. Task 7's `initializeEvalRun` change adds a third instance (`...(args.provenance ? { provenance: args.provenance } : {})`).

### A6. try/catch with nothing logged — twice, both in `materialize`

```ts
try { git(["fetch", "--depth", "1", "origin", parsed.ref], temp); }
catch { git(["fetch", "origin"], temp); }
```

```ts
try { fs.renameSync(temp, cacheDir); }
catch { fs.rmSync(temp, { recursive: true, force: true }); }
```

Both swallow the error entirely. The first is an intended fallback for servers that refuse arbitrary-sha fetches, but when the *fuller* fetch also fails the original reason is gone. The second treats every rename failure as "lost the race" — a permissions error or a full disk becomes a silent cache miss that recurs on every run with no explanation. Both need at least a `console.warn` with the original message; the rename one should arguably only swallow `EEXIST`/`ENOTEMPTY`.

### A7. Nested objects in type definitions, plus a shape written three times

`EvalRunProvenance` (Task 7) nests inline object types two deep and repeats `{ source: string; sha?: string }` three times:

```ts
export type EvalRunProvenance = {
  inputsSource: { source: string; sha?: string };
  files: Record<string, { source: string; sha?: string }>;
  agent: { entry: string; closure: { file: string; sha256: string }[] };
};
```

The catalog's fix is named types — which here also removes the triplication:

```ts
export type SourceProvenance = { source: string; sha?: string };
export type ClosureFile = { file: string; sha256: string };
export type AgentProvenance = { entry: string; closure: ClosureFile[] };

export type EvalRunProvenance = {
  inputsSource: SourceProvenance;
  files: Record<string, SourceProvenance>;
  agent: AgentProvenance;
};
```

`SourceProvenance` is also the type the `filesProvenance` accumulator threads through `LoadOptions`, so naming it removes an inline repeat there too.

### A8. `RunSeed` allows combinations that mean nothing

```ts
export type RunSeed = {
  baseDir: string; agentRelPath: string; closureFiles: string[];
  filesDir?: string;
  cloneDir?: string;   // "ignoring closureFiles/filesDir"
};
```

The comment concedes it: when `cloneDir` is set, two other fields are silently ignored, and `{ cloneDir, filesDir }` is representable but meaningless. A discriminated union says the same thing without the trap, and turns `Workspace.create`'s leading `if` into an exhaustive branch:

```ts
type RunSeed =
  | { kind: "seeded"; baseDir: string; agentRelPath: string; closureFiles: string[]; filesDir?: string }
  | { kind: "legacyClone"; baseDir: string; agentRelPath: string; cloneDir: string };
```

### A9. Magic numbers

`.slice(0, 24)` on the cache-key hash and `.slice(0, 50)` on the seeded-file listing are both unexplained. Named constants (`CACHE_KEY_LENGTH`, `MAX_LISTED_SEEDED_FILES`) cost a line each. The test-fixture sizes (`2 * 1024 * 1024`, `1024 * 1024`) are fine — they are the assertion's subject, stated adjacently.

### A10. Single-character names

`(c) => fs.existsSync(c)` in `firstExisting`; `for (const d of dirs.splice(0))`, `const g = (...args)`, `const r = resolveSource(...)`, `const p = parseSource(...)` across the test blocks. The catalog does not exempt tests.

### A11. Duplication the plan explicitly instructs

Task 7 Step 1: *"reuse the helper from sources.test.ts — copy it into this file."* That is a ~15-line `makeRepo` fixture copied between two test files. This repo already has the convention for the alternative — `lib/typeChecker/testUtils.ts`, `lib/debugger/testHelpers.ts`, and two more added in #727 — so `lib/eval/testUtils.ts` exporting `makeRepo` is the in-house pattern. Instructing a copy is the "duplicating existing code" entry, written into the plan on purpose.

## Not hit

No dynamic imports. No `Map`/`Set`/`interface` introductions. No nested ternaries. No unbraced one-line `if`s (the plan is consistently braced — better than the surrounding codebase). No `safeDelete` violations beyond `mkdtemp` cleanup, which is correct for paths outside a project root and matches `runArtifacts.ts`'s documented reasoning. No test whose failure is catastrophic — the destructive operations all target `mkdtemp` directories.

## Weighting

A1, A2, and A6 are worth fixing before the code is written, because they are shapes that get copied. A3 is worth fixing because it also resolves a spec divergence. A5, A7, and A8 are cheap and improve the types other tasks consume. A9–A11 are polish, except that A11 is a direct instruction to duplicate and should just be changed to point at a shared helper.
