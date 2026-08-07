# The vendored commander fork

`lib/vendor/commander/` is a copy of [commander.js](https://github.com/tj/commander.js)
v15.0.0 (MIT — the upstream LICENSE ships with it), modified so the CLI's core
concept — one command line carrying agency's arguments *and* the program's —
lives inside the parser instead of being bolted on ahead of it. The design is
`docs/superpowers/specs/2026-08-06-cli-flag-ownership-design.md`; the
user-facing rules are `docs/dev/cli-arguments.md`.

## Why a fork

Upstream commander cannot express a program boundary. Its one gesture at it,
`passThroughOptions()`, requires `enablePositionalOptions()` on the root,
which changes parsing for the whole CLI (it broke `label ingest --store`). So
for a while the boundary was drawn *outside* commander by rewriting argv
(`splitCommandLine`), which meant maintaining a shadow tokenizer that had to
mimic commander's real one bug-for-bug. The fork ends that: one parser, one
tokenizer, and the boundary is a property of a command.

## What was copied

Upstream `lib/*.js` (six files of plain JS with JSDoc), `index.js` (import
paths flattened), and `typings/index.d.ts` as `index.d.ts`. The makefile
ships the directory into `dist/`, and the repo's global `**/*.js` gitignore
has an exception for it — these are hand-maintained sources, not compiled
output.

## The modifications

`MODIFICATIONS.md` beside the sources is the authoritative ledger; every edit
in the code is marked `// AGENCY FORK:`. In brief, and why:

1. **Packaging** — flattened import paths.
2. **Duplicate-name guard** — the same option spelling on a command and its
   ancestor/descendant throws at registration. Stock commander let the parent
   win silently; the child received `undefined` as if the flag were never
   passed. The guard turned that documented trap into an impossible state
   (and immediately caught a live one: `logs view -f`).
3. **Boundary-aware delegation** — `passThroughOptions` is per-command, takes
   `{ boundary: "first-operand" | "immediate" }`, ancestors stop consuming at
   a boundary command's territory, and inside one, options resolve by
   ownership (self or ancestor; variadic continuations included).
4. **Boundary provenance** — `boundaryInfo()` records the program tail,
   whether an explicit `--` drew the line, and the first agency-owned flag in
   the tail. This is what lets the misplaced-flag warning distinguish
   `f.agency --max-cost 5` from `f.agency -- --max-cost 5` after commander
   would have discarded the separator.
5. **`fallbackCommand(name)`** — unmatched lines dispatch the *existing*
   command object (the shorthand IS run), with `invokedAsFallback()`
   provenance and `unknownFallbackOperand()` for typo suggestions.
6. **Ownership-aware parent parsing** — one pure `_consumeOptionToken`
   primitive decides every option token's shape; `parseOptions` performs its
   returned mutations and `_resolveInvocation` walks viable interpretations
   without mutating, scoping owner errors to the typed command/alias path.
   This is the "write it after 'run'" error, and the reason there is no
   second tokenizer anywhere.

## Fork discipline

- Do **not** restyle upstream code to repo conventions; eslint ignores the
  directory.
- Keep modifications minimal, marked in place, and listed in
  `MODIFICATIONS.md` — that ledger is what keeps a future diff against
  upstream readable.
- Upstream's test suite is not vendored. `vendorNoop.test.ts` pins the
  adjacent upstream behaviors our modifications sit next to (paired `--no-*`
  defaults, parent-priority option reading), and the fork tests
  (`duplicateNames`, `boundary`, `fallback`) cover the modifications
  themselves. A fork edit that breaks either fails loudly.

## Diffing against upstream

```bash
git clone --branch v15.0.0 https://github.com/tj/commander.js /tmp/commander
diff -u /tmp/commander/lib/command.js lib/vendor/commander/command.js
```

The diff should contain only `AGENCY FORK` blocks and the index.js path
flattening. Anything else is drift — fix it or ledger it.
