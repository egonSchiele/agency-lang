# Editor and coding-agent integration

Agency ships with two small servers — one over the Language Server Protocol, one over MCP — that you can wire into editors and coding agents.

## Language Server (LSP)

```
agency lsp
```

Starts the Agency Language Server over stdio. Most editor extensions launch this for you, so you usually don't need to call it directly.


The Agency [VSCode extension](/appendix/vscode-extension) uses this to provide syntax highlighting, typechecking, and other editor features.

### Coding agent integration
If you'd like to use Agency with a coding agent, you can scaffold the right configuration with:

```
agency lsp setup claude-code codex
```

Supported targets: `claude-code`, `codex`, `opencode`, `pi`. You can pass one or more targets in a single command.

## MCP server

```
agency mcp
```

Starts the Agency MCP server over stdio. This exposes Agency-aware tools (typecheck, parse, run a node, etc.) so a coding agent can interact with your Agency code through MCP.

To configure your coding agents to talk to this MCP server, use:

```
agency mcp setup
```

This is interactive — it'll ask which coding agents you want to set up and write the corresponding config for you.
