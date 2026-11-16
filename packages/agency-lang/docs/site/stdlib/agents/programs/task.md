---
name: "task"
description: "The Agency agent as a program that does one task and exits."
---

# task

The spawning brain starts it as a process of its own, once per task.

  ```
  agency run --detach task.log --wait-for-response task.agency -- "Summarize the README"
  ```

  It runs the minimal brain: one coder with read, bash, edit, and write. It
  answers none of the agent's approval questions, so each one reaches the
  program's host. Started with `--wait-for-response`, the program holds each
  one until a person answers it with `agency attach`.

  The one question it answers itself is a budget that ran out. It ends the
  agent there, with the reply it has so far.
