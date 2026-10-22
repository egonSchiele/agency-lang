# Resume command

`agency resume <checkpoint-file> <input.agency>` compiles the original program
and resumes it at the checkpoint's saved source location. The command owns a
complete CLI run. The debugger rewind and interrupt-response APIs remain
separate.

## Process boundary

The parent CLI validates and resolves the checkpoint path, parses overrides,
and compiles the input with the same options as `agency run`. It then starts the
compiled child with four environment carriers:

- `AGENCY_RESUME_FILE` is the absolute checkpoint path.
- `AGENCY_RESUME_OVERRIDES` is JSON with `locals`, `args`, and `globals`
  objects.
- `AGENCY_RESUME_EDITS` is a JSON array of edits (`checkpoint-patch.md`), from
  `--edit` and `--edits`; absent when there are none.
- `AGENCY_RESUME_FORCE` is set when `--force` allows an unverifiable signed
  checkpoint.

`withRootCarriers` clears all four variables for every child launch, including
fresh runs. This prevents a nested or shell-inherited resume request from
silently changing a later run.

The generated executable calls `runCliEntry`. With no resume carrier it calls
`main` as before. With a carrier it reads and validates the checkpoint, then
calls the generated private `__resumeFromCheckpoint` binding with the
checkpoint, the overrides, and the edits. That binding supplies the compiled
module's `__globalCtx` to `resumeCliFromCheckpoint`. The edits are checked
against the edit schema twice: in the parent, so a wrong `--edit` is refused
before anything is compiled, and again in the child, since the carrier is an
environment variable anything could have set. The
public `rewindFrom(checkpoint, flatLocalOverrides, opts?)` export is unchanged.

## Shared restore setup

`restoreForResume` in `lib/runtime/resumeSetup.ts` is used by direct CLI resume,
interrupt response, and debugger rewind. It checks code fingerprints before
restoring state. It reinstalls the root policy handler and host budget. It also
reloads providers, registers top-level callbacks, and applies overrides.
Handlers are not serialized, so every resumed execution installs the root
policy again.

The direct CLI path uses the same resume loop as interrupt response. A resumed
run can therefore interrupt again. Completion emits the agent lifecycle end,
writes the trace footer, flushes statelog work, and releases the execution
context. A new interrupt pauses the trace without a footer because the run has
not finished. The result carries `usage` and `traceId`, the same two fields
`runNode` puts on a fresh run's result.

The resumed run logs into the paused run's statelog trace. The checkpoint
carries the trace id it was taken under, and `resumeCliFromCheckpoint` uses it
when nothing else names a trace: a subprocess's inherited id and
`AGENCY_TRACE_ID` both come first, so a harness that gives a process tree one
trace keeps it. With the span ids that `runPrompt` saves in its frame (see
"Span ids across a resume" in `../hosting/statelog.md`), the resumed events
then land in the spans the paused run opened, and a viewer reads the two
invocations as one story.

Two things follow from that. A checkpoint file is not used up by a resume, so
resuming the same file twice (after a failure, say) puts both attempts into
one trace, with the same span ids; the viewer shows them as one story, and in
`traceDir` mode both append to one `.agencytrace` file. That is deliberate:
the attempts are one piece of work on one checkpoint. And because the id
becomes part of that file name, `resolveInvocation` trusts a checkpoint's
trace id only when it has the shape the runtime mints (letters, digits, `_`
and `-`, at most 64 characters); any other value gets a fresh id, so an
edited checkpoint cannot steer the trace file outside `traceDir`.

## Integrity and code identity

`runCliEntry` validates the checkpoint before checking its signature. A signed
checkpoint must verify with a configured current or retired key unless the user
passes `--force`. Unsigned checkpoints do not require a key. Code fingerprints
are checked after the generated program is loaded, so a checkpoint cannot
resume against changed source code. Agency-only compilation uses the original
source paths as stable module identities and emits code fingerprints too.

## Overrides and program arguments

The repeatable flags `--local-var`, `--arg`, and `--global-var` accept
`name=value`. Agency parses each value as JSON when possible and otherwise uses
the text unchanged. Each becomes an edit on the checkpoint
(`checkpoint-patch.md`): a local or argument override changes the frame the
checkpoint was taken in, which inside a tool call is the tool's frame and
at one of the tool loop's own stops is the frame that called `llm()`; a
global override changes the checkpoint's module namespace. Before edits,
an override always changed the last frame of the root stack.

`--edit <json>` (repeatable) and `--edits <file>` carry edits proper, the
same `CheckpointEdit` shapes the debugger makes, applied after the overrides
and in order (`parseResumeEdits` in `lib/cli/resumeOverrides.ts`).

Process arguments are not part of a checkpoint. Each `--program-arg <value>` is
passed to the compiled child, where `std::args` can read it. With no such flags,
a resumed program receives no program arguments.

## Sandbox and run options

`run` and `resume` share compilation and launch options, including model,
local-model, policy, budget, trace, statelog, strictness, tool-loop limits,
`--agency-only`, and `--capture-workdir`. In particular, resume must pass
`--agency-only` through to both compile-time closure checking and the child
runtime sandbox.

## Key files

| File | Role |
|------|------|
| `lib/runtime/resumeSetup.ts` | Shared checkpoint restore preparation and overrides |
| `lib/runtime/cliEntry.ts` | Generated child entry selection and checkpoint verification |
| `lib/runtime/interrupts.ts` | Lifecycle-complete CLI resume and shared resume loop |
| `lib/cli/resumeOverrides.ts` | `name=value` parsing |
| `lib/cli/resumeCarrier.ts` | Checkpoint path validation and carrier serialization |
| `lib/cli/childEnv.ts` | Clears and installs child environment carriers |
| `scripts/agency.ts` | `agency resume` command and shared run options |
