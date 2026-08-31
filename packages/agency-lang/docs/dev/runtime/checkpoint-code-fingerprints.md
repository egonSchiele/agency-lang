# Checkpoint code fingerprints

A checkpoint resumes by replaying into generated code whose statements are
numbered: the saved `step` counters index into the compiled module's statement
sequence (see `docs/dev/runtime/interrupts.md`). If the code changed between
pause and resume — a statement inserted, a function edited — those counters
point at different statements, and the resume silently executes the wrong
thing. This feature makes that a refusal instead: a resume throws
`CheckpointCodeChangedError` when the source of a module the checkpoint is
paused inside has changed.

## Only referenced modules matter

The insight that keeps this from being "any redeploy kills every paused run":
a fresh call made *after* resume starts at step 0 and tolerates any code
change. Only modules with a **live frame on the saved stack** (including
frames inside `fork`/`parallel`/`race` branch stacks) are replayed mid-block,
so only those must match. You can freely edit modules the paused run merely
imports, as long as nothing was mid-flight in them.

The granularity is per module, not per scope. A per-scope design (hash each
def's generated code with the compile-variable tokens masked) was specced and
reviewed, and set aside as not worth its compiler-side machinery; the
checkpoint field is keyed by module, so per-scope can extend the keys later
without a format break. The price of per-module: editing *any* function — or
even a comment — in a module with a live frame refuses the resume.

## How it works

- **Compile time.** Each compiled module's init registers
  `registerModuleSourceHash("<moduleId>", "<sha256 of its source text>")`
  (emitted by `TypeScriptBuilder.build`, hash computed at the
  `generateTypeScript` call sites from the exact string that was parsed).
- **Runtime registry.** `lib/runtime/moduleSourceHashRegistry.ts` is a
  process-global map rebuilt whenever code loads — like `__toolRegistry`, and
  like handlers it is never serialized: fingerprints describe CODE, so they
  must come from the code actually loaded now.
- **Claim time.** `claimFrameForScope` stamps `moduleId` on the frame next to
  `scopeName` (generated function/node preambles, block setup templates). The
  runtime builtins that claim frames (`runPrompt`, `withResumableScope`
  without a module) pass an empty moduleId and are skipped.
- **Checkpoint creation.** `Checkpoint.fromStateStack` walks the serialized
  stack (`collectModuleSourceHashes`, `lib/runtime/referencedModules.ts`) and
  stores the referenced modules' hashes in a `moduleSourceHashes` field
  (`Record<moduleId, hash>`, in the zod schema per the PR #977 rule).
- **Resume.** `respondToInterruptsCore` calls
  `assertCodeUnchanged(checkpoint.moduleSourceHashes)` after the checkpoint is
  resolved and **before** `restoreState`, so an out-of-date checkpoint is
  never partially executed. A stored module that is missing from the registry
  counts as changed. Rewind and the debugger restore directly and skip the
  check on purpose — they are in-process, the code cannot have changed under
  them. The serve adapter maps the refusal to HTTP 409 with the module name.

The frame filter: a frame participates only when it has a non-empty
`moduleId` **and** that module has a registered hash. Bootstrap and
runtime-builtin frames are skipped, never treated as "missing module".

## Honest limitations

- **Not a security boundary by itself.** `moduleSourceHashes` is caller-editable
  JSON on the external path; a hostile caller can strip it. It catches honest
  drift. Paired with the checkpoint integrity checksum
  (`docs/dev/runtime/checkpoint-integrity.md`), the checksum covers the
  hashes and stripping becomes detectable.
- **Comment and whitespace edits refuse.** The fingerprint is a source hash.
- **Module identity is the cwd-relative input path** (`buildSession.ts`), so
  resuming the same unchanged program from a different working directory
  changes every moduleId and refuses; the error message names both causes.
- **A redeploy invalidates outstanding paused runs** in changed modules, with
  no override — the caller starts a fresh run. And because interrupts are
  usually raised inside stdlib `def`s (which then have a live frame), an
  agency-lang upgrade that touches those stdlib files invalidates outstanding
  paused runs too. Correct (the generated code changed) but operationally
  loud; hosts surface the 409.
