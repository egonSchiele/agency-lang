---
name: "jobs"
description: "Read, stop, and list the shell commands running in the background."
---

# jobs

A background job is a shell command that keeps running while the program
  does other work, such as a download, a server, or a forty-minute
  benchmark. `startJob` in `std::safeBash` starts one, after asking the same
  questions `safeBash` asks for the same command. This module reads a job's
  output, waits for it, stops it, and lists the jobs.

  ```agency
  import { startJob } from "std::safeBash"
  import { jobOutput, stopJob } from "std::jobs"

  node main() {
    handle {
      startJob("./run-comparison.sh")
      const report = jobOutput("job-1", wait: 300)
      print(report)
      stopJob("job-1")
    } with (intr) {
      return approve()
    }
  }
  ```

  Jobs belong to the run that started them. They are not saved in a
  checkpoint, because a running process cannot be saved. A job stops when
  its run ends, and when the run pauses to hand an interrupt to its caller.
  After that, reading the job returns a failure that says so.

  None of these functions raises an interrupt. A job exists only because
  its command was approved when it started, and its output is what
  `safeBash` would have returned under the same approval. Stopping a job
  can only undo what that approval allowed, and an id names a job from the
  run's own table, so a call can never reach a process the run did not
  start. A policy that wants to keep a program from using jobs rejects
  `std::bash` and `std::exec`, which keeps any job from starting.

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/jobs.agency#L48))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/jobs.agency#L60))

## Functions

### jobOutput

```ts
jobOutput(id: string, wait: number = 0): Result<JobReport>
```

Read what a background job has printed since you last read it, and its state. Each call returns only output not returned before. A job that has ended reports its exit code.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| id | `string` |  | The job id, such as job-1. |
| wait | `number` | 0 | Seconds to wait before reading, at most 600. The call returns early when the job ends. A wait can be cancelled without stopping the job. |

**Returns:** `Result<JobReport>`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/jobs.agency#L80))

### stopJob

```ts
stopJob(id: string): Result<JobReport>
```

Stop a background job and everything it started, and return its last output.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| id | `string` |  | The job id, such as job-1. |

**Returns:** `Result<JobReport>`

**Needs:** `subprocess`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/jobs.agency#L92))

### listJobs

```ts
listJobs(): JobSummary[]
```

List the background jobs of this run: each one's id, command, state, and running time.

**Returns:** `JobSummary[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/jobs.agency#L102))
