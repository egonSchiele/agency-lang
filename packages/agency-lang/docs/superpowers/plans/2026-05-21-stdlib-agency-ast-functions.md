# Stdlib `agency` Module — AST + Formatter + Import Policy toolkit

**Goal:** Add a coherent set of AST-, formatter-, and import-policy functions to `stdlib/agency.agency`:
- `parseAST(source)` → raw AST as a plain JSON-serializable object
- `writeAST(ast, dir, filename, overwrite=true)` → format the AST as Agency source and write it to disk (sandbox-contained, interrupt-gated)
- `format(source)` → format Agency source code, returning the formatted source (pure string-in, string-out)
- `formatFile(dir, filename)` → read a file, format it, and write the result back in place (sandbox-contained, interrupt-gated)
- `walkAST(ast, visitor)` → walk every node in a deep-cloned AST; visitor may mutate nodes in place
- `getNodesOfType(source, types[])` plus convenience wrappers `getImports`, `getFunctions`, `getGraphNodes`
- `filterImports(source, allowedPackages, excludedPackages, allowKinds, excludeKinds)` → drop disallowed imports, return new source + a filtered flag

Plus two cross-cutting changes:
- Extend `std::write` (`stdlib/index.agency`) with a `mode: "overwrite" | "append" | "create-only"` parameter, defaulting to `"overwrite"` for backward compatibility.
- Replace `compileSource`'s boolean `restrictImports` with the shared `ImportPolicy` shape that `filterImports` uses, so the compiler and the new function go through one classifier.

**Strategy:** Each task is independently committable. Order matters where there are dependencies:
1. `parseAST` (no filesystem)
2. `std::write` mode (used by `writeAST` and `formatFile`)
3. `writeAST` (introduces `generateSource` helper and `resolveInSandbox` refactor)
4. `format` / `formatFile` (build on Tasks 1, 3)
5. `walkAST` (depends on Task 1's AST type knowledge)
6. `getNodesOfType` + convenience wrappers (depend on Task 1)
7. `filterImports` (depends on Tasks 1, 3, and introduces the shared `ImportPolicy` classifier in `lib/importPaths.ts`)
8. `compileSource` consolidation onto the shared classifier (depends on Task 7)

Tasks 1, 5, 6 are independent enough to ship in any order. Task 8 is the only task that touches existing behavior — schedule it last so the new surface area lands first and the migration of `restrictImports` is a clean follow-on.

---

## Background / references

- AST type: `AgencyProgram` from `lib/types.ts`. JSON-serializable today (it's what `pnpm run ast` prints). Comments are preserved as nodes (`AgencyComment`, `multiLineComment`).
- Parser entry point: `parseAgency(source, config, isProgram)` from `lib/parser.ts`. Returns `{ success: true, result: AgencyProgram } | { success: false, message }`.
- Formatter / AST → source: `AgencyGenerator` in `lib/backends/agencyGenerator.ts`. This is what `pnpm run fmt` uses. **Comments round-trip; whitespace is canonicalized to the formatter's style.** Verify by reading `agencyGenerator.test.ts` before writing the docstring.
- Existing sandbox helper: `resolveInSandbox(dir, filename)` in `lib/stdlib/agency.ts` (added in the previous task — realpath + `+ sep` containment).
- Existing `_write` lives in `lib/stdlib/builtins.ts`, not `lib/stdlib/agency.ts`.
- Existing `write` signature in `stdlib/index.agency`: `write(filename, content, dir=".")` — note the order is filename-first, inconsistent with `_compileFile` / `_typecheckFile`'s `(dir, filename)`. **Don't fix this here.** New params get appended.

---

## Pre-flight

- [ ] Confirm tree is green: `pnpm test:run 2>&1 | tee /tmp/preflight.log`
- [ ] Confirm `pnpm run typecheck` is clean
- [ ] Skim `lib/backends/agencyGenerator.ts` and `agencyGenerator.test.ts` to confirm the comment-preservation / whitespace-canonicalization claim before writing the `writeAST` docstring. If it turns out comments are dropped or order changes, update the docstring caveat accordingly.

---

## Task 1 — `parseAST`

**Goal:** Add `parseAST(source: string): Result` returning the raw AST.

- [ ] **Step 1: TS side — `lib/stdlib/agency.ts`**

  Add:
  ```ts
  import { parseAgency } from "../parser.js";
  import type { AgencyProgram } from "../types.js";

  export function _parseAST(source: string): AgencyProgram {
    const result = parseAgency(source, {}, true);
    if (!result.success) {
      throw new Error(result.message ?? "Failed to parse Agency source");
    }
    return result.result;
  }
  ```

  Don't strip locations or other metadata — return the parser's output verbatim so the round trip through `writeAST` has everything the generator needs.

- [ ] **Step 2: Agency side — `stdlib/agency.agency`**

  Add to the import line: `_parseAST`.

  Add:
  ```ts
  export def parseAST(source: string): Result {
    """
    Parse Agency source code into an abstract syntax tree. Returns the raw AST as a JSON-serializable object on success, or a failure with the parse error message.

    The AST is the same structure printed by `pnpm run ast`. It is suitable for inspection, transformation, or round-tripping back to source via writeAST().

    @param source - Agency source code as a string
    """
    return try _parseAST(source)
  }
  ```

  No interrupt — `parseAST` doesn't touch disk and doesn't run anything.

- [ ] **Step 3: Tests — `lib/stdlib/agency.test.ts`**

  Add unit tests:
  - `_parseAST("node main() { return 1 }")` returns an object with `nodes` array; first node has `type: "graphNodeDefinition"` and `name: "main"`
  - `_parseAST("def x")` (invalid) throws with a message that includes parse-related text
  - The returned AST is JSON-serializable: `JSON.parse(JSON.stringify(ast))` deep-equals `ast` (catches accidental class instances)

- [ ] **Step 4: Regenerate stdlib JS**

  ```bash
  make
  ```

  Verify `stdlib/agency.js` picks up `_parseAST` in its import line and emits `parseAST`.

- [ ] **Step 5: Agency execution test — `tests/agency/`**

  Add a small `.agency` test that calls `parseAST` and asserts on the result shape. Confirms the function survives the Agency runtime layer.

---

## Task 2 — `mode` parameter on `std::write`

**Goal:** Add `mode: "overwrite" | "append" | "create-only"` to `std::write`. Default `"overwrite"` preserves existing behavior.

- [ ] **Step 1: TS side — `lib/stdlib/builtins.ts`**

  Update `_write`:
  ```ts
  export type WriteMode = "overwrite" | "append" | "create-only";

  export async function _write(
    dir: string,
    filename: string,
    content: string,
    mode: WriteMode = "overwrite",
  ): Promise<boolean> {
    const filePath = await resolvePath(dir, filename);
    if (mode === "create-only") {
      if (existsSync(filePath)) {
        throw new Error(`File already exists: '${filePath}' (mode is 'create-only').`);
      }
      await writeFile(filePath, content, "utf8");
      return true;
    }
    if (mode === "append") {
      await appendFile(filePath, content, "utf8");
      return true;
    }
    await writeFile(filePath, content, "utf8");
    return true;
  }
  ```
  Import `appendFile` and `existsSync` accordingly.

- [ ] **Step 2: Agency side — `stdlib/index.agency`**

  Extend `write`:
  ```ts
  export def write(
    filename: string,
    content: string,
    dir: string = ".",
    mode: string = "overwrite",
  ): Result {
    """
    Write content to a file. The filename is resolved relative to dir.

    The `mode` parameter controls how an existing file is handled:
      - "overwrite" (default): replace the file if it exists, create it if not
      - "append": append to the file if it exists, create it if not
      - "create-only": fail if the file already exists

    @param filename - The file to write
    @param content - The content to write
    @param dir - The directory to resolve the filename against (defaults to ".")
    @param mode - How to handle an existing file: "overwrite" | "append" | "create-only"
    """
    return interrupt std::write("Are you sure you want to write this file?", {
      dir: dir,
      filename: filename,
      mode: mode,
    })
    return try _write(dir, filename, content, mode)
  }
  ```

  Note: `mode: string` rather than a union literal, because Agency doesn't ship enum-narrowing across stdlib boundaries cleanly today (verify against `docs/site/guide/types.md`). Validate the value in `_write` — invalid `mode` throws → caller sees a `failure`.

- [ ] **Step 3: Tests — `lib/stdlib/builtins.test.ts`** (or `lib/stdlib/index.test.ts` — match wherever existing `_write` tests live; check first)

  - `_write` with no `mode` arg → backward compat, overwrites existing file
  - `_write` with `"overwrite"` → replaces content
  - `_write` with `"append"` → concatenates
  - `_write` with `"create-only"` on missing file → succeeds
  - `_write` with `"create-only"` on existing file → throws with "already exists"
  - `_write` with `"bogus"` → throws with a clear "invalid mode" message (add this validation explicitly)

- [ ] **Step 4: Regenerate stdlib JS**

  ```bash
  make
  ```

- [ ] **Step 5: Audit existing callers**

  Run `grep -rn "std::write\b\|from \"std::index\"" stdlib/ tests/ docs/` to find anything that imports or interrupts on `std::write` — the interrupt payload now has a new `mode` field, which existing policies / handlers won't break on (they'll just see the extra key), but flag any policy file that filter-matches the exact payload shape.

---

## Task 3 — `writeAST`

**Goal:** Add `writeAST(ast, dir, filename, overwrite=true)` that formats the AST and writes it to disk, sandbox-contained and interrupt-gated.

- [ ] **Step 1: TS side — `lib/stdlib/agency.ts`**

  Add:
  ```ts
  import { generateAgency } from "../backends/agencyGenerator.js";

  export async function _writeAST(
    ast: AgencyProgram,
    dir: string,
    filename: string,
    overwrite: boolean,
  ): Promise<boolean> {
    // Use the refactored resolveInSandbox with mustExist:false because the
    // target file may not yet exist. The new _write (Task 2) does its own
    // path resolution + existence checks for the "create-only" mode.
    const source = generateAgency(ast);
    const mode = overwrite ? "overwrite" : "create-only";
    return _write(dir, filename, source, mode);
  }
  ```

  Delegating to `_write` from Task 2 means:
  - All future improvements to `_write` (atomicity, perms, etc.) flow through `writeAST`.
  - The `overwrite` boolean maps cleanly to `mode = overwrite ? "overwrite" : "create-only"`.
  - Sandbox containment and existence checks live in one place (`_write` already does this via `resolvePath`).

  Verify that `_write`'s sandbox containment is at least as strict as we want. If not, fold the stricter `resolveInSandbox` into `_write` itself rather than duplicating it here.

  The `generateAgency(program)` helper at the bottom of `lib/backends/agencyGenerator.ts` returns a trimmed, trailing-newline-fixed string — exactly what we want to write to disk. Do NOT call `new AgencyGenerator().generate(program).output` directly; use the wrapper.

- [ ] **Sub-task: Refactor `resolveInSandbox` to support missing targets**

  In `lib/stdlib/agency.ts`:
  ```ts
  function resolveInSandbox(
    dir: string,
    filename: string,
    opts: { mustExist?: boolean } = { mustExist: true },
  ): string {
    const sandboxRoot = realpathSync(resolve(dir));
    const resolved = resolve(sandboxRoot, filename);
    const target = opts.mustExist ? realpathSync(resolved) : resolved;
    if (!target.startsWith(sandboxRoot + sep)) {
      throw new Error(
        `Sandbox violation: '${filename}' resolves to '${target}', which is outside the sandbox dir '${sandboxRoot}'.`,
      );
    }
    return target;
  }
  ```
  `_compileFile` and `_typecheckFile` keep their existing behavior (default `mustExist: true`). `_writeAST` calls with `mustExist: false`.

  **Caveat:** With `mustExist: false`, a symlink at `dir/filename` won't be realpath-collapsed. If an attacker plants a symlink inside `dir` pointing outside, we'd write through it. Mitigation: if the file already exists, realpath it; if not, only the parent directory check matters. Document this in a comment on `resolveInSandbox` and decide whether to realpath the parent dir of the target instead of the target itself.

- [ ] **Step 2: Agency side — `stdlib/agency.agency`**

  Add to the import line: `_writeAST`.

  Add:
  ```ts
  export def writeAST(
    ast: any,
    dir: string,
    filename: string,
    overwrite: boolean = true,
  ): Result {
    """
    Format an AST as Agency source and write it to dir/filename. The AST is typically obtained from parseAST() and optionally transformed before being written.

    The output is canonical formatter output: comments are preserved (they live in the AST as nodes), but whitespace and formatting are normalized to the AgencyGenerator's style — the same style produced by `pnpm run fmt`.

    The dir argument is the sandbox boundary: filename cannot escape it via absolute paths or .. segments (symlinks on existing files are followed and re-checked).

    @param ast - The AST to write (typically from parseAST)
    @param dir - The sandbox directory
    @param filename - The agency file to write, resolved relative to dir
    @param overwrite - If false, fail when the file already exists (default true)
    """
    const mode = if (overwrite) { "overwrite" } else { "create-only" }
    return interrupt std::write("Are you sure you want to write this file?", {
      dir: dir,
      filename: filename,
      mode: mode,
    })
    return try _writeAST(ast, dir, filename, overwrite)
  }
  ```

- [ ] **Step 3: Tests — `lib/stdlib/agency.test.ts`**

  - Happy path: parse → write → re-parse → assert the second AST is structurally equivalent to the first (round-trip)
  - `overwrite=true` (default) replaces existing file
  - `overwrite=false` on missing file → writes successfully
  - `overwrite=false` on existing file → throws with "already exists"
  - Sandbox containment: same battery as `_compileFile` (absolute filename, `..` escape, sibling-prefix dir). The symlink-escape case is harder when the target doesn't yet exist — write the test for an *existing* file in a symlinked location to confirm the realpath-on-existing branch still catches escapes.
  - AST → source spot-check: write a hand-built AST for `node main() { return 1 }` and assert the resulting file contains `node main`, `return 1`, with the formatter's canonical spacing.

- [ ] **Step 4: Regenerate stdlib JS**

  ```bash
  make
  ```

- [ ] **Step 5: Agency execution test — `tests/agency/`**

  End-to-end: `parseAST` → mutate the AST (e.g. rename a function via a small block of agency code that walks `ast.nodes`) → `writeAST` to a sandbox tmpdir → read the file back → assert content. Confirms the full round-trip through the Agency runtime.

---

## Task 4 — `format` / `formatFile`

**Goal:** Add `format(source)` (pure source → source) and `formatFile(dir, filename)` (in-place file format).

`format` is `parseAST` + `AgencyGenerator` composed. `formatFile` is `format` plus disk I/O with the same sandbox + interrupt pattern as `writeAST`.

Depends on: Task 1 (`_parseAST`) and Task 3 (refactored `resolveInSandbox` with `mustExist`, and the verified `AgencyGenerator` API shape). Land Task 4 last.

- [ ] **Step 1: TS side — `lib/stdlib/agency.ts`**

  `generateAgency` from `lib/backends/agencyGenerator.ts` is the single source-of-truth helper for AST → source. Use it directly here and in `_writeAST` — no need for a separate `generateSource` wrapper.

  ```ts
  import { generateAgency } from "../backends/agencyGenerator.js";

  export function _format(source: string): string {
    return generateAgency(_parseAST(source));
  }

  export function _formatFile(dir: string, filename: string): boolean {
    // formatFile *requires* the file to exist — it reads then writes.
    // Use the existing-target branch (mustExist: true) so symlinks get
    // realpath-collapsed. Same as _typecheckFile.
    const target = resolveInSandbox(dir, filename, { mustExist: true });
    const source = readFileSync(target, "utf-8");
    const formatted = generateAgency(_parseAST(source));
    // Skip the write if formatting is a no-op — avoids touching mtime
    // when nothing actually changed. Match Prettier / rustfmt behavior.
    if (formatted !== source) {
      writeFileSync(target, formatted, "utf-8");
    }
    return true;
  }
  ```

  Notes:
  - `_format` throws on parse failure (callers wrap in `try`). No filesystem access at all.
  - `_formatFile` uses `mustExist: true` because the file *has* to exist to read it. This is the existing-target sandbox path so symlinks are realpath-collapsed and the missing-target caveat from Task 3 doesn't apply here.
  - The "skip write if unchanged" optimization is worth doing — keeps `pnpm run fmt` idempotent without poking file mtimes. If the user disagrees, drop it; either is defensible.

- [ ] **Step 2: Agency side — `stdlib/agency.agency`**

  Add to the import line: `_format`, `_formatFile`.

  Add:
  ```ts
  export def format(source: string): Result {
    """
    Format Agency source code using the standard Agency formatter (the same one used by `pnpm run fmt`). Returns the formatted source on success, or a failure with a parse error.

    Comments are preserved. Whitespace and formatting are canonicalized — this is a lossy transformation for whitespace but not for semantics or comments.

    @param source - Agency source code as a string
    """
    return try _format(source)
  }

  export def formatFile(dir: string, filename: string): Result {
    """
    Format an Agency file in place. Reads dir/filename, formats it with the standard Agency formatter, and writes the result back to the same path. If the file is already formatted, no write occurs (mtime is preserved).

    The dir argument is the sandbox boundary: filename cannot escape it via absolute paths or .. segments (symlinks are followed and re-checked). Both the read and the write happen inside the same interrupt — approving the interrupt approves both.

    Returns success(true) on a successful format (whether or not a write was needed), or a failure if parsing or I/O fails.

    @param dir - The sandbox directory. filename is resolved against this and must stay inside it.
    @param filename - The agency file to format, resolved relative to dir
    """
    return interrupt std::write("Are you sure you want to format this file in place?", {
      dir: dir,
      filename: filename,
      mode: "overwrite",
    })
    return try _formatFile(dir, filename)
  }
  ```

  Decisions to flag for review:
  - **One interrupt or two?** `formatFile` does both a read and a write. I picked a single `std::write` interrupt (it's the more destructive of the two — the read is the same source we'd return from format anyway). Alternative: chain `std::read` then `std::write`. Pick one; document.
  - **Interrupt message wording** — `"Are you sure you want to format this file in place?"` is more accurate than the default write message because the user might not realize formatting overwrites the file. Worth the divergence.

- [ ] **Step 3: Tests — `lib/stdlib/agency.test.ts`**

  For `_format`:
  - Idempotence: `_format(_format(src)) === _format(src)` for a few source samples
  - Parse error: `_format("def x")` throws (caller wraps in `try`)
  - Comments survive: `_format("// hi\nnode main() {}")` still contains `// hi`
  - Whitespace canonicalizes: a deliberately ugly source (mixed indentation, extra blank lines) → formatted output matches what `pnpm run fmt` would produce. Use a fixture so the expected output is checked into the repo and visible in diffs.

  For `_formatFile`:
  - Happy path: write an ugly source into a sandbox file, call `_formatFile`, read it back, assert formatted
  - No-op skip: if file already matches formatter output, file mtime is unchanged (capture mtime before/after; assert equal). If the no-op optimization is dropped, drop this test too.
  - Sandbox containment: absolute filename, `..` escape, sibling-prefix dir, symlink escape — same battery as `_compileFile`. Reuse the test scaffold.
  - Missing file → throws (sandbox helper uses `mustExist: true` so this falls out for free)

- [ ] **Step 4: Regenerate stdlib JS**

  ```bash
  make
  ```

  Spot-check `stdlib/agency.js` for `_format` / `_formatFile` in the import line and `format` / `formatFile` in the emitted code.

- [ ] **Step 5: Agency execution tests — `tests/agency/`**

  - End-to-end `format`: pass an ugly source, assert formatted output
  - End-to-end `formatFile`: write a fixture to a tmpdir under cwd's `.agency-tmp/`, call `formatFile`, read back, assert
  - Use `safeDeleteDirectory(path, false)` for cleanup, not raw `rmSync`

---

## Task 5 — `walkAST`

**Goal:** Add `walkAST(ast, visitor)` that walks every node in a deep clone of the AST and invokes `visitor(node, ancestors)` for each one. The visitor may mutate the node in place; mutations land in the returned clone, the original is untouched.

Depends on: Task 1 (`_parseAST`) for source-of-truth on the AST shape, but otherwise independent — could ship before Tasks 2–4.

**Design summary (settled):**
- Deep-clone the AST upfront; original is never mutated.
- Visitor receives `(node, ancestors)` and may mutate `node` freely.
- Visitor's return value is ignored (no replace semantics — keeps this simple).
- Iteration is **pre-order**: visitor runs on a node *before* we descend into its children. So a visitor that swaps a function's body for new content will see its replacement walked on the next ticks.
- All `AgencyNode` positions are visited, including those reached via `walkNodes`' inline-child traversal (conditions, expressions inside `valueAccess.chain`, block-argument bodies, etc.). `blockArgument` nodes appear in `ancestors`.
- Non-`AgencyNode` substructures (e.g. `valueAccess.chain[i].kind === "property"` records, raw text segments inside strings) are **not** passed to the visitor — only actual AgencyNode values are.
- The function returns the deep-cloned (and possibly mutated) AST.

### Step 1: TS side — `lib/stdlib/agency.ts`

Add:

```ts
import { walkNodes } from "../utils/node.js";
import { deepCopy } from "../utils.js";

export type WalkASTVisit = {
  node: AgencyNode;
  ancestors: AgencyNode[]; // includes block arguments — see WalkAncestor in lib/utils/node.ts
};

// Deep-clone the AST, enumerate every visit (pre-order) into a flat array,
// and hand both back. The Agency wrapper iterates `visits` calling the
// user's block; the visits hold references into `clone`, so in-place
// mutation in the block lands in `clone` and is returned. We use the
// existing `walkNodes` generator from lib/utils/node.ts as the single
// source of truth for traversal — don't reimplement the node-type
// dispatch.
export function _walkAST(ast: AgencyProgram): {
  clone: AgencyProgram;
  visits: WalkASTVisit[];
} {
  const clone = deepCopy(ast);
  const visits: WalkASTVisit[] = [];
  for (const { node, ancestors } of walkNodes(clone.nodes)) {
    visits.push({ node, ancestors: ancestors as AgencyNode[] });
  }
  return { clone, visits };
}
```

Notes:
- `deepCopy` is already exported from `lib/utils.ts` and uses `JSON.parse(JSON.stringify(...))`. The AST is JSON-serializable (verified by Task 1's round-trip test), so this is safe.
- `walkNodes` walks every node position the agency-generator cares about. Reusing it means `walkAST` will pick up any new node kinds the parser learns about for free.
- The visits array holds **references** into `clone`. In-place mutation by the user is visible in the returned clone. This is intentional and is the whole point of "modify in place if you'd like."
- **Iteration order vs mutation:** if the visitor mutates a node *before* its children have been visited, the children we visit next are the **new** ones (because `walkNodes` is a generator that descends from the current node — but we've already buffered the visits into a flat array). **Wait — verify this.** Two possibilities:
  - (a) `walkNodes` yields nodes lazily; reifying the generator into an array before the visitor runs means we've already captured references to the *original* children. Mutating the parent later doesn't change which child references are in our array.
  - (b) If the user replaces a child reference (e.g. `node.body = newBody`), the array still holds a reference to the old `body`, so the visitor will still be called on the orphaned children.

  This is the most important semantic question. **My recommendation: document (b) as the behavior.** It's predictable: "we computed the walk order before any mutations." If the user wants their mutations to influence the walk, they should drive the iteration themselves with their own recursion. Document this clearly in the docstring with an example.

  Alternative: stream the visitor lazily through the generator. That makes mutations affect the walk but creates a confusing semantic where "visit before mutate" and "visit after mutate" interleave. Hard to reason about. Don't do this.

### Step 2: Agency side — `stdlib/agency.agency`

Add to the import line: `_walkAST`.

**Block-invocation pattern (verified against `stdlib/array.agency`):** higher-order stdlib functions take their callback as a typed parameter (e.g. `func: (any) => any` for `map`, `func: (any, any) => any` for `reduce`) and invoke it with a plain function call inside a `for ... in` loop. There is no special block syntax — just a typed function parameter and a normal call.

```ts
export def walkAST(ast: any, visitor: (any, any) => any): any {
  """
  Walk every node in a deep-cloned copy of the AST, invoking the visitor with each (node, ancestors) pair. The visitor may mutate the node in place; mutations land in the returned AST. The original AST passed in is never modified.

  Iteration order is pre-order: a node is visited before its children. The set of nodes to visit is determined upfront — if the visitor adds new children (e.g. by appending to a function's body), those new children will NOT be visited on this walk. Similarly, if the visitor replaces a child reference (e.g. `node.body = [newNode]`), the visitor will still be called on the OLD body's nodes (which are already in the buffered visit list). To re-walk a transformed AST, call walkAST again.

  The ancestors array lists every enclosing node from the root outward (excluding `node` itself). For nodes inside a block argument (e.g. inside `map(arr) as x { ... }`), the block argument appears in ancestors as a node with `type: "blockArgument"`.

  @param ast - The AST to walk (typically from parseAST)
  @param visitor - Called once per node as visitor(node, ancestors). Return value is ignored.
  """
  const result = _walkAST(ast)
  for (visit in result.visits) {
    visitor(visit.node, visit.ancestors)
  }
  return result.clone
}
```

Notes on the signature:
- Parameter type `(any, any) => any` matches `reduce`'s shape in `stdlib/array.agency`. Return type is `any` even though the visitor's return value is ignored, because there's no `void` in Agency function types today (verify against `docs/site/guide/types.md` — if a more precise type exists for "ignored return," use it).
- Callers use it like:
  ```ts
  const newAst = walkAST(ast) as (node, ancestors) {
    if (node.type == "variableName" && node.value == "foo") {
      node.value = "bar"
    }
  }
  ```
  The `as (params) { ... }` form is Agency's block-argument syntax, which desugars to a function value matching the typed parameter. This is the same surface Agency users already know from `map` / `filter` / `reduce`.

### Step 3: Tests — `lib/stdlib/agency.test.ts`

For `_walkAST`:
- Original is not mutated: parse → `_walkAST` → mutate every visited node's `.type` to `"MUTATED"` → original AST still has its real types.
- Returned `clone` IS mutated: same setup, but assert `clone.nodes[0].type === "MUTATED"`.
- Visit order is pre-order: parse `node main() { return 1 }`, push each visit's `node.type` into an array, assert `["graphNode", ..., "returnStatement", ...]` (graphNode comes before returnStatement).
- Ancestors are populated correctly: for the `returnStatement` inside `node main()`, assert `ancestors.map(a => a.type)` ends with `"graphNode"`.
- `blockArgument` ancestors appear for nodes inside `as x { ... }` blocks. Use `[1, 2, 3].map() as x { x + 1 }` (or whatever the syntax is) as a fixture.
- Mutating a parent's body during the walk does NOT affect the remaining iteration (verifies the "buffered visits" semantic). Write the test to lock in (b) above.
- Replacing a child entirely (`node.body = [newNode]`) — assert the visitor is still called on the OLD body's nodes (they're in the buffered visit list). This locks in the contract.

### Step 4: Regenerate stdlib JS

```bash
make
```

### Step 5: Agency execution test — `tests/agency/`

End-to-end: parse a small program, call `walkAST` with a block that renames every `variableName.value` matching `foo` to `bar`, then `writeAST` the result and assert the file contains `bar` and not `foo`. This is the kind of refactor `walkAST` exists to enable.

---

## Task 6 — Convenience queries on source

**Goal:** Add four convenience functions that take Agency source code (not an AST) and return matching AST nodes. These are the "I just want the imports out of this file" ergonomic layer on top of `parseAST`.

```ts
export def getNodesOfType(source: string, types: string[]): Result
export def getImports(source: string): Result
export def getFunctions(source: string): Result
export def getGraphNodes(source: string): Result
```

All return `Result<AgencyNode[], string>` — a `failure` if parsing fails, a `success` with the (possibly empty) array of matching nodes otherwise.

**Naming note:** `getGraphNodes` rather than `getNodes` to disambiguate from "AST nodes." The string passed to the underlying AST type filter is `"graphNode"` (the parser's type tag for `node main() { ... }` definitions — verify against `lib/types.ts`).

Depends on: Task 1 (`_parseAST`). Independent of Tasks 2–5.

### Step 1: TS side — `lib/stdlib/agency.ts`

There's already a `getNodesOfType` in `lib/utils/node.ts` with a slightly different shape — it takes a node array plus a *single* type string, and walks the tree returning nodes that match. We want a source-string-in version that accepts *multiple* types. Don't duplicate the walking logic; build on `walkNodes` (or `walkNodesArray`) directly.

```ts
import { walkNodesArray } from "../utils/node.js";

export function _getNodesOfType(
  source: string,
  types: string[],
): AgencyNode[] {
  const ast = _parseAST(source);
  const wanted = new Set(types);
  return walkNodesArray(ast.nodes)
    .map((v) => v.node)
    .filter((n) => wanted.has(n.type));
}
```

Notes:
- Walks the entire tree, not just top-level. For `"functionCall"` this matters (calls live inside bodies). For `"importStatement"` / `"function"` / `"graphNode"`, top-level is the only place they appear anyway — but using the full walker keeps the contract uniform.
- `_parseAST` throws on parse failure → caller wraps in `try` → Agency callers see a `failure` Result.
- Returns plain `AgencyNode` objects. They're references into the parser output. Mutating them mutates the parsed AST — but since `_parseAST` is called fresh each invocation here, there's no shared state to corrupt. Document this as "the returned nodes are not deep-cloned; treat them as read-only unless you specifically want to mutate the AST before writing it back."

The convenience wrappers are one-liners:

```ts
export function _getImports(source: string): AgencyNode[] {
  return _getNodesOfType(source, ["importStatement"]);
}

export function _getFunctions(source: string): AgencyNode[] {
  return _getNodesOfType(source, ["function"]);
}

export function _getGraphNodes(source: string): AgencyNode[] {
  return _getNodesOfType(source, ["graphNode"]);
}
```

**Verify against `lib/types.ts` before coding:**
- The AST type tag for a `def` is likely `"function"` — but confirm.
- The AST type tag for a `node` is likely `"graphNode"` — but confirm.
- `_getImports` includes only `"importStatement"`. The older `importNodeStatement` form (`import nodes { ... }`) is deprecated and slated for removal — do not include it. If you find it still present in `lib/types.ts` during implementation, that's expected (removal happens separately); we just don't surface it here.

### Step 2: Agency side — `stdlib/agency.agency`

Add to the import line: `_getNodesOfType`, `_getImports`, `_getFunctions`, `_getGraphNodes`.

```ts
export def getNodesOfType(source: string, types: string[]): Result {
  """
  Parse Agency source code and return all AST nodes whose `type` field matches any of the provided types. Walks the entire tree (not just top-level), so e.g. getNodesOfType(src, ["functionCall"]) returns every function call anywhere in the program.

  The returned nodes are references into a freshly-parsed AST; safe to mutate, but mutations do not write back to disk. Use writeAST() with the parsed AST to persist changes.

  @param source - Agency source code as a string
  @param types - List of AST type strings to match (e.g. ["function", "graphNode"])
  """
  return try _getNodesOfType(source, types)
}

export def getImports(source: string): Result {
  """
  Return all import statements in the source (i.e. `import { x } from "..."`).

  @param source - Agency source code as a string
  """
  return try _getImports(source)
}

export def getFunctions(source: string): Result {
  """
  Return all function definitions (`def foo(...) { ... }`) in the source.

  @param source - Agency source code as a string
  """
  return try _getFunctions(source)
}

export def getGraphNodes(source: string): Result {
  """
  Return all graph node definitions (`node main() { ... }`) in the source. Note: "graph nodes" here means Agency's `node` declarations, not generic AST nodes — see getNodesOfType for the latter.

  @param source - Agency source code as a string
  """
  return try _getGraphNodes(source)
}
```

No interrupts — these are pure read-only operations on a source string.

### Step 3: Tests — `lib/stdlib/agency.test.ts`

For `_getNodesOfType`:
- Empty types array → empty result
- Single type that matches one occurrence
- Single type that matches multiple occurrences (`"functionCall"` inside a body)
- Multiple types in one call → union of matches, preserving walk order
- Unknown type string → empty result (no error)
- Parse failure → throws (caller wraps in `try`)

For each convenience wrapper:
- Fixture: a small source with one import (regular + node-import), two functions, two graph nodes. Assert each wrapper returns exactly the expected count and correct type tags.
- Empty source → empty arrays from all three wrappers.

### Step 4: Regenerate stdlib JS

```bash
make
```

### Step 5: Agency execution test — `tests/agency/`

One end-to-end test: parse a fixture source, call `getFunctions` and `getImports` on it, assert lengths and names. Confirms the Result wrapping survives the runtime boundary.

---

## Task 7 — `filterImports`

**Goal:** Add `filterImports(source, allowedPackages, excludedPackages, allowKinds, excludeKinds)` that returns Agency source with disallowed imports removed, plus a boolean flag indicating whether anything was filtered.

```ts
export def filterImports(
  source: string,
  allowedPackages: string[] = [],
  excludedPackages: string[] = [],
  allowKinds: string[] = [],
  excludeKinds: string[] = [],
): Result   // success: { source: string, filtered: boolean }
```

Depends on: Task 1 (`_parseAST`), Task 3's `generateSource` helper, Task 6's `_getImports` (only for the test fixtures — implementation walks the AST directly).

### Step 1: Shared classifier — `lib/importPaths.ts`

The classifier is shared between `filterImports` (Task 7) and `compileSource`'s policy check (Task 8). Put it next to the existing `isStdlibImport` / `isPkgImport` helpers.

```ts
export type ImportKind = "stdlib" | "pkg" | "local" | "node";

export function importKind(modulePath: string): ImportKind {
  if (isStdlibImport(modulePath)) return "stdlib";
  if (isPkgImport(modulePath)) return "pkg";
  if (
    modulePath.startsWith("./") ||
    modulePath.startsWith("../") ||
    modulePath.startsWith("/") ||
    modulePath.endsWith(".agency")
  ) return "local";
  return "node";
}

export type ImportPolicy = {
  allowedPackages?: string[];
  excludedPackages?: string[];
  allowKinds?: ImportKind[];
  excludeKinds?: ImportKind[];
};

export function isImportAllowed(modulePath: string, policy: ImportPolicy): boolean {
  const kind = importKind(modulePath);
  const allowKinds = policy.allowKinds ?? [];
  const allowPkgs = policy.allowedPackages ?? [];
  const excludeKinds = policy.excludeKinds ?? [];
  const excludePkgs = policy.excludedPackages ?? [];

  // Exclude rules — any match wins, regardless of allow rules.
  if (excludeKinds.includes(kind)) return false;
  if (excludePkgs.some((g) => matchGlob(g, modulePath))) return false;

  // No allow rules of either kind → default-allow.
  // IMPORTANT: only the *combination* of empty allow-lists counts as "no
  // restriction". `allowKinds: ["stdlib"]` with `allowedPackages: []` is
  // still a restriction — only stdlib passes.
  if (allowKinds.length === 0 && allowPkgs.length === 0) return true;

  // Union across the two axes: match either an allowed kind OR an
  // allowed package glob. So `allowKinds: ["stdlib"]` + `allowedPackages: ["pkg::foo"]`
  // allows stdlib and pkg::foo.
  const kindMatched = allowKinds.includes(kind);
  const pkgMatched = allowPkgs.some((g) => matchGlob(g, modulePath));
  return kindMatched || pkgMatched;
}
```

**Verify before coding:**
- The `local` heuristic above (`./`, `../`, `/`, `.agency`) is my guess. Check `lib/importPaths.ts` for any existing `isLocalImport` or similar predicate the parser/compiler already uses; reuse it if found.
- Glob library: `lib/stdlib/policy.ts` already does pattern matching for the policy DSL. Read it to see which library Agency standardizes on (likely `minimatch` or `picomatch` — verify which). Use the same one here. If none is already a dependency, prefer `picomatch` (faster, smaller); if `minimatch` is already present, use that to avoid adding a dep.

### Step 2: TS side — `lib/stdlib/agency.ts`

```ts
import { isImportAllowed, ImportKind, ImportPolicy } from "../importPaths.js";

export function _filterImports(
  source: string,
  allowedPackages: string[],
  excludedPackages: string[],
  allowKinds: string[],
  excludeKinds: string[],
): { source: string; filtered: boolean } {
  const ast = _parseAST(source);
  const policy: ImportPolicy = {
    allowedPackages,
    excludedPackages,
    allowKinds: allowKinds as ImportKind[],
    excludeKinds: excludeKinds as ImportKind[],
  };
  const originalCount = ast.nodes.length;
  ast.nodes = ast.nodes.filter(
    (n) => n.type !== "importStatement" || isImportAllowed(n.modulePath, policy),
  );
  const filtered = ast.nodes.length !== originalCount;
  return { source: generateAgency(ast), filtered };
}
```

Notes:
- Reassigns `ast.nodes` to a filtered array. `_parseAST` returns a fresh parse, so there's no shared state to corrupt.
- Uses `generateAgency` from `lib/backends/agencyGenerator.ts` — the single AST → source helper.
- The kind-string cast (`as ImportKind[]`) is a type-narrowing convenience. Unknown values in `allowKinds`/`excludeKinds` won't match `kind` (which is constrained to the union), so they're inert. Worth a comment: "unknown kind strings are silently ignored — they can't match anything anyway."

### Step 3: Agency side — `stdlib/agency.agency`

Add to import line: `_filterImports`.

```ts
type FilterImportsResult = {
  source: string,
  filtered: boolean,
}

export def filterImports(
  source: string,
  allowedPackages: string[] = [],
  excludedPackages: string[] = [],
  allowKinds: string[] = [],
  excludeKinds: string[] = [],
): Result {
  """
  Parse Agency source, drop imports that fail the policy, and return the resulting source plus a flag indicating whether anything was dropped.

  Imports are classified by `kind`:
    - "stdlib" — `std::*` (e.g. `std::shell`)
    - "pkg"    — `pkg::*` (e.g. `pkg::wikipedia`)
    - "local"  — relative or absolute file paths (e.g. `./util.agency`)
    - "node"   — bare specifiers resolved by Node (e.g. `fs`, `child_process`)

  Policy:
    - `allowedPackages` / `excludedPackages` are glob patterns matched against the raw import path string.
    - `allowKinds` / `excludeKinds` accept the kind strings above.
    - Exclude rules always win: if a path matches anything in `excludedPackages` or `excludeKinds`, it is dropped.
    - When all four lists are empty, every import is allowed (default-allow).
    - When at least one allow list is non-empty, an import must match an allowed kind OR an allowed package glob (union across the two axes). Note that allowKinds=["stdlib"] is still a restriction even with the package lists empty — only stdlib passes.

  The returned source is regenerated via the Agency formatter, so whitespace and formatting are canonicalized. Comments are preserved (see writeAST docstring for details).

  @param source - Agency source code as a string
  @param allowedPackages - Glob patterns; matched imports are allowed (subject to excludes)
  @param excludedPackages - Glob patterns; matched imports are dropped
  @param allowKinds - Kind strings ("stdlib" | "pkg" | "local" | "node") to allow
  @param excludeKinds - Kind strings to drop
  """
  return try _filterImports(source, allowedPackages, excludedPackages, allowKinds, excludeKinds)
}
```

No interrupt — pure string-in / string-out, no filesystem.

### Step 4: Tests — `lib/stdlib/agency.test.ts`

Cover the policy matrix:
- All four lists empty → `filtered: false`, source byte-equivalent after formatting normalization (use `_format(source)` as the expected baseline)
- `allowKinds: ["stdlib"]` on a source with one stdlib + one local import → local dropped, `filtered: true`
- `excludeKinds: ["node"]` → all bare-specifier imports dropped
- `allowedPackages: ["std::shell", "pkg::foo"]` → exact-list allow
- `excludedPackages: ["std::shell"]` with `allowKinds: ["stdlib"]` → exclude wins (std::shell dropped, other stdlib imports kept)
- Union semantics: `allowKinds: ["stdlib"]` + `allowedPackages: ["pkg::foo"]` → both stdlib AND pkg::foo pass
- Unknown kind string in `allowKinds: ["bogus"]` → no match, behaves like an empty allow list contribution (but if `allowKinds` is non-empty, default-allow does NOT kick in — verify the test reflects this corner)
- Glob behavior: `allowedPackages: ["std::*"]` → all stdlib imports pass
- Empty source / no imports → `filtered: false`, source matches formatter output

### Step 5: Regenerate stdlib JS

```bash
make
```

### Step 6: Agency execution test — `tests/agency/`

End-to-end: a source with a mix of stdlib, pkg, local, and node imports. Call `filterImports` with `allowKinds: ["stdlib", "pkg"]`. Assert the resulting source contains the stdlib/pkg imports and does not contain `fs` or `./util.agency`. Confirms the round-trip through the Agency runtime.

---

## Task 8 — Consolidate `compileSource`'s `restrictImports` onto the import policy

**Goal:** Replace `compileSource`'s boolean `restrictImports` with the shared `ImportPolicy`. Compile-time policy violations still **fail the compile** (security-critical — we can't silently drop disallowed imports inside `compileSource`, since that would quietly trim the compiled output's tool surface).

Depends on: Task 7 (shared classifier + `_filterImports`).

### Step 1: Add `imports` to `CompileSourceOptions` — `lib/compiler/compile.ts`

```ts
import { ImportPolicy, isImportAllowed } from "../importPaths.js";

export type CompileSourceOptions = AgencyConfig & {
  /** @deprecated Use `imports: { allowKinds: ["stdlib"] }` instead. */
  restrictImports?: boolean;
  /** Import policy. Disallowed imports cause the compile to fail with
   *  one error per violation. See lib/importPaths.ts for the shape. */
  imports?: ImportPolicy;
};
```

### Step 2: Resolve the effective policy

`restrictImports: true` is sugar for `{ allowKinds: ["stdlib"] }`. Resolve before the rest of the pipeline runs:

```ts
function resolveImportPolicy(config: CompileSourceOptions): ImportPolicy | null {
  if (config.imports && config.restrictImports) {
    throw new Error(
      "compileSource: pass either `imports` or `restrictImports`, not both. `restrictImports` is the deprecated shorthand.",
    );
  }
  if (config.imports) return config.imports;
  if (config.restrictImports) return { allowKinds: ["stdlib"] };
  return null;
}
```

### Step 3: Check imports against policy; produce per-violation errors on rejection

The shared primitive is `isImportAllowed`, not the parse-and-regenerate pipeline. `compileSource` has already parsed the program, so just walk the existing AST and collect violations. **Do not call `_filterImports`** — re-parsing and re-generating source we already have on hand is pure waste, and stripping imports from a compiled program would silently shrink the tool surface.

```ts
// 2. Check imports against policy.
const policy = resolveImportPolicy(config);
if (policy) {
  const violations = program.nodes
    .filter((n): n is ImportStatement => n.type === "importStatement")
    .filter((n) => !isImportAllowed(n.modulePath, policy))
    .map((n) => `Import '${n.modulePath}' is not allowed under the configured import policy.`);
  if (violations.length > 0) {
    return { success: false, errors: violations };
  }
}
```

Both `compileSource` and `_filterImports` go through `isImportAllowed` — that's the real reuse, and it's free.

**Open question to flag for the implementer:** the return shape `{ source, filtered }` is intentionally minimal per the user's spec. If experience with this code shows that callers (especially `compileSource`) keep wanting to know *which* paths were dropped, consider widening to `{ source, filtered, removedPaths: string[] }` in a follow-up. Don't do it now — the boolean is what was asked for and the second walk in `compileSource` is cheap.

### Step 4: Remove `checkRestrictedImports`

The old `checkRestrictedImports(program)` helper in `lib/compiler/compile.ts` is now dead. Remove it and its helper `classifyImport(importPath)` (the human-readable label classifier — different from the new `importKind`, which returns the enum).

### Step 5: Tests

- `lib/compiler/compile.test.ts` (or wherever existing `restrictImports` tests live):
  - All existing `restrictImports: true` tests still pass (backward compat via the resolver)
  - New `imports: { allowKinds: ["stdlib"] }` tests cover the same ground
  - Error messages name every violating import (not just the first one) — verify against the old behavior, which only reported one
  - Passing both `restrictImports` and `imports` throws

- `lib/stdlib/agency.test.ts`:
  - Existing `_compile` tests using `restrictImports: true` keep working

### Step 6: Caller audit

`grep -rn 'restrictImports' lib/ stdlib/ tests/ docs/` to find every caller. The only in-tree user should be `compileAndPersist` in `lib/stdlib/agency.ts` (passed via `_compile` / `_compileFile`). Update it to use the new `imports` shape; leave the boolean alone in `compileAndPersist` if you want zero behavior change, or migrate it for cleanliness. I'd migrate.

### Step 7: Regenerate stdlib JS

```bash
make
```

---

## Anti-pattern review (before opening PR)

Check the diff against `docs/dev/anti-patterns.md`:
- Don't duplicate the sandbox containment logic — extend `resolveInSandbox`, don't copy-paste it again.
- `_format`, `_formatFile`, `_writeAST` all share the AST → source step. Make sure they go through one helper (`generateSource`), not three call sites.
- `_getImports` / `_getFunctions` / `_getGraphNodes` must delegate to `_getNodesOfType` — don't reimplement the parse-and-walk dance three times.
- The existing `getNodesOfType` in `lib/utils/node.ts` and our new `_getNodesOfType` have different signatures (single-type-string + nodes-array vs. multi-type-string + source-string). That's intentional, not duplication — but check whether they could reasonably converge during this work, and if so, do it.
- `_filterImports` and `compileSource`'s policy check **must** share `isImportAllowed` from `lib/importPaths.ts`. If you find yourself writing a second classifier, stop.
- Don't reintroduce `checkRestrictedImports` or `classifyImport` (the old `compile.ts` helpers). They're gone in Task 8 and the new policy machinery replaces them.
- Keep `_parseAST` / `_writeAST` / `_format` / `_formatFile` / `_getNodesOfType` declarative — no for-loop scaffolding around the parse/generate/filter calls.
- Cleanup paths (if any tempdirs get created in tests) must go through `safeDeleteDirectory(path, false)` — not raw `fs.rmSync`.
- No empty `catch (_) {}` blocks.

---

## Open follow-ups (out of scope for this plan)

- `read` / `write` parameter order is `(filename, content, dir)`, inconsistent with `_compileFile` / `_typecheckFile` / `writeAST`'s `(dir, filename)`. Worth a separate breaking-change discussion.
- Exposing a typed `ASTNode` hierarchy in Agency (instead of `any`) — large surface, would drift from the TS side. Deferred unless real callers ask for it.
