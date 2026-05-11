# Re-export syntax design

## Motivation

Agency users who want to expose stdlib (or other Agency package) tools through `agency serve` currently write a hand wrapper for each tool:

```ts
import { search } from "std::wikipedia"
def wikipediaSearch(query: string) {
  return search(query)
}
```

The wrapper exists only to satisfy `lib/serve/discovery.ts:15`, which filters served items by `fn.module === moduleId` — i.e. only functions originally defined in the served file are exposed. The wrapper is mechanical, lossy (loses parameter types unless the user re-declares them), and grows linearly with the number of tools the user wants to bundle.

This spec adds TS-style re-export-from-module syntax so that the same intent reads as:

```ts
export { search as wikipediaSearch } from "std::wikipedia"
export * from "std::wikipedia"
export { safe search } from "std::wikipedia"
```

Re-export feeds all three current effects of `export`: cross-Agency-file imports, JS/TS interop with the compiled output, and `agency serve` discovery for MCP and HTTP.

## Design principle

Re-export is **syntactic sugar that desugars into existing language constructs.** No new runtime concepts, no new codegen paths, no new discovery mechanism. After the preprocessor pass, the AST is indistinguishable from what the user would have written by hand. Every downstream stage (type checker, builder, serve discovery, LSP) keeps working without modification.

The **SymbolTable is the single source of truth** for what each `exportFromStatement` resolves to. The preprocessor reads only from `FileSymbols` (specifically the `reExportedFrom` metadata) when synthesizing wrappers; it does not re-walk `exportFromStatement` AST nodes for resolution. The AST nodes serve only as deletion markers after expansion.

## Pipeline

```
parse                       → new exportFromStatement AST node
SymbolTable.build           → follows re-export edges, merges symbols,
                              detects collisions and cycles
preprocessor:
  resolveReExports (new)    → for each FileSymbols entry with reExportedFrom,
                              emits one synthesized importStatement +
                              one synthesized local export declaration;
                              deletes all exportFromStatement AST nodes
  resolveImports            → processes the synthesized imports normally
typescriptBuilder           → unchanged
serve/discovery             → unchanged (sees the wrappers as normal local exports)
```

`resolveReExports` runs **before** `resolveImports` so the imports it synthesizes flow through the existing import-resolution machinery.

## Surface syntax (v1)

`safe` is a per-name modifier inside the named list, mirroring `import { safe foo, bar } from "..."`:

```ts
// named, optionally aliased
export { search } from "std::wikipedia"
export { search as wikipediaSearch, fetch as wikipediaFetch } from "std::wikipedia"

// safe-annotated per name
export { safe search } from "std::wikipedia"
export { safe search, fetch } from "std::wikipedia"
export { safe search as wikipediaSearch } from "std::wikipedia"

// star
export * from "std::wikipedia"
```

Grammar mirrors `importStatementParser`; the named-list, `as` aliasing, per-name `safe` modifier, and `*` body parsers are reused. Only the leading keyword and the AST shape differ.

### Excluded from v1

- `export { x }` with no `from` — not in the headline use case.
- `export * as ns from "..."` — Agency has no namespace symbol concept.
- `export default ... from` — Agency has no `default` export concept.

## AST

A new node type in `lib/types/`:

```ts
type ExportFromStatement = {
  type: "exportFromStatement";
  modulePath: string;             // "std::wikipedia", "./foo.agency", "pkg::bar", etc.
  isAgencyImport: boolean;
  loc: SourceLocation;
  body:
    | { kind: "namedExport"; names: string[]; aliases: Record<string, string>; safeNames: string[] }
    | { kind: "starExport" };
};
```

`safeNames` lists the original (pre-alias) names that were marked `safe`, matching the `safeNames` shape on `ImportStatement`.

Deliberately separate from `ImportStatement` rather than an `isExport` flag on it — the two have distinct downstream pipelines, and conflating them would muddle type discriminations elsewhere.

## SymbolTable changes

`SymbolTable.build` gains two responsibilities for `exportFromStatement` nodes.

### Reachability

In the file-walk loop, treat `exportFromStatement` as a second kind of edge with the same resolution as `importStatement`:

```ts
case "exportFromStatement":
  if (isAgencyImport(node.modulePath)) {
    enqueue(resolveAgencyImportPath(node.modulePath, currentFile));
  }
  break;
```

This guarantees re-export sources get parsed even if no file directly imports them.

### Symbol-flow resolution

After every reachable file is parsed and its own top-level declarations have populated `FileSymbols`, a second pass walks `exportFromStatement` edges in dependency order and merges entries from each source's `FileSymbols` into the re-exporter's.

```ts
function resolveReExports(file: string, visiting: Set<string>) {
  if (resolved.has(file)) return;
  if (visiting.has(file)) throw new Error(`Re-export cycle through ${file}`);
  visiting.add(file);

  for (const stmt of fileNodes(file).filter(isExportFrom)) {
    const sourcePath = resolveAgencyImportPath(stmt.modulePath, file);
    resolveReExports(sourcePath, visiting);
    mergeExportsFrom(file, sourcePath, stmt);
  }

  visiting.delete(file);
  resolved.add(file);
}
```

Visiting sources before re-exporters means transitive `export * from` chains resolve naturally: by the time `mergeExportsFrom` reads the source's `FileSymbols`, that source has already absorbed *its* re-exports.

This pass detects only **re-export cycles**. Ordinary import cycles that pass through a re-exporter are handled by the existing import resolver, unchanged.

### Merge rules

For `export { foo as bar } from "src"`:

- Look up `foo` in the source's `FileSymbols`.
- Hard error if missing.
- Hard error if `foo`'s kind is `class` (classes are not re-exportable in v1) — emit the class-specific message *before* the exportedness check, so the user gets a useful explanation rather than a misleading "not exported" message.
- Hard error if the source symbol is not `exported` (reuses `assertExported` from `importResolver.ts`).
- Insert a `FileSymbols` entry under the local name (`bar` if aliased, else `foo`). The entry is a **copy** of the source's `SymbolInfo` with `exported: true`, plus a new optional field:

```ts
reExportedFrom?: { sourceFile: string; originalName: string };
```

  `reExportedFrom` records only the **immediate** hop. For a chain `c → b → a`, `c`'s entry has `reExportedFrom = { sourceFile: b, originalName: ... }`. Consumers that need the ultimate origin (e.g. LSP "go to definition") walk the chain themselves. This avoids encoding chain semantics into the field shape and matches how transitive imports already behave.

- If the re-export carries `safe` for this name (i.e. the original name appears in `safeNames`), set `safe: true` on the copied symbol regardless of the source's setting.

For `export * from "src"`:

- Enumerate `Object.values(sourceFileSymbols).filter(s => s.exported)`.
- For each, run the named-form merge under its original name.

The re-exported entry's `loc` is set to the `exportFromStatement`'s `loc` so that downstream errors point at user-visible source rather than synthesized wrappers.

### Collisions

When inserting a symbol into a file's `FileSymbols`:

- If the slot already holds a **locally-declared** symbol → hard error: `Re-exported name 'foo' collides with local declaration at <loc>`.
- If the slot already holds **another re-export** from a different source → hard error: `Name 'foo' is re-exported from both 'a' and 'b'. Disambiguate with explicit 'export { foo as ... } from ...'.`
  - This rule applies whether either, both, or neither side is a `*` form. There is no "explicit-overrides-star" silent disambiguation; we prefer explicit errors over implicit precedence.
- Idempotent re-merging from the same source is allowed (defensive against double-processing).

### Downstream effect

After `SymbolTable.build` returns, `symbolTable.getFile(path)` honestly reports re-exported names. The import resolver, serve discovery, and LSP code-action consumers all benefit with no changes — they already consume `FileSymbols`. Re-exported entries carry `reExportedFrom`, which the preprocessor consults to decide whether to synthesize a wrapper.

## Preprocessor expansion

A new pass, `resolveReExports`, rewrites each file's AST so downstream stages never see `exportFromStatement` nodes.

### Drive expansion from `FileSymbols`

The preprocessor does **not** walk `exportFromStatement` nodes to decide what to emit. It iterates each file's `FileSymbols` and emits one wrapper per entry whose `reExportedFrom` is set. This keeps SymbolTable as the single source of truth and avoids skew between resolved metadata and emitted wrappers.

After emission, the preprocessor deletes all `exportFromStatement` nodes from the file's AST.

### Per-symbol synthesis

For each `FileSymbols` entry with `reExportedFrom = { sourceFile, originalName }`:

```ts
// 1. import the original under an internal alias to avoid shadowing
import { (safe?) foo as __reexport_foo } from "<sourceFile>"

// 2. synthesize a local exported declaration preserving the source signature
//    (form depends on symbol kind — see table below)
```

Signature, default values, return type, and `safe` are copied from the SymbolInfo. The synthesized declaration's `loc` is set to the `exportFromStatement`'s `loc`.

### Per-symbol-kind synthesis

| Source kind | Synthesized output |
|---|---|
| `function` | `export (safe?) def alias(...sig): ReturnType { return __reexport_orig(...args) }` |
| `node`     | `export node alias(...sig) { return __reexport_orig(...args) }` — nodes can return values *or* transition; the `return` form preserves whichever the source produces |
| `type`     | `export type Alias = Original` |
| `constant` | `export static const alias = __reexport_orig` — only legal for `static const` source bindings (the only currently exportable constant form). The aliased binding receives the value already computed once at the source module's load time. |

For `export * from "src"`: handled identically — the SymbolTable already populated one `FileSymbols` entry per starred symbol, each with `reExportedFrom.sourceFile === src`.

### Coalescing imports

Multiple `__reexport_*` imports targeting the same source module collapse into one synthesized `importStatement`. Example:

Input:
```ts
export { search } from "std::wikipedia"
export { fetch as wikipediaFetch } from "std::wikipedia"
```

Synthesized (before `resolveImports`):
```ts
import { search as __reexport_search, fetch as __reexport_fetch } from "std::wikipedia"
export def search(query: string): SearchResult {
  return __reexport_search(query)
}
export def wikipediaFetch(url: string): string {
  return __reexport_fetch(url)
}
```

The shape matches what `resolveImports` already consumes.

### What downstream sees

After `resolveReExports`:

- Zero `exportFromStatement` nodes remain.
- Synthesized `importStatement` nodes flow into `resolveImports` normally.
- Synthesized `export def` / `export node` / `export type` / `export static const` declarations are treated as ordinary local exports by every later stage.

The serve discovery filter at `lib/serve/discovery.ts:15` (`fn.module === moduleId`) is satisfied because the wrapper is genuinely local to the re-exporting file.

## Errors

All hard compile errors:

| Condition | Message |
|---|---|
| Symbol not found in source | `Symbol 'foo' is not defined in 'src'` (existing import-resolver message) |
| Source symbol exists but is not exported | `Function 'foo' in 'src' is not exported. Add the 'export' keyword to its definition.` (existing `assertExported`) |
| Re-export cycle | `Re-export cycle detected: a → b → a` |
| Collision with local declaration | `Re-exported name 'foo' collides with local declaration at <loc>` |
| Collision between re-export sources | `Name 'foo' is re-exported from both 'a' and 'b'. Disambiguate with explicit 'export { foo as ... } from ...'.` (also fires when one side is `*` and the other names `foo` explicitly) |
| Non-Agency source module | `Re-export source must be an Agency module (std::, pkg::, or .agency path)` |
| Class re-export | `Classes cannot be re-exported` (symmetric with classes not being exportable today; class support is being removed from Agency anyway) |
| `static const` bound to non-static source constant | `Constant 'foo' in 'src' is not a 'static const' and cannot be re-exported` (defensive; the current language only allows `export static const ...`, but stating the rule explicitly keeps future expansions safe) |

## Edge cases

- **Re-exporting the same name without aliasing**: works; the internal alias `__reexport_search` prevents shadowing.
- **Re-exporting *and* separately importing the same symbol**: works; the user's import produces one local binding, the synthesized internal import produces a separate one under a different name.
- **`safe` at the re-export boundary**: marks the *wrapper* safe regardless of the source. A user can mark a side-effectful source function safe and the LLM will retry it. Documented as a footgun.
- **Default-argument expressions**: SymbolInfo carries parameter defaults; the wrapper preserves them verbatim.
- **Interrupt kinds**: verified to flow through. The type checker seeds `ctx.interruptKindsByFunction` keyed by the imported local name (`__reexport_foo`), and `analyzeInterruptsFromScopes` propagates kinds from callees transitively. The wrapper's `return __reexport_foo(...)` registers `__reexport_foo` as a callee, so the wrapper inherits the source's kinds. Serve descriptions show the correct kinds without changes.
- **Re-exporting a re-export** (`a → b → wikipedia`): SymbolTable's topological pass resolves `b` first, so `c`'s wrapper imports cleanly from `b`.
- **Star re-export of a types-only file**: produces zero wrapper functions, just `export type` aliases.
- **Empty star re-export** (source has no exports): silent no-op. Could warn; v1 does not.
- **Error locations**: re-exported `FileSymbols` entries and synthesized declarations both carry the `exportFromStatement`'s `loc`, so type errors and runtime stacks point users at code they wrote.

## Documentation

Update `docs/site/guide/imports-and-packages.md` with the new syntax. Add a short example to `docs/site/guide/mcp.md` showing the headline use case (`export * from "std::wikipedia"` exposing a whole module's tools through `agency serve mcp`).

## Testing

**Parser** (`lib/parsers/exportFrom.test.ts`):
- Each surface form (named, aliased, multi-name, per-name `safe`, star) parses to the expected AST.
- Common malformed inputs produce parser errors.

**Formatter**: confirm `pnpm run fmt` round-trips each surface form unchanged. Update `AgencyGenerator` if needed.

**SymbolTable** (extend `symbolTable.test.ts`):
- Named re-export merges symbols with correct `reExportedFrom` metadata.
- Star re-export merges all exported symbols, skips non-exported ones.
- Transitive star (`a → b → c`) resolves correctly.
- Cycle detection fires on `a → b → a`.
- Collision errors fire with the right messages, including the star-vs-named overlap case.
- Per-name `safe` at the re-export boundary overrides the source's `safe` flag for *that name only*, leaving sibling names unchanged.
- Re-exported entries' `loc` matches the `exportFromStatement`'s `loc`.

**Preprocessor** (`lib/preprocessors/resolveReExports.test.ts`):
- Driven entirely from `FileSymbols`; AST input with `exportFromStatement` nodes plus a populated symbol table produces the expected synthesized `import` + wrapper output.
- All `exportFromStatement` nodes are deleted after expansion.
- Coalescing produces one import statement per source.
- Wrappers preserve parameter signatures, defaults, and return types.

**Integration** (`tests/agency/` and `tests/agency-js/`):
- A `.agency` file that re-exports from `std::` and calls the re-exported name compiles and runs.
- A re-exported function called from TS via the compiled output works.

**Serve discovery** (extend `lib/serve/discovery.test.ts`):
- A file containing only `export { foo } from "std::..."` discovers `foo` as a served tool, with `module === thisFile`'s moduleId.
- `interruptKinds` for the re-exported tool match the source's.

**Fixtures**: add a fixture exercising named, aliased, per-name `safe`, and star forms together; run `make fixtures` after implementation.

## Out of scope

- Re-exporting symbols from non-Agency (TypeScript/JavaScript) modules.
- `export { x }` without `from` (declaration-list export).
- `export * as ns from "..."` (namespace re-export).
- Re-exporting classes (classes are slated for removal from Agency).
- Warnings for empty star re-exports.
