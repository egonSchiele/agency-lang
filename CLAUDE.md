# Agency Language

Agency is a domain-specific language for defining AI agent workflows. It compiles Agency code to executable TypeScript that calls an LLM's structured output API.

## The process for every feature

A request to add, change, or support something ("add X", "let's support Y", "users should be able to Z") starts this process. It is not permission to write code.

1. Answer any question in the request.
2. Write a plan in `docs/superpowers/plans/`, inside a worktree for the task.
3. Wait for the owner's plan review.
4. Build only after the owner says the plan is approved, in words such as "plan approved" or "build it".

You may skip the plan only when the owner says so for that task ("skip the plan", "just build it"). Never decide on your own that a change is small enough to skip it. When you can't tell which kind of request it is, ask in one sentence.

## Repository layout

This is a pnpm workspace. Nearly all the code is in one package:

- `packages/agency-lang/` — the language: compiler, runtime, stdlib, CLI, and agent. **Almost all work happens here**, and it has its own `CLAUDE.md` with the commands, conventions, and architecture notes for it.
- `packages/{email,github,kokoro,lora,mcp,tesseract-local,web-fetch,whisper-local}/` — published Agency packages, each a thin Agency wrapper over a TypeScript implementation. See `docs/dev/creating-packages.md`.
- `packages/eval-daytona/` — a tool package, not an Agency library: the `agency-eval-daytona` command, which runs each eval test in its own Daytona container.
- `packages/examples/` — example programs.

## Creating worktrees

Always create worktrees inside the agency-lang directory. Never create worktrees directly in the home directory.

## Guidance on writing commit messages and PR descriptions

Write every commit message and PR description in a file, then pass the file to the command (`git commit -F <file>`, `gh pr create --body-file <file>`). Writing them inline on the command line fails when the text contains an apostrophe.

## General code guidelines

- Do not add code to support symlinks. Symlink support is not important right now; where a feature would need extra machinery to handle symlinks, refuse symlinks instead.
- NEVER use dynamic imports
- Use objects instead of maps.
- Use arrays instead of sets.
- Use types instead of interfaces.
- NEVER force push or amend commits.

## General writing tips

When talking to me, or writing documentation or comments, please follow the writing tips in `~/.claude/skills/simplify-speech/general-writing-tips.md`. After drafting, check your prose against `~/.claude/skills/simplify-speech/verbal-tics.md`.

Specifically, make sure you are writing readable prose, not using jargon, and explaining things with examples where possible.

## Anti-patterns

Make sure the code you write does not have any of these anti-patterns: `packages/agency-lang/docs/dev/contributing/anti-patterns.md`
