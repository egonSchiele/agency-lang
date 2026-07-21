# Project context and slash commands

## AGENTS.md

Like other coding agents, the Agency agent will look for an AGENTS.md file in your project root, and read it if it exists.

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