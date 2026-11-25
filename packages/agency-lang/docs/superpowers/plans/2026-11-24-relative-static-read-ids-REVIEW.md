# Architecture review: relative module ids in `__readStatic` calls

Plan: `docs/superpowers/plans/2026-11-24-relative-static-read-ids.md`

The plan is the right size for the problem. It needs one correction and one line in the PR description.

## Major features and public API

The plan changes the compiler's output, which every Agency program goes through. The change is narrow. Only the third argument of `__readStatic` changes, and the runtime uses that argument only in one error message. No program behaves differently.

The change does have one effect outside that message. A checkpoint records a fingerprint of each module it is paused inside: a hash of that module's generated code (`docs/dev/runtime/checkpoint-code-fingerprints.md`). When the generated code changes, resuming the checkpoint is refused. This fix changes the generated code of every module that reads an imported name as a value. That includes 30 modules of the built-in agent, among them `turn.agency`, `session.agency`, and `shared.agency`.

What that means for users after the release:

1. A terminal session that waits for the user is paused in `core.agency`, which this fix doesn't change. `agency agent --resume` still works for those sessions.
2. A session saved while it was waiting on an approval in the middle of a turn has frames in `turn.agency`. Resuming it will be refused.
3. A served agent with a paused run inside one of its own modules that reads an imported name will refuse that run after a redeploy.

The fingerprint doc already lists this as a known limit: an agency-lang upgrade that changes a module's generated code refuses paused runs inside it. PR #1568 changes several of the same agent modules in the same release, so this fix adds little to what that release already does. It is worth one sentence in the PR description, so the release notes can mention it.

## Effort and impact

| Task | Effort | Impact | Verdict |
|---|---|---|---|
| 1. Print the id with `displayModuleId`, test it, update `init-topsort.md` | About 1 hour | Medium: it keeps the builder's paths out of every release and makes builds match across machines | Do it |
| 2. Rebuild and check the output | About 15 minutes | It proves the release is clean | Do it, after fixing the command below |

The docs change is two sentences in an existing section. The new test compiles two small files once. Both are proportionate to the fix.

## Correction: Task 2's check searches a folder that doesn't exist

Task 2 Step 2 runs:

```bash
grep -rlE '__readStatic\([^)]*"/' dist/lib dist/stdlib | wc -l
```

There is no `dist/stdlib`. The stdlib compiles to `.js` files next to its sources in `stdlib/`. The package publishes `./stdlib/**/*.js` from that folder. Change the command to search `dist/lib stdlib`.

The background section also says the 30 files are "under `dist/lib/agents` and `dist/stdlib`". All 30 are under `dist/lib/agents`. The compiled stdlib in `stdlib/` has none today, because its imports are `std::` imports.

## The 80/20 rule

The plan is already the smallest fix: one argument passed through a function that exists. The issue suggested writing the import specifier for a `pkg::` import. The plan rejects that for a good reason: the registry calls for the same module already use `displayModuleId`, so one function gives one printed name everywhere.

## Reusing code

The plan reuses `displayModuleId` and adds no new function or type. Exporting it from `sectionAssembler.ts` is fine, because `typescriptBuilder.ts` already imports from that file.

## Tying concepts together

The plan ties the `__readStatic` id to the registry ids, so a module has the same printed name in every generated call. That tie is wanted: an error that names a module should name it the way the rest of the generated code does. A future change to `displayModuleId` will change both, which is the right result.
