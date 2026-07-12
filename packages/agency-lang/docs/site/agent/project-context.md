# Project context and slash commands

The agent adapts to the project you launch it in. It reads your conventions from
an `AGENTS.md` file, and it picks up any custom slash commands you keep in the
project. Both are optional, and both are read from the directory you run
`agency agent` in.

## AGENTS.md

If your project root has an `AGENTS.md` file, the agent reads it at startup and
folds it into its system prompt. Use it to record conventions the agent should
follow: coding style, commands to run, things to avoid.

```markdown
# Project notes for the agent

- Run `make test` before claiming a change works.
- This project uses tabs, not spaces.
- Never edit files under `generated/` by hand.
```

The agent reads `AGENTS.md` automatically. Running the agent in the directory is
your opt-in, so no approval prompt appears for that read.

## Custom slash commands

Drop a Markdown file in `.claude/commands/` and it becomes a slash command in the
session. A file named `review.md` becomes `/review`. The file's body is the
prompt the agent runs when you type the command.

```markdown
---
description: Review the staged diff for bugs
argument-hint: [focus area]
---

Review the currently staged git diff. Point out real bugs and risky changes.
Focus on: $ARGUMENTS
```

Type `/review error handling`, and the agent runs the body with `$ARGUMENTS`
replaced by `error handling`. If the body has no `$ARGUMENTS` placeholder, the
agent appends your arguments at the end instead.

The frontmatter is optional. The agent reads two fields:

- **description** — shown next to the command in the `/help` palette.
- **argument-hint** — a hint about the arguments, shown after the description.

A file with no frontmatter still works. Its command just has no description.

Built-in commands like `/clear` always win, so a file named `clear.md` cannot
shadow them.
