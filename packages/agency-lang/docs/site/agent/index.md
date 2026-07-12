# The agency agent

Agency ships with a built-in coding agent. It is an autonomous assistant that
plans, writes and edits code, runs shell commands, searches the web, and reviews
its own work. Every action that touches your machine runs under an approval
policy you control.

Launch it from any project directory:

```bash
agency agent
```

That starts an interactive session. Ask it to write a function, explain a
compiler error, tour a module, or just chat. You can also run it once and exit,
or pipe input to it like any Unix tool. See [Running the agent](/agent/running).

## How it works

The agent is a small team, not one model. A **coordinator** reads your message
and hands it to the right specialist:

- a **code** agent that reads, writes, and runs code,
- a **research** agent that searches the web and fetches pages,
- an **oracle** and an **explorer** for deep reasoning and broad codebase tours,
- a **review** agent that checks Agency code for errors.

Each specialist runs in its own context with its own tools. See
[The agent team](/agent/subagents).

## What you can configure

- **[Running the agent](/agent/running)** — interactive, one-shot, and seeded
  modes; the CLI flags; the agent home directory.
- **[The agent team](/agent/subagents)** — the coordinator and its five
  specialists, and when each one runs.
- **[Models and settings](/agent/models)** — pick models per role, use local
  models, and tune per-model capabilities.
- **[Approvals and policies](/agent/approvals)** — control what the agent may do
  without asking, and what it must ask about first.
- **[Memory](/agent/memory)** — let the agent remember facts across runs.
- **[Project context and slash commands](/agent/project-context)** — teach the
  agent your project's conventions and add your own commands.
- **[MCP servers](/agent/mcp)** — give the agent tools from external
  [Model Context Protocol](https://modelcontextprotocol.io) servers.

For the raw flag reference, see the [`agency agent` CLI page](/cli/agent).
