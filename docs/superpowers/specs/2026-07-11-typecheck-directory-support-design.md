# Design: directory + `-` stdin support for `.agency` CLI commands

**Issue:** [#438](https://github.com/egonSchiele/agency-lang/issues/438) — `agency typecheck` should accept directories (docs already promise it; currently crashes with EISDIR)

**Date:** 2026-07-11

## Problem

`agency typecheck` (and its aliases `tc`/`check`) documents directory support — `docs/site/cli/typecheck.md` shows `agency tc src/` — but passing a directory crashes with `EISDIR`. The typecheck action loops over its raw argument list and passes each entry straight to `readFile()`, which does `fs.readFileSync()` with no directory handling.

Four sibling commands share the identical `readFile`-in-a-loop pattern and the same bug: `parse`/`ast`, `preprocess`, and `diagnostics`.

Separately, stdin via `-` only works implicitly when no arguments are given. A literal `-` argument is passed to `readFile("-")` and fails with "not found", so `-` cannot be mixed with files or directories.

## Key insight

This is not a missing capability. The codebase already owns directory walking:

- `findRecursively(dir, ext)` in `lib/cli/util.ts` — the general walker; skips dotfiles and symlinks.
- `formatFile` (`lib/cli/commands.ts`) and `doc` (`lib/cli/doc.ts`) call `findRecursively` directly for directories.
- `expandEntries` (`lib/compiler/buildSession.ts`) wraps `findRecursively` for `compile`/`build`.

The established pattern is `fs.statSync(x).isDirectory() → findRecursively(x)`. The five file-oriented commands simply never route through it. The fix routes them through a single shared resolver.

## Scope

In scope (decided during brainstorming):

1. Directory support for `typecheck`/`tc`/`check`, `parse`/`ast`, `preprocess`, and `diagnostics`.
2. Literal `-` argument reads from stdin, and can be mixed with files/directories.

Both delivered through one shared helper so the five commands stay consistent.

## Design

### A. Shared resolver

New function in `lib/cli/commands.ts`, co-located with the existing `readFile`/`readStdin`:

```ts
type InputSource = { kind: "file"; path: string } | { kind: "stdin" };

export function resolveInputSources(inputs: string[]): InputSource[]
```

Rules, preserving argument order:

- `"-"` → `{ kind: "stdin" }`.
- an existing **directory** → `findRecursively(input, ".agency")`, each match yielding `{ kind: "file", path }`.
- an existing **file** → `{ kind: "file", path: input }`.
- a **missing path** → preserve today's behavior: print `Error: Input file '<x>' not found` and `process.exit(1)`.
- a **second `stdin` source** (e.g. two `-` args) → error, because `readStdin()` can only be consumed once: print a clear message ("stdin can only be read once") and `process.exit(1)`.

The helper reuses `findRecursively` — the same walker `fmt`/`doc` use — so no new directory-traversal logic is introduced. `expandEntries` is deliberately **not** reused: it returns a build-specific `{ files, hasDirectory }` shape, resolves to absolute paths, and has no stdin/dash concept. Both helpers bottom out on `findRecursively`, so the walk itself is not duplicated.

### B. Per-command wiring

Each of the five commands replaces its `if (inputs.length === 0) { stdin } else { for … readFile }` block with:

```ts
const sources = inputs.length === 0 ? [{ kind: "stdin" }] : resolveInputSources(inputs);
for (const src of sources) {
  const contents = src.kind === "stdin" ? await readStdin() : readFile(src.path);
  doThing(contents, src.kind === "file" ? src.path : undefined);
}
```

The `inputs.length === 0 → stdin` default is preserved (it is not the same as an explicit `-`).

### C. typecheck's SymbolTable optimization

typecheck builds one `SymbolTable` seeded from the first input and reuses it for every file (crawling reachable files and stdlib once). This must be preserved:

- Seed the shared `SymbolTable` from the **first `file` source** in the resolved list.
- Reuse it for all `file` sources.
- `stdin` sources pass `undefined` (today's no-arg behavior — they build their own SymbolTable via `buildCompilationUnit`).

The other four commands do not build a SymbolTable in their loop, so this nuance is typecheck-only.

### D. Edge cases

- **Empty directory:** `agency tc emptydir/` resolves to zero sources. It must **not** fall through to `readStdin()` (that would hang waiting on stdin). Print `No .agency files found in '<dir>'` and exit `0`.
- **Exit codes:** unchanged. typecheck still `process.exit(1)` if any file has an error-severity diagnostic; a directory of clean files exits `0`.
- **Ordering:** mixed args (`agency tc src/ extra.agency -`) are processed in the order given; directory contents appear in `findRecursively` yield order.

## Docs

Resolve the existing contradiction and advertise the new capability:

- `docs/site/guide/developer-tools.md` — remove "Directories are not supported yet" (currently line ~24) and document directory + `-` support.
- `docs/site/cli/typecheck.md` — `agency tc src/` example is now accurate; add a note on `-`.
- `docs/site/cli/` pages (and/or `docs/misc/`) for `parse`/`preprocess`/`diagnostics` — add a line about directory and `-` support for parity.

## Testing

Extend `tests/integration/cli-main/test.mjs` (runs against a fresh temp project with the packed tarball; no LLM calls). Follow TDD — write these first, confirm they crash/fail against current code, then implement:

- `tc` on a directory of `.agency` files.
- `tc` on mixed directory + file arguments.
- `tc` with a literal `-` (piped stdin).
- `tc` on an empty directory → prints "No .agency files found" and exits `0`.
- One sibling (`parse`) on a directory, to prove the shared helper applies beyond typecheck.

## Non-goals (YAGNI)

- No `--ignore` flag for these commands (`findRecursively` already skips dotfiles/symlinks; defer if a real need appears).
- No glob patterns.
- No parallel file processing.
