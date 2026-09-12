# `agency resume` Command Implementation Plan

**Goal:** Add `agency resume <checkpoint-file> <input.agency>` with local,
global, entry-argument, and program-argument overrides. A resumed CLI run must
use the same compilation, sandbox, policy, budget, trace, capture, provider,
and interrupt machinery as `agency run`.

**Compatibility:** Keep the existing public compiled-module API
`rewindFrom(checkpoint, flatLocalOverrides, opts?)`. The CLI uses a new
module-bound `resumeCliFromCheckpoint(checkpoint, ResumeOverrides)` entry so the
new override buckets do not silently change existing JavaScript callers.

**Architecture:** Both interrupt responses and direct checkpoint-file resumes
restore through `restoreForResume`. The helper verifies code fingerprints,
installs the root policy handler, reloads providers, restores callbacks and
state, reapplies the host budget, and applies override buckets. The callback
`afterCheckpointRestored` lets `respondToInterruptsCore` preserve the current
`checkpointRestored` then `interruptResolved` event ordering before later
restore work can fail. `resumeCliFromCheckpoint` lives beside the existing
resume loop in `interrupts.ts`; it owns CLI lifecycle events and trace
pause/close behavior. The generated entry calls `runCliEntry`, which selects
fresh `main` or the module-bound resume function.

Program argv is process state, not checkpoint state. `agency resume` defaults
it to empty and accepts repeated `--program-arg <value>` flags for programs
that read `std::args`.

## Constraints

- Do not use dynamic imports.
- Use objects instead of maps, arrays instead of sets, and types instead of interfaces.
- Do not add symlink support.
- Modify `.mustache` templates, then run `pnpm run templates`; never edit generated template `.ts` files.
- Run `make fixtures` after changing the generated main entry.
- Run `pnpm run fmt:ts` before each implementation commit.
- Save test output to `/tmp`; do not run the full Agency execution suite.
- Put spawned Agency fixtures under this package and remove them with
  `safeDeleteDirectoryWithin`.
- Keep every `if` body in braces and name nested option/function types.
- Every resume context installs the root policy handler because handlers are
  not serialized.

## Task 1: Shared restore setup

**Files:** Add `lib/runtime/resumeSetup.ts`,
`lib/runtime/checkpointTestHelpers.ts`, and `lib/runtime/resumeSetup.test.ts`.
Modify `lib/runtime/interrupts.ts`, `lib/runtime/node.ts`,
`lib/runtime/rewind.ts`, and `lib/runtime/index.ts`.

1. Add a test helper that constructs a checkpoint directly with
   `new Checkpoint({ stack: stack.toJSON(), globals: globals.toJSON(), nodeId:
   "main", moduleId: "", scopeName: "", stepPath: "" })`. Build the top frame
   with `StateStack.getNewState()`.
2. Write failing tests for local overrides, argument/global restore overrides,
   no-op overrides, code-fingerprint refusal, root policy installation, root
   budget replacement, callback metadata, and
   `afterCheckpointRestored` ordering.
3. Add:

   ```ts
   export type ResumeOverrides = {
     locals?: Record<string, unknown>;
     args?: Record<string, unknown>;
     globals?: Record<string, unknown>;
   };
   export type ResumeMetadata = {
     callbacks?: AgencyCallbacks;
     debugger?: DebuggerState;
   };
   export type AfterCheckpointRestored = () => void;
   export type ResumeRequest = {
     checkpoint: Checkpoint;
     policy?: Policy;
     overrides?: ResumeOverrides;
     metadata?: ResumeMetadata;
     afterCheckpointRestored?: AfterCheckpointRestored;
   };
   export async function restoreForResume(
     execCtx: RuntimeContext<GraphState>,
     request: ResumeRequest,
   ): Promise<void>;
   ```

   `restoreForResume` deep-clones the checkpoint, applies local overrides,
   checks fingerprints, installs policy, reloads providers, records
   `checkpointRestored`, calls `afterCheckpointRestored`, registers top-level
   callbacks, restores state, reinstalls the root budget, applies args/globals,
   and merges metadata.
4. Replace the corresponding setup in `respondToInterruptsCore`. Emit the
   existing `interruptResolved` loop through `afterCheckpointRestored`, then
   install response data after restore completes.
5. Use `applyRestoreOverrides` in every `RestoreSignal` loop that supports
   restore options: `node.ts`, `interrupts.ts`, and `rewind.ts`.
6. Validate override keys in this shared layer, not only in the CLI parser.
   Queue argument overrides when the checkpoint is paused inside a function so
   the generated function preamble updates its live parameters.
7. Keep the public `rewindFrom` flat-local signature. It calls
   `restoreForResume(..., { overrides: { locals: overrides } })`.
8. Run the new unit test and the existing interrupt/checkpoint/rewind tests.

## Task 2: Lifecycle-complete direct resume

**Files:** Modify `lib/runtime/interrupts.ts`, `lib/runtime/index.ts`,
`lib/templates/backends/typescriptGenerator/imports.mustache`, and
`docs/dev/runtime/rewind.md`. Add an Agency-JS compatibility test.

1. Write a failing test proving the existing flat form
   `rewindFrom(cp, { mood: "happy" })` still overrides `mood`.
2. Add runtime `resumeCliFromCheckpoint({ ctx, checkpoint, overrides? })` beside
   `runResumeLoop`. It creates a run id/context, restores with
   `restoreForResume`, emits the same agent
   lifecycle/span events as an interrupt resume, runs with `endsRun: true`,
   pauses traces on interrupts, closes them with a footer on completion,
   flushes statelog requests, and cleans up on every path.
3. Keep `rewindFrom` debugger lifecycle unchanged (`endsRun: false`).
4. Add a private generated binding named `__resumeFromCheckpoint`; do not
   change the public `rewindFrom` wrapper signature.
5. Add tests for args/globals through the new binding and for a resumed run
   that raises another interrupt.

## Task 3: Checkpoint-file generated entry

**Files:** Modify `lib/constants.ts`, `lib/runtime/index.ts`,
`lib/templates/backends/typescriptGenerator/imports.mustache`, and
`lib/backends/typescriptBuilder.ts`, `lib/backends/typescriptGenerator.ts`, and
the sandboxed compiler. Add `lib/runtime/cliEntry.ts` and its test.

1. Add `AGENCY_RESUME_FILE`, `AGENCY_RESUME_OVERRIDES`, and
   `AGENCY_RESUME_FORCE` constants.
2. Write failing tests for fresh entry, unsigned resume, valid signed resume,
   tampered signed refusal, forced signed resume, malformed checkpoint JSON
   with and without a signing key, and overrides.
3. Implement `runCliEntry({ runMain, resume })`. Read and parse the checkpoint
   only when `AGENCY_RESUME_FILE` exists. Validate the checkpoint shape before
   checking a present signature, and bypass a failed check only when the force
   carrier is set.
4. Change the generated main block to:

   ```ts
   const __result = await runCliEntry({
     runMain: () => main(undefined, ..., initialState),
     resume: __resumeFromCheckpoint,
   });
   await resolveCliInterrupts(__result, respondToInterrupts);
   ```

5. Run `pnpm run templates`, typecheck, `make fixtures`, the builder test, and
   the CLI-main integration test. Fixture diffs will include runtime imports,
   the private resume binding, and the generated entry.
6. Emit fingerprint registration through the TypeScript IR before program
   execution. Agency-only compilation uses each validated source file's
   original path as its stable fingerprint identity.

## Task 4: Resume command and carriers

**Files:** Modify `lib/cli/childEnv.ts`, `lib/cli/commands.ts`, and
`scripts/agency.ts`. Add `lib/cli/resumeOverrides.ts`,
`lib/cli/resumeCarrier.ts`, their tests, and `lib/cli/resume.spawn.test.ts`.

1. Write failing tests for stale resume env clearing, carrier serialization,
   JSON-or-string `key=value` parsing, embedded equals signs, malformed
   assignments, missing checkpoint files, and null-prototype override objects.
2. Add a `ResumeCarrier` to `withRootCarriers`. Clear both resume variables on
   every child launch and set them only for a resume.
3. Resolve checkpoint paths to absolute paths and parse the three override
   buckets. Reject missing or non-file checkpoint paths.
4. Refactor CLI option registration so both `run` and `resume` receive model,
   local-model, trace/logging, strictness, tool-loop, policy, budget,
   `--agency-only`, and `--capture-workdir` options. Remove the dead `--resume`
   flags from `run` and `trace run`.
5. Add resume-only repeated `--local-var`, `--global-var`, `--arg`, and
   `--program-arg` options, plus `-f, --force`. Pass `programArg` to `run()` as
   child argv.
6. Add spawn tests for local/default overrides, argument/global overrides,
   `--program-arg`, `--approve`, no-policy interrupt reporting,
   `--agency-only` compile refusal, trace footer creation, and malformed flags.

## Task 5: Documentation

**Files:** Add `docs/dev/runtime/resume-command.md`. Modify
`docs/dev/runtime/checkpoint-integrity.md`, `docs/dev/runtime/rewind.md`,
`docs/site/guide/checkpointing.md`, `CLAUDE.md`, and
`.claude/skills/agency-runtime-docs/SKILL.md`.

1. Document the child-process carrier flow, the private CLI resume binding,
   shared restore setup, lifecycle behavior, checksum rule, sandbox parity,
   and program-argument rule.
2. Keep the existing public `rewindFrom(checkpoint, flatLocals, opts?)`
   examples and document that args/globals belong to `agency resume` and the
   internal resume request.
3. Replace the nonexistent `saveToDisk` example. Tell users to copy the JSON
   object printed by `printJSON`; warn that redirecting all `agency run`
   output also captures the launch banner.
4. Add the new dev note to both runtime indexes.

## Final verification

Run each command once and save output:

```bash
pnpm run typecheck 2>&1 | tee /tmp/resume-final-typecheck.txt
pnpm run fmt:ts
pnpm run fmt:ts:check 2>&1 | tee /tmp/resume-final-format.txt
pnpm run lint:structure 2>&1 | tee /tmp/resume-final-lint.txt
pnpm test:run <targeted unit files> 2>&1 | tee /tmp/resume-final-unit.txt
pnpm run agency test js tests/agency-js/rewind-overrides 2>&1 | tee /tmp/resume-final-rewind.txt
pnpm run agency test js tests/agency-js/resume-overrides 2>&1 | tee /tmp/resume-final-overrides.txt
pnpm run agency test js tests/agency-js/resume-reinterrupt 2>&1 | tee /tmp/resume-final-reinterrupt.txt
```

Run the resume spawn test separately. Check its trace fixture for one header
and a footer. Smoke-test debugger rewind because it remains the other caller.
Review the diff against the anti-pattern catalog, then commit, push the
`codex/agency-resume-command` branch, and open a PR against `main`.
