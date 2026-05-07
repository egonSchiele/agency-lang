# Vim and Neovim Setup for Agency

This guide covers how to get the Agency language server working in Neovim and classic Vim.

## Prerequisites

Make sure `agency` is installed and available in your PATH:

```bash
npm install -g agency-lang
```

Verify it works:

```bash
agency lsp
```

(It will hang waiting for stdin — that's correct. Press Ctrl+C to exit.)

## Neovim

Neovim has built-in LSP support. No plugin is required for the language server itself.

### Neovim 0.11+ (recommended)

Neovim 0.11 introduced the `vim.lsp.config()` and `vim.lsp.enable()` APIs, making setup very simple.

Add this to your `~/.config/nvim/init.lua` (or a file in `~/.config/nvim/lua/`):

```lua
-- Register the .agency filetype
vim.filetype.add({
  extension = { agency = "agency" },
})

-- Configure the language server
vim.lsp.config('agency', {
  cmd = { 'agency', 'lsp' },
  filetypes = { 'agency' },
  root_markers = { 'agency.json', '.git' },
})

-- Enable it
vim.lsp.enable('agency')
```

That's all you need. Open a `.agency` file and the LSP will start automatically.

### Neovim 0.8–0.10 (with nvim-lspconfig)

If you're on an older Neovim, use the [nvim-lspconfig](https://github.com/neovim/nvim-lspconfig) plugin.

```lua
-- Register the .agency filetype
vim.filetype.add({
  extension = { agency = "agency" },
})

-- Define the Agency language server config
local configs = require('lspconfig.configs')

if not configs.agency then
  configs.agency = {
    default_config = {
      cmd = { 'agency', 'lsp' },
      filetypes = { 'agency' },
      root_dir = require('lspconfig.util').root_pattern('agency.json', '.git'),
      settings = {},
    },
  }
end

-- Activate it
require('lspconfig').agency.setup({})
```

### Verifying It Works

1. Open a `.agency` file in Neovim
2. Run `:LspInfo` (nvim-lspconfig) or `:lua print(vim.inspect(vim.lsp.get_clients()))` to confirm the server is attached
3. You should see diagnostics, and can test hover with `K`, go-to-definition with `gd`, etc.

### Optional: Basic Syntax Highlighting (without Tree-sitter)

If you want some syntax coloring without writing a full Tree-sitter grammar, create a vim syntax file:

`~/.config/nvim/syntax/agency.vim`:

```vim
if exists("b:current_syntax")
  finish
endif

" Keywords
syn keyword agencyKeyword node def let const return if else while for in
syn keyword agencyKeyword import from export type static safe
syn keyword agencyKeyword handle with approve reject propagate
syn keyword agencyKeyword interrupt checkpoint restore
syn keyword agencyKeyword thread subthread fork
syn keyword agencyKeyword uses try catch success failure

" Built-in functions
syn keyword agencyBuiltin llm print input map filter

" Booleans and null
syn keyword agencyConstant true false null undefined

" Strings
syn region agencyString start=/"/ end=/"/ skip=/\\"/
syn region agencyString start=/`/ end=/`/ skip=/\\`/
syn region agencyString start=/"""/ end=/"""/

" Numbers
syn match agencyNumber /\<\d\+\(\.\d\+\)\?\>/

" Comments
syn match agencyComment /\/\/.*/
syn region agencyComment start=/\/\*/ end=/\*\//

" Type annotations
syn match agencyType /:\s*\zs\u\w*/

" Highlighting links
hi def link agencyKeyword Keyword
hi def link agencyBuiltin Function
hi def link agencyConstant Constant
hi def link agencyString String
hi def link agencyNumber Number
hi def link agencyComment Comment
hi def link agencyType Type

let b:current_syntax = "agency"
```

Also create `~/.config/nvim/ftdetect/agency.vim`:

```vim
au BufRead,BufNewFile *.agency set filetype=agency
```

(This ftdetect file is only needed if you're not using `vim.filetype.add()` in Lua.)

## Classic Vim

Classic Vim does not have built-in LSP support. You'll need a plugin to act as the LSP client.

### Option 1: vim-lsp

Install [vim-lsp](https://github.com/prabirshrestha/vim-lsp) using your preferred plugin manager (vim-plug, Vundle, etc.).

```vim
" Register the filetype
au BufRead,BufNewFile *.agency set filetype=agency

" Register the language server
au User lsp_setup call lsp#register_server({
  \ 'name': 'agency',
  \ 'cmd': {server_info->['agency', 'lsp']},
  \ 'allowlist': ['agency'],
  \ })
```

### Option 2: ALE

Install [ALE](https://github.com/dense-analysis/ale) and configure:

```vim
au BufRead,BufNewFile *.agency set filetype=agency

let g:ale_linters = {
  \ 'agency': ['agency-lsp'],
  \ }

" Define the custom linter
call ale#linter#Define('agency', {
  \ 'name': 'agency-lsp',
  \ 'lsp': 'stdio',
  \ 'executable': 'agency',
  \ 'command': 'agency lsp',
  \ 'project_root': function('ale#path#FindNearestFile', ['agency.json']),
  \ })
```

### Option 3: coc.nvim

If you use [coc.nvim](https://github.com/neoclide/coc.nvim), add to your `:CocConfig`:

```json
{
  "languageserver": {
    "agency": {
      "command": "agency",
      "args": ["lsp"],
      "filetypes": ["agency"],
      "rootPatterns": ["agency.json", ".git"]
    }
  }
}
```

And register the filetype:

```vim
au BufRead,BufNewFile *.agency set filetype=agency
```

## Summary

| Setup | What you need |
|-------|--------------|
| Neovim 0.11+ | ~10 lines of Lua, no plugins |
| Neovim 0.8–0.10 | nvim-lspconfig plugin + ~15 lines of Lua |
| Vim + vim-lsp | vim-lsp plugin + ~8 lines of vimscript |
| Vim + ALE | ALE plugin + ~12 lines of vimscript |
| Vim + coc.nvim | coc.nvim plugin + JSON config |

## References

- [Neovim LSP documentation](https://neovim.io/doc/user/lsp/)
- [nvim-lspconfig](https://github.com/neovim/nvim-lspconfig)
- [vim-lsp](https://github.com/prabirshrestha/vim-lsp)
- [ALE](https://github.com/dense-analysis/ale)
- [coc.nvim](https://github.com/neoclide/coc.nvim)
