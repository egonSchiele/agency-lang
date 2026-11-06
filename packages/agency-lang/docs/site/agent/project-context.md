# Project context and slash commands

## Global instructions

Put instructions you want in every project in `~/.agency-agent/AGENTS.md`:

```markdown
# My preferences

- Keep replies concise.
- Prefer pnpm for JavaScript projects.
- Explain how you tested code changes.
```

The agent reads this optional file at startup, regardless of the working
directory. Both brains and their subagents receive the instructions.
Restart the agent after editing it; continuing a saved session picks up
the new contents too. A missing or empty file adds no instructions.

If you use `--agent-home` or `AGENCY_AGENT_HOME`, put `AGENTS.md` in that
directory instead. The agent does not create the file for you.

## Project instructions

The agent reads `AGENTS.md` in the working directory. If that file is
absent, it reads `CLAUDE.md` there instead. Inside a git repository it
does the same in each parent directory, up to the repository root. Project
instructions apply alongside the global file and take precedence when
they conflict.

## Custom slash commands

The agency agent will also read any commands you have placed in `.claude/commands/`, and create a slash command that you can use in the agent. Slash command names follow the file name: a file named `review.md` becomes `/review`. Each command has a body and an optional description. The body is what gets run as a prompt by the agent if you execute that command. You can pass in arguments as well:

```markdown
---
description: Review the staged diff for bugs
argument-hint: [focus area]
---

Review the currently staged git diff. Point out real bugs and risky changes.
Focus on: $ARGUMENTS
```

Now you can type `/review error handling`, and the agent will run the body, first replacing `$ARGUMENTS` with `error handling`. 

Frontmatter options:

- **description** — shown next to the command in the `/help` palette.
- **argument-hint** — a hint about the arguments, shown after the description.

A file with no frontmatter still works, its command just has no description.
