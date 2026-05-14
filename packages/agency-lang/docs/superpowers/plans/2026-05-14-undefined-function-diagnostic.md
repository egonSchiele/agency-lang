# Undefined Function Diagnostic Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Warn when Agency code calls a function that doesn't exist, with a configurable severity level. Recognize a curated set of JavaScript globals (`parseInt`, `JSON.parse`, `Math.floor`, etc.) so genuine JS interop doesn't false-positive.

**Architecture:**

1. Consolidate the three existing type-check config keys (`strictTypes`, `typeCheck`, `typeCheckStrict`) into a single `typechecker` object in `AgencyConfig`. Add an `undefinedFunctions` setting (`"silent" | "warn" | "error"`, default `"silent"` for the initial landing).
2. Add a pure helper module `lib/typeChecker/resolveCall.ts` that exposes `resolveCall()`, `lookupJsMember()`, and the `JS_GLOBALS` / `RESERVED_FUNCTION_NAMES` data. No `ctx`, no side effects, no error emission — just lookups.
3. Add a structured `JS_GLOBALS` registry that supports both flat callables (`parseInt`) and namespaces with members (`JSON.parse`, `Math.floor`). Each callable entry has an optional `sig: BuiltinSignature` field — Phase 1 uses existence-only checks; Phase 2 (a follow-up) populates `sig` to enable arity/type checking.
4. Add a self-contained diagnostic module `lib/typeChecker/undefinedFunctionDiagnostic.ts` exposing a single declarative entry point: `checkUndefinedFunctions(scopes, ctx)`. It walks the AST with `walkNodes`, handles both `functionCall` and `valueAccess` (namespace member chains), and pushes diagnostics. **`checker.ts` and `synthesizer.ts` are NOT modified by this feature** — the diagnostic stays out of the core synth/check code, mirroring how `interruptAnalysis.ts` is structured.
5. `TypeChecker.check()` invokes `checkUndefinedFunctions(scopes, ctx)` once, alongside the existing `checkUnhandledInterruptWarnings` call.
6. Add missing entries to `BUILTIN_FUNCTION_TYPES` for built-in functions that currently skip arity checking (`approve`, `reject`, `propagate`, `checkpoint`, `getCheckpoint`). Add an explanatory comment for `schema` in the synthesizer.

**Tech Stack:** TypeScript, Vitest, Zod

**Breaking change:** The three flat config keys (`strictTypes`, `typeCheck`, `typeCheckStrict`) are removed and replaced by a `typechecker` object. Existing `agency.json` files using the old keys will need to be updated. Acceptable per project policy (small user base).

**Default for the new diagnostic:** `"silent"` for the initial landing. A follow-up PR will flip the default to `"warn"` once any test regressions in the codebase are cleaned up.

---

### File Structure

| Action | File | Responsibility |
|--------|------|----------------|
| Modify | `lib/config.ts` | Add `typechecker` config object, remove old keys, update Zod schema |
| Create | `lib/config.test.ts` | Tests for the new config shape |
| Modify | `lib/cli/commands.ts` | Read from new `typechecker` config shape |
| Modify | `lib/compiler/compile.ts` | Read from new `typechecker` config shape |
| Modify | `lib/compiler/compile.test.ts` | Update test that passes `{ typeCheck: true }` |
| Create | `lib/typeChecker/resolveCall.ts` | **Pure** module — `resolveCall()`, `lookupJsMember()`, `JS_GLOBALS`, `RESERVED_FUNCTION_NAMES`. No `ctx`, no side effects. |
| Create | `lib/typeChecker/resolveCall.test.ts` | Unit tests for the pure lookups |
| Create | `lib/typeChecker/undefinedFunctionDiagnostic.ts` | The diagnostic walker. Single public function `checkUndefinedFunctions(scopes, ctx)`. Uses `walkNodes` + `resolveCall`. |
| Create | `lib/typeChecker/undefinedFunctionDiagnostic.test.ts` | Integration tests across `functionCall` and namespace-member chains |
| Modify | `lib/typeChecker/index.ts` | Import `RESERVED_FUNCTION_NAMES` from `resolveCall.ts`; invoke `checkUndefinedFunctions(scopes, ctx)` once in the main check loop. |
| Modify | `lib/typeChecker/builtins.ts` | Add `approve`, `reject`, `propagate`, `checkpoint`, `getCheckpoint` |
| Modify | `lib/typeChecker/synthesizer.ts` | Add explicit `schemaExpression` case with explanatory comment (NOT for the diagnostic — this is a separate documentation cleanup in Task 5) |
| Modify | `lib/typeChecker/scopes.ts` | Read `strictTypes` from new config shape |
| Modify | `docs/misc/config.md` | Document new `typechecker` config |
| Modify | `docs/dev/typechecker.md` | Add a top-level "Diagnostics" section describing the pattern; update the Builtin section to reflect the builtin-vs-stdlib distinction; document `schema(Type)` |
| Modify | `docs/dev/undefined-function-diagnostic.md` | Replace the "Reasonable implementation sketch" section with pointers to the actual implementation |

**Note:** `lib/typeChecker/checker.ts` is intentionally NOT in this list. The diagnostic stays in its own module rather than bolting onto `checkSingleFunctionCall` — this mirrors `lib/typeChecker/interruptAnalysis.ts`, keeps the core synth/check code focused on type correctness, and makes the diagnostic easy to test, disable, or remove as a unit.

---

### Background: builtins vs stdlib functions

Two distinct categories of Agency function — **conceptually**:

- **Built-in functions** (language primitives, no `def` source): `success`, `failure`, `isSuccess`, `isFailure`, `llm`, `interrupt`, `approve`, `reject`, `propagate`, `checkpoint`, `getCheckpoint`, `restore`, `schema`, `debugger`. Their semantics are hardcoded in the type checker and runtime.
- **Stdlib functions** (regular Agency code): `print`, `printJSON`, `read`, `fetch`, `notify`, `sleep`, `range`, `keys`, etc. — defined in [stdlib/index.agency](../../stdlib/index.agency) like any user function and resolved through normal import machinery.

Two registries the type checker currently uses:

- **`BUILTIN_FUNCTION_TYPES`** ([lib/typeChecker/builtins.ts](../../lib/typeChecker/builtins.ts)) — signatures used by both `checkSingleFunctionCall` and `synthFunctionCall` for arity / arg-type / return-type checks. **Currently mixes both categories above** — true builtins AND stdlib signatures duplicated here for convenience. The existing `NOTE` comment in the file flags this as tech debt: ideally stdlib signatures would come from the symbol table. **Out of scope for this plan; see follow-ups.**
- **`RESERVED_FUNCTION_NAMES`** ([lib/typeChecker/index.ts](../../lib/typeChecker/index.ts#L47)) — language-builtin names users cannot redefine via `def` / `node`. Contains only true builtins; stdlib names are NOT here (users CAN shadow `print` if they really want to).

Built-in names fall into three sub-categories based on how they're parsed:

| Sub-category | Examples | Status |
|---|---|---|
| Parsed as plain `functionCall`, signature already in `BUILTIN_FUNCTION_TYPES` | `success`, `failure`, `isSuccess`, `isFailure`, `llm`, `restore` | OK — arity/types checked. |
| Parsed as plain `functionCall`, **no** signature in `BUILTIN_FUNCTION_TYPES` | `approve`, `reject`, `propagate`, `checkpoint`, `getCheckpoint` | **Task 5 fixes this** — adds the missing signatures. |
| Parsed as **their own AST node** (not `functionCall`) | `schema` → `SchemaExpression`, `interrupt` → `InterruptStatement`, `debugger` → `DebuggerStatement` | No changes needed. The reservation only exists to prevent `def schema()` etc. from creating parse ambiguity. |

### Background: namespace registry shape

The `JS_GLOBALS` registry is a tagged-union tree that mirrors the structure of JavaScript namespaces:

```ts
import type { BuiltinSignature } from "./types.js";

export type JsRegistryEntry =
  | { kind: "callable"; sig?: BuiltinSignature }
  | { kind: "namespace"; members: Record<string, JsRegistryEntry> };

export const JS_GLOBALS: Record<string, JsRegistryEntry> = {
  // Flat callables
  parseInt: { kind: "callable" },
  parseFloat: { kind: "callable" },
  // ...

  // Namespaces
  JSON: {
    kind: "namespace",
    members: {
      parse: { kind: "callable" },
      stringify: { kind: "callable" },
    },
  },
  Math: {
    kind: "namespace",
    members: {
      floor: { kind: "callable" },
      // ...
    },
  },
  // ...
};
```

Phase 1 (this plan) uses only existence: walk the registry to verify a name (or namespace.member chain) exists, ignore `sig`. Phase 2 (a follow-up) starts populating `sig` for entries we want type-checked, and the typechecker enforces arity / types when `sig` is present. Pure addition; no breaking changes.

`BuiltinSignature` is reused here (rather than introducing a parallel JS-specific shape) so any future improvements to it benefit both Agency builtins and JS globals.

---

### Task 1: Consolidate type-check config keys

**Files:**
- Modify: `lib/config.ts:28-108` (AgencyConfig interface) and `:183-239` (Zod schema)
- Create: `lib/config.test.ts`

- [ ] **Step 1: Write the failing test**

Create `lib/config.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { AgencyConfigSchema } from "./config.js";

describe("AgencyConfig typechecker key", () => {
  it("accepts the new typechecker object", () => {
    const result = AgencyConfigSchema.safeParse({
      typechecker: {
        enabled: true,
        strict: true,
        strictTypes: true,
        undefinedFunctions: "warn",
      },
    });
    expect(result.success).toBe(true);
  });

  it("rejects invalid undefinedFunctions value", () => {
    const result = AgencyConfigSchema.safeParse({
      typechecker: { undefinedFunctions: "banana" },
    });
    expect(result.success).toBe(false);
  });

  it("accepts an empty typechecker object", () => {
    const result = AgencyConfigSchema.safeParse({ typechecker: {} });
    expect(result.success).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:run lib/config.test.ts 2>&1 | tee /tmp/config-test-1.txt`
Expected: FAIL — `typechecker` key not recognized.

- [ ] **Step 3: Update the AgencyConfig interface**

In `lib/config.ts`, replace the three keys:

```ts
// REMOVE these three:
//   strictTypes?: boolean;
//   typeCheck?: boolean;
//   typeCheckStrict?: boolean;

// ADD this:
  /**
   * Type checker configuration. Controls which checks run and their severity.
   */
  typechecker?: {
    /** If true, run type checking during compilation and print warnings. Default: false. */
    enabled?: boolean;
    /** If true, type errors are fatal during compilation (implies enabled: true). Default: false. */
    strict?: boolean;
    /** If true, untyped variables are errors. Default: false. */
    strictTypes?: boolean;
    /**
     * What to do when a function call cannot be resolved:
     * - "silent": ignore (default for the initial landing)
     * - "warn": emit a warning
     * - "error": emit an error
     */
    undefinedFunctions?: "silent" | "warn" | "error";
  };
```

Update the Zod schema similarly — replace the three flat keys with:

```ts
    typechecker: z
      .object({
        enabled: z.boolean(),
        strict: z.boolean(),
        strictTypes: z.boolean(),
        undefinedFunctions: z.enum(["silent", "warn", "error"]),
      })
      .partial(),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test:run lib/config.test.ts 2>&1 | tee /tmp/config-test-2.txt`
Expected: PASS

- [ ] **Step 5: Commit**

```
git add lib/config.ts lib/config.test.ts
git commit -m "refactor: consolidate typecheck config into typechecker object"
```

---

### Task 2: Update all consumers of old config keys

**Files:**
- Modify: `lib/cli/commands.ts:167-178`
- Modify: `lib/compiler/compile.ts:134-135`
- Modify: `lib/compiler/compile.test.ts:29`
- Modify: `lib/typeChecker/scopes.ts:142`
- Modify: `lib/typeChecker/index.ts` (TypeChecker class)
- Modify: any remaining files surfaced by the grep below

- [ ] **Step 1: Update `lib/cli/commands.ts`**

Replace:

```ts
if (config.typeCheck || config.typeCheckStrict) {
    const { errors } = typeCheck(resolvedProgram, config, info);
    if (errors.length > 0) {
      if (config.typeCheckStrict) {
```

With:

```ts
const tc = config.typechecker;
if (tc?.enabled || tc?.strict) {
    const { errors } = typeCheck(resolvedProgram, config, info);
    if (errors.length > 0) {
      if (tc?.strict) {
```

- [ ] **Step 2: Update `lib/compiler/compile.ts`**

Replace `config.typeCheck || config.typeCheckStrict` with `config.typechecker?.enabled || config.typechecker?.strict` at line 134. Also update `lib/compiler/compile.test.ts` — change `{ typeCheck: true }` to `{ typechecker: { enabled: true } }`.

- [ ] **Step 3: Update `lib/typeChecker/scopes.ts`**

Replace `ctx.config.strictTypes` with `ctx.config.typechecker?.strictTypes`.

- [ ] **Step 4: Search for any other references to the old keys**

Run: `grep -rn 'config\.strictTypes\|config\.typeCheck\b\|config\.typeCheckStrict' lib/ --include='*.ts'`

Update every remaining reference. Key files to check:
- `lib/cli/policy.ts`
- `lib/cli/serve.ts`
- `lib/cli/doc.ts`
- `lib/typeChecker/index.ts`

- [ ] **Step 5: Run the full test suite to check for breakage**

Run: `pnpm test:run 2>&1 | tee /tmp/consumer-update-tests.txt`
Expected: PASS (existing tests should still work since they pass `config: {}` which means the optional keys are just absent)

- [ ] **Step 6: Commit**

```
git add lib/cli/commands.ts lib/compiler/compile.ts lib/compiler/compile.test.ts lib/typeChecker/scopes.ts lib/cli/policy.ts lib/cli/serve.ts lib/cli/doc.ts lib/typeChecker/index.ts
git commit -m "refactor: update all consumers to read from typechecker config object"
```

---

### Task 3: Create `resolveCall` helper with `JS_GLOBALS` registry

**Files:**
- Create: `lib/typeChecker/resolveCall.ts`
- Create: `lib/typeChecker/resolveCall.test.ts`

- [ ] **Step 1: Write the failing test**

Create `lib/typeChecker/resolveCall.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { resolveCall, lookupJsMember, JS_GLOBALS, RESERVED_FUNCTION_NAMES } from "./resolveCall.js";

const emptyInput = {
  functionDefs: {},
  nodeDefs: {},
  importedFunctions: {},
  scopeHas: () => false,
};

describe("resolveCall", () => {
  it("resolves a locally defined function", () => {
    const result = resolveCall("myFunc", { ...emptyInput, functionDefs: { myFunc: {} as any } });
    expect(result.kind).toBe("def");
  });

  it("resolves an imported function", () => {
    const result = resolveCall("imported", { ...emptyInput, importedFunctions: { imported: {} as any } });
    expect(result.kind).toBe("imported");
  });

  it("resolves a builtin function", () => {
    const result = resolveCall("print", emptyInput);
    expect(result.kind).toBe("builtin");
  });

  it("resolves a reserved name", () => {
    const result = resolveCall("schema", emptyInput);
    expect(result.kind).toBe("reserved");
  });

  it("resolves a scope binding (lambda, partial, etc.)", () => {
    const result = resolveCall("myLambda", {
      ...emptyInput,
      scopeHas: (name) => name === "myLambda",
    });
    expect(result.kind).toBe("scopeBinding");
  });

  it("resolves a flat callable JS global", () => {
    const result = resolveCall("parseInt", emptyInput);
    expect(result.kind).toBe("jsGlobal");
  });

  it("returns unresolved for a genuinely missing name", () => {
    const result = resolveCall("doesNotExist", emptyInput);
    expect(result.kind).toBe("unresolved");
  });
});

describe("JS_GLOBALS", () => {
  it("includes flat callables", () => {
    expect(JS_GLOBALS.parseInt?.kind).toBe("callable");
    expect(JS_GLOBALS.setTimeout?.kind).toBe("callable");
  });

  it("includes namespaces with members", () => {
    const json = JS_GLOBALS.JSON;
    expect(json?.kind).toBe("namespace");
    if (json?.kind === "namespace") {
      expect(json.members.parse?.kind).toBe("callable");
      expect(json.members.stringify?.kind).toBe("callable");
    }
  });

  it("does not include native Agency literals", () => {
    expect(JS_GLOBALS.undefined).toBeUndefined();
    expect(JS_GLOBALS.NaN).toBeUndefined();
    expect(JS_GLOBALS.Infinity).toBeUndefined();
  });
});

describe("lookupJsMember", () => {
  it("returns the callable entry for JSON.parse", () => {
    const result = lookupJsMember(["JSON", "parse"]);
    expect(result?.kind).toBe("callable");
  });

  it("returns null for an unknown member on a known namespace", () => {
    expect(lookupJsMember(["JSON", "banana"])).toBeNull();
  });

  it("returns null for an unknown base", () => {
    expect(lookupJsMember(["NotAGlobal", "parse"])).toBeNull();
  });

  it("walks deeper namespaces if added later", () => {
    // Sanity: structure supports nested namespaces.
    const fake = { kind: "namespace", members: { x: { kind: "namespace", members: { y: { kind: "callable" } } } } } as const;
    // Just exercise the type — actual lookup is on JS_GLOBALS at runtime.
    expect(fake.members.x.members.y.kind).toBe("callable");
  });
});

describe("RESERVED_FUNCTION_NAMES", () => {
  it("includes the names imported by index.ts", () => {
    for (const name of ["success", "failure", "approve", "reject", "propagate", "schema", "interrupt", "debugger"]) {
      expect(RESERVED_FUNCTION_NAMES.has(name)).toBe(true);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:run lib/typeChecker/resolveCall.test.ts 2>&1 | tee /tmp/resolve-test-1.txt`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `resolveCall.ts`**

Create `lib/typeChecker/resolveCall.ts`:

```ts
import type { FunctionDefinition, GraphNodeDefinition } from "../types.js";
import type { ImportedFunctionSignature } from "../compilationUnit.js";
import type { BuiltinSignature } from "./types.js";
import { BUILTIN_FUNCTION_TYPES } from "./builtins.js";

/**
 * Names of Agency's *built-in* functions — language primitives with no
 * `def` source. Users cannot redefine these via `def` or `node`. Single
 * source of truth — imported by typeChecker/index.ts.
 *
 * Stdlib functions (print, read, fetch, etc.) are NOT here. They are
 * regular Agency code in stdlib/index.agency and users may shadow them.
 *
 * Built-ins fall into two parse-time categories:
 *
 *   1. Parsed as plain `functionCall`. Their typed signatures live in
 *      BUILTIN_FUNCTION_TYPES, so they resolve as `kind: "builtin"` before
 *      reaching the reserved-name fallback below. Listed here too as
 *      defense-in-depth (if a BUILTIN_FUNCTION_TYPES entry is ever removed,
 *      the reservation still prevents user redefinition).
 *
 *   2. Parsed as their own AST node — never reach functionCall handling:
 *
 *        schema(Type)  → SchemaExpression  — a language primitive that
 *          bridges *type space* and *value space*: the argument is a
 *          VariableType (not a value expression), and at runtime it
 *          constructs a zod schema from that type. Reserved here only so
 *          that `def schema()` can't create parse ambiguity. The typechecker
 *          currently synthesizes its result type as "any" — populating it
 *          with a structured `Schema<T>` type is future work.
 *
 *        interrupt ...  → InterruptStatement
 *        debugger       → DebuggerStatement
 */
export const RESERVED_FUNCTION_NAMES = new Set([
  // Category 1 — parsed as `functionCall`, also in BUILTIN_FUNCTION_TYPES.
  "success", "failure", "isSuccess", "isFailure", "restore", "llm",
  "approve", "reject", "propagate",
  "checkpoint", "getCheckpoint",

  // Category 2 — parsed as their own AST node.
  "schema", "interrupt", "debugger",
]);

/**
 * Registry of JavaScript / Node.js globals that compiled Agency output
 * is allowed to call. Each entry is either:
 *   - kind: "callable"  — a function (sig is optional; populating it
 *                         later enables type-checking)
 *   - kind: "namespace" — an object with named members, each of which
 *                         is itself a JsRegistryEntry
 *
 * Phase 1 uses only the structure (existence checks). Phase 2 will
 * populate `sig` for entries we want type-checked; the typechecker
 * starts enforcing arity/types when `sig` is present.
 *
 * Names already supported natively by Agency (null, undefined) or rare
 * enough to defer (NaN, Infinity) are intentionally absent.
 */
export type JsRegistryEntry =
  | { kind: "callable"; sig?: BuiltinSignature }
  | { kind: "namespace"; members: Record<string, JsRegistryEntry> };

const callable = (sig?: BuiltinSignature): JsRegistryEntry => ({ kind: "callable", sig });
const namespace = (members: Record<string, JsRegistryEntry>): JsRegistryEntry => ({
  kind: "namespace",
  members,
});

export const JS_GLOBALS: Record<string, JsRegistryEntry> = {
  // --- Flat callable globals ---
  parseInt: callable(),
  parseFloat: callable(),
  isNaN: callable(),
  isFinite: callable(),
  encodeURIComponent: callable(),
  decodeURIComponent: callable(),
  encodeURI: callable(),
  decodeURI: callable(),
  setTimeout: callable(),
  setInterval: callable(),
  clearTimeout: callable(),
  clearInterval: callable(),
  queueMicrotask: callable(),
  structuredClone: callable(),
  BigInt: callable(),
  Symbol: callable(),

  // --- Namespaces ---
  JSON: namespace({
    parse: callable(),
    stringify: callable(),
  }),
  Math: namespace({
    floor: callable(),
    ceil: callable(),
    round: callable(),
    abs: callable(),
    max: callable(),
    min: callable(),
    pow: callable(),
    sqrt: callable(),
    random: callable(),
    log: callable(),
    log2: callable(),
    log10: callable(),
    exp: callable(),
    sin: callable(),
    cos: callable(),
    tan: callable(),
    asin: callable(),
    acos: callable(),
    atan: callable(),
    atan2: callable(),
    sign: callable(),
    trunc: callable(),
    cbrt: callable(),
    hypot: callable(),
  }),
  Object: namespace({
    keys: callable(),
    values: callable(),
    entries: callable(),
    assign: callable(),
    freeze: callable(),
    fromEntries: callable(),
    getOwnPropertyNames: callable(),
    getPrototypeOf: callable(),
    setPrototypeOf: callable(),
  }),
  Array: namespace({
    isArray: callable(),
    from: callable(),
    of: callable(),
  }),
  String: namespace({
    fromCharCode: callable(),
    raw: callable(),
  }),
  Number: namespace({
    isInteger: callable(),
    isFinite: callable(),
    isNaN: callable(),
    isSafeInteger: callable(),
    parseFloat: callable(),
    parseInt: callable(),
  }),
  Date: namespace({
    now: callable(),
    parse: callable(),
    UTC: callable(),
  }),
  Promise: namespace({
    resolve: callable(),
    reject: callable(),
    all: callable(),
    allSettled: callable(),
    race: callable(),
    any: callable(),
  }),
  console: namespace({
    log: callable(),
    error: callable(),
    warn: callable(),
    info: callable(),
    debug: callable(),
    trace: callable(),
    table: callable(),
    dir: callable(),
    group: callable(),
    groupEnd: callable(),
    time: callable(),
    timeEnd: callable(),
    count: callable(),
  }),
  process: namespace({
    exit: callable(),
    nextTick: callable(),
    cwd: callable(),
    chdir: callable(),
  }),
  Buffer: namespace({
    from: callable(),
    alloc: callable(),
    allocUnsafe: callable(),
    concat: callable(),
    isBuffer: callable(),
    byteLength: callable(),
  }),
  // Error constructors (used like `new Error(...)` in agency? Currently namespaces
  // — calling them as Error("...") works in JS but is anti-pattern; included to
  // prevent false positives on existing code).
  Error: namespace({}),
  TypeError: namespace({}),
  RangeError: namespace({}),
  ReferenceError: namespace({}),
  SyntaxError: namespace({}),
};

/**
 * Walk a namespace path through `JS_GLOBALS`. Returns the leaf entry if
 * the full chain resolves, otherwise null.
 *
 * Examples:
 *   lookupJsMember(["JSON", "parse"])     → { kind: "callable", sig: undefined }
 *   lookupJsMember(["JSON", "banana"])    → null
 *   lookupJsMember(["NotAGlobal", "x"])   → null
 */
export function lookupJsMember(path: string[]): JsRegistryEntry | null {
  if (path.length === 0) return null;
  let current: JsRegistryEntry | undefined = JS_GLOBALS[path[0]];
  for (let i = 1; i < path.length; i++) {
    if (!current || current.kind !== "namespace") return null;
    current = current.members[path[i]];
  }
  return current ?? null;
}

type ResolveCallInput = {
  functionDefs: Record<string, FunctionDefinition>;
  nodeDefs: Record<string, GraphNodeDefinition>;
  importedFunctions: Record<string, ImportedFunctionSignature>;
  scopeHas: (name: string) => boolean;
};

export type CallResolution =
  | { kind: "def" }
  | { kind: "imported" }
  | { kind: "builtin" }
  | { kind: "reserved" }
  | { kind: "scopeBinding" }
  | { kind: "jsGlobal" }
  | { kind: "unresolved" };

export function resolveCall(
  name: string,
  input: ResolveCallInput,
): CallResolution {
  if (name in input.functionDefs || name in input.nodeDefs) return { kind: "def" };
  if (name in input.importedFunctions) return { kind: "imported" };
  if (name in BUILTIN_FUNCTION_TYPES) return { kind: "builtin" };
  if (RESERVED_FUNCTION_NAMES.has(name)) return { kind: "reserved" };
  if (input.scopeHas(name)) return { kind: "scopeBinding" };
  const jsEntry = JS_GLOBALS[name];
  if (jsEntry?.kind === "callable") return { kind: "jsGlobal" };
  return { kind: "unresolved" };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test:run lib/typeChecker/resolveCall.test.ts 2>&1 | tee /tmp/resolve-test-2.txt`
Expected: PASS

- [ ] **Step 5: Commit**

```
git add lib/typeChecker/resolveCall.ts lib/typeChecker/resolveCall.test.ts
git commit -m "feat: add resolveCall helper and JS_GLOBALS registry"
```

---

### Task 4: Create `undefinedFunctionDiagnostic` module and invoke from `index.ts`

**Files:**
- Create: `lib/typeChecker/undefinedFunctionDiagnostic.ts`
- Create: `lib/typeChecker/undefinedFunctionDiagnostic.test.ts`
- Modify: `lib/typeChecker/index.ts` (add ONE call to `checkUndefinedFunctions(scopes, ctx)` in the main check loop, alongside the existing `checkUnhandledInterruptWarnings` call)

This task creates the diagnostic as a self-contained module. **No changes to `checker.ts` or `synthesizer.ts`** — the diagnostic walker uses the existing `walkNodes` utility and the pure `resolveCall` from Task 3, and pushes errors via `ctx.errors`.

This mirrors the existing pattern in [lib/typeChecker/interruptAnalysis.ts](../../lib/typeChecker/interruptAnalysis.ts):

- One module
- One declarative public function: `checkUndefinedFunctions(scopes: ScopeInfo[], ctx: TypeCheckerContext): void`
- Internal walker uses `walkNodes` from [lib/utils/node.ts](../../lib/utils/node.ts)
- Invoked once from `TypeChecker.check()` after scopes are collected

This avoids the anti-patterns of imperative diagnostic logic inside `checkSingleFunctionCall` / `synthValueAccess` (which exist to do other work — arity checks, type synthesis), and makes the diagnostic trivial to enable, disable, test, or remove as a unit.

- [ ] **Step 1: Write the failing test**

Create `lib/typeChecker/undefinedFunctionDiagnostic.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { writeFileSync, unlinkSync } from "fs";
import path from "path";
import os from "os";
import { parseAgency } from "../parser.js";
import { SymbolTable } from "../symbolTable.js";
import { buildCompilationUnit } from "../compilationUnit.js";
import { typeCheck } from "./index.js";
import type { TypeCheckError } from "./types.js";
import type { AgencyConfig } from "../config.js";

function errorsFrom(source: string, config: AgencyConfig = {}): TypeCheckError[] {
  const file = path.join(
    os.tmpdir(),
    `tc-undef-${Date.now()}-${Math.random().toString(36).slice(2)}.agency`,
  );
  writeFileSync(file, source);
  try {
    const absPath = path.resolve(file);
    const symbolTable = SymbolTable.build(absPath, config);
    const parseResult = parseAgency(source, config);
    if (!parseResult.success) throw new Error("Parse failed");
    const program = parseResult.result;
    const info = buildCompilationUnit(program, symbolTable, absPath, source);
    return typeCheck(program, config, info).errors;
  } finally {
    unlinkSync(file);
  }
}

const WARN: AgencyConfig = { typechecker: { undefinedFunctions: "warn" } };

describe("undefined function diagnostic", () => {
  it("warns on a genuinely undefined function", () => {
    const errors = errorsFrom(
      `
      node main() {
        let x = parseJSON("{}")
      }
    `,
      WARN,
    );
    const undef = errors.filter((e) => e.message.includes("parseJSON"));
    expect(undef).toHaveLength(1);
    expect(undef[0].severity).toBe("warning");
  });

  it("does not warn on a locally defined function", () => {
    const errors = errorsFrom(
      `
      def helper(): string { return "ok" }
      node main() {
        helper()
      }
    `,
      WARN,
    );
    expect(errors.filter((e) => e.message.includes("helper"))).toHaveLength(0);
  });

  it("does not warn on a builtin function", () => {
    const errors = errorsFrom(
      `
      node main() {
        print("hello")
      }
    `,
      WARN,
    );
    expect(errors.filter((e) => e.message.includes("print"))).toHaveLength(0);
  });

  it("does not warn on a reserved name", () => {
    const errors = errorsFrom(
      `
      node main() {
        let r = success(42)
      }
    `,
      WARN,
    );
    expect(errors.filter((e) => e.message.includes("success"))).toHaveLength(0);
  });

  it("does not warn on a variable in scope (lambda/partial)", () => {
    const errors = errorsFrom(
      `
      def add(a: number, b: number): number { return a + b }
      node main() {
        const add2 = add.partial(a: 2)
        add2(3)
      }
    `,
      WARN,
    );
    expect(errors.filter((e) => e.message.includes("add2"))).toHaveLength(0);
  });

  it("does not warn on a flat callable JS global", () => {
    const errors = errorsFrom(
      `
      node main() {
        let x = parseInt("42")
      }
    `,
      WARN,
    );
    expect(errors.filter((e) => e.message.includes("parseInt"))).toHaveLength(0);
  });

  it("warns on a bare-statement call to an undefined function", () => {
    const errors = errorsFrom(
      `
      node main() {
        doStuff()
      }
    `,
      WARN,
    );
    const undef = errors.filter((e) => e.message.includes("doStuff"));
    expect(undef).toHaveLength(1);
  });

  it("does not warn on a node call (goto target)", () => {
    const errors = errorsFrom(
      `
      node start() {
        return finish()
      }
      node finish() {
        print("done")
      }
    `,
      WARN,
    );
    expect(errors.filter((e) => e.message.includes("finish"))).toHaveLength(0);
  });

  it("emits the diagnostic exactly once when used in an assignment (no double-fire)", () => {
    const errors = errorsFrom(
      `
      node main() {
        let x = doesNotExist()
      }
    `,
      WARN,
    );
    expect(errors.filter((e) => e.message.includes("doesNotExist"))).toHaveLength(1);
  });

  it("respects undefinedFunctions: silent (default)", () => {
    const errors = errorsFrom(`
      node main() {
        parseJSON("{}")
      }
    `);
    expect(errors.filter((e) => e.message.includes("parseJSON"))).toHaveLength(0);
  });

  it("respects undefinedFunctions: error", () => {
    const errors = errorsFrom(
      `
      node main() {
        parseJSON("{}")
      }
    `,
      { typechecker: { undefinedFunctions: "error" } },
    );
    const undef = errors.filter((e) => e.message.includes("parseJSON"));
    expect(undef).toHaveLength(1);
    expect(undef[0].severity).toBe("error");
  });
});

describe("undefined function diagnostic — JS namespaces", () => {
  it("does not warn on a known namespace member", () => {
    const errors = errorsFrom(
      `
      node main() {
        let x = JSON.parse("{}")
        let y = Math.floor(1.5)
      }
    `,
      WARN,
    );
    expect(errors.filter((e) => e.message.includes("JSON") || e.message.includes("Math"))).toHaveLength(0);
  });

  it("warns on an unknown member of a known namespace", () => {
    const errors = errorsFrom(
      `
      node main() {
        let x = JSON.banana("{}")
      }
    `,
      WARN,
    );
    expect(errors.filter((e) => e.message.includes("JSON.banana"))).toHaveLength(1);
  });

  it("does not warn when the base is a value in scope", () => {
    const errors = errorsFrom(
      `
      def makeObj(): any { return { foo: "bar" } }
      node main() {
        const obj = makeObj()
        obj.foo
      }
    `,
      WARN,
    );
    expect(errors.filter((e) => e.message.includes("obj"))).toHaveLength(0);
  });
});
```

Sanity-check the test helper: `SymbolTable.build`, `parseAgency`, and `typeCheck` all receive the same `config` argument.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:run lib/typeChecker/undefinedFunctionDiagnostic.test.ts 2>&1 | tee /tmp/undef-test-1.txt`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `undefinedFunctionDiagnostic.ts`**

Create the module. Public surface is one function. The "what" is encoded in the function name and a single block comment; the "how" is two short helpers:

```ts
import type { ScopeInfo, TypeCheckerContext } from "./types.js";
import type { Scope } from "./scope.js";
import type { FunctionCall, ValueAccess } from "../types.js";
import { walkNodes } from "../utils/node.js";
import { resolveCall, lookupJsMember, JS_GLOBALS } from "./resolveCall.js";

/**
 * Emit a diagnostic for every call site that doesn't resolve to a known
 * function — bare `functionCall` names AND `<JsNamespace>.member(...)` chains.
 *
 * Severity is controlled by `config.typechecker.undefinedFunctions`:
 *   - "silent" (default): no diagnostics emitted
 *   - "warn":  pushed as warnings
 *   - "error": pushed as errors
 *
 * Resolution is delegated to `resolveCall` / `lookupJsMember` (pure functions
 * in resolveCall.ts) — this module just walks the AST and translates "didn't
 * resolve" into a diagnostic.
 */
export function checkUndefinedFunctions(
  scopes: ScopeInfo[],
  ctx: TypeCheckerContext,
): void {
  const mode = ctx.config.typechecker?.undefinedFunctions ?? "silent";
  if (mode === "silent") return;

  for (const info of scopes) {
    if (!info.name || info.name === "top-level") continue;
    ctx.withScope(info.scopeKey, () => {
      for (const { node } of walkNodes(info.body)) {
        if (node.type === "functionCall") {
          checkBareCall(node, info.scope, ctx, mode);
        } else if (node.type === "valueAccess") {
          checkAccessChain(node, info.scope, ctx, mode);
        }
      }
    });
  }
}

// --- Internal helpers ---

function checkBareCall(
  call: FunctionCall,
  scope: Scope,
  ctx: TypeCheckerContext,
  mode: "warn" | "error",
): void {
  const resolution = resolveCall(call.functionName, {
    functionDefs: ctx.functionDefs,
    nodeDefs: ctx.nodeDefs,
    importedFunctions: ctx.importedFunctions,
    scopeHas: (name) => scope.has(name),
  });
  if (resolution.kind !== "unresolved") return;
  ctx.errors.push({
    message: `Function '${call.functionName}' is not defined.`,
    severity: mode,
    loc: call.loc,
  });
}

function checkAccessChain(
  expr: ValueAccess,
  scope: Scope,
  ctx: TypeCheckerContext,
  mode: "warn" | "error",
): void {
  // Only handle <variableName>.<member>... chains where the base is a JS
  // namespace global. Everything else (objects in scope, computed lookups,
  // optional chains) is the typechecker's job — not this diagnostic's.
  if (expr.base.type !== "variableName") return;
  const baseName = expr.base.name;
  if (scope.has(baseName)) return;
  if (baseName in ctx.functionDefs) return;
  if (baseName in ctx.importedFunctions) return;
  if (!(baseName in JS_GLOBALS)) return;

  const path = collectNamePath(expr, baseName);
  if (path === null) return; // Computed/optional access — bail.

  if (lookupJsMember(path) === null) {
    ctx.errors.push({
      message: `Function '${path.join(".")}' is not defined.`,
      severity: mode,
      loc: expr.loc,
    });
  }
}

/**
 * Walk a valueAccess chain, collecting member names. Returns null if the
 * chain contains anything we can't statically follow (computed lookup,
 * call-on-call, etc.) — caller bails out in that case.
 */
function collectNamePath(expr: ValueAccess, baseName: string): string[] | null {
  const path = [baseName];
  for (const access of expr.access) {
    if (access.kind === "propertyAccess") {
      path.push(access.propertyName);
    } else if (access.kind === "methodCall") {
      path.push(access.functionCall.functionName);
    } else {
      return null;
    }
  }
  return path;
}
```

(Adjust the `valueAccess` shape destructuring to whatever the actual `ValueAccess` type exports — see [lib/types/access.ts](../../lib/types/access.ts).)

- [ ] **Step 4: Wire into `TypeChecker.check()`**

In `lib/typeChecker/index.ts`, find the existing `checkUnhandledInterruptWarnings(scopes, interruptKindsByFunction, ctx)` call (around line 230) and add one line beside it:

```ts
import { checkUndefinedFunctions } from "./undefinedFunctionDiagnostic.js";

// ... in TypeChecker.check(), right after checkUnhandledInterruptWarnings:
checkUndefinedFunctions(scopes, ctx);
```

That's the only edit to `index.ts` from this task (the `RESERVED_FUNCTION_NAMES` import dedupe is Task 6).

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm test:run lib/typeChecker/undefinedFunctionDiagnostic.test.ts 2>&1 | tee /tmp/undef-test-2.txt`
Expected: PASS

- [ ] **Step 6: Run the full vitest suite to check for regressions**

Run: `pnpm test:run 2>&1 | tee /tmp/full-tests-after-diagnostic.txt`
Expected: PASS. Default is `"silent"`, so no existing tests should regress unless they explicitly enable the diagnostic.

- [ ] **Step 7: Commit**

```
git add lib/typeChecker/undefinedFunctionDiagnostic.ts lib/typeChecker/undefinedFunctionDiagnostic.test.ts lib/typeChecker/index.ts
git commit -m "feat: add undefined function diagnostic as separate module"
```

---

### Task 5: Add missing signatures for built-in functions; document `schema`

**Files:**
- Modify: `lib/typeChecker/builtins.ts`
- Modify: `lib/typeChecker/synthesizer.ts` (add explicit `schemaExpression` case with explanatory comment)
- Add: tests in `lib/typeChecker/builtinSignatures.test.ts` (or a fitting existing test file)

The following are language built-ins (no `def` source — semantics hardcoded by the type checker / runtime) that are parsed as plain `functionCall` AST nodes but currently have **no** `BUILTIN_FUNCTION_TYPES` entry, so they bypass arity checking entirely. They appear in real user code (verified in `examples/`, `tests/agency/`):

| Name | Arity | Return type |
|------|-------|-------------|
| `approve(value?)` | 0 or 1 | `"any"` (InterruptResponse — too dynamic to type meaningfully) |
| `reject(value?)` | 0 or 1 | `"any"` |
| `propagate()` | 0 | `"any"` |
| `checkpoint()` | 0 | `number` |
| `getCheckpoint(id: number)` | 1 | `"any"` |

Note: `schema`, `interrupt`, `debugger` are also language built-ins, but parsed into their own AST nodes (`SchemaExpression`, `InterruptStatement`, `DebuggerStatement`). They never reach `functionCall` handling, so no `BUILTIN_FUNCTION_TYPES` entry is needed. They stay in `RESERVED_FUNCTION_NAMES` purely to prevent user redefinition. **However**, `schemaExpression` currently has no explicit case in `synthType` — it falls through to the default `return "any"`. We add an explicit case with an explanatory comment so future readers don't have to reverse-engineer this.

- [ ] **Step 1: Write failing tests**

Create or extend a typechecker test file with cases like:

```ts
describe("BUILTIN_FUNCTION_TYPES — reserved callables", () => {
  it("approve accepts 0 or 1 args", () => {
    expect(errorsFrom(`node main() { approve() }`).filter(arityErr)).toHaveLength(0);
    expect(errorsFrom(`node main() { approve(42) }`).filter(arityErr)).toHaveLength(0);
    expect(errorsFrom(`node main() { approve(1, 2) }`).filter(arityErr).length).toBeGreaterThan(0);
  });

  it("propagate takes no args", () => {
    expect(errorsFrom(`node main() { propagate() }`).filter(arityErr)).toHaveLength(0);
    expect(errorsFrom(`node main() { propagate(42) }`).filter(arityErr).length).toBeGreaterThan(0);
  });

  it("getCheckpoint requires exactly 1 numeric arg", () => {
    expect(errorsFrom(`node main() { getCheckpoint(1) }`).filter(arityErr)).toHaveLength(0);
    expect(errorsFrom(`node main() { getCheckpoint() }`).filter(arityErr).length).toBeGreaterThan(0);
    expect(errorsFrom(`node main() { getCheckpoint(1, 2) }`).filter(arityErr).length).toBeGreaterThan(0);
  });
});
```

(`arityErr` = a predicate matching the type checker's arity-mismatch error message.)

- [ ] **Step 2: Run tests, verify they fail**

- [ ] **Step 3: Add entries to `BUILTIN_FUNCTION_TYPES`**

In `lib/typeChecker/builtins.ts`:

```ts
  // --- Handler outcomes (reserved names) ---
  approve:    { params: ["any"], minParams: 0, returnType: "any" },
  reject:     { params: ["any"], minParams: 0, returnType: "any" },
  propagate:  { params: [],                    returnType: "any" },

  // --- Checkpointing ---
  checkpoint:    { params: [],         returnType: number },
  getCheckpoint: { params: [number],   returnType: "any" },
```

- [ ] **Step 4: Run tests, verify they pass**

- [ ] **Step 5: Add explicit `schemaExpression` case in `synthType`**

In [lib/typeChecker/synthesizer.ts](../../lib/typeChecker/synthesizer.ts), the `synthType` switch (around line 100-120) currently has no case for `schemaExpression`, so it falls through to `default: return "any"`. Replace the default fall-through for `schemaExpression` with an explicit case carrying an explanatory comment:

```ts
    case "schemaExpression":
      // `schema(Type)` is a language built-in that bridges *type space* and
      // *value space*: the parser captures `Type` as a VariableType (not as a
      // value expression — see schemaExpressionParser in parsers.ts), and at
      // runtime the SchemaExpression node compiles to a zod schema constructed
      // from that type.
      //
      // We currently synthesize its result as "any" because there's no
      // structured `Schema<T>` type in Agency's type system yet. Adding one
      // would let downstream code see e.g. `Schema<MyType>` and validate
      // .parse() / .safeParse() return types — that's future work, deliberately
      // out of scope here.
      //
      // `schema` is listed in RESERVED_FUNCTION_NAMES so users can't define
      // their own `def schema()` (which would create parse ambiguity).
      return "any";
```

- [ ] **Step 6: Full suite check**

Run: `pnpm test:run 2>&1 | tee /tmp/full-tests-after-arity.txt`

If existing programs use these with wrong arities (unlikely but possible), surface them and either fix the program or relax the signature.

- [ ] **Step 7: Commit**

```
git add lib/typeChecker/builtins.ts lib/typeChecker/synthesizer.ts lib/typeChecker/builtinSignatures.test.ts
git commit -m "feat: add signatures for approve/reject/propagate/checkpoint/getCheckpoint; document schema"
```

---

### Task 6: Dedupe `RESERVED_FUNCTION_NAMES` in `index.ts`

**Files:**
- Modify: `lib/typeChecker/index.ts:47-62`

Since Task 3 already exports `RESERVED_FUNCTION_NAMES` from `resolveCall.ts`, replace the duplicate definition in `index.ts` with an import.

- [ ] **Step 1: Replace the local set with an import**

```ts
import { RESERVED_FUNCTION_NAMES } from "./resolveCall.js";
```

- [ ] **Step 2: Sanity-check usages**

`RESERVED_FUNCTION_NAMES` is used to reject `def`/`node` definitions with reserved names. Verify no other code depends on it being a *closed* set (e.g., type-alias name validation uses `RESERVED_TYPE_NAMES`, a separate set, so no collision).

- [ ] **Step 3: Full suite check**

Run: `pnpm test:run 2>&1 | tee /tmp/full-tests-dedup.txt`
Expected: PASS

- [ ] **Step 4: Commit**

```
git add lib/typeChecker/index.ts
git commit -m "refactor: import RESERVED_FUNCTION_NAMES from resolveCall.ts"
```

---

### Task 7: Update documentation

**Files:**
- Modify: `docs/misc/config.md`
- Modify: `docs/dev/typechecker.md` (add Diagnostics section; update Builtin section)
- Modify: `docs/dev/undefined-function-diagnostic.md`

- [ ] **Step 1: Update `docs/misc/config.md`**

Add a new section documenting the `typechecker` config object and remove the old `strictTypes` / `typeCheck` / `typeCheckStrict` documentation:

```markdown
### Type Checker

- **`typechecker`** (object): Type checker configuration

  - **`enabled`** (boolean): Run type checking during compilation. Default: `false`
  - **`strict`** (boolean): Type errors are fatal (implies `enabled: true`). Default: `false`
  - **`strictTypes`** (boolean): Untyped variables are errors. Default: `false`
  - **`undefinedFunctions`** (`"silent" | "warn" | "error"`): What to do when a called
    function (or `Namespace.method(...)` chain on a JS global) cannot be resolved.
    Default: `"silent"`. Recommend setting to `"warn"` once your codebase is clean.
```

- [ ] **Step 2: Update `docs/dev/typechecker.md`**

This is the most important documentation change — without it, future contributors won't know that diagnostics are a separate thing from synth/check. Three additions:

**(a) Add a top-level "Diagnostics" section** (after "Special cases for Agency", before "Return type inference"):

```markdown
## Diagnostics

Diagnostics are checks that emit warnings or errors but don't affect type
synthesis or assignability. Each diagnostic lives in its own module and is
invoked once from `TypeChecker.check()`'s main loop after scopes are
collected and the core synth/check passes have run.

This separation keeps the core synth/check code focused on type correctness,
lets each diagnostic be enabled/disabled and tested as a unit, and makes it
cheap to add new diagnostics without entangling unrelated code.

### Existing diagnostics

| Module | Public function | Purpose |
|---|---|---|
| `lib/typeChecker/interruptAnalysis.ts` | `checkUnhandledInterruptWarnings` | Warn when a function calls something that may throw an interrupt outside a handler. |
| `lib/typeChecker/undefinedFunctionDiagnostic.ts` | `checkUndefinedFunctions` | Warn (or error) when a `functionCall` or `Namespace.method(...)` chain doesn't resolve to anything known. Uses the pure `resolveCall` / `lookupJsMember` / `JS_GLOBALS` data from `lib/typeChecker/resolveCall.ts`. |

### Adding a new diagnostic

Follow the existing module shape:

1. One module under `lib/typeChecker/`.
2. One public function taking `(scopes: ScopeInfo[], ctx: TypeCheckerContext): void`.
3. Walk the AST with `walkNodes` from `lib/utils/node.ts`.
4. Push diagnostics to `ctx.errors`.
5. Add one call from `TypeChecker.check()` after the existing diagnostic calls.
6. Add a config knob under `typechecker.<name>` if the diagnostic should be opt-in or opt-out.

Keep the public surface narrow (one function), keep lookup data in a
separate pure module so it can be reused, and don't reach into `checker.ts`
or `synthesizer.ts` from the diagnostic — they have a different job.

### Resolving call sites

`lib/typeChecker/resolveCall.ts` exports `resolveCall(name, input)` and
`lookupJsMember(path)` — pure functions answering "what does this call
site refer to?" Returns a tagged union of `def | imported | builtin |
reserved | scopeBinding | jsGlobal | unresolved`. The undefined-function
diagnostic uses these; future analyses asking the same question should use
them too.
```

**(b) Replace the existing "Builtin function signatures" section** with the builtin-vs-stdlib distinction:

```markdown
## Builtin and stdlib function signatures

Two distinct categories of Agency function — **conceptually**:

- **Built-in functions** (language primitives, no `def` source): `success`,
  `failure`, `isSuccess`, `isFailure`, `llm`, `interrupt`, `approve`,
  `reject`, `propagate`, `checkpoint`, `getCheckpoint`, `restore`, `schema`,
  `debugger`. Their semantics are hardcoded in the type checker and
  runtime, and users cannot redefine them (see `RESERVED_FUNCTION_NAMES`
  in `lib/typeChecker/resolveCall.ts`).
- **Stdlib functions** (regular Agency code): `print`, `printJSON`, `read`,
  `fetch`, `notify`, `sleep`, `range`, `keys`, etc. — defined in
  `stdlib/index.agency` like any user function. Users may shadow them.

`BUILTIN_FUNCTION_TYPES` in `lib/typeChecker/builtins.ts` holds typed
signatures for both categories. Stdlib entries are duplicated there for
typechecker convenience — see the `NOTE` comment in that file. Long term,
stdlib signatures should come from the symbol table via `importedFunctions`.

[Existing table of signatures...]
```

**(c) Add a short subsection under "Special cases for Agency"** about `schema`:

```markdown
### `schema(Type)`

`schema(Type)` is a language built-in that bridges *type space* and *value
space*: the parser captures `Type` as a `VariableType` (not a value
expression — see `schemaExpressionParser` in `lib/parsers/parsers.ts`),
and at runtime the resulting `SchemaExpression` AST node compiles to a
zod schema constructed from that type.

The type checker currently synthesizes its result as `"any"` — populating
it with a structured `Schema<T>` type is future work that would let
downstream code see e.g. `Schema<MyType>` and validate `.parse()` /
`.safeParse()` return types.

`schema` is listed in `RESERVED_FUNCTION_NAMES` so users can't define
their own `def schema()` (which would create parse ambiguity).
```

- [ ] **Step 3: Rewrite `docs/dev/undefined-function-diagnostic.md`**

Replace the speculative "A reasonable implementation sketch" section with the actual implementation. Add:

- Pointer to `lib/typeChecker/undefinedFunctionDiagnostic.ts` (the diagnostic) and `lib/typeChecker/resolveCall.ts` (the pure lookups + `JS_GLOBALS` data).
- Note that the diagnostic is a separate module, not woven into `checker.ts` / `synthesizer.ts`. Cross-link to the new "Diagnostics" section in `typechecker.md`.
- Phase 1 vs Phase 2 distinction (existence vs typed signatures).
- Follow-ups: flipping default to `"warn"`; populating `sig` fields on `JS_GLOBALS`; symmetric undefined-variable diagnostic.

- [ ] **Step 4: Commit**

```
git add docs/misc/config.md docs/dev/typechecker.md docs/dev/undefined-function-diagnostic.md
git commit -m "docs: document typechecker diagnostics and undefined function check"
```

---

### Task 8: Run agency execution tests

- [ ] **Step 1: Run agency tests**

Run: `AGENCY_USE_TEST_LLM_PROVIDER=1 pnpm run agency test tests/agency 2>&1 | tee /tmp/agency-tests.txt`

- [ ] **Step 2: Run agency-js tests**

Run: `AGENCY_USE_TEST_LLM_PROVIDER=1 pnpm run agency test js tests/agency-js 2>&1 | tee /tmp/agency-js-tests.txt`

- [ ] **Step 3: Fix any failures**

The diagnostic ships at `"silent"`, so no test-level regressions are expected. If any tests fail, they're likely from Task 5 (new arity checks for `approve`/`reject`/`propagate`/`checkpoint`/`getCheckpoint`) — investigate per-test and either fix the program or relax the signature.

- [ ] **Step 4: Commit if needed**

```
git add -A
git commit -m "test: fix any agency execution test regressions"
```

---

## Out of scope (follow-ups)

These are explicitly NOT done in this plan; capture as separate tickets:

1. **Flip `undefinedFunctions` default from `"silent"` to `"warn"`.** Requires cleaning up any internal test agency files that produce false positives. Small, mostly-mechanical PR.
2. **Populate `sig: BuiltinSignature` on `JS_GLOBALS` entries.** Add typed signatures for high-traffic entries (`JSON.parse`, `JSON.stringify`, `Math.floor`, `parseInt`, etc.) and let the typechecker enforce them. Pure addition.
3. **Move stdlib signatures out of `BUILTIN_FUNCTION_TYPES`.** Today, stdlib functions (`print`, `read`, `fetch`, `printJSON`, `notify`, `sleep`, `range`, `keys`, `values`, `entries`, `mostCommon`, etc.) have hardcoded signatures in `BUILTIN_FUNCTION_TYPES` for typechecker convenience, even though they're regular Agency code in [stdlib/index.agency](../../stdlib/index.agency). The existing `NOTE` comment in [lib/typeChecker/builtins.ts:66-71](../../lib/typeChecker/builtins.ts#L66-L71) flags this as tech debt: signatures should come from the symbol table via `importedFunctions`. Doing this requires the SymbolTable to expose typed parameter info in the shape the typechecker expects, which is a substantial separate refactor.
4. **Synth a structured `Schema<T>` type for `schemaExpression`.** Currently returns `"any"` (see Task 5 step 5 comment). Adding a real type would let downstream code validate `.parse()` / `.safeParse()` return types.
5. **Undefined-variable diagnostic.** Symmetric problem for non-call references (e.g., `let x = doesNotExist`). A separate analysis on `variableName` lookups against scope. Distinct enough to plan separately.
6. **Higher-order callback safety.** A name passed by reference to `map(items, doesNotExist)` is a `variableName` argument, not a `functionCall`. Catching this is its own analysis (probably part of the undefined-variable diagnostic above).
