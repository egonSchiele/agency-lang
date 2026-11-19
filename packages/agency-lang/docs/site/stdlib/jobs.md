---
name: "jobs"
description: "Start, read, stop, and list the shell commands running in the background."
---

# jobs

A background job is a shell command that keeps running while the program
  does other work, such as a download, a server, or a forty-minute
  benchmark. `start` here, or `startJob` in `std::safeBash`, starts one,
  after asking the same questions `safeBash` asks for the same command.
  This module reads a job's output, waits for it, stops it, and lists the
  jobs.

  ```agency
  import { shellJob, start, output, stop } from "std::jobs"

  node main() {
    handle {
      const job = start(shellJob("./run-comparison.sh", label: "comparison"))?
      print(output(job))
      stop(job)
    } with (intr) {
      return approve()
    }
  }
  ```

  The tools a model calls, `startJob`, `jobOutput`, `stopJob`, and
  `listJobs`, name a job by its id, such as `job-3fa9c1`, in place of a
  handle.

  A job is a process of its own, and it outlives the program that started
  it. It keeps running until its command exits, it reaches its time limit
  (60 minutes unless the start says otherwise, 720 at most), or it is
  stopped, with `stop`, `stopJob`, or `agency jobs stop` at a terminal. A
  program that starts a job and returns leaves the job running. The run
  keeps the list of jobs it started in every checkpoint, so a pause, or a
  resume in another process, does not lose one. A job cannot be started
  inside a `run()` subprocess.

  A job's output is saved under `~/.agency/jobs/`, and stays there after
  the job ends, until `agency jobs clean` removes it. Anything secret a
  command prints stays on disk until then. `agency jobs` lists every job
  on the machine.

  None of these functions raises an interrupt. A job exists only because
  its command was approved when it started, and its output is what
  `safeBash` would have returned under the same approval. Stopping a job
  can only undo what that approval allowed, and these functions act only
  on a job the run itself started, so a call can never reach a process
  the run did not start. A policy that wants to keep a program from using
  jobs rejects `std::bash` and `std::exec`, which keeps any job from
  starting.

  A time guard keeps counting during a wait. When it runs out, the wait
  returns the job's state at that moment, and the guard's trip is raised as
  `std::guard` right after, so every handler sees it. The job keeps running.

## Types

### JobReport

```ts
export type JobReport = {
  id: string;
  command: string;
  state: "running" | "ended" | "stopped" | "timedOut";
  status: string;
  exitCode?: number;
  runningFor: string;
  stdout: string;
  stderr: string;
  note: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/jobs.agency#L70))

### JobSummary

```ts
export type JobSummary = {
  id: string;
  command: string;
  state: "running" | "ended" | "stopped" | "timedOut";
  status: string;
  exitCode?: number;
  runningFor: string;
  unread: boolean
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/jobs.agency#L82))

### JobDescription

What to run as a job. Plain data, built before anything starts.

```ts
/** What to run as a job. Plain data, built before anything starts. */
export type JobDescription = {
  kind: "shell";
  label: string;
  maxMinutes: number
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/jobs.agency#L140))

### ShellJob

A shell command to run as a job.

```ts
/** A shell command to run as a job. */
export type ShellJob = JobDescription & { command: string; cwd: string }
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/jobs.agency#L147))

## Functions

### jobOutput

```ts
jobOutput(id: string, wait: number = 0): Result<JobReport>
```

Read what a background job has printed since you last read it, and its state. Each call returns only output not returned before. A job that has ended reports its exit code.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| id | `string` |  | The job id, such as job-3fa9c1. |
| wait | `number` | 0 | Seconds to wait before reading, at most 600. The call returns early when the job ends. A wait can be cancelled without stopping the job. |

**Returns:** `Result<JobReport>`

**Needs:** `fileRead`, `fileWrite`, `subprocess`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/jobs.agency#L103))

### stopJob

```ts
stopJob(id: string): Result<JobReport>
```

Stop a background job and everything it started, and return its last output.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| id | `string` |  | The job id, such as job-3fa9c1. |

**Returns:** `Result<JobReport>`

**Needs:** `fileRead`, `fileWrite`, `subprocess`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/jobs.agency#L121))

### listJobs

```ts
listJobs(): JobSummary[]
```

List the background jobs this session started: each one's id, command, state, and running time.

**Returns:** `JobSummary[]`

**Needs:** `fileRead`, `fileWrite`, `subprocess`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/jobs.agency#L132))

### shellJob

```ts
shellJob(
  command: string,
  label: string = "",
  cwd: string = "",
  maxMinutes: number = 60,
): ShellJob
```

Describe a shell command to run as a background job. Starts nothing.

Describes a shell command to run as a job. Starts nothing: pass the
  description to `start`.

  ```agency
  const handle = start(shellJob("./fetch-models.sh", label: "Model downloads"))?
  ```

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| command | `string` |  | One or more bash commands. |
| label | `string` | "" | What a list of jobs shows for this one. The command when empty. |
| cwd | `string` | "" | Working directory, defaulting to the agent directory or the process directory. |
| maxMinutes | `number` | 60 | Minutes the job may run before it is stopped, at most 720. |

**Returns:** [ShellJob](#shelljob)

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/jobs.agency#L159))

### start

```ts
start(description: ShellJob): Result<JobHandle> raises <SafeBashEffects>
```

Start a background job and return its handle. It asks the approvals running the command in the foreground would ask. The job keeps running after this program ends, until it exits, reaches its time limit, or is stopped. A command that cannot be a job, such as a file read, is refused and runs nothing.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| description | [ShellJob](#shelljob) |  | What to run, from shellJob. |

**Returns:** `Result<JobHandle>`

**Throws:** `std::read`, `std::guard`, `std::run`, `std::bash`, `std::write`, `std::grep`, `std::ls`, `std::glob`, `std::exec`, `std::remove`, `std::git::status`, `std::git::log`, `std::git::diff`, `std::git::show`, `std::git::blame`, `std::git::branchList`, `std::git::remoteList`, `std::git::stashList`, `std::git::add`, `std::git::commit`, `std::git::checkout`, `std::git::switch`, `std::git::branchCreate`, `std::git::branchDelete`, `std::git::stashPush`, `std::git::stashPop`, `std::git::restore`, `std::github::prGet`, `std::github::prDiff`, `std::github::issueGet`, `std::github::prFiles`, `std::github::prReviewList`, `std::github::prReviewCommentList`, `std::github::prChecks`, `std::github::issueCommentList`, `std::github::prList`, `std::github::issueList`, `std::github::issueSearch`

**Needs:** `fileRead`, `fileWrite`, `subprocess`, `env`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/jobs.agency#L184))

### status

```ts
status(handle: JobHandle): Result<JobSummary>
```

The state of a job this program started: running, ended, stopped, or timed out, with its running time.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| handle | [JobHandle](safeBash.md#jobhandle) |  | The handle start returned. |

**Returns:** `Result<JobSummary>`

**Needs:** `fileRead`, `fileWrite`, `subprocess`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/jobs.agency#L204))

### output

```ts
output(handle: JobHandle): Result<JobReport>
```

What a job this program started has printed since the last read, and its state.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| handle | [JobHandle](safeBash.md#jobhandle) |  | The handle start returned. |

**Returns:** `Result<JobReport>`

**Needs:** `fileRead`, `fileWrite`, `subprocess`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/jobs.agency#L215))

### stop

```ts
stop(handle: JobHandle): Result<JobReport>
```

Stop a job this program started, and everything it started, and return its last output.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| handle | [JobHandle](safeBash.md#jobhandle) |  | The handle start returned. |

**Returns:** `Result<JobReport>`

**Needs:** `fileRead`, `fileWrite`, `subprocess`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/jobs.agency#L226))
