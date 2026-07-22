---
title: Editor and coding-agent integration
description: Documents the `agency lsp` and `agency mcp` commands that expose Agency-aware tooling to editors and coding agents over the Language Server Protocol and Model Context Protocol.
---

# Editor and coding-agent integration

Agency ships with two small servers — one over the Language Server Protocol, one over MCP — that you can wire into editors and coding agents.

## Language Server (LSP)

```
agency lsp
```

Starts the Agency Language Server over stdio. Most editor extensions launch this for you, so you usually don't need to call it directly.


The Agency [VSCode extension](/guide/vscode-extension) uses this to provide syntax highlighting, typechecking, and other editor features.

### Lint findings in the editor

The language server runs the same rules as [`agency lint`](/cli/lint). An unused import renders grayed out (it carries the LSP `Unnecessary` tag), and the lightbulb menu on it offers:

- **Remove unused import '&lt;name&gt;'** — removes just that name, or the whole `import` line when it was the only name.
- **Remove all unused imports** — one action that cleans up every unused name in the file.

### Remove unused imports on save

VS Code can apply the batch removal automatically whenever you save. Add either of these to your settings — the dedicated kind only removes unused imports, while `source.fixAll` also runs any other fix-all providers you have installed:

```json
"editor.codeActionsOnSave": {
  "source.removeUnusedImports": "explicit"
}
```

```json
"editor.codeActionsOnSave": {
  "source.fixAll": "explicit"
}
```

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
