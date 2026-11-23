# A scratch folder for each run

## The problem

An agent writes temporary files to `/tmp` by habit:

```bash
pnpm test > /tmp/out.log 2>&1; tail -20 /tmp/out.log
```

Under the built-in `recommended` policy this line asks three questions: `std::exec` for `pnpm test`, `std::write` for `/tmp/out.log`, and `std::read` for the same file. `recommended` approves no file write at all, and it approves reads only under the launch folder and a few named folders. One of our own shipped skills tells the model to write `/tmp/pr-body.md`.

Approving all of `/tmp` would stop the prompts, but `/tmp` is shared with every other program the user runs. The agent could then read and overwrite their temporary files with no prompt.

## The design in one example

Each run gets a folder of its own. On Linux it looks like this:

```
/tmp/agency-scratch-1000/3f9a1c0be27d4a15/
```

The agent learns the path from its project context. With the scratch folder, the model writes:

```bash
pnpm test > /tmp/agency-scratch-1000/3f9a1c0be27d4a15/out.log 2>&1; tail -20 /tmp/agency-scratch-1000/3f9a1c0be27d4a15/out.log
```

It asks `std::exec` for `pnpm test`. The policy approves the write and the read.

When the model writes to plain `/tmp` anyway, the policy rejects the write, and the model reads why:

```
interrupt rejected: Write temporary files under /tmp/agency-scratch-1000/3f9a1c0be27d4a15 instead.
```

The model repeats the line with the scratch path. The user is not prompted either time.

## Decisions the owner made

These came out of the design discussion on 2026-11-23.

1. The agent is told about the folder by a reject rule with a message, at the moment it writes to `/tmp`. A line in the prompt alone is a request, and a request is not enough.
2. The policy file holds a placeholder, `<scratch>`, and never a path.
3. Nothing inside a run can set where the scratch folder is. There is no setter in the stdlib.
4. The stdlib exposes one function, `scratchDir()`, which returns the path and creates the folder on first use.
5. The folder's name survives an interrupt and resume.

## Where the name comes from

The name is computed from the run's id. It is not stored anywhere.

```
<temp folder>/agency-scratch-<user id>/<first 16 hex characters of sha256("agency-scratch:" + runId)>
```

This is what makes decision 5 hold with no new state. The runtime already carries a run's id across a pause and resume: `resolveInvocation` in `lib/runtime/invocationOptions.ts` takes the id from the paused interrupt on a resume (`kind: "resume"`), and every interrupt carries `runId`. So the same run computes the same folder before and after a resume, in the same process or a new one.

Three more facts follow from using the run id:

- **A subprocess shares its parent's folder.** A child run inherits the parent's run id (`docs/dev/runtime/subprocess-ipc.md`).
- **Code that answers an interrupt outside the run can compute the folder too.** `agency run --interactive`, the agent's terminal session, and the MCP server each check a policy with only a host and the interrupt in hand. They have no access to the paused run's state. The interrupt's `runId` is enough.
- **Two runs given the same trace id share a folder.** A harness can set `AGENCY_TRACE_ID` for a whole tree of runs, and the trace id becomes the run id. Those runs are one job, so sharing is acceptable.

The run id is hashed for two reasons. A run id can be supplied by a caller, so it may hold any characters, and the hash is always sixteen safe ones. And the checkpoint is the program: someone who edits the run id in a checkpoint or an interrupt can only move the run to another hash-named folder under the same parent. No value of the run id can produce a path outside `agency-scratch-<user id>`.

The parent folder follows the saved-output folder, `agency-spill-<user id>` (`lib/runtime/toolOutputStore.ts`). It is created with `host.files.privateDir`, which makes a folder only the user can use and throws when an existing folder is someone else's. That check exists for a folder in a shared place where another user could create it first.

The temp folder is `host.system.tempDir()`. On Linux that is `/tmp`. On macOS it is a per-user folder under `/var/folders`, so the path is longer there.

## The stdlib function

```
export def scratchDir(): Result<string> {
  """
  Return the absolute path of this run's scratch folder, creating the folder if it does not exist yet. Use it for temporary files.
  """
}
```

It lives in `std::fs`. It raises no interrupt, because the caller chooses nothing: not the location, not the name, not the contents. The saved-output folder is created the same way, with no interrupt.

A host with no file system, such as the browser host, has no `privateDir`, and the function returns a failure.

There is no `setScratchDir` and no separate create function. `setAgentCwd` exists, and the policy doc says the policy's `.` deliberately does not follow it, because a model can call it. A scratch setter would let one call turn "writes to the scratch folder need no approval" into "writes to the policy file need no approval".

## The policy placeholder

`<scratch>` joins `<agent-home>`, `<home>`, and `<agency>`.

- `PolicyDirs` gains `scratch: string | null`.
- Inside a run, the execution context fills it from its own run id.
- Outside a run, each site that checks a policy against an interrupt fills it from `interrupt.runId`.
- When it is null, `<scratch>` is left as written and the rule matches nothing. That is what `<agency>` does today when the install folder cannot be found.

One part is new. Today a placeholder is filled in only in the path fields of a rule's `match`. A `rejectMessage` must be filled in too, so the model reads a real path. The message is filled with the plain path, with no glob escaping, for all four named placeholders.

## The rules in `recommended`

For `std::write`, in this order:

```json
[
  { "match": { "dir": "{<scratch>,<scratch>/**}" }, "action": "approve" },
  { "match": { "dir": "{.,./**}" }, "action": "propagate" },
  { "match": { "dir": "{/tmp,/tmp/**,/private/tmp,/private/tmp/**}" },
    "action": "reject",
    "rejectMessage": "Write temporary files under <scratch> instead." }
]
```

The first match wins, so the order matters:

1. The scratch folder is under `/tmp` on Linux, so its approve rule comes before the reject.
2. A project can live under `/tmp`. The agent's own tests run that way. The `propagate` rule keeps a write into the launch folder going to the user, as it does today, so the reject does not catch it.

The other effects get an approve rule for the scratch folder and no reject:

| Effect | Field | Rule |
|---|---|---|
| `std::read`, `std::readBinary`, `std::ls`, `std::glob`, `std::grep` | `dir` | approve under `<scratch>`, added to `readScopeRules` |
| `std::writeBinary`, `std::edit` | `dir` | approve under `<scratch>` |
| `std::mkdir` | `dir` | approve under `<scratch>` |
| `std::remove` | `target` | approve under `<scratch>` |

A read elsewhere in `/tmp` is not rejected. A user may ask the agent to look at `/tmp/crash.log`, and a reject rule never reaches the user, so they could not approve it. Such a read prompts, as it does today.

`with-writes` spreads `recommended` and then replaces these effects' rules, so it gets the same scratch rules. Its `std::write` order is: the propagate rules for the agent's own policy files, the scratch approve, the approve for the launch folder, then the `/tmp` reject. The launch-folder approve comes before the reject for the reason in point 2.

A saved `policy.json` does not follow `recommended`. `/policy` in the agent already lists the rules `recommended` has and the saved policy lacks, and appends them on a yes. That works for these rules with no change.

## What this changes for the user

`recommended` has approved no file write until now, so the user has seen every write before it happened. After this change the agent can write files in its scratch folder unprompted. Running one of them still asks: `node <scratch>/x.js` asks `std::exec`. But the user approves that command without having seen the file's contents. The same is true today for files in the project under `with-writes`.

## How the agent learns the path

- The agent's project context (`lib/agents/agency-agent/lib/projectContext.agency`) gains one line with the literal path, beside "Current working directory".
- The two shipped skills that say `/tmp/pr-body.md` and `/tmp/notes.md` say to use the scratch folder from the project context.
- The reject message is the enforcement. The two points above only save a wasted call.

## Changes made while building

- **How `<scratch>` is resolved.** `PolicyDirs` holds the scratch parent, resolved once from the host, and the matcher adds the run's part from the interrupt it is checking. An execution context sets the finished path for its own run. This replaced putting a finished path in `PolicyDirs` at every site.
- **A session's policy replaces the saved one whole.** A session with a policy of its own used to get the saved policy's reject rules ahead of its own rules. Carried alone, the `/tmp` reject would have rejected writes to the scratch folder on Linux, where that folder is under `/tmp`, and writes to a project under `/tmp`. The owner decided on 2026-11-23 that a session's policy should replace the saved one completely, so `sessionRunPolicy` no longer carries anything over.
- **The agent calls `scratchDir()` at the start of every turn,** so the folder exists whenever the reject message sends the model to it.
- **The folder is not a security boundary between runs.** A run id can be chosen by whoever starts the run.

## Not in this design

- **Deleting the folder.** A run that is paused on an interrupt has not ended, and it must find its files when it resumes, possibly in a new process. So the runtime does not delete the folder when a process exits. The operating system clears the temp folder. Deleting on a run's true end can be added later.
- **`TMPDIR` for the shells safeBash starts**, so that programs put their own temp files in the scratch folder.
- **Programs the agent runs.** A policy decides whether `pnpm test` runs. It cannot see what `pnpm test` writes. Only a process sandbox can confine that.
- **A host option to choose the location.** Nothing needs it yet.
- **A resume on another machine.** The temp folder and user id differ there, so the path differs and the files are gone. The folder is created empty on first use.
