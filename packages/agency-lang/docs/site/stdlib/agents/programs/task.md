---
name: "task"
description: "The Agency agent as a program that does one task and exits."
---

# task

The spawntest brain starts this program as a process of its own, once per task.

  ```
  agency run --detach task.log --wait-for-response task.agency -- "Summarize the README"
  ```

  It runs the minimal brain: one coder with read, bash, edit, and write. It
  answers none of the agent's approval questions, so each one reaches the
  program's host. Started with `--wait-for-response`, the program holds each
  one until a person answers it with `agency attach`.

  The agent stops at `agencyAgent`'s own budget, $50 and 30 minutes, with
  the reply it has so far.
