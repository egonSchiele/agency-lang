# Agency Language

Agency is a domain-specific language for defining AI agent workflows. It compiles Agency code to executable TypeScript that calls an LLM's structured output API.

## Repository layout

This is a pnpm workspace. Nearly all the code is in one package:

- `packages/agency-lang/` — the language: compiler, runtime, stdlib, CLI, and agent. **Almost all work happens here**, and it has its own `CLAUDE.md` with the commands, conventions, and architecture notes for it.
- `packages/{email,github,mcp,web-fetch,whisper-local}/` — published Agency packages, each a thin Agency wrapper over a TypeScript implementation. See `docs/dev/creating-packages.md`.
- `packages/examples/` — example programs.

## Creating worktrees

Always create worktrees inside the agency-lang directory. Never create worktrees directly in the home directory.

## Guidance on writing commit messages and PR descriptions

If you try to write commit messages with apostrophes right on the command line, you will get an error. I'm telling you this now because you do this every time. Same with PR descriptions. Instead you need to write the commit message or PR description in a file, and then pass that in to the git command.

## General code guidelines

- Do not add code to support symlinks. Symlink support is not important right now; where a feature would need extra machinery to handle symlinks, refuse symlinks instead.
- NEVER use dynamic imports
- Use objects instead of maps.
- Use arrays instead of sets.
- Use types instead of interfaces.
- NEVER force push or amend commits.

## General writing tips

When talking to me, or writing documentation or comments, please follow these general writing tips: `packages/agency-lang/docs/dev/contributing/general-writing-tips.md`

Specifically, make sure you are writing readable prose, not using jargon, and explaining things with examples where possible.

## Anti-patterns

Make sure the code you write does not have any of these anti-patterns: `packages/agency-lang/docs/dev/contributing/anti-patterns.md`
