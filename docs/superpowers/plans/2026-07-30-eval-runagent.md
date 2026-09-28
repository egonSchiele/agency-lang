# runAgent + runTypes Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Plan v2** — incorporates the sibling `-REVIEW` file. Resolution of its findings, in one place:
- **Must-fix 1 (two unknown behavior changes):** `AgentRun` gains a third arm, `"no-record"`, so a clean exit with nothing to extract stays a suite-level success exactly as today; extractor crashes get their own message on the error arm instead of masquerading as "no statelog". The deliberate-delta list is now exactly one item (failed runs extract when a statelog exists).
- **Must-fix 2 (Agency-side mirror):** `stdlib/agency/eval.agency` is in Tasks 1–2 (remove `working_dir`, rename `agent`), with `make` + `make doc` steps and widened staging. **Deliberately NOT adding `files` to the Agency `Input`** (reviewer's adjacent-bug suggestion): the stdlib run path does no seeding, so advertising the field would be a lie; wiring fixtures into the stdlib path is named Level-2 work in the spec instead.
- **Must-fix 3:** `projectTree.test.ts` deleted with its implementation; `runArtifacts.test.ts` comment; all **three** `working_dir` spots in `eval.md` including the line-33 example JSON.
- **Altitude 1:** owner decided **`lib/eval/run/`** — `runAgent` is a library primitive; `lib/cli/eval/run.ts` stays the thin command. `shouldExtractStatelog` also moves into `run/extract.ts` so the atom depends only downward/sideways.
- **Altitude 2:** the stdlib's own prepare/finalize pipeline is named in Out of Scope as the second run path Level 2 must absorb; `runEvalInput`'s stale "single source of truth / both CLI and stdlib route through this" claim dies with the file and is not carried into `runAgent`'s header.
- **Gaps:** `extractor` added to the suite options' Produces list with the correct `overrides.extractor ?? opts.extractor` precedence; `runAgent`'s option is `seed?` ("computed when omitted") while the suite-level option stays `precomputedSeed` (optimizer-only, where the name is true); `toInputResult` reads paths off `prepared` instead of recomputing; `pipeOutput` defaults `true` at both layers; no conditional spread (ternary-to-undefined); unused `baseDir` binding removed; Task 5's zero-behavior claim now stated precisely (no *assertion* changes; imports/keys do change).
- **Kept against the review, deliberately:** `runDir` stays the name on the atom's API — for a single `runAgent` call it genuinely is *the run's directory*; the doc comment now says a suite allocates one per input (`runs/<suiteId>/inputs/<inputId>/`). Flagged here so the owner can veto with one word.
- **Coverage notes the review asked for:** `docs/site/cli/optimize.md` contains no `working_dir` (checked — nothing to do); the spec's "explicit working_dir error" test is dropped because the owner's no-shims decision superseded it.

**Goal:** Make "run one agent, once, and collect its output" a single readable building block — `runAgent(agentPath, node, args, options)` composed from one-concept files — and clear the runTypes dead weight (`working_dir`, `agent`→`agentLabel`, `inputsSource`, dead `EvalRunConfig`).

**Architecture:** Level 1 of the three-layer frame. `lib/eval/run/` gains `seed.ts`, `subprocess.ts`, `extract.ts`, `runAgent.ts`; the `Workspace` class dissolves into plain-verb functions; the suite loop becomes a thin loop over `runAgent` with no behavior change beyond the one named delta.

**Tech Stack:** TypeScript, Node, vitest. No new dependencies.

**Spec:** `/Users/adityabhargava/agency-lang/docs/superpowers/specs/2026-07-30-eval-cleanups-design.md` (Changes 1–5, 7, 8; Change 6 deferred to Level 2 by name).

## Global Constraints

- **Worktree + branch:** `git worktree add worktree-eval-runagent -b adit/eval-runagent origin/main` inside `packages/agency-lang`. Never commit to `main`; re-check the branch every commit.
- **Owner ground rules:** no backward compatibility anywhere; "objective" stays; his main-checkout edits are review notes — supersede, don't merge.
- **Build rules:** fresh worktree needs `pnpm install` + one setup `make`. Tasks 1 and 2 edit `stdlib/agency/eval.agency`, so **each of those tasks runs `make` (stdlib change — the named exception) and `make doc`** (regenerates `docs/site/stdlib/agency/eval.md`). All other tasks are TypeScript-only: at most `pnpm run build`, never `make`.
- **Staging:** `git add -A packages/agency-lang` in every task (Tasks 1–2 touch `stdlib/` and generated `docs/`, which `…/lib` would silently miss).
- **Commit messages via file** (`git commit -F /tmp/commitmsg.txt`); test output to a file then grep (`grep -E "FAIL|Tests " | grep -v worktree`); scope test runs; `pnpm run typecheck` + `pnpm run lint:structure` before every commit.
- Anti-patterns to actively avoid: multiple concepts per file; near-identical shapes; metaphor names; conditional spreads; single-char names; unlogged catches.
- **Out of scope:** Level-2/3 redesign (`evaluate`/`evaluateSuite`, suite option renames, `EvalRunResult` restructure, `okCount`/`errorCount`); the empty-suite guard; `agency eval judge`; **the stdlib's second run pipeline** — `lib/stdlib/agencyEval.ts` `_prepareInput`/`_finalizeInput` re-implement prepare/extract for Agency callers and must eventually fold onto `run/extract.ts`; that absorption (and giving the Agency `Input` a working `files` field) is Level-2 work, recorded in the spec.

---

## File Structure

**Created (all under `packages/agency-lang/`):**

| File | Responsibility |
|---|---|
| `lib/eval/run/seed.ts` | Which files go into the run directory, and putting them there: `AgentSeed`, `seedFromAgentFile`, `filesToCopy` (pure), `copyFiles`, `applyOverlay`, `compileAgent`. |
| `lib/eval/run/seed.test.ts` | Seeding tests (adapted from `workspace.test.ts`). |
| `lib/eval/run/subprocess.ts` | Fork the compiled agent, wire statelog, answer interrupt IPC, enforce limits. Owns `DEFAULT_EVAL_RUN_LIMITS`, `evalInterruptDecision`, `EvalInputRunner`. |
| `lib/eval/run/extract.ts` | Statelog → record: both extractors, `shouldExtractStatelog` (moved here — it is an extract concern), and `agentRunPaths(runDir)` — the one written-down copy of the inside-a-run-directory layout. |
| `lib/eval/run/runAgent.ts` | The atom. Never throws; three-arm result. |
| `lib/eval/run/runAgent.test.ts` | Success, no-record, error, extractor-crash, seed-listing, collision-as-result. |

**Modified:**

| File | Change |
|---|---|
| `lib/eval/runTypes.ts` | Delete `Input.working_dir` + `EvalRunConfig`; `agent` → `agentLabel`; `node` doc fix. |
| `stdlib/agency/eval.agency` | Delete `working_dir` from the Agency `Input`; `agent` → `agentLabel` on the Agency `EvalRunResult`. (`make` + `make doc` regenerate `docs/site/stdlib/agency/eval.md`.) |
| `lib/eval/loadInputs.ts` | `working_dir` validation/resolution gone. |
| `lib/eval/runArtifacts.ts` | `agentLabel`; `inputsSource` removed; per-input paths + `shouldExtractStatelog` come from `./run/extract.js`. |
| `lib/eval/readRun.ts` | Its `firstExisting` fallback reads the current-layout paths from `agentRunPaths` instead of restating them. |
| `lib/eval/workspace.ts` + test, `lib/eval/runEvalInput.ts`, `lib/utils/projectTree.ts` + test | **Deleted.** |
| `lib/cli/eval/run.ts` | Sheds subprocess/extract/seed/limits to `lib/eval/run/`; loop calls `runAgent`; `working_dir` branch gone; `validateInputSelection` = owner's shape + neither-flag error; gains `extractor?` option. |
| `lib/optimize/baseOptimizer.ts` | `working_dir` stripping gone; `seed:` → `precomputedSeed:`; extractor via `opts.extractor`; `inputsSource` → provenance. `RunInput` seam unchanged. |
| `lib/stdlib/agencyEval.ts` | `agentLabel`; `inputsSource` arg dropped; `shouldExtractStatelog` import path follows the move. |
| `lib/analysis/closure.ts` | `uniqueSorted`; `ParsedSourceFile` two-consumer doc. |
| Tests | `run.workdir.test.ts`, `run.test.ts` (imports + option keys only, no assertion changes), `loadInputs.test.ts`, `baseOptimizer.workdir.test.ts`, `runArtifacts.test.ts` (comment), fixture `agent:` keys. |
| `docs/site/cli/eval.md` | All three `working_dir` mentions removed (deprecation sentence, prose, and the line-33 example input JSON). |

Task order unchanged from v1: cleanup ×2, pure moves, build-beside, rewire, polish. Old and new seeding coexist only between Tasks 4 and 5.

---

### Task 1: Remove `working_dir` (both languages), `EvalRunConfig`, and `projectTree.*`

**Files:**
- Modify: `lib/eval/runTypes.ts`, `stdlib/agency/eval.agency`, `lib/eval/loadInputs.ts`, `lib/cli/eval/run.ts`, `lib/eval/workspace.ts`, `lib/optimize/baseOptimizer.ts`, `lib/eval/runArtifacts.ts` (comment), `lib/eval/runArtifacts.test.ts` (comment)
- Delete: `lib/utils/projectTree.ts` **and** `lib/utils/projectTree.test.ts`
- Tests: `run.workdir.test.ts`, `workspace.test.ts`, `loadInputs.test.ts`, `baseOptimizer.workdir.test.ts`

**Interfaces:**
- Produces: `RunSeed` collapses to `{ baseDir; agentRelPath; closureFiles; filesDir? }` (no `kind`; Task 4 renames it `AgentSeed`). `Input` has no `working_dir` in either language. `EvalRunConfig` gone.

- [ ] **Step 1: Worktree setup**

```bash
cd /Users/adityabhargava/agency-lang/packages/agency-lang
git fetch origin main --quiet
git worktree add worktree-eval-runagent -b adit/eval-runagent origin/main
cd worktree-eval-runagent && pnpm install --frozen-lockfile > /tmp/install.log 2>&1
cd packages/agency-lang && make > /tmp/make.log 2>&1; echo "setup make=$?"
```

- [ ] **Step 2: TypeScript side**

Exactly as plan v1: delete `Input.working_dir` and `EvalRunConfig` from `runTypes.ts` (fixing the `node` doc comment: "Overrides the node named by the `--agent file:node` target, which itself defaults to `main`"); delete the three `working_dir` pieces from `loadInputs.ts`; collapse the union and delete `LegacyCloneSeed`/`cloneLegacy`/the `copyProjectTree` import in `workspace.ts`; in `run.ts` delete the whole `working_dir` branch of `resolveInputSeed` plus the `callerSetSeed` throw and fold the two surviving lines into the loop (`const seed = input.files ? { ...defaultSeed, filesDir: input.files } : defaultSeed;`); in `baseOptimizer.ts` delete the `working_dir: undefined` stripping and the `kind: "seeded"` literal line; drop the stale `working_dir` comments in `runArtifacts.ts` **and** `runArtifacts.test.ts:100-104`.

```bash
git rm lib/utils/projectTree.ts lib/utils/projectTree.test.ts
```

- [ ] **Step 3: Agency side**

In `stdlib/agency/eval.agency`, delete the `working_dir?: string;` line from the exported `Input` type (~line 67) and any docstring mention of it in the same file. Do **not** add `files` — the stdlib run path does no seeding, so the field would be advertised and ignored (Level-2 work, per Out of Scope). Then:

```bash
make > /tmp/make1.log 2>&1; echo "make=$?"        # stdlib .agency changed — the named exception
make doc > /tmp/makedoc1.log 2>&1; echo "doc=$?"  # regenerates docs/site/stdlib/agency/eval.md
grep -n "working_dir" docs/site/stdlib/agency/eval.md; echo "expect: no hits"
```

- [ ] **Step 4: Tests that exercised deleted behavior** — as plan v1 (delete the two `working_dir` tests in `run.workdir.test.ts` and the seed `kind` keys; delete the legacy-clone test in `workspace.test.ts`; delete the `files`+`working_dir` exclusion test in `loadInputs.test.ts`; in `baseOptimizer.workdir.test.ts` drop `kind` from the seed assertion and delete the `working_dir).toBeUndefined()` assertion).

- [ ] **Step 5: Verify and commit**

```bash
grep -rn "working_dir\|copyProjectTree\|EvalRunConfig" lib stdlib scripts --include='*.ts' --include='*.agency' | grep -v worktree; echo "expect: none"
npx vitest run lib/eval lib/cli/eval lib/optimize lib/utils > /tmp/t1.txt 2>&1
grep -E "FAIL|Tests " /tmp/t1.txt | grep -v worktree
pnpm run typecheck && pnpm run lint:structure
cd ../..
git add -A packages/agency-lang
printf 'eval: remove working_dir (both languages), dead EvalRunConfig, projectTree\n\nworking_dir predates the two-ingredient seed: a wholesale-cloned directory\nthat had to CONTAIN the agent, tying a test to one agent. Nothing uses it\n(owner: sole user of the project), so it goes without ceremony from the\nTypeScript Input, the Agency Input in stdlib/agency/eval.agency, and the\ngenerated stdlib docs. With it go the legacy clone path (RunSeed collapses\nto one shape), projectTree.ts + its test (this was copyProjectTree'"'"'s last\nconsumer), and EvalRunConfig (zero constructors, zero readers).\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>\n' > /tmp/commitmsg.txt
git commit -F /tmp/commitmsg.txt
```

---

### Task 2: `agent` → `agentLabel` (both languages); `inputsSource` → provenance only

**Files:**
- Modify: `lib/eval/runTypes.ts`, `stdlib/agency/eval.agency`, `lib/eval/runArtifacts.ts`, `lib/cli/eval/run.ts`, `lib/optimize/baseOptimizer.ts`, `lib/stdlib/agencyEval.ts`
- Tests: fixture `agent:` keys (`gradeRun.test.ts`, `grade.test.ts`, `readRun.test.ts`); `inputsSource:` call sites (`run.test.ts`, `run.workdir.test.ts`, optimizer tests, `agencyEval.test.ts`)

**Interfaces:**
- Produces: `EvalRunResult.agentLabel` (+ same key in `summary.json`/`config.json` and the Agency `EvalRunResult`). `EvalRunLoadedInputsOptions` loses `inputsSource`; origin flows through the existing optional `provenance` (fallback `{ source: "unspecified" }`). `initializeEvalRun` loses the arg. Unchanged: `EvalRunLoadedInputsOptions.agent` (it names the agent target, truthfully).

- [ ] **Step 1: TypeScript renames + removal** — as plan v1 (runTypes doc'd `agentLabel`; `runArtifacts` state/arg/JSON keys; `run.ts` call site; `agencyEval.ts` label; the three test fixtures; delete `EvalRunState.inputsSource` + arg + config key; `run.ts` fallback `inputsSource: opts.provenance?.inputsSource ?? { source: "unspecified" }`; optimizer passes `provenance: { inputsSource: { source: "optimize" }, files: {} }`; stdlib and test call sites drop the argument).

- [ ] **Step 2: Agency side + regeneration**

In `stdlib/agency/eval.agency`, rename `agent: string;` → `agentLabel: string;` on the exported `EvalRunResult` (~line 82), updating any docstring that names it. Then `make` + `make doc`; verify:

```bash
grep -n "agentLabel" docs/site/stdlib/agency/eval.md | head -2; grep -rn '\binputsSource\b' lib stdlib --include='*.ts' --include='*.agency' | grep -v provenance | grep -v worktree; echo "expect: agentLabel hit, no inputsSource hits"
```

- [ ] **Step 3: Verify and commit**

```bash
npx vitest run lib/eval lib/cli/eval lib/optimize lib/stdlib/agencyEval.test.ts > /tmp/t2.txt 2>&1
grep -E "FAIL|Tests " /tmp/t2.txt | grep -v worktree
pnpm run typecheck && pnpm run lint:structure
cd ../..
git add -A packages/agency-lang
printf 'eval: agent renamed agentLabel in both languages; inputsSource folded into provenance\n\nThe field holds a display label ("<path>:<node>"), not a path or a name -\nnow it says so, in the TypeScript type, the Agency type, and the generated\ndocs. Input origin was recorded twice; the free-text inputsSource is gone\nand provenance.inputsSource (with the resolved sha) is the single record,\nfalling back to an explicit "unspecified".\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>\n' > /tmp/commitmsg.txt
git commit -F /tmp/commitmsg.txt
```

---

### Task 3: Extract `lib/eval/run/subprocess.ts` and `lib/eval/run/extract.ts` (pure moves)

**Files:**
- Create: `lib/eval/run/subprocess.ts`, `lib/eval/run/extract.ts`
- Modify: `lib/cli/eval/run.ts` (deletions + imports), `lib/eval/runEvalInput.ts` (type re-imports), `lib/eval/runArtifacts.ts` (paths + `shouldExtractStatelog` move out), `lib/eval/readRun.ts` (fallbacks read `agentRunPaths`), `lib/stdlib/agencyEval.ts` (`shouldExtractStatelog` import path)

**Interfaces:**
- Produces:

```ts
// lib/eval/run/subprocess.ts
export const DEFAULT_EVAL_RUN_LIMITS: RunLimits;                                  // moved, TODO intact
export function evalInterruptDecision(interruptId: string): IpcDecisionMessage;   // moved
export type EvalInputRunner = /* moved verbatim from runEvalInput.ts */;
export function makeSubprocessRunner(pipeAgentOutput: boolean): EvalInputRunner;  // was makeSubprocessEvalInputRunner

// lib/eval/run/extract.ts
export type EvalRecordExtractor = /* moved verbatim */;
export const defaultEvalRecordExtractor: EvalRecordExtractor;                     // moved
export const optimizeEvalRecordExtractor: EvalRecordExtractor;                    // moved
export function shouldExtractStatelog(statelogPath: string): boolean;             // moved from runArtifacts.ts
/** The one place the inside-a-run-directory layout is written down. */
export function agentRunPaths(runDir: string): {
  agentDir: string; statelogPath: string; evalRecordPath: string; errorPath: string; workdirPath: string;
};
```

- [ ] **Step 1: The moves** — as plan v1, plus: `shouldExtractStatelog` moves from `runArtifacts.ts` to `extract.ts` (it decides whether extraction happens — an extract concern); `runArtifacts.ts`, `runEvalInput.ts`, and `lib/stdlib/agencyEval.ts` update their imports. `prepareInput` spreads `agentRunPaths(inputDir)` instead of building five paths inline (`inputJsonPath` stays — `input.json` is a suite concept).

- [ ] **Step 2: Point `readRun.ts` at the layout authority** (review suggestion, adopted): its `firstExisting` current-layout candidates come from `agentRunPaths(inputDir)` — the legacy flat-path fallbacks stay as literals, labeled `// pre-#733 layout`.

- [ ] **Step 3: Verify (pure move ⇒ everything passes untouched), commit**

```bash
npx vitest run lib/eval lib/cli/eval lib/optimize > /tmp/t3.txt 2>&1
grep -E "FAIL|Tests " /tmp/t3.txt | grep -v worktree
pnpm run typecheck && pnpm run lint:structure
cd ../..
git add -A packages/agency-lang
printf 'eval: subprocess and extract each get their own file under lib/eval/run/\n\nPure moves out of the blended CLI conductor, per review - and per the\nlayering decision, into the eval library rather than under cli/: runAgent\nis a primitive the suite, grading, and optimizer compose over, and the\ncommand file stays a thin flag-parser. agentRunPaths is the single\nwritten-down copy of the run-directory layout; runArtifacts and readRun\nnow read it instead of restating it.\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>\n' > /tmp/commitmsg.txt
git commit -F /tmp/commitmsg.txt
```

---

### Task 4: `lib/eval/run/seed.ts` and `runAgent.ts` — the new bricks

**Files:**
- Create: `lib/eval/run/seed.ts`, `seed.test.ts`, `runAgent.ts`, `runAgent.test.ts`

**Interfaces:**
- Consumes: `agentClosure`; `compile`/`RunStrategy`; `makeSubprocessRunner`/`EvalInputRunner` from `./subprocess.js`; `defaultEvalRecordExtractor`/`EvalRecordExtractor`/`shouldExtractStatelog`/`agentRunPaths` from `./extract.js`.
- Produces:

```ts
// lib/eval/run/seed.ts — rename table identical to plan v1:
//   RunSeed→AgentSeed, planSeed→filesToCopy, materialize→copyFiles,
//   compileEntry→compileAgent, deriveSeedFromAgent(run.ts)→seedFromAgentFile,
//   applyOverlay/resolveWithin/listFilesRecursive/PROJECT_CONFIG_FILES unchanged,
//   SeedEntry exported, seedFromPlan dissolves into the visible recipe.

// lib/eval/run/runAgent.ts
export type RunAgentOptions = {
  /** The directory for THIS run — records land in <runDir>/agent/, the agent
   *  executes in <runDir>/workdir/. A suite allocates one per input
   *  (runs/<suiteId>/inputs/<inputId>/). */
  runDir: string;
  config: AgencyConfig;
  seedFiles?: string;                      // the test's fixture directory
  overlayFiles?: Record<string, string>;   // optimizer candidate edits, applied last
  /** Computed from the agent when omitted. Supply it to reuse one closure
   *  walk across many runs, or to pin runs to a discovery-time file view
   *  (the optimizer does both). */
  seed?: AgentSeed;
  /** Pipe the agent's stdout/stderr through this process. Default true. */
  pipeOutput?: boolean;
  extractor?: EvalRecordExtractor;         // the optimizer passes its warning-free one
};
export type RunAgentDeps = { runner?: EvalInputRunner };   // test seam

export type AgentRun =
  /** Ran and was recorded: the normal case. */
  | { status: "success";   output: unknown;      record: EvalRecord;  runDir: string; workdir: string }
  /** Exited cleanly but there is nothing to extract (empty/missing statelog,
   *  or the extractor wrote no record). Suites count this as ok, exactly as
   *  before; grading later reports the missing record — unchanged behavior. */
  | { status: "no-record";                                            runDir: string; workdir: string }
  /** Crashed, failed to seed/compile, or the extractor itself blew up.
   *  error.txt is on disk; record present when a statelog was salvageable. */
  | { status: "error";     errorMessage: string; record?: EvalRecord; runDir: string; workdir: string };

export async function runAgent(
  agentPath: string, node: string, args: Record<string, any>,
  options: RunAgentOptions, deps?: RunAgentDeps,
): Promise<AgentRun>;   // never throws
```

- [ ] **Step 1: Failing seed tests** — as plan v1 (the seven behaviors from `workspace.test.ts` minus class/legacy, called as functions, plus the "filesToCopy is pure" test). Run → `Cannot find module './seed.js'`.

- [ ] **Step 2: Write `seed.ts`** per the rename table; seed tests → PASS.

- [ ] **Step 3: Failing runAgent tests** — plan v1's three (recipe/cwd/statelog-location; seedFiles + failed-run seed-listing + error.txt; collision-as-result — with the unused `baseDir` binding removed), **plus three pinning the review's must-fix-1 semantics:**

```ts
  it("a clean exit with an empty statelog is no-record, not an error (suite counts it ok)", async () => {
    const { agentPath } = makeAgentProject();
    const run = await runAgent(agentPath, "main", {}, { runDir: path.join(tmp(), "r"), config: {} }, {
      runner: async () => ({ ok: true }),           // writes no statelog at all
    });
    expect(run.status).toBe("no-record");
  });

  it("an extractor crash is an error carrying the extractor's message, not 'no statelog'", async () => {
    const { agentPath } = makeAgentProject();
    const run = await runAgent(agentPath, "main", {}, {
      runDir: path.join(tmp(), "r"), config: {},
      extractor: async () => { throw new Error("extractor exploded"); },
    }, {
      runner: async ({ statelogPath }) => { fs.writeFileSync(statelogPath, "{}\n"); return { ok: true }; },
    });
    expect(run.status).toBe("error");
    if (run.status === "error") {
      expect(run.errorMessage).toMatch(/extractor exploded/);
    }
  });

  it("an extractor that runs but writes no record file is no-record (matches today's stub-extractor tests)", async () => {
    const { agentPath } = makeAgentProject();
    const run = await runAgent(agentPath, "main", {}, { runDir: path.join(tmp(), "r"), config: {}, extractor: async () => {} }, {
      runner: async ({ statelogPath }) => { fs.writeFileSync(statelogPath, "{}\n"); return { ok: true }; },
    });
    expect(run.status).toBe("no-record");
  });
```

Run → `Cannot find module './runAgent.js'`.

- [ ] **Step 4: Write `runAgent.ts`**

The recipe as in plan v1, with the extract tail replaced by the three-way logic. `tryExtract` returns a small union so "nothing" and "blew up" cannot be conflated:

```ts
type ExtractResult =
  | { kind: "record"; record: EvalRecord }
  | { kind: "nothing" }                          // no/empty statelog, or extractor wrote no file
  | { kind: "failed"; errorMessage: string };    // the extractor itself threw

async function tryExtract(
  statelogPath: string, evalRecordPath: string,
  extractor: EvalRecordExtractor, input: Record<string, any>,
): Promise<ExtractResult> { … }
```

and the tail of `runAgent`:

```ts
  const statelogPath = adoptStatelogFallback(paths, result);
  const extracted = await tryExtract(statelogPath, paths.evalRecordPath, extractor, args);

  if (!result.ok) {
    const record = extracted.kind === "record" ? extracted.record : undefined;
    return fail(withSeedListing(result.errorMessage, seededFiles), record);
  }
  if (extracted.kind === "failed") {
    return fail(`eval-record extraction failed: ${extracted.errorMessage}`);
  }
  if (extracted.kind === "nothing") {
    return { status: "no-record", runDir: options.runDir, workdir: paths.workdirPath };
  }
  return { status: "success", output: lastOutput(extracted.record), record: extracted.record,
           runDir: options.runDir, workdir: paths.workdirPath };
```

Behavior contract, spelled out: **no-record on the success path is not an error** (today's semantics, pinned by the new tests — clean exit + `shouldExtractStatelog` false, or extractor wrote nothing); **extractor throw is an error with the extractor's message** (today's semantics); **the one deliberate delta remains**: a *failed* run still attempts extraction so a crash after useful work keeps its record.

Run runAgent tests → PASS.

- [ ] **Step 5: Typecheck, lint, commit** (message as plan v1, adjusted for the three-arm result: "…returns a three-arm result: success carries the output and parsed record; no-record is a clean exit with nothing to extract, which suites keep counting as ok; error carries the message — including the extractor's own, when extraction is what failed — with error.txt on disk.").

---

### Task 5: Rewire the suite loop; delete the old files

**Files:**
- Modify: `lib/cli/eval/run.ts`, `lib/optimize/baseOptimizer.ts`
- Delete: `lib/eval/workspace.ts`, `lib/eval/workspace.test.ts`, `lib/eval/runEvalInput.ts`
- Tests: `run.test.ts` + `run.workdir.test.ts` — **imports and option keys only** (`EvalInputRunner`/`EvalRecordExtractor` now from `@/eval/run/…`; `seed:` → `precomputedSeed:`); **no assertion changes** — that, precisely, is the zero-behavior-change proof.

**Interfaces:**
- Produces:
  - `EvalRunLoadedInputsOptions.precomputedSeed?: AgentSeed` — the optimizer's discovery-time closure; here the name is true (the CLI path never sets it).
  - `EvalRunLoadedInputsOptions.extractor?: EvalRecordExtractor` — **new field** (this is an interface change): the optimizer's warning-free extractor arrives as a real option instead of through the test-override parameter. Precedence everywhere: `overrides.extractor ?? opts.extractor ?? defaultEvalRecordExtractor` (the test seam wins, then the caller, then the default) — `runAgent` receives it as its `extractor` option.
  - `EvalRunInputResult` and the optimizer's `RunInput` seam: unchanged.

- [ ] **Step 1: The loop**

```ts
  const defaultSeed = opts.precomputedSeed ?? seedFromAgentFile(target.agentFile);   // one walk per suite
  …
  for (const input of opts.inputs) {
    const prepared = prepareInput(state, input);            // try/catch → recordInputPrepareFailure, as today
    const run = await runAgent(target.agentFile, input.node ?? target.node, input.args, {
      runDir: prepared.inputDir,
      config,
      seedFiles: input.files,
      overlayFiles: opts.overlayFiles,
      seed: defaultSeed,                                    // reuse the one walk (see runAgent's seed doc)
      pipeOutput: opts.pipeAgentOutput ?? true,
      extractor: overrides.extractor ?? opts.extractor,
    }, { runner: overrides.runner });
    results.push(toInputResult(input, prepared, run));
    if (run.status === "error" && !continueOnError) break;
  }
```

with the adapter reading paths off `prepared` (no recomputation) and mapping `no-record` to the suite's `"success"` (today's vocabulary — `readEvalRun` later reports the missing record, unchanged):

```ts
/** An AgentRun in the suite's per-input vocabulary. */
function toInputResult(input: Input, prepared: PreparedInput, run: AgentRun): EvalRunInputResult {
  return {
    inputId: input.id ?? "",
    status: run.status === "error" ? "error" : "success",
    evalRecordPath: prepared.evalRecordPath,
    statelogPath: prepared.statelogPath,
    workdirPath: prepared.workdirPath,
    errorMessage: run.status === "error" ? run.errorMessage : undefined,
  };
}
```

(No conditional spread; `errorMessage: undefined` on success arms is dropped by `JSON.stringify` in the summary, same as today.)

- [ ] **Step 2: Optimizer + deletions** — `baseOptimizer.ts`: `seed:` → `precomputedSeed:`; move `optimizeEvalRecordExtractor` from the `overrides` argument to `opts.extractor`. Delete the three files; chase stragglers:

```bash
git rm lib/eval/workspace.ts lib/eval/workspace.test.ts lib/eval/runEvalInput.ts
grep -rn "runEvalInput\|workspace.js\|\bRunSeed\b" lib scripts --include='*.ts' | grep -v worktree; echo "expect: none"
```

The stale "single source of truth / both the CLI and the stdlib route through this" doc dies with `runEvalInput.ts` — `runAgent`'s header does **not** inherit the claim (the stdlib path is a second pipeline until Level 2 absorbs it).

- [ ] **Step 3: Adapt imports/keys in the two test files, run everything, commit** (message as plan v1's Task 5, plus one line: "no-record runs keep counting as ok, exactly as before").

```bash
npx vitest run lib/eval lib/cli/eval lib/optimize > /tmp/t5.txt 2>&1
grep -E "FAIL|Tests " /tmp/t5.txt | grep -v worktree
pnpm run typecheck && pnpm run lint:structure
cd ../.. && git add -A packages/agency-lang && git commit -F /tmp/commitmsg.txt
```

---

### Task 6: Closure readability, `validateInputSelection`, docs, audit, PR

As plan v1 (`uniqueSorted` + `ParsedSourceFile` two-consumer doc; owner's `validateInputSelection` shape + the restored neither-flag error), with the docs step corrected per review:

- [ ] **Step 1–2:** closure + validateInputSelection, as v1.
- [ ] **Step 3: Docs** — `docs/site/cli/eval.md`: all **three** `working_dir` spots — the deprecation sentence (~line 37), the prose mention (~line 94), and the example input JSON (~line 33) which still shows `"working_dir": "./fixtures/empty-project"` as a live field (replace the example with a `files` one). `docs/site/cli/optimize.md`: verified clean, nothing to do.
- [ ] **Step 4: Audit + full check** — as v1, adding to the checklist: no file under `lib/eval/run/` imports from `lib/cli/`; `agentRunPaths` has no competing restatement left (`grep -rn 'agent", "statelog\|"agent", "eval-record' lib` should hit only `extract.ts` and `readRun.ts`'s labeled legacy literals).
- [ ] **Step 5: Commit, push, PR** — PR body additionally names: the three-arm `AgentRun` and why no-record exists (review caught the silent flip); the `lib/eval/run/` layering decision; the stdlib second pipeline as named Level-2 debt; the single deliberate delta.

---

## Self-Review

**Review disposition:** must-fix 1 → the `"no-record"` arm + `ExtractResult` union + three pinning tests (Task 4); must-fix 2 → `stdlib/agency/eval.agency` in Tasks 1–2 with `make`/`make doc` and widened staging, `files`-field addition explicitly declined with reasoning; must-fix 3 → both `projectTree` files, the test comment, all three doc spots. Altitude 1 → `lib/eval/run/` (owner decided), `shouldExtractStatelog` moved so the atom never imports from `cli/`; altitude 2 → Out of Scope names the stdlib pipeline, stale claim dies with `runEvalInput.ts`. All seven gap items adopted except `runDir`, kept deliberately with its doc note (flagged in the header for veto).

**Spec coverage:** unchanged from v1 (Changes 1–5, 7, 8 placed; 6 deferred by name), plus the two review-requested notes: `optimize.md` verified clean; the spec's conditional `working_dir`-error test dropped because the owner's no-shims decision superseded it.

**Type consistency:** `AgentSeed` defined once (Task 4), consumed by `runAgent.seed`, the suite's `precomputedSeed`, the optimizer (Task 5); `AgentRun`'s three arms adapted to `EvalRunInputResult` only in `toInputResult` (`no-record` → `"success"`); `ExtractResult` private to `runAgent.ts`; `agentRunPaths` the single layout authority (consumed by `runArtifacts`, `readRun`, `runAgent`); `EvalInputRunner`/`EvalRecordExtractor` live in `run/` from Task 3 on; `RunSeed` gone by end of Task 5 (grep-verified).
