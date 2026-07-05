---
name: VSCode Extension
description: Install instructions for the Agency VS Code extension and an overview of the language server (LSP) that powers editor features like typechecking.
---

# VSCode Extension

To install the VS Code extension, first clone this repo:
https://github.com/egonSchiele/agency-vscode-extension

Then, inside VS Code, trigger the command palette using command-shift-P and choose `Install Extension from Location`. Then select the `agency-vscode-extension` folder that you just cloned.

## The language server

The extension's editor features are powered by the **Agency Language Server**, which speaks the [Language Server Protocol (LSP)](https://microsoft.github.io/language-server-protocol/). It gives you syntax highlighting, typechecking, and other editor smarts as you work.

The extension starts the language server for you, so there's usually nothing to configure. Under the hood it runs:

```bash
agency lsp
```

which starts the server over stdio. You'd only run this yourself if you're wiring Agency into a different editor by hand.

## Other editors and coding agents

Not on VS Code? The same language server works with any LSP-aware editor, and Agency can scaffold the config for popular coding agents for you:

```bash
agency lsp setup claude-code codex
```

Supported targets are `claude-code`, `codex`, `opencode`, and `pi`. Agency also ships an MCP server (`agency mcp`) that exposes Agency-aware tools — typecheck, parse, run a node — to coding agents. See the [editor and coding-agent integration reference](/cli/editor-integration) for the full picture.
