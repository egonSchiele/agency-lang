# Import Rewriting

This document explains how the Agency compiler handles imports in generated output. Import handling differs between compile mode and run mode, and this distinction is critical to understand.

## Background

Agency files can import from several sources:

- **Agency files**: `import { foo } from "./bar.agency"` — compiled by Agency
- **TypeScript/JavaScript files**: `import { foo } from "./bar.ts"` or `./bar.js` — user code
- **Standard library**: `import { bash } from "std::shell"` — resolved to the stdlib directory
- **Packages**: `import { foo } from "pkg::toolbox"` — resolved via npm
- **Bare specifiers**: `import { nanoid } from "nanoid"` — resolved by Node at runtime

The first four are handled during compilation. Bare specifiers are left untouched.

## The problem: compile vs run

When Agency compiles a file, the generated output contains import statements. These imports need to resolve correctly wherever the output runs. But "wherever the output runs" differs depending on what the user is doing:

- **`agency compile`**: The output goes through a build pipeline (e.g., `tsc`). The user's build tools handle TypeScript → JavaScript conversion. Imports should be left as the user wrote them.
- **`agency run` / `agency debug` / `agency test`**: The output is executed immediately by Node. All imports must point to `.js` files that exist on disk right now.

This means the same Agency source file needs different import handling depending on the command. A user might write:

```
import { fib } from "./tools.js"
```

If only `tools.ts` exists on disk:
- `agency compile` should leave the import as `./tools.js` — `tsc` will compile `tools.ts` to `tools.js` later.
- `agency run` should ensure `tools.js` exists (by compiling `tools.ts` via esbuild) so Node can import it.

## ImportStrategy

The `ImportStrategy` interface (in `lib/importStrategy.ts`) encapsulates these differences. It has two methods:

```ts
interface ImportStrategy {
  rewriteImport(modulePath: string, sourceFile: string): string;
  prepareDependencies(imports: string[], sourceFile: string): void;
}
```

- **`rewriteImport`**: Called for each non-stdlib, non-pkg `importStatement` node in the AST. Returns the import path to write in the generated output.
- **`prepareDependencies`**: Called after compilation with all the non-Agency imports. Ensures dependencies exist on disk before execution.

### CompileStrategy

Used by `agency compile`. Configured with a target extension (`.js` or `.ts`) for `.agency` rewrites.

**`rewriteImport`**: Rewrites `.agency` imports to the target extension. Leaves everything else untouched.

**`prepareDependencies`**: No-op. The user's build pipeline handles dependencies.

### RunStrategy

Used by `agency run`, `agency debug`, and `agency test`. Extends `CompileStrategy` with two overrides:

**`rewriteImport`**: Rewrites `.agency` → `.js` (always `.js` for execution). Rewrites `.ts` → `.js` (Node needs `.js`). Leaves `.js` imports as-is.

**`prepareDependencies`**: For each relative `.js` import, checks if the file exists. If not, looks for a `.ts` file with the same name and compiles it to `.js` using esbuild. Throws an error if neither file exists.

## Behavior tables

### Compile mode (`agency compile`)

| User writes | File on disk | Action | Rationale |
|---|---|---|---|
| `./tools.js` | `tools.js` exists | Leave as-is | Already correct |
| `./tools.js` | Only `tools.ts` exists | Leave as-is | User's build pipeline (tsc) will produce `tools.js` |
| `./tools.ts` | `tools.ts` exists | Leave as-is | User knows what they're doing |
| `./tools.ts` | Only `tools.js` exists | Leave as-is | Not our problem at compile time |
| `./foo.agency` | `foo.agency` exists | Rewrite to `.js` (or `.ts` with `--ts`) | Standard Agency behavior |
| `"nanoid"` | n/a | Leave as-is | Node resolves at runtime |
| `std::foo` | n/a | Rewrite to absolute stdlib path | Standard Agency behavior |

**Summary: `agency compile` never touches `.js`/`.ts` imports. It only rewrites `.agency` imports.**

### Run mode (`agency run` / `agency debug` / `agency test`)

| User writes | File on disk | Action | Rationale |
|---|---|---|---|
| `./tools.js` | `tools.js` exists | Leave as-is | Already works |
| `./tools.js` | Only `tools.ts` exists | Compile `tools.ts` → `tools.js` via esbuild | Make the `.js` import work |
| `./tools.ts` | `tools.ts` exists | Compile `tools.ts` → `tools.js`, rewrite import to `.js` | Node needs `.js` at runtime |
| `./tools.ts` | Only `tools.js` exists | Rewrite import to `.js` | The `.js` file is what Node needs |
| `./foo.agency` | `foo.agency` exists | Compile to `.js`, rewrite import | Standard Agency behavior |
| `"nanoid"` | n/a | Leave as-is | Node resolves at runtime |
| `std::foo` | n/a | Rewrite to absolute stdlib path | Standard Agency behavior |

**Summary: `agency run` always produces `.js` imports and ensures the `.js` file exists — compiling `.ts` dependencies with esbuild if needed.**

### distDir mode (`agency debug --dist-dir` / `agency test` with distDir config)

| User writes | What's in distDir | Action | Rationale |
|---|---|---|---|
| `./tools.js` | `tools.js` exists | Import from distDir | Everything pre-compiled |
| Any | File missing from distDir | Error: "compiled file not found" | User needs to rebuild |

**Summary: With distDir, no compilation happens. Everything must already be built.**

## Where the strategy is used

The `compile()` function in `lib/cli/commands.ts` accepts an optional `importStrategy` parameter. If not provided, it defaults to `CompileStrategy` with the appropriate target extension.

The CLI wiring:

| Command | Strategy |
|---|---|
| `agency compile foo.agency` | `CompileStrategy({ targetExt: ".js" })` |
| `agency compile foo.agency --ts` | `CompileStrategy({ targetExt: ".ts" })` |
| `agency run foo.agency` | `RunStrategy()` |
| `agency debug foo.agency` | `RunStrategy()` |
| `agency test foo.agency` | `RunStrategy()` |

## Agency imports vs non-Agency imports in the AST

After the `resolveImports` preprocessor runs, Agency imports (`.agency` files) are transformed into specialized AST node types: `importNodeStatement` and `importToolStatement`. Plain `importStatement` nodes that remain at this point are non-Agency imports (`.js`, `.ts`, bare specifiers). The import rewriting loop in `compile()` only processes `importStatement` nodes, which is why it naturally skips already-processed Agency imports.

The `.agency` → `.js`/`.ts` rewriting in the strategy still applies because at the point where `rewriteImport` is called, the `.agency` extension hasn't been rewritten yet in the remaining `importStatement` nodes.

## stdlib and pkg imports

`std::` and `pkg::` imports are handled separately, before the strategy is consulted:

- `std::` imports are rewritten to absolute paths pointing into the stdlib directory.
- `pkg::` imports are resolved via Node's module resolution to find the package in `node_modules`.

Both are skipped by the import rewriting loop (checked via `isStdlibImport` and `isPkgImport`).
