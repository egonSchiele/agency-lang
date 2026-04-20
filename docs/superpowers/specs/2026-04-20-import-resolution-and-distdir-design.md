# Import Resolution & distDir Debugger Support

## Problem

Agency's debugger breaks when users have a multi-step compilation pipeline (e.g., `agency compile` → `tsc` → `dist/`). The root cause is an import extension mismatch:

- Users write `import { foo } from "./bar.js"` in `.agency` files because that's what works in `dist/` after `tsc` runs.
- But the debugger compiles and runs from the source directory, where only `bar.ts` exists — not `bar.js`.
- The dynamic import crashes because the file doesn't exist.

A secondary issue: when imports fail, the error is an unhelpful hard crash instead of a clear message.

## Solution

Two complementary features:

1. **ImportStrategy** — A class hierarchy that encapsulates the different import handling behaviors for compile mode vs run mode.
2. **distDir config** — For the debugger, allow specifying a dist directory so it can import pre-compiled JS instead of compiling on the fly.

## Feature 1: ImportStrategy

### The core insight

Import handling must differ between compile time and run time:

- **Compile time** (`agency compile`): The user has a build pipeline (e.g., tsc). Non-Agency imports should be left as-is. The user's build tools handle them.
- **Run time** (`agency run` / `agency debug` / `agency test`): The compiled code will be executed immediately by Node. All imports must resolve to `.js` files that exist on disk.

### Behavior by mode

**Compile mode** (`agency compile`):

| User writes | File on disk | Action | Rationale |
|---|---|---|---|
| `./tools.js` | `tools.js` exists | Leave as-is | Already correct |
| `./tools.js` | Only `tools.ts` exists | Leave as-is | User's build pipeline (tsc) will produce `tools.js` |
| `./tools.ts` | `tools.ts` exists | Leave as-is | User knows what they're doing |
| `./foo.agency` | `foo.agency` exists | Rewrite to `.js` (or `.ts` with `--ts`) | Standard Agency behavior |
| `"nanoid"` | n/a | Leave as-is | Node resolves at runtime |

**Run mode** (`agency run` / `agency debug` / `agency test`):

| User writes | File on disk | Action | Rationale |
|---|---|---|---|
| `./tools.js` | `tools.js` exists | Leave as-is | Already works |
| `./tools.js` | Only `tools.ts` exists | Compile `tools.ts` → `tools.js` via esbuild | Make the `.js` import work |
| `./tools.ts` | `tools.ts` exists | Compile `tools.ts` → `tools.js`, rewrite import to `.js` | Node needs `.js` at runtime |
| `./tools.ts` | Only `tools.js` exists | Rewrite import to `.js` | The `.js` file is what Node needs |
| `./foo.agency` | `foo.agency` exists | Compile to `.js`, rewrite import | Standard Agency behavior |
| `"nanoid"` | n/a | Leave as-is | Node resolves at runtime |

**distDir mode** (`agency debug --dist-dir` / `agency test` with distDir):

| User writes | What's in distDir | Action | Rationale |
|---|---|---|---|
| `./tools.js` | `tools.js` exists | Import from distDir | Everything pre-compiled |
| Any | File missing from distDir | Error: "compiled file not found" | User needs to rebuild |

### Interface

```ts
interface ImportStrategy {
  /**
   * Rewrite an import path for the output.
   * Handles .agency, .js, and .ts imports.
   */
  rewriteImport(modulePath: string, sourceFile: string): string;

  /**
   * Ensure all non-Agency dependencies are available for execution.
   * Called after compilation, before the output is executed.
   * Errors if a dependency can't be resolved.
   */
  prepareDependencies(imports: string[], sourceFile: string): void;
}
```

### Class hierarchy

`RunStrategy` extends `CompileStrategy`. Shared behavior (`.agency` rewriting) lives in the base class. Readers can see what's different by looking at the overrides in `RunStrategy`.

```ts
type CompileOptions = {
  /** Extension for .agency rewrites: ".js" or ".ts" */
  targetExt: ".js" | ".ts";
};

class CompileStrategy implements ImportStrategy {
  constructor(protected options: CompileOptions) {}

  rewriteImport(modulePath: string, sourceFile: string): string {
    if (modulePath.endsWith(".agency")) {
      return modulePath.replace(/\.agency$/, this.options.targetExt);
    }
    // Leave .js/.ts imports untouched — user's build pipeline handles them
    return modulePath;
  }

  prepareDependencies(imports: string[], sourceFile: string): void {
    // No-op — user's build pipeline handles dependencies
  }
}

class RunStrategy extends CompileStrategy {
  constructor() {
    // Run always targets .js
    super({ targetExt: ".js" });
  }

  rewriteImport(modulePath: string, sourceFile: string): string {
    if (modulePath.endsWith(".agency")) {
      return super.rewriteImport(modulePath, sourceFile);
    }
    // Always produce .js — Node needs .js at runtime
    return modulePath.replace(/\.ts$/, ".js");
  }

  prepareDependencies(imports: string[], sourceFile: string): void {
    for (const imp of imports) {
      if (!imp.startsWith("./") && !imp.startsWith("../")) continue;
      if (!imp.endsWith(".js")) continue;

      const resolved = path.resolve(path.dirname(sourceFile), imp);
      if (fs.existsSync(resolved)) continue;

      const tsPath = resolved.replace(/\.js$/, ".ts");
      if (fs.existsSync(tsPath)) {
        // compile tsPath → resolved via esbuild (strip types)
      } else {
        throw new Error(
          `Cannot resolve import '${imp}' from '${sourceFile}'.\n` +
          `Tried: ${resolved}, ${tsPath} — neither file exists.`
        );
      }
    }
  }
}
```

### CLI wiring

```ts
// agency compile foo.agency
new CompileStrategy({ targetExt: ".js" })

// agency compile foo.agency --ts
new CompileStrategy({ targetExt: ".ts" })

// agency run / agency debug / agency test
new RunStrategy()
```

### Where the change lives

The `compile()` function in `lib/cli/commands.ts` receives an `ImportStrategy` and uses it in two places:

1. **Import path rewriting** — the loop that currently rewrites `.agency` imports now calls `strategy.rewriteImport()` for all `importStatement` nodes (after `resolveImports` has transformed Agency imports into `importNodeStatement` / `importToolStatement`).

2. **Dependency preparation** — after compilation, `strategy.prepareDependencies()` is called with the list of non-Agency imports. For `CompileStrategy` this is a no-op. For `RunStrategy` it compiles `.ts` → `.js` via esbuild.

The strategy classes live in `lib/importStrategy.ts`.

## Feature 2: distDir Config for the Debugger

### Motivation

Even with the ImportStrategy, the debugger still needs to compile the `.agency` file on the fly. This works for simple projects but doesn't work when:

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

## Mtime Warning

When using `distDir`, the debugger compares the modification time of the `.agency` source file against the compiled `.js` file. If the source is newer:

```
Warning: src/agents/myapp.agency is newer than dist/myapp.js.
You may need to recompile before debugging.
```

This is a warning, not a prompt or hard block. The debugger continues after printing the warning. This avoids issues in non-interactive contexts (CI, piped stdin) where a y/n prompt would hang.

Implementation: `fs.statSync(sourceFile).mtimeMs` vs `fs.statSync(compiledFile).mtimeMs`.

## Summary of changes

| File | Change |
|------|--------|
| `lib/importStrategy.ts` | New file: `ImportStrategy` interface, `CompileStrategy`, `RunStrategy` |
| `lib/cli/commands.ts` | `compile()` accepts `ImportStrategy`, uses it for import rewriting and dependency preparation |
| `lib/cli/util.ts` | `resolveCompiledFile` helper for distDir path resolution |
| `lib/config.ts` | Add `distDir?: string` to `AgencyConfig` |
| `scripts/agency.ts` | Pass correct strategy to each CLI command; add `--dist-dir` to debug command |
| `lib/cli/debug.ts` | When distDir is set, skip compilation and import from dist; add mtime check |
| `lib/importPaths.ts` | Remove `resolveFlexibleExtension` (replaced by ImportStrategy) |

## Testing

- Unit tests for `CompileStrategy.rewriteImport` — `.agency` → `.js`, `.agency` → `.ts`, `.js`/`.ts` left as-is
- Unit tests for `RunStrategy.rewriteImport` — `.agency` → `.js`, `.ts` → `.js`, `.js` left as-is
- Unit tests for `RunStrategy.prepareDependencies` — compiles `.ts` when `.js` missing, errors when neither exists, no-op when `.js` exists
- Debugger test with `--dist-dir` pointing at a directory with pre-compiled output
- Mtime warning test: source newer than compiled → warning shown
