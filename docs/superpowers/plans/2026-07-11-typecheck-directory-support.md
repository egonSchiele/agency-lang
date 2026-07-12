# Typecheck Directory + Stdin Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `agency typecheck`/`tc`/`check` (and its siblings `ast`/`parse`, `preprocess`, `diagnostics`) accept directory arguments and a literal `-` stdin argument, instead of crashing with EISDIR.

**Architecture:** Add one shared resolver, `resolveInputSources(inputs)`, in `lib/cli/commands.ts` that turns raw CLI args into an ordered list of `InputSource` values (`file` or `stdin`), expanding directories via the existing `findRecursively` walker and mapping `-` to stdin. A `forEachSource(inputs, handle)` helper encapsulates the resolve → null-check → read → iterate scaffold so the four sibling commands (ast/parse, preprocess, diagnostics) each declare only their per-file work instead of duplicating the loop. typecheck is the deliberate exception: it needs the whole resolved list up front to seed one `SymbolTable` from **every** file source (crawling reachable files + stdlib once), so it calls `resolveInputSources`/`readSource` directly.

**Tech Stack:** TypeScript, Commander (CLI), vitest (unit), Node integration harness (`tests/integration/cli-main/test.mjs`).

## Global Constraints

- NEVER commit to `main`. All work happens on branch `worktree-typecheck-directory-support` in the worktree at `/Users/adityabhargava/agency-lang/.claude/worktrees/typecheck-directory-support`.
- NEVER use dynamic imports.
- Use types, not interfaces. Use arrays, not sets. Use objects, not maps.
- The five affected commands live in `packages/agency-lang/scripts/agency.ts`. The shared helpers live in `packages/agency-lang/lib/cli/commands.ts`. All paths below are relative to `packages/agency-lang/` unless absolute.
- `commands.ts` already imports everything the new helper needs: `import * as fs from "fs"` (line 5), `import * as path from "path"` (line 7), `import { findRecursively } from "./util.js"` (line 22), and `readFile` (re-exported at line 155). Do not add duplicate imports.
- Preserve existing behavior: no arguments → read stdin; typecheck exits 1 on any error-severity diagnostic.

---

### Task 1: Shared input resolver (`resolveInputSources` + `readSource` + `forEachSource`)

Add the resolver, a stdin/file reader, and an iteration helper to `lib/cli/commands.ts`, with fast vitest coverage. This task adds no command wiring yet.

**Files:**
- Modify: `lib/cli/commands.ts` (add type + three functions near the existing `readStdin`/`readFile` exports, around lines 114–155)
- Test: `lib/cli/commands.test.ts` (create)

**Interfaces:**
- Produces:
  - `type InputSource = { kind: "file"; path: string } | { kind: "stdin" }`
  - `resolveInputSources(inputs: string[]): InputSource[] | null` — ordered sources; `[{ kind: "stdin" }]` when `inputs` is empty; `null` (after printing a notice) when args were given but no `.agency` files were found; `process.exit(1)` on a missing path or a second stdin source.
  - `readSource(src: InputSource): Promise<string>` — `readStdin()` for stdin, `readFile(src.path)` for a file.
  - `forEachSource(inputs: string[], handle: (contents: string, src: InputSource) => void): Promise<void>` — resolves `inputs`, returns early on the `null` notice case, then reads and hands each source to `handle`. Encapsulates the resolve → null-check → iterate → read scaffold so the four sibling commands (ast/parse, preprocess, diagnostics) don't each duplicate it. typecheck deliberately does NOT use this helper: it needs the full resolved list up front to seed one `SymbolTable` from every file source, so it calls `resolveInputSources`/`readSource` directly (see Task 2).

- [ ] **Step 1: Write the failing unit test**

Create `lib/cli/commands.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { resolveInputSources } from "./commands.js";

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agency-resolve-"));
}

describe("resolveInputSources", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("maps no arguments to a single stdin source", () => {
    expect(resolveInputSources([])).toEqual([{ kind: "stdin" }]);
  });

  it("maps '-' to a stdin source", () => {
    expect(resolveInputSources(["-"])).toEqual([{ kind: "stdin" }]);
  });

  it("keeps a plain file as a file source", () => {
    const dir = makeTempDir();
    const file = path.join(dir, "a.agency");
    fs.writeFileSync(file, "node main() {}\n");
    expect(resolveInputSources([file])).toEqual([{ kind: "file", path: file }]);
  });

  it("expands a directory to its .agency files", () => {
    const dir = makeTempDir();
    fs.writeFileSync(path.join(dir, "a.agency"), "node a() {}\n");
    fs.writeFileSync(path.join(dir, "b.agency"), "node b() {}\n");
    fs.writeFileSync(path.join(dir, "ignore.txt"), "not agency\n");
    const result = resolveInputSources([dir]);
    const paths = (result ?? [])
      .filter((s) => s.kind === "file")
      .map((s) => path.basename((s as { path: string }).path))
      .sort();
    expect(paths).toEqual(["a.agency", "b.agency"]);
  });

  it("preserves order across mixed directory and file arguments", () => {
    const dir = makeTempDir();
    fs.writeFileSync(path.join(dir, "d.agency"), "node d() {}\n");
    const file = path.join(makeTempDir(), "solo.agency");
    fs.writeFileSync(file, "node solo() {}\n");
    const result = resolveInputSources([dir, file]) ?? [];
    expect(result.map((s) => (s.kind === "file" ? path.basename(s.path) : "-"))).toEqual([
      "d.agency",
      "solo.agency",
    ]);
  });

  it("returns null and prints a notice for a directory with no .agency files", () => {
    const dir = makeTempDir();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(resolveInputSources([dir])).toBeNull();
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("No .agency files found"),
    );
  });

  it("exits on a missing path", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation(((): never => {
      throw new Error("exit");
    }) as never);
    expect(() => resolveInputSources(["does-not-exist.agency"])).toThrow("exit");
  });

  it("exits when stdin is requested twice", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation(((): never => {
      throw new Error("exit");
    }) as never);
    expect(() => resolveInputSources(["-", "-"])).toThrow("exit");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run lib/cli/commands.test.ts`
Expected: FAIL — `resolveInputSources` is not exported from `./commands.js`.

- [ ] **Step 3: Implement the resolver and reader**

In `lib/cli/commands.ts`, immediately after the `readStdin` function (ends at line 131) and before `export function parse(`, insert:

```ts
export type InputSource = { kind: "file"; path: string } | { kind: "stdin" };

/**
 * Turn raw CLI arguments into an ordered list of input sources.
 * - no arguments   -> a single stdin source
 * - "-"            -> a stdin source (mixable with files/dirs)
 * - a directory    -> every .agency file under it (recursive)
 * - a file         -> that file
 * - a missing path -> prints an error and exits 1
 * - a second stdin -> prints an error and exits 1 (stdin is read-once)
 *
 * Returns null (after printing a notice) when arguments were given but no
 * .agency files were found, so the caller can exit cleanly instead of
 * hanging on stdin.
 */
export function resolveInputSources(inputs: string[]): InputSource[] | null {
  if (inputs.length === 0) {
    return [{ kind: "stdin" }];
  }
  const sources: InputSource[] = [];
  let sawStdin = false;
  for (const input of inputs) {
    if (input === "-") {
      if (sawStdin) {
        console.error("Error: stdin ('-') can only be read once");
        process.exit(1);
      }
      sawStdin = true;
      sources.push({ kind: "stdin" });
      continue;
    }
    if (!fs.existsSync(input)) {
      console.error(`Error: Input file '${input}' not found`);
      process.exit(1);
    }
    if (fs.statSync(input).isDirectory()) {
      for (const { path: filePath } of findRecursively(input)) {
        sources.push({ kind: "file", path: filePath });
      }
    } else {
      sources.push({ kind: "file", path: input });
    }
  }
  if (sources.length === 0) {
    console.log("No .agency files found in the given input(s).");
    return null;
  }
  return sources;
}
```

> **Note on the notice wording.** The design doc (§D) phrases this as `No .agency files found in '<dir>'` (naming the directory). We deliberately use a generic message here because `inputs` may be several arguments, not one directory. The integration tests below assert only the `"No .agency files found"` prefix, so both wordings pass — do not "correct" this to include a single `<dir>` or the multi-input case would be misleading.

```ts
// (end of resolver — the reader and iteration helper below)

export async function readSource(src: InputSource): Promise<string> {
  return src.kind === "stdin" ? readStdin() : readFile(src.path);
}

/**
 * Resolve `inputs` to sources, then read and hand each to `handle`. Returns
 * early (no-op) when `resolveInputSources` returns null (arguments given but
 * no .agency files found). This is the shared "iterate every input" scaffold
 * for commands that process each source independently. typecheck does NOT use
 * it — it needs the whole resolved list up front to seed one SymbolTable.
 */
export async function forEachSource(
  inputs: string[],
  handle: (contents: string, src: InputSource) => void,
): Promise<void> {
  const sources = resolveInputSources(inputs);
  if (sources === null) {
    return;
  }
  for (const src of sources) {
    handle(await readSource(src), src);
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm exec vitest run lib/cli/commands.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/cli/commands.ts lib/cli/commands.test.ts
git commit -m "Add resolveInputSources CLI helper for dirs and stdin (#438)"
```

---

### Task 2: Wire typecheck to the resolver + integration tests

Route `typecheck`/`tc`/`check` through `resolveInputSources`, preserving the single-`SymbolTable` optimization, and add end-to-end coverage for directories, mixed args, `-`, and empty directories.

**Files:**
- Modify: `scripts/agency.ts:846-883` (the `typecheck` action)
- Modify: `scripts/agency.ts:8-12` (import block from `@/cli/commands.js`)
- Test: `tests/integration/cli-main/test.mjs` (add cases in the `// tc` section, after line 530)

**Interfaces:**
- Consumes: `resolveInputSources`, `readSource`, `InputSource` from Task 1.

- [ ] **Step 1: Write the failing integration tests**

In `tests/integration/cli-main/test.mjs`, immediately after the `28-tc-strict` block (ends at line 530), insert:

```ts
  // tc: directories and '-' stdin (#438)
  const tcDir = join(dir, "tc-clean");
  mkdirSync(tcDir, { recursive: true });
  writeFileSync(
    join(tcDir, "one.agency"),
    `node oneCheck(): string {
  return "ok"
}
`,
  );
  writeFileSync(
    join(tcDir, "two.agency"),
    `node twoCheck(): number {
  return 42
}
`,
  );
  const tcDirOut = runAgency("28a-tc-dir", ["tc", "tc-clean"]);
  assert(
    (tcDirOut.match(/No type errors found\./g) || []).length >= 2,
    "tc on a directory should type check every .agency file in it",
  );

  // tc: a directory whose files import each other divergently. This guards the
  // multi-entrypoint SymbolTable seed: `consumer.agency` imports from
  // `helper.agency`, which is NOT reachable from whichever file `findRecursively`
  // yields first. With a single-file seed, consumer's import resolves to nothing
  // and typecheck reports a false-positive error (exit 1). Seeding from every
  // file source keeps it clean.
  const tcImportDir = join(dir, "tc-imports");
  mkdirSync(tcImportDir, { recursive: true });
  writeFileSync(
    join(tcImportDir, "helper.agency"),
    `export def greet(name: string): string {
  return "hi " + name
}
`,
  );
  writeFileSync(
    join(tcImportDir, "consumer.agency"),
    `import { greet } from "./helper.agency"

node useGreet(): string {
  return greet("there")
}
`,
  );
  const tcImportOut = runAgency("28a2-tc-dir-imports", ["tc", "tc-imports"]);
  assert(
    (tcImportOut.match(/No type errors found\./g) || []).length >= 2,
    "tc on a directory with cross-file imports must resolve them (seed the SymbolTable from every file, not just the first)",
  );

  const tcMixedOut = runAgency("28b-tc-dir-mixed", ["tc", "tc-clean", "src/type-ok.agency"]);
  assert(
    (tcMixedOut.match(/No type errors found\./g) || []).length >= 3,
    "tc should accept mixed directory and file arguments",
  );

  assertIncludes(
    runAgency("28c-tc-dash", ["tc", "-"], {
      input: `node dashCheck(): string {
  return "dash-ok"
}
`,
    }),
    "No type errors found.",
  );

  const tcEmptyDir = join(dir, "tc-empty");
  mkdirSync(tcEmptyDir, { recursive: true });
  assertIncludes(
    runAgency("28d-tc-empty-dir", ["tc", "tc-empty"]),
    "No .agency files found",
  );
```

- [ ] **Step 2: Run the integration test to verify the new cases fail**

Build, pack, and run the harness:

```bash
make && npm pack && node tests/integration/cli-main/test.mjs ./agency-lang-*.tgz
```

Expected: FAIL at case `28a-tc-dir` — passing the `tc-clean` directory throws `EISDIR` (directory read) against the current code.

- [ ] **Step 3: Add the import**

In `scripts/agency.ts`, the import from `@/cli/commands.js` currently spans lines 2–12 and pulls in `compile`, `compileWarning`, `format`, `formatFile`, `loadConfig`, `parse`, `readFile`, `readStdin`, and `run`. Do NOT replace the whole block — only ADD the two new symbols `resolveInputSources` and `readSource` to it. The result must keep every existing name:

```ts
import {
  compile,
  compileWarning,
  format,
  formatFile,
  loadConfig,
  parse,
  readFile,
  readSource,
  readStdin,
  resolveInputSources,
  run,
} from "@/cli/commands.js";
```

(`readFile` and `readStdin` remain imported — other commands in this file still use them directly until Task 3.)

- [ ] **Step 4: Rewrite the typecheck action body**

In `scripts/agency.ts`, replace the current input-handling block (lines 870–882, from `if (inputs.length === 0) {` through `if (hasErrors) process.exit(1);`) with:

typecheck does NOT use the `forEachSource` helper (Task 1). It needs the whole resolved list before iterating — to seed one `SymbolTable` from every file source — and it dispatches differently for stdin vs file, so it calls `resolveInputSources`/`readSource` directly:

```ts
      const sources = resolveInputSources(inputs);
      if (sources === null) {
        return;
      }
      // Build one SymbolTable seeded from EVERY file source, not just the
      // first. `SymbolTable.build` accepts an array of entrypoints and crawls
      // reachable files (imports + stdlib) from each, deduping via its visited
      // set. Seeding from only the first file leaves files whose imports are
      // unreachable from it with an empty resolution -> false-positive "unknown
      // symbol" errors and missing interrupt-effect metadata (see below). The
      // symbol table stays file-keyed, so adding more entrypoints never merges
      // or pollutes across files; it only makes resolution complete.
      const filePaths = sources
        .filter((s) => s.kind === "file")
        .map((s) => path.resolve(s.path));
      const symbolTable = filePaths.length
        ? SymbolTable.build(filePaths, config)
        : undefined;
      for (const src of sources) {
        const contents = await readSource(src);
        if (src.kind === "stdin") {
          runTypeCheck(contents);
        } else {
          runTypeCheck(contents, src.path, symbolTable);
        }
      }
      if (hasErrors) process.exit(1);
```

Leave the `runTypeCheck` closure (lines 849–866) and the `--strict` handling (lines 867–869) unchanged.

> **Why seed from all files, not the first.** `SymbolTable.build` (`lib/symbolTable.ts:129`, signature `entrypoint: string | string[]`) crawls imports transitively from its entrypoint(s) only. Each file is later typechecked via `buildCompilationUnit(..., symbolTable, fromFile)`, which resolves that file's imports with `symbolTable.resolveImport(stmt, fromFile)` — a lookup into `this.files[resolvedImportPath]`. If a file's imports were never reachable from the seed, that lookup returns `undefined` and the import resolves to nothing. Empirically (verified against the real typechecker), an unresolved agency import is **fail-open**: the imported name becomes `any` rather than an "unknown symbol" error. So a single-file seed does not produce false positives — it **silently misses real cross-file type errors** (e.g. a wrong-typed call to an imported function) in every file whose imports aren't reachable from the arbitrary first file, and also drops those files' interrupt-effect metadata (`symbolTable.getFile(fromFile)` is `undefined`). For the primary `agency tc src/` use case that is a correctness hole (missed errors, silent). Seeding from every file makes directory typechecking complete, and is free — the loop parses those files anyway.

- [ ] **Step 5: Run the integration test to verify it passes**

```bash
make && npm pack && node tests/integration/cli-main/test.mjs ./agency-lang-*.tgz
```

Expected: PASS — all `tc` cases including `28a`–`28d` succeed, and existing cases `25`–`28` (single file, error, stdin, strict) still pass.

- [ ] **Step 6: Commit**

```bash
git add scripts/agency.ts tests/integration/cli-main/test.mjs
git commit -m "typecheck: accept directories and '-' stdin (#438)"
```

---

### Task 3: Wire the sibling commands (ast/parse, preprocess, diagnostics)

Apply the same resolver to the three remaining commands that share the `readFile`-in-a-loop pattern, with one integration test proving the shared helper works beyond typecheck.

**Files:**
- Modify: `scripts/agency.ts:571-584` (the `ast`/`parse` action)
- Modify: `scripts/agency.ts:592-615` (the `preprocess` action)
- Modify: `scripts/agency.ts:811-836` (the `diagnostics` action)
- Test: `tests/integration/cli-main/test.mjs` (add a `parse` directory case in the `// parse` section, after line 468)

**Interfaces:**
- Consumes: `forEachSource` from Task 1. Add `forEachSource` to the `@/cli/commands.js` import block (the same block extended in Task 2). `resolveInputSources` and `readSource` are already imported from Task 2 but are no longer referenced directly by these three commands — leave them imported only if typecheck (Task 2) still uses them (it does).

- [ ] **Step 1: Write the failing integration test**

In `tests/integration/cli-main/test.mjs`, immediately after the `17-parse-stdin` block (ends at line 468), insert:

```ts
  // parse: directory support (#438)
  const parseDir = join(dir, "parse-dir");
  mkdirSync(parseDir, { recursive: true });
  writeFileSync(
    join(parseDir, "alpha.agency"),
    `node alphaMain() {
  return "alpha"
}
`,
  );
  writeFileSync(
    join(parseDir, "beta.agency"),
    `node betaMain() {
  return "beta"
}
`,
  );
  const parseDirOut = runAgency("17a-parse-dir", ["parse", "parse-dir"]);
  assertIncludes(parseDirOut, "alphaMain");
  assertIncludes(parseDirOut, "betaMain");
```

- [ ] **Step 2: Run the integration test to verify it fails**

```bash
make && npm pack && node tests/integration/cli-main/test.mjs ./agency-lang-*.tgz
```

Expected: FAIL at case `17a-parse-dir` — passing the `parse-dir` directory throws `EISDIR` against the current code.

- [ ] **Step 3: Rewrite the ast/parse action**

In `scripts/agency.ts`, replace the `ast`/`parse` action body (lines 571–584, the whole `async (inputs) => { ... }`) with:

```ts
    .action(async (inputs: string[]) => {
      const config = getConfig();
      await forEachSource(inputs, (contents) => {
        const result = parse(contents, config);
        console.log(JSON.stringify(result, null, 2));
      });
    });
```

- [ ] **Step 4: Rewrite the preprocess action**

In `scripts/agency.ts`, replace the `preprocess` input-handling block (lines 607–615, from `if (inputs.length === 0) {` to the end of the `else` block) with:

```ts
      await forEachSource(inputs, (contents) => {
        processInput(contents);
      });
```

Leave the `processInput` closure (lines 595–605) unchanged.

- [ ] **Step 5: Rewrite the diagnostics action**

In `scripts/agency.ts`, replace the `diagnostics` action body (lines 811–836, the whole `async (inputs) => { ... }`) with:

```ts
    .action(async (inputs: string[]) => {
      await forEachSource(inputs, (contents) => {
        try {
          _parseAgency(contents);
        } catch (error) {
          if (error instanceof TarsecError) {
            console.log(JSON.stringify(error.data, null, 2));
          } else {
            throw error;
          }
        }
      });
    });
```

- [ ] **Step 6: Run the integration test to verify it passes**

```bash
make && npm pack && node tests/integration/cli-main/test.mjs ./agency-lang-*.tgz
```

Expected: PASS — `17a-parse-dir` passes, and existing `parse` cases (`16-parse`, `17-parse-stdin`) still pass.

- [ ] **Step 7: Commit**

```bash
git add scripts/agency.ts tests/integration/cli-main/test.mjs
git commit -m "parse/preprocess/diagnostics: accept directories and '-' stdin (#438)"
```

---

### Task 4: Update documentation

Resolve the doc contradiction (one page promises directories, another says they are unsupported) and document `-`.

**Files:**
- Modify: `docs/site/guide/developer-tools.md` (the "Directories are not supported yet" line, ~line 24)
- Modify: `docs/site/cli/typecheck.md` (note `-` alongside the existing `agency tc src/` example)

- [ ] **Step 1: Fix the developer-tools guide**

Open `docs/site/guide/developer-tools.md`. Find the list around lines 19–24:

```
You can give it
- a file
- a list of files
- input on stdin.

Directories are not supported yet.
```

Replace it with:

```
You can give it
- a file
- a list of files
- a directory (scanned recursively for `.agency` files)
- a mix of the above
- input on stdin (no arguments, or a literal `-` that can be mixed with files and directories).
```

- [ ] **Step 2: Note `-` in the typecheck CLI page**

Open `docs/site/cli/typecheck.md`. It already shows `agency tc src/` and states "If no input is given, the type checker reads from stdin." Immediately after that stdin sentence, add:

```
You can also pass a literal `-` to read from stdin explicitly, and mix it with file and directory arguments (for example, `agency tc src/ extra.agency -`).
```

- [ ] **Step 3: Commit**

```bash
git add docs/site/guide/developer-tools.md docs/site/cli/typecheck.md
git commit -m "docs: typecheck and siblings accept directories and '-' (#438)"
```

---

## Self-Review

**Spec coverage:**
- Directory support for typecheck → Task 2. ✓
- Directory support for parse/ast, preprocess, diagnostics → Task 3. ✓
- Shared resolver reusing `findRecursively`, not reinventing the walk → Task 1. ✓
- `forEachSource` encapsulates the resolve/read/iterate scaffold; the four sibling commands declare only per-file work (no duplicated loop), typecheck is the documented exception → Task 1 + Task 3. ✓
- `-` stdin, mixable with files/dirs → Task 1 (`resolveInputSources`) + verified in Task 2 (`28c-tc-dash`). ✓
- typecheck single-`SymbolTable` seeded from **every** *file* source (not just the first, so cross-file imports in a directory resolve) → Task 2, Step 4 + `28a2-tc-dir-imports` test. ✓
- Empty directory prints a notice and exits 0 (no stdin hang) → Task 1 (returns null) + Task 2 (`28d`); callers `return` before any `process.exit(1)`. ✓
- Second stdin source is an error → Task 1 + unit test. ✓
- Missing path preserves exit-1 behavior → Task 1 + unit test. ✓
- Docs contradiction resolved → Task 4. ✓
- Tests in `tests/integration/cli-main/test.mjs` (dir, cross-file-import dir, mixed, `-`, empty dir, sibling parse) → Tasks 2 and 3. ✓
- Non-goals (no `--ignore`, no globs, no parallelism) → not implemented. ✓

**Placeholder scan:** No TBD/TODO; every code step shows complete code. ✓

**Type consistency:** `InputSource`, `resolveInputSources` (`InputSource[] | null`), and `readSource` are named identically in Tasks 1–3. The `null` return is handled the same way (`if (sources === null) return;`) in every command. ✓
