# Agency modifications to vendored commander v15.0.0

Upstream: https://github.com/tj/commander.js at v15.0.0 (MIT — see LICENSE).
Rule: modifications are minimal, marked `// AGENCY FORK:` in place, and listed
here. Do not restyle upstream code.

1. index.js — import paths flattened from ./lib/<f>.js to ./<f>.js (packaging only).
2. command.js — duplicate option spellings on one command path (ancestor or
   descendant, either spelling) throw at registration instead of silently
   shadowing; addCommand validates the detached tree before attaching (spec:
   modification 5).
3. command.js + index.d.ts — boundary-aware delegation: passThroughOptions is
   per-command (the enablePositionalOptions prerequisite is removed) and takes
   an optional { boundary: "first-operand" | "immediate" } config; a parent
   stops consuming its own options at a direct boundary subcommand; inside a
   boundary command options resolve by ownership (self or ancestor, with
   variadic continuations emitted on the owner); immediate mode hands the
   whole tail to the program, stripping one leading -- (spec: modification 1).
4. command.js + index.d.ts — boundaryInfo() provenance: parses that reach a
   boundary record the original program tail and whether an explicit --
   drew the line (post-input separators are detected at the pass-through stop
   and stripped; pre-input separators at the literal branch); reset per parse
   in _prepareForParse (spec: modification 2).
5. command.js + index.d.ts — fallbackCommand(name): lines whose first operand
   names no known command dispatch the existing command object, with
   invokedAsFallback() provenance threaded through _dispatchSubcommand after
   _prepareForParse; the parent stops option consumption at a fallback-bound
   operand (separator preserved for the child), and a first-operand boundary
   child dispatched with its input already consumed treats the whole unknown
   as program tail (spec: modification 4).
