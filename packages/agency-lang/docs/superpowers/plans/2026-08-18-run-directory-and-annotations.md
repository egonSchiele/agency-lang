# Run Directory and Annotations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task, inline in this session (this repo does not use subagent-driven development). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the statelog the run, and one plain directory plus one append-only `annotations.jsonl` the single shape that observing, noting, labeling, grading and optimizing all read and write.

**Architecture:** A new `lib/runDirectory/` module owns the run directory behind one declarative read interface (`readRunDirectory`) and four declarative write operations (`addToRunDirectory`, `recordCompletedRun`, `recordNote`, `recordGradingPass`). Those operations—not CLIs or eval callers—own the writer lock, complete preflight, mutation order, safe replacement, torn-tail repair and durable append. The runtime records code identity and input on `agentStart`; then the eval harness, grader, labeling TUI, optimizer and log viewer are re-pointed at the new module, and the redundant formats they replaced are deleted.

**Tech Stack:** TypeScript, Node `fs`/`crypto`, zod (row schemas), vitest, the vendored commander (CLI), the existing statelog client and JSONL helpers.

**Spec:** `/Users/adityabhargava/agency-lang/packages/agency-lang/docs/superpowers/specs/2026-08-18-run-directory-and-annotations-design.md` (and its review, `…-design-REVIEW.md`). Read both first; the plan argues from them.

## Global Constraints

- One word per concept, the same word in CLI, files and code: `run`, `run directory`, `trace`, `input`, `test`, `suite`, `annotation`, `annotator`, `checklist`, `code`, `workdir`. Never introduce `provenance`, `occurrence`, `verifier`, `corpus`, `record` (as a stored thing), `ingest`.
- A directory holding only `statelog.jsonl` is a valid run directory. Nothing refuses to start because an attachment is missing.
- Writers take `.lock`; readers never do. Every JSONL append is one whole line + `fsync`. A final line without `\n` is a torn write and is ignored on read.
- Callers never acquire a run-directory lock or sequence filesystem mutations. Public write operations accept complete declarative requests, acquire/release the lock in `finally`, preflight the whole request before changing disk, repair or refuse a torn tail, and then perform the mutation.
- Annotation ids are deterministic: `ann_` + sha256 of the canonical JSON of `{traceId, annotator, kind, payload, sessionId|null}`. Score payloads include a pass id, expected pass size and completion bit: replay converges, a second pass adds rows, and an interrupted pass never becomes effective.
- Machine annotators are identified by revision, not by path: a grader is `<module path>@<sha256 of its local module closure>`; a judge is `goal-judge:<model>@<sha256 of its prompt template>`. Editing the grader or one of its local imports creates a new annotator.
- Statelog merge: the per-trace digest is sha256 over the *canonicalized parsed envelopes* in event order (key order does not matter). `mergeStatelog` skips a trace whose digest is already present and refuses one whose id is present with a different digest. Conflict detection lives only in `mergeStatelog`; a plain `cat` result cannot be validated after the fact.
- Code is stored under `code/<closureHash>/`; attaching code that does not hash to what a trace recorded is refused, never warned.
- Reuse `lib/statelog/parse.ts` for statelog decoding and validation; extend it to preserve raw lines rather than introducing a second JSONL parser.
- No caller uses `rm -rf`/`fs.rmSync` directly. Replacement goes through `safeDeleteDirectoryWithin(root, target)`, which proves the target is a strict, symlink-resolved descendant of the supplied root and can never delete the root itself.
- Clean break: no migration of old `runs/` or `labels/` directories.
- Repo rules from CLAUDE.md apply: types not interfaces, objects not maps, arrays not sets, no dynamic imports, no per-run module globals, save test output to a file, run only tests covering changed files, `pnpm run fmt:ts` before every commit, `make` when stdlib changes, never touch `CHANGELOG.md`, never hand-edit `docs/site/**` (list what the owner should change instead), commit on a branch, never on `main`.
- Each phase is one PR. Within a phase, commit after every task.

---

## Background for the implementer

**What a statelog is.** Every Agency process appends JSON events, one per line, to a `.jsonl` file (see `lib/statelog/wireTypes.ts` for `EventEnvelope`: `{format_version, trace_id, project_id, span_id, parent_span_id, data}`; `data.type` names the event, e.g. `agentStart`, `promptCompletion`, `toolCall`, `agentEnd`). One *trace* is every event sharing a `trace_id`. `lib/statelog/parse.ts:parseStatelogJsonl(text)` returns `{events, errors}`. `lib/eval/extract.ts:extractEvalRecord(events, sourcePath)` turns one trace's events into an `EvalRecord` (`lib/eval/types.ts`): hoisted `evalValues`/`evalOutputs`, `metrics`, flat `events`. That type stays; the file it was written to goes.

**What exists that we reuse.** `lib/eval/label/jsonl.ts` has `appendDurably(filePath, line)` (write + fsync) and `atomicWriteValidated`. `lib/eval/label/lock.ts` has `acquireDatasetLock({datasetDir, reportWarning})` returning `{holder, release()}` — a pid+token lock file that is never stolen. `lib/analysis/closure.ts:agentClosure(entryFile)` returns `{baseDir, files}` (absolute paths of the entry and everything it imports). `lib/utils/hash.ts:sha256Text(s)`. `lib/eval/label/load/statelogScan.ts:scanStatelog(text)` groups events by trace and `matchTraceId(scan, prefix)` resolves a prefix. `lib/eval/label/checklist.ts` owns checklist revisions and publication; `lib/eval/label/controller.ts` owns the sign-off protocol; `lib/eval/label/labelTui.ts` is the screen.

**How the eval harness works today.** `lib/cli/eval/run.ts:evalRun` → `lib/eval/run/runSuite.ts:runSuite` runs each test in a seeded workdir via `runAgent` and writes `runs/<id>/…` through `lib/eval/runArtifacts.ts` (`initializeEvalRun`, `prepareInput`, `writeEvalRunSummary`, `writeVerifierGrading`, `buildProvenance`). Grading reads the directory back through `lib/eval/readRun.ts:readEvalRun` and `lib/eval/grading/gradeRun.ts:gradeRun(runDir, ctx)` / `gradeSuite.ts`. The child process gets its statelog path and other config through the `AGENCY_CONFIG_OVERRIDES` env var (`lib/config.ts:829`, `lib/eval/run/spawnRunner.ts`).

**How the runtime records a run start.** `lib/runtime/node.ts:431` calls `execCtx.statelogClient.agentStart({entryNode, args})`; `lib/statelogClient.ts:1005` posts `{type:"agentStart", entryNode, args}`. The client is built from `StatelogConfig` (`lib/statelogClient.ts:72`), itself populated from `AgencyConfig.statelog` (`lib/config.ts:540`).

## File structure

New module, one concept per file:

```
lib/runDirectory/
  runDir.ts            # paths + readRunDirectory(dir) → one consistent snapshot
  traces.ts            # per-trace digest; readTraces(statelogPath) → Trace[]
  mergeStatelog.ts     # pure preflight + private application of a trace merge
  annotations.ts       # named row types, schemas, ids, read/fold (no public write choreography)
  mutations.ts         # the four public declarative write operations
  lock.ts              # private mutation infrastructure, moved from label/lock.ts
  codeIdentity.ts      # computeCodeIdentity(entryFile) → {entry, closureHash, closure[]}
  attachCode.ts        # private preflight/application for code attachments
  attachWorkdir.ts     # private preflight/application for workdir attachments
  evalRecord.ts        # evalRecordFor(trace) — the in-memory EvalRecord from a Trace
  list.ts              # summarizeRuns(dir) → one row per trace for `runs list`
lib/cli/runDirectory/
  add.ts  list.ts  note.ts  extract.ts   # one command per file
```

Existing files that change hands: `lib/eval/label/{checklist,controller,labelTui,session,draft,annotations}.ts` are re-pointed at `lib/runDirectory/annotations.ts`; everything else under `lib/eval/label/` and `lib/eval/label/load/` is deleted in Phase 5.

---

# Phase 0 — Clear the ground (tiny PR)

### Task 0.1: Remove the prototype and the `eval optimize` alias

**Files:**
- Delete: `lib/cli/eval/save.prototype.ts`
- Modify: `lib/cli/eval/labelCommand.ts` (remove the `save`/`saved` registrations and the import)
- Modify: `scripts/agency.ts:1056-1057` (call `addOptimizeCommand(program)` only)
- Test: `lib/cli/eval/optimize.test.ts` remains unchanged; it tests `evalOptimize` rather than command registration

- [ ] **Step 1: Delete the prototype and its wiring**

```bash
git rm lib/cli/eval/save.prototype.ts
```
In `labelCommand.ts` remove the `import { labelSave, labelSaved } from "./save.prototype.js";` line and the block from `// PROTOTYPE — see save.prototype.ts` through the `saved` command's closing `});`.

- [ ] **Step 2: Drop the alias**

In `scripts/agency.ts` replace
```ts
  addOptimizeCommand(evalCmd);
  addOptimizeCommand(program);
```
with
```ts
  addOptimizeCommand(program);
```
and change the comment above `addOptimizeCommand` from "Registered under both …" to "Registered as the top-level `agency optimize`."

- [ ] **Step 3: Typecheck and run the touched tests**

Run: `npx tsc --noEmit -p . > /private/tmp/…/scratchpad/p0-tsc.log 2>&1; pnpm vitest run lib/cli/eval/optimize.test.ts lib/cli/eval/labelCommand.test.ts > /private/tmp/…/scratchpad/p0-tests.log 2>&1`
Expected: tsc clean; tests pass (fix any test that asserted `eval optimize` exists by removing that assertion).

- [ ] **Step 4: Commit**

```bash
pnpm run fmt:ts
git add -A lib/cli/eval scripts/agency.ts
git commit -F /private/tmp/…/scratchpad/msg.txt   # "Remove the label-save prototype and the eval optimize alias"
```

---

# Phase 1 — The statelog records code identity and input

### Task 1.1: `computeCodeIdentity`

**Files:**
- Create: `lib/runDirectory/codeIdentity.ts`
- Test: `lib/runDirectory/codeIdentity.test.ts`

**Interfaces:**
- Produces: `type CodeIdentity = { entry: string; closureHash: string; closure: { file: string; sha256: string }[] }` and `computeCodeIdentity(entryFile: string): CodeIdentity`. `entry` and `closure[].file` are relative to `agentClosure(entryFile).baseDir`, sorted by `file`; `closureHash` = `sha256Text(closure.map(f => `${f.file}\n${f.sha256}\n`).join(""))`.

- [ ] **Step 1: Write the failing test**

```ts
// lib/runDirectory/codeIdentity.test.ts
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { describe, expect, it } from "vitest";
import { computeCodeIdentity } from "./codeIdentity.js";

function proj(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codeid-"));
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  return dir;
}

describe("computeCodeIdentity", () => {
  it("lists the entry and its imports relative to the closure base, sorted, with a stable hash", () => {
    const dir = proj({
      "main.agency": 'import { f } from "./lib/util.agency"\nnode main() { return f() }\n',
      "lib/util.agency": "export def f(): string { return \"x\" }\n",
    });
    const firstIdentity = computeCodeIdentity(path.join(dir, "main.agency"));
    expect(firstIdentity.entry).toBe("main.agency");
    expect(firstIdentity.closure.map((file) => file.file)).toEqual([
      "lib/util.agency",
      "main.agency",
    ]);
    expect(firstIdentity.closureHash).toMatch(/^[0-9a-f]{64}$/);
    const secondIdentity = computeCodeIdentity(path.join(dir, "main.agency"));
    expect(secondIdentity.closureHash).toBe(firstIdentity.closureHash);
  });

  it("changes the hash when any closure file changes", () => {
    const dir = proj({ "main.agency": "node main() { return 1 }\n" });
    const before = computeCodeIdentity(path.join(dir, "main.agency")).closureHash;
    fs.writeFileSync(path.join(dir, "main.agency"), "node main() { return 2 }\n");
    expect(computeCodeIdentity(path.join(dir, "main.agency")).closureHash).not.toBe(before);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm vitest run lib/runDirectory/codeIdentity.test.ts > /private/tmp/…/scratchpad/t11.log 2>&1`
Expected: FAIL, cannot find module `./codeIdentity.js`.

- [ ] **Step 3: Implement**

```ts
// lib/runDirectory/codeIdentity.ts
import * as fs from "fs";
import * as path from "path";
import { agentClosure } from "@/analysis/closure.js";
import { sha256Text } from "@/utils/hash.js";

export type ClosureFile = { file: string; sha256: string };
export type CodeIdentity = { entry: string; closureHash: string; closure: ClosureFile[] };

/** Which code an agent is: the entry file and every file it transitively
 *  imports, each hashed, plus one hash over the whole list. Paths are relative
 *  to the closure's base directory so the same code hashes the same anywhere. */
export function computeCodeIdentity(entryFile: string): CodeIdentity {
  const { baseDir, files } = agentClosure(entryFile);
  const closure = files
    .map((absoluteFile) => ({
      file: path.relative(baseDir, absoluteFile),
      sha256: sha256Text(fs.readFileSync(absoluteFile, "utf8")),
    }))
    .sort((left, right) => left.file.localeCompare(right.file));
  return {
    entry: path.relative(baseDir, fs.realpathSync(path.resolve(entryFile))),
    closureHash: closureHashOf(closure),
    closure,
  };
}

export function closureHashOf(closure: readonly ClosureFile[]): string {
  return sha256Text(closure.map((c) => `${c.file}\n${c.sha256}\n`).join(""));
}
```

- [ ] **Step 4: Run the test**

Run: same command. Expected: PASS.

- [ ] **Step 5: Commit** — `git add lib/runs && git commit` ("Add computeCodeIdentity: entry, closure hashes, one closure hash").

### Task 1.2: `agentStart` carries `code` and `input`

**Files:**
- Modify: `lib/statelogClient.ts:64-90` (add `code?: CodeIdentity` to `StatelogConfig`), `:1005-1014` (`agentStart` posts `code` and `input`)
- Modify: `lib/config.ts:540` (statelog schema accepts `code`)
- Modify: `lib/statelog/wireTypes.ts` (document `agentStart.code`, `agentStart.input`)
- Modify: `lib/runtime/node.ts` (`RunNodeArgs.input` and `agentStart.input`), `lib/runtime/subprocess-bootstrap.ts` (pass `RunInstruction.task` as hidden node invocation input), `lib/backends/typescriptBuilder/nodeWrapperParams.ts` and `lib/backends/typescriptBuilder.ts` (accept and forward that hidden option)
- Test: `lib/statelogClient.test.ts` (or nearest existing agentStart test), `lib/config.test.ts`, `lib/runtime/ipc.test.ts`, `lib/backends/typescriptBuilder/nodeWrapperParams.test.ts`

**Interfaces:**
- Produces: `agentStart` event data `{ type: "agentStart", entryNode, args, input?: JsonValue, code?: CodeIdentity }`.

- [ ] **Step 1: Failing test** — in the statelog client test file, build a client with `logFile` and `code: {entry:"a.agency", closureHash:"h", closure:[]}`, call `agentStart({entryNode:"main", args:{}, input:"hello"})`, read the file, assert the posted `agentStart` line has `code.closureHash === "h"` and `input === "hello"`.
- [ ] **Step 2: Run, see it fail** (unknown property `code` on config / missing field).
- [ ] **Step 3: Implement**

```ts
// lib/statelogClient.ts (StatelogConfig)
  /** Which code this process is running; recorded on agentStart so a trace can
   *  be attributed to a version after the fact. */
  code?: CodeIdentity;
```
```ts
  async agentStart({ entryNode, args, input }: { entryNode: string; args?: any; input?: unknown }): Promise<void> {
    await this.post({
      type: "agentStart",
      entryNode,
      args,
      input,
      code: this.code,
    });
```
(store `this.code = config.code` in the constructor next to `this.metadata`). In `lib/config.ts` add to the statelog object schema: `code: z.object({ entry: z.string(), closureHash: z.string(), closure: z.array(z.object({ file: z.string(), sha256: z.string() })) }).optional()`.

Do not reconstruct input from `RunNodeArgs.data`: an ordinary one-parameter invocation and an eval input have the same data shape. Add a hidden `input?: unknown` member to the generated node wrapper's trailing options object and to `RunNodeArgs`. In `executeRun`, call the wrapper with `...call.args` followed by `{ input: msg.task }`; direct callers may omit the option. Have `typescriptBuilder.ts` forward `__invocationInput` as `RunNodeArgs.input`, then post `agentStart({ entryNode: nodeName, args: data, input })`. Tests must prove that an IPC run with `task` records it, while a direct one-parameter node call without the hidden option leaves `input` absent. Task 4.1 later renames the IPC field from `task` to `input` without changing this channel.

- [ ] **Step 4: Run tests** — the statelog client test and `lib/config.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** ("agentStart records code identity and the input").

### Task 1.3: Every launcher fills `statelog.code`

**Files:**
- Modify: `scripts/agency.ts:418` (`agency run`), `lib/eval/run/spawnRunner.ts` (eval harness child), `lib/cli/runAgencyAgent.ts` (`agency agent`)
- Test: `lib/eval/run/spawnRunner.test.ts` (assert the overrides passed to the child include `statelog.code.closureHash`), one agency-js test that runs a tiny agent with `--log` and asserts `agentStart.code.entry` in the log

- [ ] **Step 1: Failing tests** as above.
- [ ] **Step 2: Run, see them fail.**
- [ ] **Step 3: Implement** — at each launch site, where the statelog config / `AGENCY_CONFIG_OVERRIDES` is assembled, add `statelog: { ...existing, code: computeCodeIdentity(entryFile) }`. For `agency agent`, use the `agencyFile` already returned by `resolveAgencyAgentPath(args.agent, args.cwd)` as `entryFile`; this preserves bundled-agent lookup as well as cwd-relative paths. For command agents under `--agent-cmd`, do nothing — the invoked `agency` CLI fills it itself.
- [ ] **Step 4: Run tests.** Expected: PASS.
- [ ] **Step 5: Commit** ("Fill statelog.code from agency run, eval run, and agency agent").

**Phase 1 PR checklist:** `pnpm run lint:structure`, `pnpm run fmt:ts`, `npx tsc --noEmit -p .`, tests for changed files. Dev note: add a short section "Code identity and input on agentStart" to `docs/dev/statelog.md` and mention it in CLAUDE.md's pointer line. Open the PR; the owner merges.

---

# Phase 2 — `lib/runDirectory/`: the run directory core

### Task 2.1: Traces and per-trace digest

**Files:**
- Modify: `lib/statelog/parse.ts`, `lib/statelog/parse.test.ts`
- Create: `lib/runDirectory/traces.ts`, `lib/runDirectory/traces.test.ts`

**Interfaces:**
- Produces: `type ParsedEventLine = { event: EventEnvelope; raw: string; line: number }`; `parseStatelogJsonlWithLines(text): { lines: ParsedEventLine[]; errors: ParseError[] }`. The existing `parseStatelogJsonl` delegates to it and maps `lines` to events, so JSON decoding, version checks and envelope validation still have one owner.
- Produces: `type Trace = { traceId: string; events: EventEnvelope[]; lines: string[]; digest: string }`; `readTraces(statelogPath: string): { traces: Trace[]; errors: ParseError[] }`; `traceDigest(events: readonly EventEnvelope[]): string` = sha256 over `canonicalize(event)` (from `lib/utils/canonicalize.ts`) for each event in order, joined with `\n` — so key order in the source JSON does not matter; `matchTrace(traces, idOrPrefix): {kind:"one", trace} | {kind:"none"} | {kind:"ambiguous", ids: string[]}`.
- `readTraces` groups by `trace_id`; it drops a line that is byte-identical to a line already seen for that trace (the harmless result of `cat`-ing two copies of one trace) and reports nothing else. It does **not** try to detect two different streams sharing an id: after concatenation there is no boundary to compare against. That check lives in `mergeStatelog` (Task 2.4), where the existing and incoming traces are still separate.

- [ ] **Step 1: Failing tests** — first extend the parser test to prove `parseStatelogJsonlWithLines` returns the validated envelope, original raw line and one-based line number, while `parseStatelogJsonl` retains its existing output. Then write a 3-line statelog with two trace ids and assert `readTraces` returns two traces with the right event counts; assert `traceDigest` is equal for envelopes that differ only in key order and differs when a value changes; assert a duplicated identical line yields one event; assert prefix match works; assert a trailing partial line is not counted.
- [ ] **Step 2: Run, fail.**
- [ ] **Step 3: Implement** — move the existing per-line decoding in `parseStatelogJsonl` into `parseStatelogJsonlWithLines`; make the old function delegate. `readTraces` removes only the torn suffix before calling that parser, groups its validated `ParsedEventLine`s by `trace_id`, skips exact duplicate raw lines and computes the canonical digest. It must not call `JSON.parse` itself.
- [ ] **Step 4: Run, pass.** **Step 5: Commit** ("Add lib/runDirectory/traces: read a statelog into traces with per-trace digests").

### Task 2.2: Named annotation types and effective state

**Files:**
- Create: `lib/runDirectory/annotations.ts`, `lib/runDirectory/annotations.test.ts`

**Interfaces:**
- Produces named types rather than nested anonymous object contracts:
```ts
export type Annotator = { kind: "human" | "grader" | "judge" | "harness"; id: string };
export type Score = { kind: "binary"; pass: boolean } | { kind: "scalar"; value: number };
export type NotePayload = { kind: "note"; text: string };
export type ChecklistPayload = {
  kind: "checklist";
  checklist: string;
  version: number;
  hash: string;
  answers: Record<string, boolean>;
  note: string;
};
export type ScorePayload = {
  kind: "score";
  passId: string;
  passSize: number;
  completesPass: boolean;
  name: string;
  score: Score;
  weight: number;
  mustPass: boolean;
  feedback?: string;
  gradersModule?: string;
};
export type SuiteIdentity = { source: string; sha?: string };
export type RunOutcome = "ok" | "error" | "timeout" | "cost-cap" | "killed";
export type RunPayload = {
  kind: "run";
  test: JsonValue;
  suite: SuiteIdentity | null;
  ended: RunOutcome;
  flags: Record<string, JsonValue>;
};
export type AnnotationPayload = NotePayload | ChecklistPayload | ScorePayload | RunPayload;
export type Annotation = { v: 1; id: string; traceId: string; createdAt: string; annotator: Annotator; sessionId?: string } & AnnotationPayload;
export type EffectiveChecklistJudgement = { annotator: Annotator; answers: Record<string, boolean>; note: string };
export type EffectiveTraceAnnotations = { notes: Annotation[]; scores: Record<string, Annotation>; checklists: Record<string, EffectiveChecklistJudgement>; run: Annotation | null };
export function annotationId(annotation: Omit<Annotation, "id" | "createdAt">): string;
/** @internal Used by readRunDirectory and mutation owners, not feature callers. */
export function readAnnotations(dir: string, reportWarning: (message: string) => void): Annotation[];
/** @internal Exposed for focused pure tests; callers use snapshot.effectiveAnnotations. */
export function foldAnnotations(rows: Annotation[]): Record<string, EffectiveTraceAnnotations>;
```
`foldAnnotations` keys checklist judgements by checklist + annotator kind + annotator id, so two humans never merge. It includes score rows only from completed passes: a pass is complete only when exactly `passSize` unique rows exist and one row has `completesPass: true`; the latest complete pass wins. Incomplete rows left by a crash are retained but never affect effective state.

- [ ] **Step 1: Failing tests** — prove deterministic ids; per-question checklist folding; two humans' conflicting answers survive separately; two machine annotator revisions survive separately; a complete later score pass wins; a pass missing its completion row does not change effective scores; malformed middle rows warn; a torn final row is ignored by readers.
- [ ] **Step 2: Run, fail.** **Step 3: Implement the named schemas and pure fold.** **Step 4: Run, pass.** **Step 5: Commit** ("Add named annotation types and effective-state folding").

### Task 2.3: One read snapshot and private lock infrastructure

**Files:**
- Create: `lib/runDirectory/runDir.ts`, `lib/runDirectory/runDir.test.ts`, `lib/runDirectory/lock.ts`
- Move test: `lib/eval/label/lock.test.ts` → `lib/runDirectory/lock.test.ts`

**Interfaces:**
- Produces: `type RunDirectorySnapshot = { dir: string; hasStatelog: boolean; traces: Trace[]; annotationRows: Annotation[]; effectiveAnnotations: Record<string, EffectiveTraceAnnotations> }`; `readRunDirectory(dir, {reportWarning}) → RunDirectorySnapshot`; `runDirPaths(dir) → RunDirectoryPaths` (a named type).
- `readRunDirectory` reads statelog → annotations → statelog and retries when the statelog digest changed, so callers receive one coherent snapshot without taking a reader lock. A missing statelog yields an empty valid snapshot.
- `acquireRunDirLock` remains internal mutation infrastructure. Only `mutations.ts` and the checklist commit owner may import it; no CLI, eval runner or grader receives a lock handle.

- [ ] **Step 1: Failing tests** — empty directory returns an empty snapshot; a directory with traces and annotations returns both raw and effective state; simulate a statelog change between reads and assert the snapshot retries; lock tests retain their current exclusive-owner behavior.
- [ ] **Step 2: Run, fail.** **Step 3: Implement.** **Step 4: Run, pass.** **Step 5: Commit** ("Add coherent run-directory snapshots and private writer locking").

### Task 2.4: Private mutation primitives and safe replacement

**Files:**
- Create: `lib/runDirectory/mergeStatelog.ts`, `lib/runDirectory/attachCode.ts`, `lib/runDirectory/attachWorkdir.ts`, tests for each
- Modify: `lib/utils.ts`, `lib/utils.test.ts`

**Interfaces:**
- `planStatelogMerge(existing, incoming) → StatelogMergePlan` is pure and validates the entire incoming set: add absent traces, skip equal digests, refuse any conflicting id. `applyStatelogMerge(paths, plan)` is private and writes only a successful plan.
- `planCodeAttachment(snapshot, entryFile) → CodeAttachmentPlan` and `planWorkdirAttachment(snapshot, request) → WorkdirAttachmentPlan` perform all validation without changing disk. Private `apply*` functions execute validated plans.
- `safeDeleteDirectoryWithin(root, target)` resolves symlinks, requires `target` to be a strict descendant of `root`, refuses the root and paths outside it, and deletes only after validation. Workdir replacement uses it inside `applyWorkdirAttachment`; callers never delete first.

- [ ] **Step 1: Failing tests** — all-or-nothing multi-log merge; code match/mismatch; workdir add/refuse/replace; safe deletion succeeds for one strict descendant and refuses the root, a sibling, `..`, and a symlink escape. Tests use temporary directories containing sentinel files and never point at a real project or home directory.
- [ ] **Step 2: Run the focused tests and see the missing functions fail.**
- [ ] **Step 3: Implement pure planning separately from private application.**
- [ ] **Step 4: Run the focused tests and confirm they pass.**
- [ ] **Step 5: Commit** ("Add preflighted run attachments and contained replacement").

### Task 2.5: Declarative run-directory mutations

**Files:**
- Create: `lib/runDirectory/mutations.ts`, `lib/runDirectory/mutations.test.ts`

**Interfaces:**
- Produces named request/result types and four public operations. The request describes the desired domain change, not the lock or filesystem steps needed to make it:
```ts
export type WorkdirAttachmentRequest = {
  traceId: string;
  sourceDir: string;
  replace?: boolean;
};
export type AddToRunDirectoryRequest = {
  dir: string;
  statelogFiles: string[];
  codeEntries: string[];
  workdir?: WorkdirAttachmentRequest;
  annotationFiles: string[];
};
export type MutationCounts = { added: number; skipped: number };
export type AddToRunDirectoryResult = {
  statelogs: MutationCounts;
  code: MutationCounts;
  workdirs: MutationCounts;
  annotations: MutationCounts;
  snapshot: RunDirectorySnapshot;
};
export type RunAnnotationDraft = {
  traceId: string;
  annotator: Annotator;
  payload: RunPayload;
};
export type RecordCompletedRunRequest = {
  dir: string;
  stagedStatelogFile: string;
  codeEntry?: string;
  workdir?: WorkdirAttachmentRequest;
  run: RunAnnotationDraft;
};
export type RecordCompletedRunResult = {
  annotation: Annotation;
  snapshot: RunDirectorySnapshot;
};
export type RecordNoteRequest = {
  dir: string;
  traceId: string;
  annotator: Annotator;
  text: string;
};
export type ScoreDraft = {
  traceId: string;
  annotator: Annotator;
  name: string;
  score: Score;
  weight: number;
  mustPass: boolean;
  feedback?: string;
  gradersModule?: string;
};
export type RecordGradingPassRequest = { dir: string; scores: ScoreDraft[] };
export type RecordGradingPassResult = {
  passId: string;
  annotations: Annotation[];
  snapshot: RunDirectorySnapshot;
};
export function addToRunDirectory(request: AddToRunDirectoryRequest): AddToRunDirectoryResult;
export function recordCompletedRun(request: RecordCompletedRunRequest): RecordCompletedRunResult;
export function recordNote(request: RecordNoteRequest): Annotation;
export function recordGradingPass(request: RecordGradingPassRequest): RecordGradingPassResult;
```
- Each operation acquires/releases the lock internally, calls `readRunDirectory`, preflights the complete request with Task 2.4's pure planners, repairs a torn append target by truncating to its last newline and `fsync`ing before append, then applies the plan. No partial change occurs on a preflight error.
- `recordGradingPass` accepts all already-computed score drafts (including revision-based annotators), mints one pass id, sets `passSize` on every row and `completesPass` only on the final row, then appends them. A crash before the final row leaves an incomplete pass that `foldAnnotations` ignores. Grading owns how a grader revision is computed; run-directory storage only records the supplied identity.

- [ ] **Step 1: Failing tests** — callers can add multiple statelogs/code/workdir/annotations with one request; any conflict leaves every target byte-identical; completed-run recording writes all attachments without exposing a lock; note recording is idempotent; a complete grading pass becomes effective; a simulated failure before its final row leaves prior effective scores unchanged; annotation and statelog appends repair a torn suffix before writing a valid new row; injected failures always release the lock.
- [ ] **Step 2: Run, fail.**
- [ ] **Step 3: Implement the four operations; keep lock, append and `apply*` helpers module-private.**
- [ ] **Step 4: Run, pass.**
- [ ] **Step 5: Commit** ("Expose declarative run-directory mutations").

### Task 2.6: `evalRecordFor` and `summarizeRuns`

**Files:**
- Create: `lib/runDirectory/evalRecord.ts`, `lib/runDirectory/list.ts`, tests

**Interfaces:**
- `evalRecordFor(trace, sourcePath) → EvalRecord`; `summarizeRuns(snapshot: RunDirectorySnapshot) → RunSummary[]`. Define `RunSummary` as a named type with one property per displayed column; callers never reopen or separately fold files.

`ended`: the harness `run` annotation's `ended` if present; else `"ok"` when the trace has an `agentEnd` with a result, `"error"` when it has a `runtimeError` and a result-less `agentEnd`, else `"unknown"`.

- [ ] **Step 1: Failing test** — a fixture dir with one trace + a note + a score → one summary row with `noteCount 1`, `latestScore` set, `ended "ok"`. A trace with no `agentEnd` → `"unknown"`.
- [ ] **Step 2–5.** Commit ("Add evalRecordFor and summarizeRuns").

**Phase 2 PR checklist:** as Phase 1. Run `pnpm run lint:structure` to catch the catalogued patterns. Dev note: create `docs/dev/run-directory.md` describing the declarative read/write interfaces first, then the private lock, preflight, torn-tail repair, digest merge and code-by-hash machinery they hide. Nothing user-facing changes yet.

---

# Phase 3 — CLI primitives: `logs extract`, `runs add`, `note`, `runs list`

### Task 3.1: `agency logs extract <log> --trace <id> [-o <file>]`

**Files:**
- Create: `lib/cli/runDirectory/extract.ts`, `lib/cli/runDirectory/extract.test.ts`
- Modify: `scripts/agency.ts` (register under the `logs` command at `:683`)

**Interfaces:**
- `logsExtract({ log, trace?, out? }, deps = { stdout })`: `readTraces(log)`; if `trace` is undefined and there is exactly one trace, use it; if undefined with several, error listing ids (reuse the table from `describeAvailableTraces` — move that helper into `lib/runDirectory/traces.ts` in this task); prefix match via `matchTrace`; write `trace.lines.join("\n") + "\n"` to `out` (create parent dirs) or stdout.

- [ ] **Step 1: Failing test** — two-trace log: no `--trace` → error listing both; `--trace <prefix>` → output has exactly that trace's lines; one-trace log with no `--trace` → succeeds.
- [ ] **Step 2–4.** **Step 5: Commit** ("agency logs extract: copy one trace out of a statelog").

### Task 3.2: `agency runs add`

**Files:**
- Create: `lib/cli/runDirectory/add.ts`, test
- Modify: `scripts/agency.ts` (new `runs` command group with `add`)

**Interfaces:**
- `runsAdd(options)` translates Commander values into one `AddToRunDirectoryRequest`, calls `addToRunDirectory(request)` once, and renders its result. It never imports the lock, merge, attachment, deletion or annotation-log modules. `--replace` becomes `workdir.replace: true`; replacement policy remains inside the domain operation. Render the returned snapshot with `summarizeRuns(result.snapshot)`.

- [ ] **Step 1: Failing test** — assemble a dir from a two-trace log; re-run → all skipped; add code from a matching fixture project → `code/<hash>/`; add code from a non-matching project → exit 2, message contains the recorded hash.
- [ ] **Step 2–5.** Commit ("agency runs add: assemble a run directory from statelogs, code, workdir, annotations").

### Task 3.3: `agency note <dir> [--trace <id>] <text>` and `agency runs list <dir>`

**Files:**
- Create: `lib/cli/runDirectory/note.ts`, `lib/cli/runDirectory/list.ts`, tests
- Modify: `scripts/agency.ts`

- `note`: resolve the trace from `readRunDirectory`, call `recordNote({ dir, traceId, annotator, text })`, and print the returned annotation id. It never opens the annotation file or lock.
- `runs list`: `summarizeRuns(readRunDirectory(dir, { reportWarning }))` rendered with the shared table component from `lib/runsExplorer/` (see `docs/dev/runs-explorer.md`) — columns: trace (8 chars), started, ended, duration, cost, llm, tools, score, notes, labeled, input preview (60 chars).

- [ ] **Step 1: Failing tests** — `note` on a one-trace dir appends a note row; on a two-trace dir without `--trace` errors listing ids; `runs list` prints one row per trace with the note count.
- [ ] **Step 2–5.** Commit ("agency note and agency runs list").

### Task 3.4: Viewer: extract key in, `l` key out

**Files:**
- Modify: `lib/logsViewer/views/treeView.ts` (replace the `labelTrace` ViewAction on `l` with an `extractTrace` action on `x`), `lib/logsViewer/views/view.ts` (action type), `lib/logsViewer/run.ts:303` (handle `extractTrace`: prompt for an output path with a default of `./<traceId>.jsonl`, write via the same function `logsExtract` uses)
- Delete: `lib/logsViewer/labelTrace.ts` + test, and the `labeling` option in `lib/cli/logsView.ts:102-108,340`. **Keep** `lib/eval/label/labelingHost.ts` and `datasetWriter.ts` for now: `lib/cli/eval/label.ts` and `ingest.ts` still import them, and both CLIs must keep working until Task 5.2 replaces them. Task 5.2 deletes the two services.
- Test: `lib/logsViewer/views/treeView.test.ts`, `lib/cli/logsView.test.ts`

- [ ] **Step 1: Update tests** — replace the `l`-key assertions with `x` emitting `extractTrace`.
- [ ] **Step 2: Run, fail.** **Step 3: Implement + delete.** **Step 4: Run, pass.**
- [ ] **Step 4b: Prove nothing else broke** — `npx tsc --noEmit -p .` clean and `pnpm vitest run lib/cli/eval/label.test.ts lib/cli/eval/ingest.test.ts` still pass (the old CLIs are untouched in this phase).
- [ ] **Step 5: Commit** ("Viewer: x extracts a trace to a file; drop the l key").

**Phase 3 PR checklist:** dev note `docs/dev/run-directory.md` gains a "Commands" section; delete `docs/dev/statelog-to-dataset.md` and its CLAUDE.md pointer. Tell the owner: `docs/site/cli/logs.md` "Labeling a trace from the viewer" and `docs/site/cli/eval.md` "Labeling a statelog trace" need rewriting.

---

# Phase 4 — Eval: run never grades, grade appends scores, `test`/`input` vocabulary

### Task 4.1: The suite loader and every consumer speak `test` and `input`

This is one atomic rename, not a loader-only change: a `type Input = Test` alias would keep the *name* compiling while every `.task` access fails. Do the whole rename in this task and prove it with a search before committing.

**Files:**
- Modify: `lib/eval/loadInputs.ts` → rename to `lib/eval/loadSuite.ts` (`loadInputs`/`loadSuite` exports accordingly), `lib/eval/runTypes.ts` (`Input` → `Test`: `{ id, input, goal?, expected?, files?, graders?, timeoutSec?, metadata? }`)
- Modify every production consumer of `.task` on an eval input, found with the search in Step 0 — at the time of writing: `lib/eval/run/runSuite.ts`, `lib/eval/run/runAgent.ts`, `lib/eval/run/subprocess.ts`, `lib/eval/run/spawnRunner.ts`, `lib/eval/run/commandLine.ts` (the `{task}` placeholder in `--agent-cmd` stays as the user-facing token but is documented as "the input"; rename the internal variable), `lib/runtime/ipc.ts` (`RunInstruction.task` → `input`, `resolveNodeCallArgs`), `lib/eval/grading/*` (`input:` param → `test:`), `lib/eval/judge/*`, `lib/optimize/baseOptimizer.ts`, `lib/optimize/gepaReflect.ts` (`Task:` → `Input:`), `lib/optimize/evalCache.ts`, and the fixtures under `lib/eval/testUtils.ts`, `lib/eval/grading/testUtils.ts`, `lib/eval/label/runFixture.ts`
- Modify: `lib/cli/eval/run.ts` (`--inputs` → `--suite`; `--goal` sets `input` and `goal`; error text), `lib/cli/eval/optimize.ts` (same flags)
- Test: every `*.test.ts` that builds an eval input literal (`{ id, task, goal }`) — update to `input`

- [ ] **Step 0: Enumerate** — `grep -rn "\.task\b\|task:" lib/eval lib/optimize lib/runtime/ipc.ts lib/cli/eval --include=*.ts | grep -v test > /private/tmp/…/scratchpad/task-sites.txt` and read it. This is the file list for the task; anything not in the list above goes on it.
- [ ] **Step 1: Update loader tests** — a suite entry `{ id, input: "…", goal: "…" }` loads; `{ task: "…" }` is rejected with a message saying "`task` was renamed to `input`"; `{ args: … }` still rejected; `--goal x` yields `input === goal === "x"`.
- [ ] **Step 2: Run the loader test, see it fail.**
- [ ] **Step 3: Rename the field and fix every site from Step 0**, including `RunInstruction.input` on the IPC wire (bump nothing: the wire is internal to one process tree). Keep `{task}` as the literal placeholder token in `--agent-cmd` strings for now (renaming a user-facing token is a separate decision; note it in the PR).
- [ ] **Step 4: Prove the rename is complete** — rerun the Step 0 search; expected: zero hits outside `commandLine.ts`'s placeholder handling. Then `npx tsc --noEmit -p .` clean, and `pnpm vitest run lib/eval lib/optimize lib/cli/eval lib/runtime/ipc.test.ts > /private/tmp/…/scratchpad/t41.log 2>&1` green.
- [ ] **Step 5: Commit** ("Eval: input replaces task everywhere; --suite replaces --inputs").

### Task 4.2: `eval run` writes a run directory and never grades

**Files:**
- Modify: `lib/eval/run/runSuite.ts`, `lib/eval/run/runAgent.ts`, `lib/eval/run/spawnRunner.ts` (each test runs entirely in a staging directory and hands one complete request to `recordCompletedRun`), `lib/cli/eval/run.ts` (drop grading, `--no-grade`, `--graders`; drop `requireGoal`)
- Delete: `lib/eval/runArtifacts.ts` + test, `lib/eval/readRun.ts` + test, `lib/eval/run/extract.ts` (the per-input eval-record writer)
- Test: `lib/eval/run/runSuite.test.ts`, `lib/cli/eval/run.test.ts`, the eval-run integration test

For each test the harness creates one temporary staging directory **outside** the final run directory, seeds and runs the agent there, and captures its statelog there. On finish it calls `recordCompletedRun` once with the staged statelog, workdir, optional agent entry and complete `run` annotation payload. That operation owns merge, code/workdir attachment, annotation append and locking. The harness removes the staging directory through `safeDeleteDirectoryWithin(stagingRoot, testStagingDir)` in `finally`; no old `inputs/<id>/` tree survives. `ended` maps from the existing outcome kinds: ok → `"ok"`, agent error → `"error"`, wall-clock kill → `"timeout"`, cost-cap kill → `"cost-cap"`, SIGINT → `"killed"`. Command agents omit code.

- [ ] **Step 1: Failing test** — after `runSuite` on a two-test suite: `<dir>/statelog.jsonl` has two traces; `annotations.jsonl` has two `run` rows with `ended "ok"`; `code/<hash>/` exists; `workdir/<traceId>/` exists for both; no `config.json`, `summary.json`, `verifier/`.
- [ ] **Step 2–5.** Commit ("eval run writes a run directory and never grades").

### Task 4.3: `eval grade` reads a run directory and appends `score` rows

**Files:**
- Modify: `lib/eval/grading/gradeRun.ts` (`gradeRun(snapshot, ctx)` iterates `snapshot.traces`; for each, `record = evalRecordFor(trace)`, `test = snapshot.effectiveAnnotations[traceId]?.run?.test`, `workdir = workdir/<traceId>` if present, and the grader callback receives `{ output, test, workdir, record, judge }`), `lib/eval/grading/gradeSuite.ts` (read one snapshot, convert grader results directly to `ScoreDraft[]`, then call `recordGradingPass({ dir, scores })` once), `lib/cli/eval/grade.ts`
- Modify: `lib/eval/grading/types.ts` (`LoadedRun` loses `recordPath`; `input: Input` → `test: Test`), every grader under `lib/eval/grading/graders/` that reads `input.` → `test.`
- Delete: `lib/eval/grading/recordGrading.ts`, `writeVerifierGrading`, and any `verifier-N` reader; the old recorder has no responsibility after `gradeSuite` produces drafts and the run-directory operation persists them
- Test: `lib/eval/grading/gradeRun.test.ts`, `lib/cli/eval/grade.test.ts`

Rules to keep from `docs/dev/eval-grading.md`: a trace whose `run.ended !== "ok"` (or, without a `run` row, whose trace has no `agentEnd` result) scores 0 on every grader and is never shown to graders; a successful trace with no output grades with `output: null`; precedence flag > `test.graders` > `eval.graders` config > goal judge (which errors *per test* naming the missing `goal`).

- [ ] **Step 1: Failing tests** — (a) grade a fixture dir with one ok trace and one `ended: "timeout"` trace: the ok one gets grader-produced score rows, the timeout one gets zero-valued rows without being shown to the spy grader; (b) `gradeSuite` hands one complete `ScoreDraft[]` to `recordGradingPass`, never appending itself; (c) a second pass with unchanged results produces a second complete pass and the fold picks it; (d) editing an imported grader helper changes annotator identity; (e) a failure before the completing row leaves the prior complete pass effective; (f) objective prints as today.
- [ ] **Step 2–5.** Commit ("eval grade reads a run directory and appends score annotations").

### Task 4.4: Remove `eval extract` and the on-disk eval record

**Files:**
- Modify: `scripts/agency.ts:891` (remove `extract`), `lib/eval/public.ts` (drop any file-writing export; keep `extractEvalRecord`)
- Delete: the CLI extract handler and its test; migrate `lib/eval/statelogParser.ts` to `lib/statelog/parse.ts`, then delete `lib/eval/parseJsonl.ts` and its test
- Modify: `lib/eval/judge/*` to take two run directories + trace ids (or two statelog files) instead of `.eval.json` paths, computing records in memory

- [ ] **Step 1: Update tests**, **Step 2–5.** Commit ("Remove eval extract; the eval record is computed, never written").

**Phase 4 PR checklist:** update `docs/dev/eval-grading.md` (the interface is now the run directory in the new shape; `run` row replaces `input.json`/`summary.json`), delete `docs/dev/eval-command-agents.md` sections that mention `config.json`. Owner: `docs/site/cli/eval.md` needs a rewrite (run/grade split, `--suite`, `input`, no `extract`).

---

# Phase 5 — Labeling on the run directory

### Task 5.1: Checklists live in the run directory

**Files:**
- Modify: `lib/eval/label/checklist.ts` (paths from `runDirPaths(dir).checklistsDir`; drafts at `checklists/<name>/draft.json`), `lib/eval/label/draft.ts` (draft carries `pendingAnnotation` as today, plus `traceIds` order for the session id)
- Create: `lib/runDirectory/checklistSignoff.ts`, `lib/runDirectory/checklistSignoff.test.ts`
- Test: existing checklist/draft tests re-pointed

**Interfaces:**
- `commitChecklistSignoff(request: ChecklistSignoffRequest) → ChecklistSignoffResult` is the one imperative safety owner for revision publication, pending-row persistence, durable annotation append and recovery. It receives the session's internal write capability; CLI/TUI callers never receive a lock or call append helpers.

- [ ] **Step 1: Failing tests** — move the existing crash-at-every-boundary protocol tests to the new owner and assert replay converges on one revision and one annotation.
- [ ] **Step 2: Run and see the new owner is missing.**
- [ ] **Step 3: Move the protocol without changing its order or behavior.**
- [ ] **Step 4: Run and confirm every recovery test passes.**
- [ ] **Step 5: Commit** ("Move checklist sign-off behind one declarative operation").

### Task 5.2: The controller writes `checklist` annotations

**Files:**
- Modify: `lib/eval/label/controller.ts` (session items come from one `readRunDirectory` snapshot; sign-off constructs one `ChecklistSignoffRequest` and calls `commitChecklistSignoff`; no publication or append order remains in the controller), `lib/eval/label/annotations.ts` (fold now via the snapshot's effective annotations), `lib/eval/label/session.ts`
- Modify: `lib/eval/label/labelTui.ts` (left pane shows the trace's input and output from `evalRecordFor(trace)`; when there is no output, show the last assistant message clearly marked "last message (no recorded output)")
- Modify: `lib/cli/eval/label.ts` (`agency label <dir> --checklist <file> [--annotator <id>]`; `--dataset` removed), `lib/cli/eval/labelCommand.ts`
- Delete: `lib/eval/label/dataset.ts`, `corpus.ts`, `occurrences.ts`, `ids.ts` (record ids), `datasetWriter.ts`, `labelingHost.ts`, the whole `lib/eval/label/load/`, `lib/cli/eval/ingest.ts`, all their tests
- Test: `lib/eval/label/controller.test.ts` (crash-at-every-fault-point tests must still converge on one row), `lib/cli/eval/label.test.ts`

- [ ] **Step 1: Failing tests** — open a session on a fixture dir with two traces; sign off the first → one `checklist` row for that traceId; simulate a crash after publish-before-append and reopen → still exactly one row; a stale item (a live question with no answer) scores `null`.
- [ ] **Step 2–5.** Commit ("agency label reads a run directory and appends checklist annotations; ingest and the label store are gone").

**Phase 5 PR checklist:** rewrite `docs/dev/eval-labeling.md` down to what remains (identities: trace id, checklist revision, question id, annotation id, session id; sign-off protocol; why the lock; the per-question fold) and delete the store sections. Owner: `docs/site/cli/eval.md` labeling section.

---

# Phase 6 — Optimize and the viewer read annotations

### Task 6.1: The optimizer reads scores, notes and checklists as feedback

**Files:**
- Modify: `lib/optimize/baseOptimizer.ts` (after `runSuite` + `gradeSuite`, call `readRunDirectory` once; reflection feedback = grader feedback as today + every `note.text` + each unchecked checklist question's text from the snapshot), `lib/optimize/gepaReflect.ts` (prompt shows `Input:` not `Task:`), tests

- [ ] **Step 1: Failing test** — a candidate dir with a note "too slow" produces a reflection prompt containing "too slow".
- [ ] **Step 2–5.** Commit ("optimize: notes and checklist misses feed reflection").

### Task 6.2: `agency logs <dir>` opens a run directory and shows annotations

**Files:**
- Modify: `lib/cli/logsView.ts` (a directory containing `statelog.jsonl` is loaded through `readRunDirectory`; the trace tree shows a one-line annotation summary per trace: `n notes · score 0.7 · labeled`), `lib/logsViewer/summary.ts`, tests

- [ ] **Step 1–5.** Commit ("logs viewer opens a run directory and shows annotations").

### Task 6.3: `agency run --capture-workdir`

**Files:**
- Modify: `scripts/agency.ts:418` (`agency run`), `lib/config.ts` (`run.captureWorkdir?: string` = a run directory path); at exit, call `addToRunDirectory({ dir, statelogFiles: [logPath], codeEntries: [], annotationFiles: [], workdir: { sourceDir: cwd, traceId } })` once.

- [ ] **Step 1: agency-js test** — run a trivial agent with `--capture-workdir out/` and assert `out/statelog.jsonl`, `out/workdir/<traceId>/`.
- [ ] **Step 2–5.** Commit ("agency run --capture-workdir writes a run directory").

**Phase 6 PR checklist:** dev notes for `docs/dev/writing-optimizers.md` (feedback sources) and `docs/dev/logs-viewer.md` (run directory + annotation summary). Owner: `docs/site/cli/run.md`, `logs.md`, `optimize.md`.

---

## Self-review against the spec

- Run directory shape (statelog / annotations / code by hash / workdir by trace / checklists / private lock): Tasks 2.2–2.5 and 5.1.
- Statelog additions (code identity, input): Tasks 1.1–1.3.
- Annotation kinds `note`/`checklist`/`score`/`run`, named payload types, deterministic ids, completed-pass score folding, annotator-isolated checklist folding, revision-based machine annotator ids and durability: Tasks 2.2 and 2.5; declarative callers: 3.3 (note), 4.3 (score), 4.2 (run), 5.1–5.2 (checklist).
- Declarative boundary: `readRunDirectory`, `addToRunDirectory`, `recordCompletedRun`, `recordNote`, `recordGradingPass`, and `commitChecklistSignoff` are the public domain operations. Locks, append repair, safe replacement and mutation order remain private.
- Phase independence: every phase typechecks and ships on its own — 3.4 keeps the two label services alive until 5.2; 4.1 is one atomic rename with a completeness search.
- Lock kept but hidden from general callers, readers lock-free, checklist draft the only draft: 2.3, 2.5, 5.1.
- Existing statelog parser reused and extended: 2.1. Digest merge; `cat` readable-not-validated: 2.1 (canonical digest; readers drop byte-identical duplicate lines and make no other promise), 2.4 (conflict detection only while streams are separate).
- Anti-pattern checks: no conditional spread construction, nested ternaries, single-character sample names, direct recursive deletion, parallel statelog parser, or caller-owned lock choreography. Named types replace nested inline contracts; `lint:structure` runs in every phase.
- Commands removed (`extract`, `ingest`, `eval optimize`, `l` key, store internals): 0.1, 3.4, 4.4, 5.2. Added (`logs extract`, `runs add`, `note`, `runs list`): 3.1–3.3. Changed (`eval run`, `eval grade`, `label`, `optimize`, `logs`, `run --capture-workdir`): 4.2, 4.3, 5.2, 6.1, 6.2, 6.3.
- Vocabulary (`test`/`input`/`suite`, grader context `test`): 4.1, 4.3.
- Migration: none, by decision.
- Open questions from the spec left open on purpose: command namespace (`runs`), test inlining in `run` rows (inline for now), judge-row volume (one file), multi-trace agent sessions (verify against a real session in Phase 6.2 and note the result in `docs/dev/run-directory.md`).

Type names used consistently: `Trace`, `RunDir`, `Annotation`, `Annotator`, `Score`, `CodeIdentity`, `ClosureFile`, `RunSummary`, `Test`.
