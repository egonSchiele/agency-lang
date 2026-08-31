# Checkpoint code fingerprints

A checkpoint resumes by replaying into generated code whose statements are
numbered: the saved `step` counters index into the compiled module's statement
sequence (see `docs/dev/runtime/interrupts.md`). If the code changed between
pause and resume, those counters point at different statements and the resume
silently executes the wrong thing. Code fingerprints turn that into a refusal:
resuming throws `CheckpointCodeChangedError` when the source of a module the
checkpoint is paused inside has changed, and the serve adapter maps that to
HTTP 409.

Only modules with a live frame on the saved stack are checked (frames inside
`fork`/`parallel`/`race` branch stacks included). A call made after resume
starts at step 0 and tolerates any code change, so modules the paused run
merely imports can be edited freely.

## How it works

- Each compiled module registers its identity as its file's last statement:
  `__registerModuleFingerprint("<moduleId>", sha256(generated code), import.meta.url)`.
  The hash covers the module's printed output up to that line — the thing
  resume actually replays into — so a change from ANY source (the module's
  code, a splice generator, a template, the compiler itself) changes it. The
  emitted bytes carry no timestamp, so identical input emits identical bytes
  and incremental emit stays byte-identical; the registry derives "compiled
  at" from the artifact's mtime instead.
- `lib/runtime/moduleFingerprintRegistry.ts` holds those entries per process.
  Like handlers, the registry is derived from loaded code and never
  serialized; it is rebuilt whenever code loads, including in a resumed
  subprocess.
- `claimFrameForScope` stamps `moduleId` on the frame next to `scopeName`. A
  frame from a checkpoint written before `moduleId` existed is backfilled on
  its matching re-claim; a re-claim from a different module throws the same
  way a scope-name mismatch does.
- `Checkpoint.fromStateStack` walks the serialized stack
  (`collectModuleFingerprints`, `lib/runtime/referencedModules.ts`) and stores
  the referenced modules' entries in the checkpoint's `moduleFingerprints`
  field.
- `respondToInterrupts` calls `assertCodeUnchanged` before `restoreState`, so
  an out-of-date checkpoint is never partially executed. The error message
  carries both compile timestamps — the code the checkpoint ran and the code
  loaded now. Rewind and the debugger restore directly and skip the check:
  they are in-process, so the code cannot have changed under them.

A frame participates only when it has a non-empty `moduleId` with a
registered entry. Runtime builtins that claim frames (`runPrompt`,
`withResumableScope` without a module) pass an empty id and are skipped.

## Module identity

`moduleId` is the cwd-relative input path (`buildSession.ts`). `compileSource`
programs keep their per-compile random identity and register no fingerprint,
so their checkpoints are not covered (there is no stable key an equal
recompile could match).

## Limitations

- The field is caller-editable JSON, so by itself this catches honest drift,
  not an attacker. Paired with the checkpoint integrity checksum
  (`docs/dev/runtime/checkpoint-integrity.md`), stripping it becomes
  detectable.
- A comment edit in a referenced module refuses (comments reach the generated
  `__sourceMap`). Granularity is per module; the field is keyed by moduleId,
  so a finer-grained scheme can extend the keys later.
- Resuming from a different working directory changes every moduleId and
  refuses.
- A redeploy invalidates outstanding paused runs in changed modules, with no
  override — and since interrupts are usually raised inside stdlib defs, an
  agency-lang upgrade that touches those files does too.
