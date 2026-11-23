# Architecture review: the scratch folder

Reviews `docs/superpowers/specs/2026-11-23-scratch-dir-design.md` and `docs/superpowers/plans/2026-11-23-scratch-dir.md`. Nothing in either has been changed by this review. Findings 2, 3, and 6 need the owner's answer.

## Major features and API

The plan touches three things that matter:

- **The policy matcher.** `PolicyDirs` and `checkPolicy` are exported (`lib/runtime/portable.ts`). Finding 4 is about not breaking callers.
- **`recommended`.** It approves a file write for the first time, and it gains the first reject rule in any built-in policy. Both are deliberate and the owner agreed to them. One consequence is worth having in plain words: a user who asks the agent to write to `/tmp/report.md` cannot approve that at a prompt under `recommended`, because a reject never reaches them.
- **The run id.** It gains a second job. Finding 3 is about that.

No handler is skipped and no file operation loses its interrupt, except creating the scratch folder itself, which follows the saved-output folder.

## Finding 1: keep the run id out of `PolicyDirs`

The plan puts the finished scratch path in `PolicyDirs.scratch`. That forces every site that checks a policy outside a run to rebuild its dirs for each interrupt: a new `withScratchFor` helper, a new `runId` argument on `resolvePolicyDirs`, and edits at five sites. It also breaks a rule those sites state. `buildDecider` resolves the dirs once "so no decision reads the disk", and the plan's helper resolves a real path for each interrupt.

A smaller design does the same job. The scratch path has two parts, and they come from different places:

| Part | Example | Known from |
|---|---|---|
| The parent | `/tmp/agency-scratch-1000` | the host, once |
| The run's id part | `3f9a1c0be27d4a15` | the interrupt being checked |

So `PolicyDirs` holds only the parent, as a real path, resolved once like the other three. The matcher appends the id part from the interrupt it is already holding. `PolicyInterrupt` gains an optional `runId`.

What this removes from the plan: `withScratchFor`, the `runId` argument on `resolvePolicyDirs`, and the per-site edits in Task 2, Step 5. What is left there is to check that each site passes the whole interrupt to the matcher, and to widen the interrupt type in the MCP server's `applyPolicy`.

## Finding 2: the folder may not exist when the model is sent to it (owner's call)

The reject message names the scratch folder. Nothing in the plan guarantees the folder exists at that moment. It exists only if something called `scratchDir()` first. Two cases where it does not:

- A program other than the agent runs under `recommended` and never calls `scratchDir()`.
- An agent session is resumed after a reboot, which cleared the temp folder.

The model then writes to a folder that is not there, gets "No such file or directory", and does the natural thing:

```bash
mkdir -p /tmp/agency-scratch-1000/3f9a1c0be27d4a15
```

The plan approves that `std::mkdir`. `mkdir -p` creates the parent, `agency-scratch-1000`, with ordinary permissions. `privateDir` never changes an existing folder's mode and throws when the folder is not private. So from then on `scratchDir()` fails for that user until someone deletes the folder.

Options:

1. The agent calls `scratchDir()` at the start of every turn, not once per session. It is one cheap call, and it brings the folder back after a reboot. Programs other than the agent are told in the docstring to call it before relying on the rules.
2. The same, and `recommended` does not approve `std::mkdir` under the scratch folder, so a model cannot create the parent itself. A `mkdir` in a scratch folder that exists would then prompt, which costs a prompt for a legitimate subfolder.

I recommend the first, plus a clear error from `ensureScratchDir` that names the folder to delete.

## Finding 3: the run id is not a secret, so the folder is not a wall between runs (owner's call)

The spec says two runs with the same trace id share a folder, and treats that as a harness running one job. It is wider than that. A run id can be chosen by whoever starts the run: `options.traceId`, `AGENCY_TRACE_ID`, or a trace id in a checkpoint. `docs/dev/hosting/per-invocation-config.md` describes a client setting the trace id for one hosted invocation. Trace ids also appear in logs.

So on a server that runs several callers' invocations as one operating-system user, a caller who learns another run's trace id can start a run with it and get the same scratch folder. If the server's policy has the scratch rules, the reads and writes there are approved with no prompt.

This is the cost of tying the folder to an id whose first job is tracing. The alternatives are worse: a random name kept in the run's state cannot be seen by the code that checks a policy outside the run.

I recommend accepting it and writing it down in the dev doc in one sentence: the scratch folder keeps a user's own runs from colliding, and it is not a security boundary between runs. Callers on one server already share the launch folder under the same policy, so this adds little. The owner should confirm, because it is a statement about what the feature promises.

## Finding 4: do not break `PolicyDirs` for existing callers

`PolicyDirs` is an exported type, and many tests build one by hand. A new required field breaks every one of them. Make the new field optional. A missing value and a null value mean the same thing: the placeholder is left as written.

## Finding 5: one helper for "a per-user folder in the temp folder"

`scratchDirPath` repeats the first half of `spillFolder` in `lib/runtime/toolOutputStore.ts`: trim the temp folder, add a prefix, add the user id. `ensureScratchDir` repeats `writeCopy`'s first two lines in `lib/stdlib/spill.ts`: get a root for the temp folder and call `privateDir`. Take both halves out into one small function each and use them from both places. Then the two folders cannot drift apart in how they are named or checked.

## Finding 6: the measured impact is small (owner's call, said once)

The trace that started this work had 21 prompts. One was a write to `/tmp`. The other evidence is one logged line from an earlier session and two shipped skills that tell the model to write there.

For the owner alone there is a zero-code answer today: answer "always approve when" once for writes under `/private/tmp` and once for reads. That is not something a built-in policy can ship, because `/tmp` is shared, and it does nothing for other users. The feature is for them, and for doing it safely.

The plan is six tasks and about a day of work. It adds a fourth placeholder, the first reject rule in a built-in, and the first write approval in `recommended`. I think it is still worth building, mainly because the reject message is a mechanism the next steering problem can reuse. The owner asked for the spec and plan, so this is only to make the size of the gain visible.

## Effort and impact by task

| Task | Effort | Must-do? | Notes |
|---|---|---|---|
| 1. The path | S | Yes | Finding 5 makes it smaller. |
| 2. The placeholder | M, S after finding 1 | Yes | The largest task as written. |
| 3. `scratchDir()` and the resume test | S | Yes | The resume test is the proof of the owner's fifth decision. |
| 4. The rules | S | Yes | The table of fifteen cases is the right size: each row is a different rule or order. |
| 5. Telling the agent | S | The prompt line, yes. The skills, yes. | Finding 2 changes where the call goes. |
| 6. Dev docs | S | Yes | One new doc and three edits. In proportion. |

CI cost is small: unit tests, one Agency test, one agency-js test.

## The 80/20 check

I looked for a smaller design and considered one folder per user, with a fixed name like the saved-output folder. It needs no run id anywhere. I do not recommend it. Models pick the same names every time, such as `out.log` and `pr-body.md`. Two agent sessions running at once would overwrite each other's files, and one would post the other's PR body. The owner runs several sessions at once. Finding 1 gets most of the simplicity back without giving up a folder per run.

## Concepts

One new concept for a policy author: `<scratch>`. It is the fourth placeholder of a kind they already know. One new behavior: a reject message can hold a placeholder. One new function for an Agency programmer: `scratchDir()`. That is a fair price.
