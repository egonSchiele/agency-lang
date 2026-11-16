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
  installs no handler, so every question the agent raises reaches the
  program's host. Started with `--wait-for-response`, the program holds each
  one until a person answers it with `agency attach`.
