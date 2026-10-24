---
title: Skills
description: Documents the `agency skills` command, which lists, prints, and installs the skills that teach a coding agent to use the debugger and the logs viewer.
---

# Skills

```
agency skills list
agency skills show <name>
agency skills install <names...> (--claude | --project | --dir <path>) [--full]
```

Agency ships skills: short markdown files that teach a coding agent, such as Claude Code, how to use one of Agency's tools. There are two:

- `debug-run` teaches the agent to look at a running program with [`agency debug session`](/cli/debug#driving-the-debugger-from-a-script): when to attach, what to look at first, to ask before stopping a program you are watching, and to leave the run's state alone unless you say so.
- `debug-logs` teaches the agent to read a run's log with [`agency logs session`](/cli/logs#comments-and-sessions), starting from the row your cursor is on in the viewer, and to answer your comments on the rows they are about.

## list and show

`agency skills list` prints each skill's name and description. `agency skills show debug-run` prints the skill's markdown, frontmatter included, so you can paste it into any agent's setup or save it as a skill file yourself.

## install

`agency skills install` writes a skill file for you. Say where with one of three flags:

- `--claude` writes to `~/.claude/skills/`, where Claude Code finds skills for every project.
- `--project` writes to `.claude/skills/` in the current directory, for one project.
- `--dir <path>` writes to any skills directory, for an agent that keeps its skills somewhere else.

```
$ agency skills install debug-run debug-logs --claude
Installed debug-run at /Users/you/.claude/skills/debug-run/SKILL.md
Installed debug-logs at /Users/you/.claude/skills/debug-logs/SKILL.md
```

The file it writes is a stub, not a copy of the skill:

```markdown
---
name: debug-run
description: "Look at a running Agency program with the debugger, through agency debug session. Use when an Agency run is stuck, slow, or doing the wrong thing while it is still running."
---

<!-- Written by `agency skills install`. Run it again to refresh this file. -->

Run `agency skills show debug-run` and follow what it prints. It prints the instructions that match the agency you have installed.
```

The description tells the agent when to use the skill. The instructions come from `agency skills show`, so they always match the commands and flags of the `agency` you have installed. A copied skill would keep naming a flag after a new version renamed it. The stub needs `agency` on the agent's `PATH`, which the skill's commands need anyway.

`--full` writes the whole skill instead of the stub. Use it when the agent runs somewhere `agency skills show` cannot, and run `install` again after you upgrade.

Running `install` again replaces a file it wrote before. It does not overwrite a `SKILL.md` that someone else wrote: it stops and asks you to remove that file first. It also refuses to write through a symlink at the skill's folder or file.
