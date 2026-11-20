Understood. I am dropping the `learn` and handoff material. It was about subagents, which come after this.

Here is a proposal for each item on your list.

## Start: run Agency code as a background job

Add a background version of `run()` to `std::agency`. It takes the same inputs and raises the same `std::run` approval, but returns a job id at once.

```agency
const id = startRun(compiled, "main", { topic: "jobs" })
```

The name is invented. The job goes in the same job table as shell jobs, so one set of functions covers both kinds.

## 1. Responding to interrupts and resuming

When the child raises an interrupt:

1. The child's own handlers run, then the parent's handlers that were registered when the job started. If they settle it, the child carries on.
2. Otherwise the child saves a checkpoint and exits. The job's state becomes `blocked`, and the job holds the checkpoint and the pending interrupts.

To answer, the parent calls one new function:

```agency
resumeJob(id)
```

`resumeJob` raises the job's pending interrupts again, in the parent, at that line. From there the normal rules apply. The handlers around that call run, and anything they do not settle goes to the user the way any interrupt does. The answers are sent to a fresh child, which continues from the checkpoint.

This means there is no new way to answer an interrupt. In `agency agent`, the session's policy handler already shows the approval prompt, so `/jobs answer <id>` only has to call `resumeJob`. It also settles which handlers answer a parked job: the ones around the `resumeJob` call.

## 2. Checking status and reading output

The functions that exist already do this:

- `listJobs()` and `/jobs` show each job's state, which can now be `blocked`.
- `jobOutput(id)` returns what the child has printed since the last read. When the job has ended, the report also carries the node's return value.
- `stopJob(id)` stops it.

A `jobOutput` wait on a blocked job returns at once.

## 3. Messages in both directions

**From the job to the parent,** I think nothing new is needed yet. A child already has three ways to say something:

- `print`, for news that needs no reply. It arrives as job output.
- An interrupt, for a question that needs an answer. An interrupt can ask for a value as well as for approval, so this covers "which branch should I use?".
- Its return value.

**From the parent to the job** is the new part:

```agency
sendToJob(id, "Also check the error handling in jobs.ts")
```

For a child that is running an `llm()` conversation, the message is added to that conversation at the next safe point between model rounds. The runtime already has this for a conversation in the same process (`queueMessage`). The new work is carrying the message over the channel to the child. This is how you would steer a subagent that is already working.

A child that is not in an `llm()` call has nowhere to put the message. That case needs a `receive` call in the child's code, which is the mailbox idea. I would leave it out of the first version.

## On `agency test`

Set aside, as you said. For the record, the subprocess doc says `test` and `testFile` are wrappers over the same machinery as `run`, but I have not traced the code, and nothing above depends on it.

## What I would write up

A spec for `startRun`, the `blocked` state with `resumeJob`, and `sendToJob` for a child in an `llm()` conversation. If any of the three proposals is wrong, tell me which and I will rework it before writing.
