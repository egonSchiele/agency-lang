# Import Resolution & distDir Debugger Support

## Problem

Agency's debugger breaks when users have a multi-step compilation pipeline (e.g., `agency compile` → `tsc` → `dist/`). The root cause is an import extension mismatch:

- Users write `import { foo } from "./bar.js"` in `.agency` files because that's what works in `dist/` after `tsc` runs.
- But the debugger compiles and runs from the source directory, where only `bar.ts` exists — not `bar.js`.
- The dynamic import crashes because the file doesn't exist.

A secondary issue: when imports fail, the error is an unhelpful hard crash instead of a clear message.

## Solution

Three complementary features:

1. **Flexible extension resolution** — At compile time, treat `.js` and `.ts` as interchangeable in import paths. If the specified file doesn't exist, try the other extension.
2. **distDir config** — For the debugger, allow specifying a dist directory so it can import pre-compiled JS instead of compiling on the fly.
3. **Mtime warning** — When using distDir, warn if the `.agency` source is newer than the compiled output.

## Feature 1: Flexible Extension Resolution

### Behavior

When the Agency compiler encounters a non-Agency, non-stdlib, non-pkg import (i.e., a plain `.js` or `.ts` import), it checks whether the referenced file exists. If it doesn't, it tries the other extension:

- `import { foo } from "./bar.js"` → `./bar.js` doesn't exist �� try `./bar.ts` → found, use it
- `import { foo } from "./bar.ts"` → `./bar.ts` doesn't exist → try `./bar.js` → found, use it

If neither extension exists, print a clear error message and exit:

```
Error: Cannot resolve import './bar.js' from 'src/myapp.agency'.
Tried: ./bar.js, ./bar.ts — neither file exists.
```

### Scope

This applies only to relative imports with `.js` or `.ts` extensions. It does NOT apply to:

- `.agency` imports (handled by existing Agency import resolution)
- `std::` imports (stdlib)
- `pkg::` imports (packages)
- Bare specifier imports (e.g., `import { nanoid } from "nanoid"` — these are resolved by Node at runtime)

### Where the change lives

Non-Agency imports (`.js`/`.ts` files) are not processed by the Agency compiler — they pass through to the generated TypeScript/JavaScript verbatim. The import path rewriting at `lib/cli/commands.ts:192-197` only handles `.agency` → `.js`/`.ts` rewrites and does not touch non-Agency imports.

The flexible extension resolution therefore needs to happen in the AST import path rewriting loop. Currently, line 193-196 checks `node.type === "importStatement"` and only rewrites `.agency` extensions. We extend this: for non-Agency `importStatement` nodes with `.js` or `.ts` extensions, resolve the import against the filesystem and rewrite the extension if the specified file doesn't exist but the alternative does.

Note: after `resolveImports` runs, Agency imports become `importNodeStatement` or `importToolStatement` nodes. Plain `importStatement` nodes at this point are non-Agency imports — exactly the ones we want to resolve.

### New helper function

Add to `lib/importPaths.ts`:

```ts
/**
 * Resolve a .js or .ts import path, trying the other extension if the
 * specified file doesn't exist. Returns the resolved absolute path or
 * null if neither extension exists.
 */
export function resolveFlexibleExtension(
  importPath: string,
  fromFile: string,
): string | null
```

This function:
1. Resolves the import path relative to `fromFile`
2. If the resolved file exists, returns it as-is
3. If not, swaps `.js` ↔ `.ts` and checks again
4. If neither exists, returns null (caller prints error and exits)

The caller in `commands.ts` uses the result to rewrite the import path in the AST if the extension was swapped.

## Feature 2: distDir Config for the Debugger

### Motivation

Even with flexible extension resolution, the debugger still needs to compile the `.agency` file on the fly. This works for simple projects but doesn't work when:

- The project uses `tsc` with path aliases or other transformations
- There are other build steps between Agency compilation and the final JS output
- The user wants to debug exactly what's running in production

With `distDir`, the debugger skips compilation entirely and imports pre-compiled JS from the dist directory.

### Config

In `agency.json`:

```json
{
  "distDir": "dist"
}
```

Or via CLI flag on the debug command:

```
agency debug src/myapp.agency --dist-dir dist
```

The CLI flag overrides the config file value.

### Path resolution

The debugger infers `srcDir` from the directory containing the input `.agency` file. It then computes the relative path and looks for the corresponding `.js` file in `distDir`.

Given:
- Input file: `src/agents/myapp.agency`
- distDir: `dist` (resolved relative to project root / cwd)

Resolution:
1. `srcDir` = directory of input file = `src/agents/`
2. Relative name = `myapp` (the filename without `.agency`)
3. Compiled path = `path.resolve(distDir, "myapp.js")` = `dist/myapp.js`

Wait — this doesn't account for nested structure. If `distDir` mirrors the source tree, we need to preserve subdirectory structure. But we don't know whether `tsc` strips a `rootDir` prefix or not.

The simplest approach: **just use the basename**. The compiled `.js` file for `myapp.agency` is looked up as `<distDir>/myapp.js`. If the user's tsc config puts it somewhere else (e.g., `dist/agents/myapp.js`), they can adjust `distDir` accordingly (`--dist-dir dist/agents`).

### Only the entry point needs resolution

The `distDir` path resolution only applies to the top-level `.agency` file being debugged. Any imports between compiled modules (e.g., `myapp.js` importing `utils.js`) are resolved by Node's module resolution at runtime — the debugger doesn't need to resolve those.

### Debugger flow change

In `lib/cli/debug.ts`, the current flow:

```
compile(debugConfig, inputFile) → outputFile → import(outputFile)
```

With `distDir`:

```
if distDir is set:
  compiledPath = resolve compiled JS path from distDir
  verify compiledPath exists (error + exit if not)
  check mtime (warn if source is newer)
  import(compiledPath)
else:
  compile(debugConfig, inputFile) → outputFile → import(outputFile)
```

Everything after the import is unchanged: `__setDebugger()`, `__sourceMap`, `DebuggerDriver`, all the same.

### Interaction with --trace and --checkpoint

The `--dist-dir` flag is orthogonal to `--trace` and `--checkpoint`. They can be combined freely:

- `--dist-dir` controls where the module is loaded from
- `--trace` / `--checkpoint` controls what execution state to start from

Example: `agency debug myapp.agency --dist-dir dist --trace myapp.trace`

### What the compiled module must export

For the debugger to work with a pre-compiled module, the module must export:

- `__sourceMap` — step-to-source-location mapping
- `__setDebugger` — function to activate debugger state on the RuntimeContext
- `__getCheckpoints` — function to retrieve checkpoint store
- `approveInterrupt`, `respondToInterrupt`, `rewindFrom` — interrupt/rewind wrappers
- The node function itself (e.g., `main`)

All of these are already exported by the standard Agency compilation pipeline, so this requires no changes to the builder.

### Why this works without recompilation

The compiled code already has full debug support built in. The Runner (`lib/runtime/runner.ts`) calls `maybeDebugHook()` on every step method — `step()`, `cond()`, `loop()`, `forLoop()`, `whileLoop()`, `thread()`, `handle()`, `fork()`, `pipe()`, etc. This is always present regardless of the `debugger` config flag. The `debugger: true` flag in `debug.ts` previously triggered `insertDebugSteps()` in the builder, but that method is now dead code — the Runner handles all stepping.

The debugger activates stepping by calling `__setDebugger(driver.debuggerState)`, which sets the `DebuggerState` on the `RuntimeContext`. The Runner's `maybeDebugHook` checks for this state and pauses when it's present.

### Requirement: `instrument` must not be false

The compiled JS must have instrumentation enabled (the default). If the user set `instrument: false` in their agency config when compiling, the `__sourceMap` export will exist but have zero entries, and the debugger won't be able to map steps to source locations.

Check: after importing the module, if `Object.keys(mod.__sourceMap).length === 0`, print a warning:

```
Warning: The compiled module has an empty source map. Was it compiled with instrument: false?
The debugger may not be able to step through code.
```

## Feature 3: Mtime Warning

When using `distDir` or `--compiled`, the debugger compares the modification time of the `.agency` source file against the compiled `.js` file. If the source is newer:

```
Warning: src/agents/myapp.agency is newer than dist/myapp.js.
You may need to recompile before debugging.
```

This is a warning, not a prompt or hard block. The debugger continues after printing the warning. This avoids issues in non-interactive contexts (CI, piped stdin) where a y/n prompt would hang. The warning catches the common case where someone edits their `.agency` file and forgets to recompile before debugging.

Implementation: `fs.statSync(sourceFile).mtimeMs` vs `fs.statSync(compiledFile).mtimeMs`.

## Summary of changes

| File | Change |
|------|--------|
| `lib/importPaths.ts` | Add `resolveFlexibleExtension()` helper |
| `lib/cli/commands.ts` | Use flexible extension resolution in `compile()` for non-Agency imports; print clear error if file not found with either extension |
| `lib/config.ts` | Add `distDir?: string` to `AgencyConfig` |
| `scripts/agency.ts` | Add `--dist-dir` option to the debug command |
| `lib/cli/debug.ts` | When distDir is set, skip compilation and import from dist; add mtime check |

## Testing

- Unit tests for `resolveFlexibleExtension` — both extensions, neither exists, non-.js/.ts extension
- Integration test: `.agency` file imports `./bar.js` when only `bar.ts` exists — should compile successfully
- Integration test: `.agency` file imports `./bar.ts` when only `bar.js` exists — should compile successfully
- Integration test: import where neither `.js` nor `.ts` exists — should print clear error
- Debugger test with `--dist-dir` pointing at a directory with pre-compiled output
- Mtime warning test: source newer than compiled → warning shown
