# Import Rewriting

This document explains how the Agency compiler handles imports in generated output. Import handling differs between compile mode and run mode, and this distinction is critical to understand.

## Background

Agency files can import from several sources:

- **Agency files**: `import { foo } from "./bar.agency"`, which Agency compiles
- **TypeScript/JavaScript files**: `import { foo } from "./bar.ts"` or `./bar.js`, which is user code
- **Standard library**: `import { bash } from "std::shell"`, which resolves to the stdlib directory
- **Packages**: `import { foo } from "pkg::toolbox"`, which resolves via npm
- **Bare specifiers**: `import { nanoid } from "nanoid"`, which Node resolves at runtime

The first four are handled during compilation. Bare specifiers are left untouched.

## The problem: compile vs run

When Agency compiles a file, the generated output contains import statements. These imports need to resolve correctly wherever the output runs. But "wherever the output runs" differs depending on what the user is doing:

- **`agency compile`**: The output goes through a build pipeline such as `tsc`. The user's build tools handle the TypeScript to JavaScript conversion, so the imports stay as the user wrote them.
- **`agency run` / `agency debug` / `agency test`**: Node executes the output immediately. All imports must point to `.js` files that exist on disk right now.

This means the same Agency source file needs different import handling depending on the command. A user might write:

```
import { fib } from "./tools.js"
```

If only `tools.ts` exists on disk:
- `agency compile` should leave the import as `./tools.js`, because `tsc` will compile `tools.ts` to `tools.js` later.
- `agency run` should ensure `tools.js` exists so Node can import it. It does that by compiling `tools.ts` with esbuild.

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

Used by `agency compile`. Configured with a target extension (`.js` or `.ts`) for `.agency` rewrites. Every caller in `lib/` constructs it with `.js`, so `.ts` is only exercised by tests today.

**`rewriteImport`**: Rewrites `.agency` imports to the target extension. Leaves everything else untouched.

**`prepareDependencies`**: No-op. The user's build pipeline handles dependencies.

### RunStrategy

Used by `agency run`, `agency debug`, and `agency test`. Extends `CompileStrategy` with two overrides:

**`rewriteImport`**: Rewrites `.agency` → `.js` (always `.js` for execution). Rewrites `.ts` → `.js` (Node needs `.js`). Leaves `.js` imports as-is.

**`prepareDependencies`**: For each relative `.js` import, checks whether the file exists. If it does not, `RunStrategy` looks for a `.ts` file with the same name and compiles it to `.js` using esbuild. It walks that file's own relative `.js` imports first, so a chain of TypeScript helpers gets built bottom-up. If neither file exists, it throws.

## Behavior tables

### Compile mode (`agency compile`)

| User writes | File on disk | Action | Rationale |
|---|---|---|---|
| `./tools.js` | `tools.js` exists | Leave as-is | Already correct |
| `./tools.js` | Only `tools.ts` exists | Leave as-is | User's build pipeline (tsc) will produce `tools.js` |
| `./tools.ts` | `tools.ts` exists | Leave as-is | User knows what they're doing |
| `./tools.ts` | Only `tools.js` exists | Leave as-is | Not our problem at compile time |
| `./foo.agency` | `foo.agency` exists | Rewrite to `.js` | Standard Agency behavior |
| `"nanoid"` | n/a | Leave as-is | Node resolves at runtime |
| `std::foo` | n/a | Rewrite to relative path to stdlib | Standard Agency behavior |

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
| `std::foo` | n/a | Rewrite to relative path to stdlib | Standard Agency behavior |

**Summary: `agency run` always produces `.js` imports and ensures the `.js` file exists, compiling `.ts` dependencies with esbuild if needed.**

### distDir mode (`agency debug --dist-dir` / `agency test` with distDir config)

| User writes | What's in distDir | Action | Rationale |
|---|---|---|---|
| `./tools.js` | `tools.js` exists | Import from distDir | Everything pre-compiled |
| Any | File missing from distDir | Error: "Compiled file not found: …" | User needs to rebuild |

**Summary: With distDir, no compilation happens. Everything must already be built.**

## Where the strategy is used

`compile()` lives in `lib/compiler/defaultSession.ts` and delegates to a `BuildSession`. The rewrite loop itself is in `BuildSession.compileEntry` (`lib/compiler/buildSession.ts`). `CompileOptions` carries an optional `importStrategy`. When a caller omits it, the session falls back to `new CompileStrategy({ targetExt: ".js" })`.

A caller-supplied `importStrategy` also forces the incremental-build freshness policy to `"always"`. The strategy changes the emitted bytes, and the manifest key cannot see it, so the session refuses to skip the file. See `resolveFreshness` in the same file.

The CLI wiring:

| Command | Strategy |
|---|---|
| `agency compile foo.agency` | Default `CompileStrategy({ targetExt: ".js" })` |
| `agency compile foo.agency --ts` | Default `CompileStrategy({ targetExt: ".js" })`; `--ts` changes the output file's extension, not the rewritten import specifier |
| `agency run foo.agency` | `RunStrategy()` |
| `agency debug foo.agency` | `RunStrategy()` |
| `agency test foo.agency` | `RunStrategy()` |

## Agency imports vs non-Agency imports in the AST

The `resolveImports` preprocessor (`lib/preprocessors/importResolver.ts`) splits each Agency import by the kind of symbol each name resolves to:

- Imported **nodes** become an `importNodeStatement`, which carries `agencyFile` instead of `modulePath`.
- Imported **functions, types, and constants** stay in a plain `importStatement`, flagged with `isAgencyImport: true`. Its `modulePath` still ends in `.agency` at this point.

The rewrite loop only walks `importStatement` nodes. So it skips `importNodeStatement` entirely, and it still sees the function/type/constant half of an Agency import. That is why `CompileStrategy.rewriteImport` needs its `.agency` branch: those specifiers reach it unrewritten.

Node imports never reach the strategy at all. `TypeScriptBuilder` emits them directly with a hardcoded `.agency` to `.js` swap (`lib/backends/typescriptBuilder.ts`), so `--ts` does not affect them either.

## stdlib and pkg imports

The compiler handles `std::` and `pkg::` imports separately, before it consults the strategy:

- `std::` imports become absolute paths pointing into the stdlib directory.
- `pkg::` imports go through Node's module resolution to find the package in `node_modules`.

The rewrite loop skips both, using `isStdlibImport` and `isPkgImport` from `lib/importPaths.ts`.
