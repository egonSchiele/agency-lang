# Interrupt Kind Tracking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Statically analyze which interrupt kinds each function/node can throw, surface that information through the type checker (warnings), MCP/HTTP serve system, and LSP hover.

**Architecture:** A new `interruptAnalyzer.ts` module walks function/node bodies to collect direct interrupt kinds, builds a call graph, then propagates interrupt kinds transitively using topological sort + fixed-point iteration. Results are stored on `FunctionSymbol`/`NodeSymbol` in the symbol table. Consumers (type checker, serve, LSP) read from the symbol table.

**Tech Stack:** TypeScript, vitest for testing. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-05-08-interrupt-kind-tracking-design.md`

**PR split:**
- **PR 1** (Tasks 1-7): Core analysis, symbol table integration, type checker warnings. Self-contained and testable.
- **PR 2** (Tasks 8-11): Serve/MCP metadata, LSP hover, TODO. Consumes the data from PR 1.

**Key docs to read before starting:**
- `docs-new/guide/interrupts.md` — How interrupts work in Agency
- `docs-new/guide/handlers.md` — How handlers work (handle/with blocks, approve/reject/propagate)
- `docs/dev/typechecker.md` — Type checker architecture
- `lib/utils/node.ts` — `walkNodes` utility that yields `{ node, ancestors, scopes }`

---

### Task 1: Add `InterruptKind` type and update symbol types

**Files:**
- Modify: `lib/symbolTable.ts:22-41`

- [ ] **Step 1: Add `InterruptKind` type and update `FunctionSymbol` and `NodeSymbol`**

In `lib/symbolTable.ts`, add the new type after the imports (around line 21) and add the `interruptKinds` field to both symbol types:

```typescript
export type InterruptKind = {
  kind: string;  // e.g. "myapp::deploy", "std::read", "unknown"
};
```

Add to `FunctionSymbol` (after `returnTypeValidated`, around line 30):

```typescript
interruptKinds?: InterruptKind[];
```

Add to `NodeSymbol` (after `returnTypeValidated`, around line 39):

```typescript
interruptKinds?: InterruptKind[];
```

Make it optional (`?`) so existing code that creates these symbols doesn't break. The analyzer will populate it.

- [ ] **Step 2: Verify existing tests still pass**

Run: `pnpm vitest run lib/symbolTable.test.ts 2>&1 | tee /tmp/st-test.txt`
Expected: All tests pass (additive change only).

- [ ] **Step 3: Commit**

```bash
git add lib/symbolTable.ts
git commit -m "$(cat <<'EOF'
Add InterruptKind type and interruptKinds field to FunctionSymbol and NodeSymbol.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Scaffold `interruptAnalyzer.ts` with direct collection (Phase 1)

**Files:**
- Create: `lib/interruptAnalyzer.ts`
- Create: `lib/interruptAnalyzer.test.ts`

This task implements Phase 1 only: collecting interrupt kinds that appear directly in a function/node body as `interruptStatement` AST nodes.

- [ ] **Step 1: Write failing tests for direct interrupt collection**

Create `lib/interruptAnalyzer.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { parseAgency } from "./parser.js";
import { classifySymbols } from "./symbolTable.js";
import type { FileSymbols, FunctionSymbol, NodeSymbol } from "./symbolTable.js";
import { analyzeInterrupts } from "./interruptAnalyzer.js";

type AnalyzedFiles = Record<string, FileSymbols>;

function analyze(source: string): AnalyzedFiles {
  const result = parseAgency(source, {});
  if (!result.success) throw new Error("Parse failed");
  const program = result.result;
  const symbols = classifySymbols(program);
  return analyzeInterrupts({
    "test.agency": { symbols, program },
  });
}

function isFunctionOrNode(sym: unknown): sym is FunctionSymbol | NodeSymbol {
  const s = sym as { kind?: string };
  return s?.kind === "function" || s?.kind === "node";
}

function interruptKindsFor(files: AnalyzedFiles, name: string): string[] {
  const sym = files["test.agency"][name];
  if (!isFunctionOrNode(sym)) return [];
  return (sym.interruptKinds ?? []).map((ik) => ik.kind).sort();
}

describe("interruptAnalyzer", () => {
  describe("direct collection", () => {
    it("collects structured interrupt kind from a function", () => {
      const files = analyze(`
        def deploy(env: string) {
          interrupt myapp::deploy("Deploy to env?")
          print("deploying")
        }
      `);
      expect(interruptKindsFor(files, "deploy")).toEqual(["myapp::deploy"]);
    });

    it("collects bare interrupt as unknown kind", () => {
      const files = analyze(`
        def confirm() {
          interrupt("Are you sure?")
        }
      `);
      expect(interruptKindsFor(files, "confirm")).toEqual(["unknown"]);
    });

    it("collects multiple interrupt kinds from one function", () => {
      const files = analyze(`
        def riskyOp() {
          interrupt myapp::deploy("Deploy?")
          interrupt myapp::notify("Notify?")
        }
      `);
      expect(interruptKindsFor(files, "riskyOp")).toEqual([
        "myapp::deploy",
        "myapp::notify",
      ]);
    });

    it("deduplicates interrupt kinds", () => {
      const files = analyze(`
        def loopy() {
          interrupt myapp::deploy("first")
          interrupt myapp::deploy("second")
        }
      `);
      expect(interruptKindsFor(files, "loopy")).toEqual(["myapp::deploy"]);
    });

    it("returns empty for functions with no interrupts", () => {
      const files = analyze(`
        def add(a: number, b: number): number {
          return a + b
        }
      `);
      expect(interruptKindsFor(files, "add")).toEqual([]);
    });

    it("collects interrupt kinds from a node", () => {
      const files = analyze(`
        node main() {
          interrupt std::read("Confirm?")
        }
      `);
      expect(interruptKindsFor(files, "main")).toEqual(["std::read"]);
    });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run lib/interruptAnalyzer.test.ts 2>&1 | tee /tmp/ia-test-1.txt`
Expected: FAIL — module `./interruptAnalyzer.js` not found.

- [ ] **Step 3: Implement the analyzer with direct collection**

Create `lib/interruptAnalyzer.ts`:

```typescript
import type { AgencyProgram, AgencyNode } from "./types.js";
import type { FileSymbols, InterruptKind } from "./symbolTable.js";
import { walkNodes } from "./utils/node.js";

type FileInput = {
  symbols: FileSymbols;
  program: AgencyProgram;
};

/** Maps function/node name to its direct interrupt kind strings. */
type KindsByFunction = Record<string, string[]>;

/** Maps file path to its per-function interrupt kinds. */
type KindsByFile = Record<string, KindsByFunction>;

/**
 * Analyze all files and return new FileSymbols with interruptKinds populated
 * on every function and node symbol.
 */
export function analyzeInterrupts(
  files: Record<string, FileInput>,
): Record<string, FileSymbols> {
  const directKinds = collectAllDirectInterrupts(files);
  // Phase 3 (transitive resolution) will be added in Task 4
  return attachInterruptKinds(files, directKinds);
}

function collectAllDirectInterrupts(
  files: Record<string, FileInput>,
): KindsByFile {
  const result: KindsByFile = {};
  for (const [filePath, { program }] of Object.entries(files)) {
    result[filePath] = collectDirectInterrupts(program);
  }
  return result;
}

function collectDirectInterrupts(program: AgencyProgram): KindsByFunction {
  const result: KindsByFunction = {};
  for (const node of program.nodes) {
    if (node.type === "function") {
      result[node.functionName] = collectInterruptsInBody(node.body);
    } else if (node.type === "graphNode") {
      result[node.nodeName] = collectInterruptsInBody(node.body);
    }
  }
  return result;
}

function collectInterruptsInBody(body: AgencyNode[]): string[] {
  const kinds: string[] = [];
  for (const { node } of walkNodes(body)) {
    if (node.type === "interruptStatement") {
      if (!kinds.includes(node.kind)) {
        kinds.push(node.kind);
      }
    }
  }
  return kinds;
}

function attachInterruptKinds(
  files: Record<string, FileInput>,
  kindsByFile: KindsByFile,
): Record<string, FileSymbols> {
  const result: Record<string, FileSymbols> = {};
  for (const [filePath, { symbols }] of Object.entries(files)) {
    result[filePath] = attachKindsToSymbols(
      symbols,
      kindsByFile[filePath] ?? {},
    );
  }
  return result;
}

function attachKindsToSymbols(
  symbols: FileSymbols,
  kindsByFunction: KindsByFunction,
): FileSymbols {
  const result: FileSymbols = {};
  for (const [name, sym] of Object.entries(symbols)) {
    if (sym.kind === "function" || sym.kind === "node") {
      const kinds = kindsByFunction[name] ?? [];
      result[name] = {
        ...sym,
        interruptKinds: kinds.map((k) => ({ kind: k })),
      };
    } else {
      result[name] = sym;
    }
  }
  return result;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run lib/interruptAnalyzer.test.ts 2>&1 | tee /tmp/ia-test-2.txt`
Expected: All 6 tests pass.

- [ ] **Step 5: Commit**

```bash
git add lib/interruptAnalyzer.ts lib/interruptAnalyzer.test.ts
git commit -m "$(cat <<'EOF'
Add interruptAnalyzer with Phase 1: direct interrupt kind collection.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Add block and function-reference analysis to Phase 1

**Files:**
- Modify: `lib/interruptAnalyzer.ts`
- Modify: `lib/interruptAnalyzer.test.ts`

This extends Phase 1 to handle: block arguments at call sites (trailing `as` blocks and inline `\` blocks), function references and partial applications passed as arguments, and variable tracing.

- [ ] **Step 1: Write failing tests for block arguments**

Add to `lib/interruptAnalyzer.test.ts` inside the `describe("interruptAnalyzer")` block:

```typescript
  describe("block arguments", () => {
    it("attributes trailing block interrupts to the calling function", () => {
      const files = analyze(`
        def doWork(items: string[], block: (string) => any): any[] {
          return []
        }
        node main() {
          const result = doWork(["a"]) as item {
            interrupt myapp::process("Process item?")
            return item
          }
        }
      `);
      expect(interruptKindsFor(files, "main")).toEqual(["myapp::process"]);
      expect(interruptKindsFor(files, "doWork")).toEqual([]);
    });

    it("attributes inline block interrupts to the calling function", () => {
      const files = analyze(`
        def doWork(items: string[], block: (string) => any): any[] {
          return []
        }
        node main() {
          const result = doWork(["a"], \\item -> interrupt myapp::process("Process?"))
        }
      `);
      expect(interruptKindsFor(files, "main")).toEqual(["myapp::process"]);
      expect(interruptKindsFor(files, "doWork")).toEqual([]);
    });
  });
```

- [ ] **Step 2: Run tests to verify the new test fails**

Run: `pnpm vitest run lib/interruptAnalyzer.test.ts 2>&1 | tee /tmp/ia-test-3.txt`
Expected: The block argument test fails — block bodies aren't walked yet. Verify the direct collection tests still pass.

- [ ] **Step 3: Update `collectInterruptsInBody` to handle blocks**

The `walkNodes` utility already descends into block argument bodies (see `lib/utils/node.ts:376-382`). When `walkNodes` descends into a `blockArgument`, the block appears in the `ancestors` array. So `interruptStatement` nodes inside blocks are already yielded.

However, we need to make sure that when walking a function body like `doWork`, we do NOT descend into blocks defined at call sites — those blocks belong to the caller. The key insight: `walkNodes` called on `doWork`'s body only walks `doWork`'s body. Blocks at call sites in `main` are walked when we walk `main`'s body. So the current implementation should already work.

Check if the test actually passes with the existing code. If it does, you don't need changes. If not, the issue is that `walkNodes` when walking `main`'s body encounters the `functionCall` node for `doWork`, descends into its block argument, and finds the `interruptStatement` — which should already be collected under `main`.

Run: `pnpm vitest run lib/interruptAnalyzer.test.ts 2>&1 | tee /tmp/ia-test-3b.txt`

If the test passes, move on. If it fails, the issue is likely that `collectDirectInterrupts` only walks top-level function/node definitions but needs to walk nested content. Check the output and fix accordingly.

- [ ] **Step 4: Write failing tests for variable tracing and function references**

Add to `lib/interruptAnalyzer.test.ts`:

```typescript
  describe("variable tracing", () => {
    it("traces a variable assigned a function reference", () => {
      const files = analyze(`
        def deploy() {
          interrupt myapp::deploy("Deploy?")
        }
        def orchestrate() {
          const fn = deploy
          fn()
        }
      `);
      // orchestrate calls deploy transitively — tested in Task 4
      // For now just verify deploy has the interrupt
      expect(interruptKindsFor(files, "deploy")).toEqual(["myapp::deploy"]);
    });
  });
```

Note: Full variable tracing (resolving `fn` back to `deploy` and including `deploy`'s interrupts in `orchestrate`) requires Phase 2 (call graph) and Phase 3 (transitive resolution), which are Task 4. For this task, just ensure direct collection works for all syntactic forms.

- [ ] **Step 5: Run tests and commit**

Run: `pnpm vitest run lib/interruptAnalyzer.test.ts 2>&1 | tee /tmp/ia-test-4.txt`
Expected: All tests pass.

```bash
git add lib/interruptAnalyzer.ts lib/interruptAnalyzer.test.ts
git commit -m "$(cat <<'EOF'
Extend interruptAnalyzer Phase 1: block arguments and variable tracing tests.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Add call graph construction (Phase 2) and transitive resolution (Phase 3)

**Files:**
- Modify: `lib/interruptAnalyzer.ts`
- Modify: `lib/interruptAnalyzer.test.ts`

This is the core complexity: building the call graph and propagating interrupt kinds transitively.

- [ ] **Step 1: Write failing tests for transitive propagation**

Add to `lib/interruptAnalyzer.test.ts`:

```typescript
  describe("transitive propagation", () => {
    it("propagates interrupt kinds through function calls", () => {
      const files = analyze(`
        def deploy() {
          interrupt myapp::deploy("Deploy?")
        }
        def orchestrate() {
          deploy()
        }
      `);
      expect(interruptKindsFor(files, "orchestrate")).toEqual(["myapp::deploy"]);
    });

    it("propagates through multiple levels", () => {
      const files = analyze(`
        def deploy() {
          interrupt myapp::deploy("Deploy?")
        }
        def orchestrate() {
          deploy()
        }
        node main() {
          orchestrate()
        }
      `);
      expect(interruptKindsFor(files, "main")).toEqual(["myapp::deploy"]);
    });

    it("propagates through node-to-node calls", () => {
      const files = analyze(`
        node checkout() {
          interrupt payment::charge("Charge?")
        }
        node main() {
          return checkout()
        }
      `);
      expect(interruptKindsFor(files, "main")).toEqual(["payment::charge"]);
    });

    it("unions interrupt kinds from multiple callees", () => {
      const files = analyze(`
        def deploy() {
          interrupt myapp::deploy("Deploy?")
        }
        def notify() {
          interrupt myapp::notify("Notify?")
        }
        def orchestrate() {
          deploy()
          notify()
        }
      `);
      expect(interruptKindsFor(files, "orchestrate")).toEqual([
        "myapp::deploy",
        "myapp::notify",
      ]);
    });

    it("handles cycles (mutual recursion)", () => {
      const files = analyze(`
        def ping(n: number) {
          interrupt myapp::ping("ping")
          pong(n)
        }
        def pong(n: number) {
          interrupt myapp::pong("pong")
          ping(n)
        }
      `);
      expect(interruptKindsFor(files, "ping")).toEqual(["myapp::ping", "myapp::pong"]);
      expect(interruptKindsFor(files, "pong")).toEqual(["myapp::ping", "myapp::pong"]);
    });
  });
```

- [ ] **Step 2: Run tests to verify the new tests fail**

Run: `pnpm vitest run lib/interruptAnalyzer.test.ts 2>&1 | tee /tmp/ia-test-5.txt`
Expected: The transitive propagation tests fail (e.g. `orchestrate` has `[]` instead of `["myapp::deploy"]`).

- [ ] **Step 3: Implement call graph construction and transitive resolution**

Update `lib/interruptAnalyzer.ts`. Two changes: build a call graph during the AST walk, then propagate interrupt kinds through it.

**Call graph construction:**

During `collectDirectInterrupts`, also record which functions each function calls. Add a new return type or a parallel structure:

```typescript
type CallGraph = Record<string, string[]>;  // funcName -> [calleeName, ...]
```

When walking a function body, for each `functionCall` node, record the callee name. Also check for `gotoStatement` nodes (node-to-node calls via `return`), which contain a `nodeCall` field that is a `FunctionCall`.

For cross-file calls, use `{ file: string, name: string }` tuples in the call graph entries so the callee can be looked up in a different file's symbols. For now, all calls resolve within the same file.

**Transitive resolution via fixed-point iteration:**

No topological sort needed — simple fixed-point iteration handles DAGs and cycles correctly with minimal complexity:

```typescript
function resolveTransitiveInterrupts(
  kindsByFile: KindsByFile,
  callGraphByFile: Record<string, CallGraph>,
): void {
  let changed = true;
  while (changed) {
    changed = false;
    for (const [filePath, callGraph] of Object.entries(callGraphByFile)) {
      const kinds = kindsByFile[filePath];
      for (const [funcName, callees] of Object.entries(callGraph)) {
        const currentKinds = kinds[funcName] ?? [];
        for (const calleeName of callees) {
          const calleeKinds = kinds[calleeName] ?? [];
          for (const kind of calleeKinds) {
            if (!currentKinds.includes(kind)) {
              currentKinds.push(kind);
              changed = true;
            }
          }
        }
        kinds[funcName] = currentKinds;
      }
    }
  }
}
```

This works because:
- Interrupt sets can only grow (we only add, never remove).
- There are a finite number of distinct interrupt kinds in the program.
- Each iteration, at least one set grows, or we're done.
- For a DAG, this converges in one pass. For cycles, it takes at most N passes where N is the longest cycle.

Update `analyzeInterrupts` to call this after direct collection and before `attachInterruptKinds`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run lib/interruptAnalyzer.test.ts 2>&1 | tee /tmp/ia-test-6.txt`
Expected: All tests pass, including cycle handling.

- [ ] **Step 5: Commit**

```bash
git add lib/interruptAnalyzer.ts lib/interruptAnalyzer.test.ts
git commit -m "$(cat <<'EOF'
Add call graph construction and transitive interrupt kind resolution.

Supports direct calls, node-to-node calls, and cycle handling via
fixed-point iteration.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Add `llm()` tools array analysis

**Files:**
- Modify: `lib/interruptAnalyzer.ts`
- Modify: `lib/interruptAnalyzer.test.ts`

When `llm()` is called with a `tools` option containing function references, those functions' interrupt kinds should be included in the caller's set.

- [ ] **Step 1: Write failing tests for llm tools analysis**

Add to `lib/interruptAnalyzer.test.ts`:

```typescript
  describe("llm tools analysis", () => {
    it("collects interrupt kinds from tools in llm() call", () => {
      const files = analyze(`
        def deploy() {
          interrupt myapp::deploy("Deploy?")
        }
        def cleanup() {
          interrupt myapp::cleanup("Clean?")
        }
        node main() {
          const result = llm("do stuff", { tools: [deploy, cleanup] })
        }
      `);
      expect(interruptKindsFor(files, "main")).toEqual([
        "myapp::cleanup",
        "myapp::deploy",
      ]);
    });

    it("traces tools variable to array literal", () => {
      const files = analyze(`
        def deploy() {
          interrupt myapp::deploy("Deploy?")
        }
        node main() {
          const tools = [deploy]
          const result = llm("do stuff", { tools: tools })
        }
      `);
      expect(interruptKindsFor(files, "main")).toEqual(["myapp::deploy"]);
    });
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run lib/interruptAnalyzer.test.ts 2>&1 | tee /tmp/ia-test-7.txt`
Expected: llm tools tests fail.

- [ ] **Step 3: Implement llm tools analysis**

In the call graph construction phase, detect `llm()` calls and look for a `tools` property in the options object (the second argument). The options object is an `agencyObject` AST node with entries. Look for an entry with key `"tools"` whose value is either:

1. An `agencyArray` literal — resolve each element that is a `variableName` (function reference) as a callee.
2. A `variableName` — trace back to its assignment in the same function body. If the assignment value is an `agencyArray`, resolve each element.

For partial applications (`deploy.partial(env: "prod")`), the AST will be a `valueAccess` with a `methodCall` chain element where `functionName` is `"partial"`. The base of the `valueAccess` is the original function name.

- [ ] **Step 4: Run tests and commit**

Run: `pnpm vitest run lib/interruptAnalyzer.test.ts 2>&1 | tee /tmp/ia-test-8.txt`
Expected: All tests pass.

```bash
git add lib/interruptAnalyzer.ts lib/interruptAnalyzer.test.ts
git commit -m "$(cat <<'EOF'
Analyze llm() tools arrays for interrupt kind propagation.

Supports direct array literals and variable tracing to array literals.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Integrate analyzer into SymbolTable.build()

**Files:**
- Modify: `lib/symbolTable.ts:93-138`
- Modify: `lib/symbolTable.test.ts`

- [ ] **Step 1: Write a failing integration test**

Add to `lib/symbolTable.test.ts`:

```typescript
import { SymbolTable } from "./symbolTable.js";
import { writeFileSync, unlinkSync, mkdirSync } from "fs";
import path from "path";
import os from "os";

describe("SymbolTable interrupt analysis", () => {
  it("populates interruptKinds on function symbols", () => {
    const tmpDir = os.tmpdir();
    const file = path.join(tmpDir, `st-test-${Date.now()}.agency`);
    writeFileSync(file, `
      def deploy() {
        interrupt myapp::deploy("Deploy?")
      }
      def orchestrate() {
        deploy()
      }
      node main() {
        orchestrate()
      }
    `);
    try {
      const st = SymbolTable.build(file);
      const symbols = st.getFile(path.resolve(file))!;
      const deploy = symbols["deploy"];
      const orchestrate = symbols["orchestrate"];
      const main = symbols["main"];
      expect(deploy).toBeDefined();
      expect(orchestrate).toBeDefined();
      expect(main).toBeDefined();
      if (deploy.kind === "function") {
        expect(deploy.interruptKinds).toEqual([{ kind: "myapp::deploy" }]);
      }
      if (orchestrate.kind === "function") {
        expect(orchestrate.interruptKinds).toEqual([{ kind: "myapp::deploy" }]);
      }
      if (main.kind === "node") {
        expect(main.interruptKinds).toEqual([{ kind: "myapp::deploy" }]);
      }
    } finally {
      unlinkSync(file);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run lib/symbolTable.test.ts 2>&1 | tee /tmp/st-test-2.txt`
Expected: FAIL — `interruptKinds` is undefined on symbols.

- [ ] **Step 3: Integrate analyzer into SymbolTable.build()**

In `lib/symbolTable.ts`, update `SymbolTable.build()`:

1. Add import at top: `import { analyzeInterrupts } from "./interruptAnalyzer.js";`

2. Replace the separate `files` record with a combined `parsed` record that stores both symbols and programs together. This avoids parallel mutable records that must be kept in sync:

```typescript
// Before:
const files: Record<string, FileSymbols> = {};

// After:
const parsed: Record<string, { symbols: FileSymbols; program: AgencyProgram }> = {};
```

3. Update the line that stores classified symbols (line 122) to also store the program:

```typescript
// Before:
files[absPath] = classifySymbols(program);

// After:
parsed[absPath] = { symbols: classifySymbols(program), program };
```

4. Update import-walking to use `parsed[absPath].symbols` where `files[absPath]` was used.

5. After the `visit(entrypoint)` call and before the return, run the analyzer and extract the final files:

```typescript
const analyzedFiles = analyzeInterrupts(parsed);
return new SymbolTable(analyzedFiles);
```

6. Update the remaining methods (`has`, `getFile`, `resolveImport`, etc.) — these already work on `this.files` which is now populated from `analyzedFiles`. No changes needed.

Note: The `visit` closure currently references `files` for the import-walking loop. Since `classifySymbols` results are now in `parsed[absPath].symbols`, update the constructor call but nothing else needs to change in the walker — it doesn't read from `files` during traversal.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run lib/symbolTable.test.ts 2>&1 | tee /tmp/st-test-3.txt`
Expected: All tests pass, including the new integration test.

Also run the interrupt analyzer tests to make sure nothing broke:

Run: `pnpm vitest run lib/interruptAnalyzer.test.ts 2>&1 | tee /tmp/ia-test-9.txt`
Expected: All pass.

- [ ] **Step 5: Commit**

```bash
git add lib/symbolTable.ts lib/symbolTable.test.ts
git commit -m "$(cat <<'EOF'
Integrate interruptAnalyzer into SymbolTable.build().

After parsing all files and classifying symbols, the analyzer runs to
populate interruptKinds on every function and node symbol.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Thread symbol table into type checker and add interrupt warning

**Files:**
- Modify: `lib/compilationUnit.ts`
- Modify: `lib/typeChecker/types.ts`
- Modify: `lib/typeChecker/checker.ts:105-114`
- Modify: `lib/typeChecker.test.ts`

The type checker needs access to the **transitive** `interruptKinds` from the symbol table. The good news is that minimal changes are needed — the type checker already has `ctx.functionDefs` and `ctx.nodeDefs` which contain function/node definitions built during `CompilationUnit` construction. The `CompilationUnit` already receives the symbol table as a parameter. So we just need to:

1. Add a field to the definition types
2. Copy the data during scope construction

No function signatures change. No "threading" through multiple layers.

- [ ] **Step 1: Add `interruptKinds` to `FunctionDefinition` and `GraphNodeDefinition`**

Read `lib/typeChecker/scopes.ts` to find the `FunctionDefinition` and `GraphNodeDefinition` types. Add an optional `interruptKinds?: InterruptKind[]` field to both. Import `InterruptKind` from `../symbolTable.js`.

- [ ] **Step 2: Populate `interruptKinds` during CompilationUnit construction**

In `lib/compilationUnit.ts`, `buildCompilationUnit` already receives `symbolTable` and `fromFile` as parameters. When it creates `FunctionDefinition` objects (find where function AST nodes are converted to scope entries), look up the function name in `symbolTable.getFile(fromFile)` and copy `interruptKinds` from the symbol onto the definition. This is a one-liner per definition type — no new helper functions needed.

For example, where a function definition is constructed, add:

```typescript
interruptKinds: symbolTable?.getFile(fromFile)?.[node.functionName]?.interruptKinds,
```

- [ ] **Step 3: Write failing tests**

The type checker tests need to use the full pipeline to get transitive interrupt kinds. Use `SymbolTable.build()` with temp files (same pattern as Task 6), then `buildCompilationUnit` with the symbol table, then `typeCheck`. This ensures the tests exercise the real transitive resolution.

Add a new test file `lib/typeChecker/interruptWarnings.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { writeFileSync, unlinkSync } from "fs";
import path from "path";
import os from "os";
import { parseAgency } from "../parser.js";
import { SymbolTable } from "../symbolTable.js";
import { buildCompilationUnit } from "../compilationUnit.js";
import { typeCheck } from "./index.js";

function checkSource(source: string) {
  const file = path.join(os.tmpdir(), `tc-int-${Date.now()}.agency`);
  writeFileSync(file, source);
  try {
    const absPath = path.resolve(file);
    const symbolTable = SymbolTable.build(absPath);
    const parseResult = parseAgency(source, {});
    if (!parseResult.success) throw new Error("Parse failed");
    const program = parseResult.result;
    const info = buildCompilationUnit(program, symbolTable, absPath, source);
    return typeCheck(program, {}, info);
  } finally {
    unlinkSync(file);
  }
}

function warningsFrom(source: string) {
  const { errors } = checkSource(source);
  return errors.filter((e) => e.severity === "warning");
}

describe("interrupt kind warnings", () => {
  it("warns when calling a function with interrupts outside a handler", () => {
    const warnings = warningsFrom(`
      def deploy() {
        interrupt myapp::deploy("Deploy?")
      }
      node main() {
        deploy()
      }
    `);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].message).toContain("myapp::deploy");
  });

  it("warns with transitive interrupt kinds", () => {
    const warnings = warningsFrom(`
      def deploy() {
        interrupt myapp::deploy("Deploy?")
      }
      def orchestrate() {
        deploy()
      }
      node main() {
        orchestrate()
      }
    `);
    // orchestrate has no direct interrupts but transitively throws myapp::deploy
    // Both orchestrate() and deploy() calls outside handlers should warn
    const mainWarnings = warnings.filter((w) => w.message.includes("orchestrate"));
    expect(mainWarnings.length).toBeGreaterThanOrEqual(1);
    expect(mainWarnings[0].message).toContain("myapp::deploy");
  });

  it("does not warn when call is inside a handleBlock", () => {
    const warnings = warningsFrom(`
      def deploy() {
        interrupt myapp::deploy("Deploy?")
      }
      node main() {
        handle {
          deploy()
        } with (interrupt) {
          return approve()
        }
      }
    `);
    expect(warnings).toHaveLength(0);
  });

  it("does not warn when call has withModifier approve", () => {
    const warnings = warningsFrom(`
      def deploy() {
        interrupt myapp::deploy("Deploy?")
      }
      node main() {
        deploy() with approve
      }
    `);
    expect(warnings).toHaveLength(0);
  });

  it("does not warn when call has withModifier reject", () => {
    const warnings = warningsFrom(`
      def deploy() {
        interrupt myapp::deploy("Deploy?")
      }
      node main() {
        deploy() with reject
      }
    `);
    expect(warnings).toHaveLength(0);
  });

  it("still warns when call has withModifier propagate", () => {
    const warnings = warningsFrom(`
      def deploy() {
        interrupt myapp::deploy("Deploy?")
      }
      node main() {
        deploy() with propagate
      }
    `);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].message).toContain("myapp::deploy");
  });

  it("does not warn for functions with no interrupts", () => {
    const warnings = warningsFrom(`
      def add(a: number, b: number): number {
        return a + b
      }
      node main() {
        add(1, 2)
      }
    `);
    expect(warnings).toHaveLength(0);
  });
});
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `pnpm vitest run lib/typeChecker/interruptWarnings.test.ts 2>&1 | tee /tmp/tc-test-1.txt`
Expected: Tests fail — no warning logic exists yet.

- [ ] **Step 5: Implement the warning check in the checker**

In `checkFunctionCallsInScope` (`lib/typeChecker/checker.ts:105-114`), change the `walkNodes` call to destructure `ancestors`:

```typescript
function checkFunctionCallsInScope(
  info: ScopeInfo,
  ctx: TypeCheckerContext,
): void {
  for (const { node, ancestors } of walkNodes(info.body)) {
    if (node.type === "functionCall") {
      checkSingleFunctionCall(node, info.scope, ctx);
      checkUnhandledInterrupts(node, ancestors, ctx);
    }
  }
}
```

Add a new function that uses the transitive `interruptKinds` from function definitions (populated from the symbol table in Step 2):

```typescript
function checkUnhandledInterrupts(
  call: FunctionCall,
  ancestors: WalkAncestor[],
  ctx: TypeCheckerContext,
): void {
  const def = ctx.functionDefs[call.functionName] ?? ctx.nodeDefs[call.functionName];
  if (!def) return;

  const kinds = (def.interruptKinds ?? []).map((ik) => ik.kind);
  if (kinds.length === 0) return;

  const isHandled = ancestors.some((a) => {
    if (a.type === "handleBlock") return true;
    if (a.type === "withModifier" && a.handlerName !== "propagate") return true;
    return false;
  });

  if (!isHandled) {
    const kindList = kinds.join(", ");
    ctx.errors.push({
      message: `Function '${call.functionName}' may throw interrupts [${kindList}] but is not inside a handler.`,
      severity: "warning",
      loc: call.loc,
    });
  }
}
```

Import `WalkAncestor` from `../utils/node.js` at the top of the file.

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm vitest run lib/typeChecker/interruptWarnings.test.ts 2>&1 | tee /tmp/tc-test-2.txt`
Expected: All 7 tests pass.

- [ ] **Step 7: Run the full test suite to check for regressions**

Run: `pnpm vitest run 2>&1 | tee /tmp/full-test.txt`
Expected: No regressions. If new warnings appear for existing test code that calls functions with interrupts outside handlers, that's expected — check whether those are legitimate warnings or whether test infrastructure needs to filter by severity.

- [ ] **Step 8: Commit**

```bash
git add lib/compilationUnit.ts lib/typeChecker/ lib/typeChecker.test.ts
git commit -m "$(cat <<'EOF'
Add type checker warning for function calls with unhandled interrupts.

Threads the symbol table into the type checker via the CompilationUnit
so warnings use transitive interrupt kinds, not just direct body scans.
Warns when calling a function with interrupts outside a handleBlock or
withModifier (approve/reject). A withModifier with propagate does not
count as handling.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: Add interrupt kinds to serve types and discovery

**Files:**
- Modify: `lib/serve/types.ts:3-21`
- Modify: `lib/serve/discovery.ts:6-24,42-58`
- Modify: `lib/serve/discovery.test.ts`
- Modify: `lib/cli/serve.ts:15-42`

- [ ] **Step 1: Add `interruptKinds` to serve types**

In `lib/serve/types.ts`, add the import and field:

```typescript
import type { InterruptKind } from "../symbolTable.js";
```

Add to `ExportedFunction` (after `agencyFunction`):

```typescript
interruptKinds: InterruptKind[];
```

Add to `ExportedNode` (after `invoke`):

```typescript
interruptKinds: InterruptKind[];
```

- [ ] **Step 2: Update `DiscoverOptions` and `discoverExports` in discovery.ts**

In `lib/serve/discovery.ts`:

Add to `DiscoverOptions`:

```typescript
interruptKindsByName?: Record<string, InterruptKind[]>;
```

Update `toExportedFunction` to accept and pass through interrupt kinds:

```typescript
function toExportedFunction(
  fn: AgencyFunction,
  interruptKinds: InterruptKind[],
): ExportedFunction {
  return {
    kind: "function",
    name: fn.name,
    description: fn.toolDefinition!.description,
    agencyFunction: fn,
    interruptKinds,
  };
}
```

Update `toExportedNode` similarly:

```typescript
function toExportedNode(
  nodeName: string,
  moduleExports: Record<string, unknown>,
  interruptKinds: InterruptKind[],
): ExportedNode | null {
  // ... existing code ...
  return {
    kind: "node",
    name: nodeName,
    parameters: params.map((name) => ({ name })),
    invoke: nodeFn as (...args: unknown[]) => Promise<unknown>,
    interruptKinds,
  };
}
```

Update `discoverExports` to pass interrupt kinds through:

```typescript
const { interruptKindsByName = {} } = options;

const functions = Object.values(toolRegistry)
  .filter((fn) => isExportedFromModule(fn, moduleId))
  .map((fn) => toExportedFunction(fn, interruptKindsByName[fn.name] ?? []));

const nodes = exportedNodeNames
  .map((name) => toExportedNode(name, moduleExports, interruptKindsByName[name] ?? []))
  .filter((n): n is ExportedNode => n !== null);
```

- [ ] **Step 3: Update `compileForServe` to extract interrupt kinds**

In `lib/cli/serve.ts`, update the `CompileResult` type:

```typescript
type CompileResult = {
  outputPath: string;
  moduleId: string;
  exportedNodeNames: string[];
  exportedConstantNames: string[];
  interruptKindsByName: Record<string, { kind: string }[]>;
};
```

In `compileForServe`, after extracting `exportedNodeNames` and `exportedConstantNames`, add:

```typescript
const interruptKindsByName: Record<string, { kind: string }[]> = {};
for (const sym of symbols) {
  if ((sym.kind === "function" || sym.kind === "node") && sym.interruptKinds) {
    interruptKindsByName[sym.name] = sym.interruptKinds;
  }
}
```

Add `interruptKindsByName` to the return object.

In `loadAndDiscover`, pass it to `discoverExports`:

```typescript
const exports = discoverExports({
  toolRegistry,
  moduleExports,
  moduleId: compileResult.moduleId,
  exportedNodeNames: compileResult.exportedNodeNames,
  exportedConstantNames: compileResult.exportedConstantNames,
  interruptKindsByName: compileResult.interruptKindsByName,
});
```

- [ ] **Step 4: Update discovery tests**

Update `lib/serve/discovery.test.ts` to account for the new `interruptKinds` field. Existing tests may need updates to expect `interruptKinds: []` on discovered exports. Add a test that passes `interruptKindsByName` and verifies it appears on the result.

- [ ] **Step 5: Run discovery tests**

Run: `pnpm vitest run lib/serve/discovery.test.ts 2>&1 | tee /tmp/disc-test.txt`
Expected: All pass.

- [ ] **Step 6: Commit**

```bash
git add lib/serve/types.ts lib/serve/discovery.ts lib/serve/discovery.test.ts lib/cli/serve.ts
git commit -m "$(cat <<'EOF'
Add interruptKinds to serve types and discovery pipeline.

Threads interrupt kind data from the symbol table through compileForServe
into discoverExports, attaching it to ExportedFunction and ExportedNode.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: Update MCP, HTTP adapters, and standalone entrypoints

**Files:**
- Modify: `lib/serve/mcp/adapter.ts:49-54`
- Modify: `lib/serve/mcp/adapter.test.ts`
- Modify: `lib/serve/http/adapter.ts`
- Modify: `lib/cli/serve.ts:135-198` (standalone entrypoint generators)

- [ ] **Step 1: Append interrupt info to MCP tool descriptions**

In `lib/serve/mcp/adapter.ts`, update the `functionToolEntries` mapping (around line 49):

```typescript
function descriptionWithInterrupts(description: string, interruptKinds: InterruptKind[]): string {
  if (interruptKinds.length === 0) return description;
  const kinds = interruptKinds.map((ik) => ik.kind).join(", ");
  return `${description}\n\nMay interrupt: ${kinds}`;
}

const functionToolEntries = functions.map((f) => ({
  name: f.name,
  description: descriptionWithInterrupts(f.description, f.interruptKinds),
  inputSchema: schemaToJsonSchema(f.agencyFunction.toolDefinition?.schema),
  ...(f.agencyFunction.safe ? { annotations: { readOnlyHint: true } } : {}),
}));
```

- [ ] **Step 2: Update the HTTP list route**

In `lib/serve/http/adapter.ts`, update the `/list` route to include `interruptKinds`:

In the functions mapping, add `interruptKinds`:

```typescript
functions: Object.values(functions).map((f) => ({
  name: f.name,
  description: f.description,
  safe: f.agencyFunction.safe,
  interruptKinds: f.interruptKinds,
})),
```

In the nodes mapping:

```typescript
nodes: Object.values(nodes).map((n) => ({
  name: n.name,
  parameters: n.parameters.map((p) => p.name),
  interruptKinds: n.interruptKinds,
})),
```

- [ ] **Step 3: Update standalone entrypoint generators**

In `lib/cli/serve.ts`, update `generateHttpEntrypoint` and `generateMcpEntrypoint` to embed `interruptKindsByName` as a JSON literal:

Add to both functions' `discoverExports` call in the generated code:

```typescript
  interruptKindsByName: ${JSON.stringify(compileResult.interruptKindsByName)},
```

- [ ] **Step 4: Run all serve-related tests**

Run: `pnpm vitest run lib/serve/ 2>&1 | tee /tmp/serve-test.txt`
Expected: All pass.

- [ ] **Step 5: Commit**

```bash
git add lib/serve/mcp/ lib/serve/http/ lib/cli/serve.ts
git commit -m "$(cat <<'EOF'
Update MCP, HTTP adapters, and standalone entrypoints for interrupt kinds.

MCP: appends interrupt kinds to tool descriptions.
HTTP: includes interruptKinds field in /list response.
Standalone: embeds interrupt data as JSON in generated entrypoint.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 10: Add LSP hover support

**Files:**
- Modify: `lib/lsp/semantics.ts`
- Modify: `lib/lsp/hover.test.ts`

- [ ] **Step 1: Add `interruptKinds` to `SemanticSymbol`**

In `lib/lsp/semantics.ts`, add to the `SemanticSymbol` type (around line 14-25):

```typescript
interruptKinds?: InterruptKind[];
```

Import `InterruptKind` from `../symbolTable.js`.

- [ ] **Step 2: Populate `interruptKinds` when building semantic symbols**

Find where `SemanticSymbol` objects are created in `lib/lsp/semantics.ts` (the `buildSemanticIndex` function). There are two paths:

1. **Imported symbols** — these go through `addImportedSymbol` which receives a `SymbolInfo` from the symbol table. The `SymbolInfo` already has `interruptKinds` (for functions/nodes). Copy it to the `SemanticSymbol`.

2. **Local symbols** — these are built from AST nodes directly (e.g. `addLocalDefinition`), NOT from symbol table lookups. To get `interruptKinds` for local functions/nodes, `buildSemanticIndex` needs access to the symbol table. Check if it already receives one (it takes `symbolTable` and `fsPath` parameters). If so, look up the local function/node in `symbolTable.getFile(fsPath)` and copy its `interruptKinds`.

- [ ] **Step 3: Update `formatSemanticHover` to include interrupt info**

In `formatSemanticHover` (around line 236-247), after building the code block, append interrupt info:

```typescript
function interruptSuffix(symbol: SemanticSymbol): string {
  if (!symbol.interruptKinds || symbol.interruptKinds.length === 0) return "";
  const kinds = symbol.interruptKinds.map((ik) => ik.kind).join(", ");
  return `\n\nInterrupts: ${kinds}`;
}

export function formatSemanticHover(symbol: SemanticSymbol): string {
  const signature = formatSignature(symbol);
  const codeBlock = `\`\`\`typescript\n${signature}\n\`\`\``;
  const interrupts = interruptSuffix(symbol);

  if (symbol.source === "local") {
    return `${codeBlock}${interrupts}`;
  }
  const aliasNote = symbol.originalName !== symbol.name
    ? ` as \`${symbol.originalName}\``
    : "";
  return `${codeBlock}${interrupts}\n\nImported from \`${symbol.importPath}\`${aliasNote}`;
}
```

- [ ] **Step 4: Write a hover test**

Add a test to `lib/lsp/hover.test.ts` that creates a function with an interrupt and verifies the hover output includes the interrupt kinds.

- [ ] **Step 5: Run LSP tests**

Run: `pnpm vitest run lib/lsp/ 2>&1 | tee /tmp/lsp-test.txt`
Expected: All pass.

- [ ] **Step 6: Commit**

```bash
git add lib/lsp/semantics.ts lib/lsp/hover.test.ts
git commit -m "$(cat <<'EOF'
Show interrupt kinds in LSP hover for functions and nodes.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 11: Add TODO for future work and run final verification

**Files:**
- Create: `TODO.md` (in `packages/agency-lang/`)

- [ ] **Step 1: Create TODO.md with future work items**

Create `packages/agency-lang/TODO.md`:

```markdown
# TODO

## Interrupt Kind Tracking — Future Work

- [ ] **Dynamic array/object tracking**: Track functions through `push`, spread, object property access, and indexed access for interrupt analysis. Patterns like `tools.push(deploy)`, `const allTools = [...tools1, ...tools2]`, `handlers.onDeploy()`, and `fns[0]()` are not currently tracked. Requires more sophisticated data flow analysis.

- [ ] **Interrupt data shapes**: Track the parameter types of each interrupt kind (message type, data shape) in addition to just the kind string. The `InterruptKind` type is already an object to support this extension.

- [ ] **Exhaustiveness checking**: If a standard pattern emerges for handling interrupt kinds (e.g. match blocks on `interrupt.kind`), consider checking that all kinds are covered.
```

- [ ] **Step 2: Run the full test suite**

Run: `pnpm vitest run 2>&1 | tee /tmp/final-test.txt`
Expected: All tests pass. Review the output file for any warnings or failures.

- [ ] **Step 3: Commit**

```bash
git add TODO.md
git commit -m "$(cat <<'EOF'
Add TODO.md with future work items for interrupt kind tracking.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```
