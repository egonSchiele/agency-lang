# The agency agent

Agency ships with a built-in coding agent — an autonomous assistant that plans,
edits code, runs commands, and researches, all under an approval policy you
control. Launch it with `agency agent` (see the [`agency agent` CLI
reference](/cli/agent)).

This section covers ways to extend and configure the agent.

- **[MCP servers](/agent/mcp)** — give the agent tools from external
  [Model Context Protocol](https://modelcontextprotocol.io) servers (filesystem,
  GitHub, databases, …), with every call gated by the approval policy.
