# A run's scratch folder

Each run has a folder for temporary files. On Linux it looks like this:

```
/tmp/agency-scratch-1000/3f9a1c0be27d4a15/
```

`scratchDir()` in `std::fs` returns the path and creates the folder on first use. The built-in policies approve file work there, and `recommended` rejects a write elsewhere under `/tmp` with a message that names it.

## Where the path comes from

```
<temp folder>/agency-scratch-<user id>/<id>
```

- The temp folder is `host.system.tempDir()`, as a real path. On macOS that is a per-user folder under `/private/var/folders`. `scratchDir()`, the agent's project context, and a reject message all spell the folder this one way, which is also how file effects spell it in their payloads.
- The parent, `agency-scratch-<user id>`, is named and created the way the saved-output folder `agency-spill-<user id>` is (`lib/runtime/userTempFolder.ts`). `privateDir` makes it for this user alone and throws when an existing folder is someone else's.
- `<id>` is the first 16 hex characters of `sha256("agency-scratch:" + runId)` (`scratchId` in `lib/runtime/scratchDir.ts`).

The path is computed every time and stored nowhere. Three things follow.

**It survives an interrupt and resume.** A resume takes its run id from the paused interrupt (`resolveInvocation` in `lib/runtime/invocationOptions.ts`), so the run computes the same folder afterward, in the same process or a new one. Nothing new is saved in a checkpoint.

**A subprocess shares its parent's folder.** A child run inherits the parent's run id.

**Code outside the run can compute it.** `agency run --interactive`, the agent's terminal session, and the MCP server check a policy with a host and an interrupt in hand, and no access to the paused run. Every interrupt carries `runId`.

## Why the run id is hashed

A run id can be supplied by whoever starts the run: a trace id option, `AGENCY_TRACE_ID`, or a trace id in a checkpoint. It may hold any characters. The hash is always sixteen safe ones, so no run id names a path outside the parent. Someone who edits the run id in a checkpoint can only move the run to another folder under the same parent.

## What the folder does not promise

It keeps one user's runs from overwriting each other's files. It is not a security boundary between runs. Two runs given the same trace id share a folder, and a trace id is not a secret.

## The `<scratch>` placeholder

`<scratch>` in a policy rule's path field stands for the scratch folder of the run that raised the interrupt. `PolicyDirs` has two optional fields for it:

- `scratchParent`: the parent's real path, resolved once from the host by `resolvePolicyDirs`.
- `scratch`: one run's folder. An execution context sets it for its own run when it is built (`withRunScratch`), so code inside a run needs nothing more.

Outside a run, `scratch` is absent. `checkPolicyExplicit` then builds it from `scratchParent` and the interrupt's `runId`. With neither, the placeholder stays as written and the rule matches nothing.

A reject rule's message has its named placeholders filled in with plain paths, so the model reads a real folder.

## The rules

`recommended` gives `std::write` three rules, and their order matters because the first match wins:

1. Approve under `<scratch>`. On Linux the scratch folder is under `/tmp`, so this comes before the reject.
2. Propagate for the launch folder. A project can live under `/tmp`, and its writes must still reach the user.
3. Reject under `/tmp` and `/private/tmp`, with the message `Write temporary files under <scratch> instead.`

The read effects, `std::writeBinary`, `std::edit`, `std::mkdir`, and `std::remove` get an approve rule for the scratch folder and no reject. A read elsewhere in `/tmp` still prompts, because a user may ask for one and a reject never reaches them.

A rule in this list means what it means only in this order. That is why a session with a policy of its own takes nothing from the saved policy (`sessionRunPolicy`, `docs/dev/agents/session-driver.md`).

## No setter, and no delete

Nothing sets the folder's location: no function, flag, setting, or environment variable. A call that moved it could turn "writes to the scratch folder need no approval" into "writes to the policy file need no approval".

The runtime does not delete the folder. A run paused on an interrupt has not ended, and it must find its files when it resumes. The operating system clears the temp folder.

## Making sure the folder exists

The reject message sends the model to the folder, and the policy approves a write or a `mkdir` there. If the folder were missing, the model's own write would create it, and its parent, with ordinary permissions. `privateDir` never changes an existing folder's mode, so every later `scratchDir()` for that user would fail until someone deleted the parent.

So the runtime makes the folder itself. `createExecutionContext` (`lib/runtime/state/context.ts`) calls `ensureScratchDir` right after it sets the run's id. Every run, every resume, and every subprocess passes through there, so a resume in a new process after a reboot gets its folder back. A failure is ignored, which keeps a host with no temp folder working. The cost is one empty folder per run under the private parent.

## Files and tests

- `lib/runtime/scratchDir.ts`, `lib/runtime/userTempFolder.ts`: the path and the folder.
- `lib/runtime/policy.ts`, `lib/runtime/policyDirs.ts`: the placeholder.
- `lib/runtime/builtinPolicies.ts`: the rules.
- `stdlib/fs.agency`: `scratchDir()`.
- `lib/runtime/scratchDir.test.ts`: the path, the placeholder, and the rules.
- `tests/agency/stdlib/scratch-dir-basic.agency`, `tests/agency-js/scratch-dir-resume/`: the function, and the path and a file across an interrupt and resume.
