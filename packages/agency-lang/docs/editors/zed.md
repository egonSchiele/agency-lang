# Zed Extension for Agency

This guide walks you through creating a Zed editor extension that provides Agency language support via the LSP.

## Background

Zed requires a dedicated extension to integrate a custom language server. Extensions are written in Rust, compiled to WebAssembly, and bundled with a Tree-sitter grammar for syntax highlighting.

## Extension Structure

```
zed-agency/
├── extension.toml
├── Cargo.toml
├── src/
│   └── lib.rs
└── languages/
    └── agency/
        ├── config.toml
        └── highlights.scm
```

## Step 1: `extension.toml`

This is the extension manifest. It declares metadata, the language server, and the grammar.

```toml
id = "agency-lang"
name = "Agency"
version = "0.1.0"
schema_version = 1
authors = ["Your Name <you@example.com>"]
description = "Agency language support with LSP"

[language_servers.agency-lsp]
name = "Agency Language Server"
languages = ["Agency"]

[grammars.agency]
repository = "https://github.com/your-org/tree-sitter-agency"
commit = "abc123"
```

If you don't have a Tree-sitter grammar yet, you can omit the `[grammars.agency]` section and use an empty `highlights.scm` file. You'll still get LSP features (diagnostics, completions, go-to-definition, hover) but no syntax highlighting.

## Step 2: `Cargo.toml`

```toml
[package]
name = "zed-agency"
version = "0.1.0"
edition = "2021"

[lib]
crate-type = ["cdylib"]

[dependencies]
zed_extension_api = "0.1"
```

Check [docs.rs/zed_extension_api](https://docs.rs/zed_extension_api) for the latest version.

## Step 3: `src/lib.rs`

This is the core of the extension. It tells Zed how to locate and start the Agency language server.

### Option A: Use globally installed `agency` binary

This is the simplest approach. It assumes the user has `agency` installed and available in their PATH.

```rust
use zed_extension_api::{self as zed, Command, LanguageServerId, Result};

struct AgencyExtension;

impl zed::Extension for AgencyExtension {
    fn new() -> Self {
        Self
    }

    fn language_server_command(
        &mut self,
        _language_server_id: &LanguageServerId,
        worktree: &zed::Worktree,
    ) -> Result<Command> {
        let path = worktree
            .which("agency")
            .ok_or_else(|| "agency not found in PATH. Install with: npm install -g agency-lang".to_string())?;

        Ok(Command {
            command: path,
            args: vec!["lsp".to_string()],
            env: Default::default(),
        })
    }
}

zed::register_extension!(AgencyExtension);
```

### Option B: Auto-install from npm

This approach installs `agency-lang` from npm automatically, so users don't need a global install.

```rust
use zed_extension_api::{self as zed, Command, LanguageServerId, Result};

struct AgencyExtension;

impl zed::Extension for AgencyExtension {
    fn new() -> Self {
        Self
    }

    fn language_server_command(
        &mut self,
        _language_server_id: &LanguageServerId,
        _worktree: &zed::Worktree,
    ) -> Result<Command> {
        let version = zed::npm_package_latest_version("agency-lang")?;
        zed::npm_install_package("agency-lang", &version)?;

        Ok(Command {
            command: zed::node_binary_path()?,
            args: vec![
                "node_modules/.bin/agency".to_string(),
                "lsp".to_string(),
            ],
            env: Default::default(),
        })
    }
}

zed::register_extension!(AgencyExtension);
```

## Step 4: `languages/agency/config.toml`

This configures how Zed treats `.agency` files — bracket matching, comment toggling, etc.

```toml
name = "Agency"
grammar = "agency"
path_suffixes = ["agency"]
line_comments = ["//"]
block_comment = ["/*", "*/"]
brackets = [
  { start = "{", end = "}", close = true, newline = true },
  { start = "[", end = "]", close = true, newline = false },
  { start = "(", end = ")", close = true, newline = false },
]
word_characters = ["_"]
```

## Step 5: `languages/agency/highlights.scm`

This file contains Tree-sitter queries for syntax highlighting. If you don't have a Tree-sitter grammar yet, create an empty file:

```scm
; TODO: Add highlighting queries once tree-sitter-agency exists
```

Without a Tree-sitter grammar, Zed will still provide all LSP features — just no syntax coloring.

## Building the Extension

```bash
# Install the WASM target if you haven't already
rustup target add wasm32-wasip1

# Build
cargo build --target wasm32-wasip1 --release
```

## Local Development

To test your extension locally during development:

1. Open Zed
2. Open the command palette (Cmd+Shift+P)
3. Run "zed: install dev extension"
4. Select the `zed-agency/` directory

Zed will build and load the extension. After making changes, use the "Rebuild" button in the Extensions panel.

## Publishing

Once the extension is ready, you can submit it to the [Zed extension registry](https://github.com/zed-industries/extensions):

1. Push your extension repo to GitHub
2. Open a PR to the `zed-industries/extensions` repo adding your extension
3. Once merged, users can install it from Zed's Extensions panel

## Tree-sitter Grammar

For full syntax highlighting, you'll need a Tree-sitter grammar for Agency. This is the most significant piece of work. The grammar lives in a separate repo (e.g. `tree-sitter-agency`) and contains:

- `grammar.js` — the grammar definition
- `src/` — generated C parser (from `tree-sitter generate`)
- `queries/highlights.scm` — highlighting queries

Writing a Tree-sitter grammar is a separate effort. See [tree-sitter.github.io](https://tree-sitter.github.io/tree-sitter/creating-parsers/) for the authoring guide.

## References

- [Zed Language Extensions docs](https://zed.dev/docs/extensions/languages)
- [Zed Developing Extensions docs](https://zed.dev/docs/extensions/developing-extensions)
- [zed_extension_api on docs.rs](https://docs.rs/zed_extension_api)
- [How to write a Zed extension for a made-up language (BAML blog)](https://boundaryml.com/blog/how-to-write-a-zed-extension-for-a-made-up-language)
