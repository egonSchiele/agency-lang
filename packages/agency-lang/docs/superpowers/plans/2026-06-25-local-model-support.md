# Local-Model Support (Custom Provider Modules) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user run any Agency program (and the agent) against a local/custom LLM provider (e.g. `smoltalk-llama-cpp`) by loading a user-authored "provider module" at startup, without `agency-lang` depending on that package and without editing the prebuilt binary.

**Architecture:** A user writes a tiny ES module exporting `register({ registerProvider })`. agency discovers module paths from `agency.json` (`client.providerModules`) and the `AGENCY_PROVIDER_MODULES` env var, merges them, and — in the shared run/resume bootstrap, before any `llm()` call — dynamically `import()`s each module and calls its `register` with **agency's own** `smoltalk.registerProvider` (so the provider lands in the instance the runtime resolves against). One process-level guard prevents re-registration.

**Tech Stack:** TypeScript (ESM), smoltalk (`registerProvider`/`getClient`), esbuild (`agency pack`), vitest, the agency-js test harness.

**Spec:** `docs/superpowers/specs/2026-06-16-local-model-support-design.md`

---

## Setup (do once before Task 1)

This plan runs in the `local-model-support` git worktree (branch `local-model-support`, off `origin/main`), package dir `packages/agency-lang`. The worktree has no `node_modules` yet.

- [ ] **Install deps and confirm a clean baseline**

Run (from the package dir):
```bash
pnpm install
pnpm build   # or: make
```
Expected: install completes; build succeeds with no errors.

---

## File Structure

| File | Responsibility | Action |
|---|---|---|
| `lib/config.ts` | Declare `client.providerModules: string[]` (type + zod). | Modify |
| `lib/runtime/state/context.ts` | Carry `providerModules` on `RuntimeContext` (field, ctor arg, `createExecutionContext` copy). | Modify |
| `lib/backends/typescriptBuilder.ts` | Bake `providerModules` into the generated `new RuntimeContext({...})` args. | Modify |
| `lib/backends/providerModules.codegen.test.ts` | Assert the bake. | Create |
| `lib/runtime/providerModules.ts` | `loadProviderModules(ctx)`: merge config+env, resolve paths, the one sanctioned `import()`, validate + call `register`, process-level dedupe. | Create |
| `lib/runtime/providerModules.test.ts` | Unit tests (success, env merge, dedupe, 3 error modes). | Create |
| `lib/runtime/node.ts` | Call `loadProviderModules` first in `initFreshExecCtx`. | Modify |
| `lib/runtime/interrupts.ts` | Call `loadProviderModules` first in `respondToInterrupts`. | Modify |
| `tests/agency-js/provider-module/` | End-to-end: `agency.json` → baked → loaded during a real compiled run → provider registered. | Create |
| `lib/cli/pack.test.ts` | Smoke test: `agency pack` survives a program configured with `providerModules`. | Modify |
| `docs/site/guide/custom-providers.md` (+ nav) | User docs with the `smoltalk-llama-cpp` walkthrough. | Create |

The merged-path resolution rule (used everywhere): a path is resolved against `process.cwd()` if not already absolute. This is correct for real usage (the user runs `agency` from the project root where `agency.json` lives) and for the agency-js harness (it runs `node test.js` with `cwd` = the test directory).

---

### Task 1: Config — `client.providerModules`

**Files:**
- Modify: `lib/config.ts` (type block at `lib/config.ts:121-135`; zod block at `lib/config.ts:348-364`)
- Test: `lib/config.providerModules.test.ts` (Create)

- [ ] **Step 1: Write the failing test**

Create `lib/config.providerModules.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { configSchema } from "./config.js";

describe("config client.providerModules", () => {
  it("accepts an array of module paths", () => {
    const parsed = configSchema.parse({
      client: { providerModules: ["./llama-setup.mjs", "/abs/other.mjs"] },
    });
    expect(parsed.client?.providerModules).toEqual([
      "./llama-setup.mjs",
      "/abs/other.mjs",
    ]);
  });

  it("rejects a non-array providerModules", () => {
    expect(() =>
      configSchema.parse({ client: { providerModules: "nope" } }),
    ).toThrow();
  });
});
```

> Note: confirm the exported schema name. `lib/config.ts` exports the zod schema used by `loadConfig`. If it is not named `configSchema`, open `lib/config.ts`, find the top-level `z.object({...}).partial()` export (the one containing the `client:` block at line ~348), and use that exported name in the import above.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test:run lib/config.providerModules.test.ts 2>&1 | tee /tmp/t1.txt`
Expected: FAIL — `providerModules` is stripped/unknown so the first assertion's `toEqual` fails (or the schema name import fails, which you fix per the note above).

- [ ] **Step 3: Add the type field**

In `lib/config.ts`, inside the `client?: Partial<{ ... }>` block (after `maxToolResultChars: number;` at line 135), add:
```ts
    /**
     * Paths to user-authored "provider module" ES files loaded at
     * startup. Each must export `register({ registerProvider })` and call
     * `registerProvider(name, ClientClass)` to register a custom smoltalk
     * provider (e.g. a local model via `smoltalk-llama-cpp`). Relative
     * paths resolve against the current working directory. Merged with
     * the `AGENCY_PROVIDER_MODULES` env var at runtime.
     */
    providerModules: string[];
```

- [ ] **Step 4: Add the zod field**

In `lib/config.ts`, inside the `client` `z.object({...})` (after `maxToolResultChars: z.number(),` at line 355), add:
```ts
        providerModules: z.array(z.string()),
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm test:run lib/config.providerModules.test.ts 2>&1 | tee /tmp/t1.txt`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add lib/config.ts lib/config.providerModules.test.ts
git commit -m "feat(config): add client.providerModules"
```

---

### Task 2: `RuntimeContext.providerModules`

**Files:**
- Modify: `lib/runtime/state/context.ts` (field near `:124`; ctor arg near `:191`; ctor assignment near `:247`; `createExecutionContext` copy near `:277`)
- Test: `lib/runtime/state/context.providerModules.test.ts` (Create)

- [ ] **Step 1: Write the failing test**

Create `lib/runtime/state/context.providerModules.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { RuntimeContext } from "./context.js";

function baseArgs() {
  return {
    statelogConfig: { host: "", projectId: "", apiKey: "", traceId: "t" },
    smoltalkDefaults: {},
  };
}

describe("RuntimeContext.providerModules", () => {
  it("defaults to [] when not provided", () => {
    const ctx = new RuntimeContext({ ...baseArgs(), dirname: "/x" });
    expect(ctx.providerModules).toEqual([]);
  });

  it("stores the configured paths", () => {
    const ctx = new RuntimeContext({
      ...baseArgs(),
      dirname: "/x",
      providerModules: ["./a.mjs"],
    });
    expect(ctx.providerModules).toEqual(["./a.mjs"]);
  });

  it("copies providerModules onto a child execution context", async () => {
    const ctx = new RuntimeContext({
      ...baseArgs(),
      dirname: "/x",
      providerModules: ["./a.mjs"],
    });
    const child = await ctx.createExecutionContext("run-1");
    expect(child.providerModules).toEqual(["./a.mjs"]);
  });
});
```

> Note: if the `statelogConfig` literal above does not match the `StatelogConfig` type, copy the exact shape another `RuntimeContext` test in this directory uses (e.g. `context.test.ts`).

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test:run lib/runtime/state/context.providerModules.test.ts 2>&1 | tee /tmp/t2.txt`
Expected: FAIL — `ctx.providerModules` is `undefined`.

- [ ] **Step 3: Add the field**

In `lib/runtime/state/context.ts`, after the `maxToolResultChars?` field (line ~124), add:
```ts
  /** Paths to provider modules to load at startup, baked in from
   *  `agency.json` `client.providerModules` at compile time and merged
   *  with `AGENCY_PROVIDER_MODULES` at runtime by `loadProviderModules`.
   *  Defaults to `[]`. */
  providerModules: string[];
```

- [ ] **Step 4: Add the constructor arg + assignment**

In the constructor args type (after `maxToolResultChars?: number;`, line ~191) add:
```ts
    providerModules?: string[];
```
In the constructor body, immediately after `this.maxToolResultChars = args.maxToolResultChars;` (line ~247) add:
```ts
    this.providerModules = args.providerModules ?? [];
```

- [ ] **Step 5: Copy it in `createExecutionContext`**

In `createExecutionContext`, immediately after `execCtx.maxToolResultChars = this.maxToolResultChars;` (line ~277) add:
```ts
    execCtx.providerModules = this.providerModules;
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `pnpm test:run lib/runtime/state/context.providerModules.test.ts 2>&1 | tee /tmp/t2.txt`
Expected: PASS (3 tests).

- [ ] **Step 7: Commit**

```bash
git add lib/runtime/state/context.ts lib/runtime/state/context.providerModules.test.ts
git commit -m "feat(runtime): carry providerModules on RuntimeContext"
```

---

### Task 3: Bake `providerModules` into generated code

**Files:**
- Modify: `lib/backends/typescriptBuilder.ts` (the `runtimeCtxArgs` block; `maxToolResultChars` is baked at lines ~3453-3457 — add immediately after it)
- Test: `lib/backends/providerModules.codegen.test.ts` (Create)

- [ ] **Step 1: Write the failing test**

Create `lib/backends/providerModules.codegen.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { parseAgency } from "../parser.js";
import { TypeScriptBuilder } from "./typescriptBuilder.js";
import { TypescriptPreprocessor } from "@/preprocessors/typescriptPreprocessor.js";
import { buildCompilationUnit } from "@/compilationUnit.js";
import { printTs } from "../ir/prettyPrint.js";
import type { AgencyConfig } from "@/config.js";

function generate(source: string, config?: Partial<AgencyConfig>): string {
  const parseResult = parseAgency(source, {}, false);
  if (!parseResult.success) throw new Error(`Failed to parse: ${parseResult.message}`);
  const info = buildCompilationUnit(parseResult.result);
  const preprocessor = new TypescriptPreprocessor(parseResult.result, {}, info);
  const pre = preprocessor.preprocess();
  const builder = new TypeScriptBuilder(config as AgencyConfig, info, "test.agency");
  return printTs(builder.build(pre));
}

const PROGRAM = "node main() {\n  const x = 1\n}\n";

describe("providerModules codegen", () => {
  it("bakes client.providerModules into the RuntimeContext args", () => {
    const out = generate(PROGRAM, {
      client: { providerModules: ["./llama-setup.mjs", "/abs/two.mjs"] },
    });
    expect(out).toContain("providerModules");
    expect(out).toContain('"./llama-setup.mjs"');
    expect(out).toContain('"/abs/two.mjs"');
  });

  it("omits providerModules when not configured", () => {
    const out = generate(PROGRAM);
    expect(out).not.toContain("providerModules");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test:run lib/backends/providerModules.codegen.test.ts 2>&1 | tee /tmp/t3.txt`
Expected: FAIL — the generated output has no `providerModules`.

- [ ] **Step 3: Implement the bake**

In `lib/backends/typescriptBuilder.ts`, immediately after the `maxToolResultChars` block (ends ~line 3457):
```ts
    if (cfg.client?.providerModules && cfg.client.providerModules.length > 0) {
      runtimeCtxArgs.providerModules = ts.arr(
        cfg.client.providerModules.map((p) => ts.str(p)),
      );
    }
```

> Note: confirm the array-literal IR helper name. The builder already constructs object literals with `ts.obj(...)` and strings with `ts.str(...)` in this same method. If `ts.arr` is not the array helper, grep `lib/ir/builders.ts` for the array constructor (e.g. `arr`/`array`/`list`) and use that name. The `cfg` alias is the same one used by the surrounding `cfg.client?.maxToolResultChars` code.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm test:run lib/backends/providerModules.codegen.test.ts 2>&1 | tee /tmp/t3.txt`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/backends/typescriptBuilder.ts lib/backends/providerModules.codegen.test.ts
git commit -m "feat(codegen): bake client.providerModules into RuntimeContext args"
```

---

### Task 4: `loadProviderModules` core + unit tests

**Files:**
- Create: `lib/runtime/providerModules.ts`
- Create: `lib/runtime/providerModules.test.ts`

- [ ] **Step 1: Write the failing test**

Create `lib/runtime/providerModules.test.ts`:
```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as smoltalk from "smoltalk";
import {
  loadProviderModules,
  __resetLoadedProviderModules,
} from "./providerModules.js";

// Temp provider-module fixtures are written next to this test file so their
// bare `import "smoltalk"` resolves against the package's node_modules.
const here = import.meta.dirname;
const tmpFiles: string[] = [];

function writeModule(name: string, body: string): string {
  const p = path.join(here, `__tmp_provider_${name}.mjs`);
  fs.writeFileSync(p, body);
  tmpFiles.push(p);
  return p;
}

beforeEach(() => {
  __resetLoadedProviderModules();
  delete process.env.AGENCY_PROVIDER_MODULES;
  globalThis.__providerRegisterCount = 0;
});

afterEach(() => {
  for (const p of tmpFiles.splice(0)) {
    try { fs.unlinkSync(p); } catch { }
  }
  for (const name of ["echo-a", "count-a"]) {
    smoltalk.unregisterProvider(name);
  }
  delete process.env.AGENCY_PROVIDER_MODULES;
});

describe("loadProviderModules", () => {
  it("registers a provider from a configured module path", async () => {
    const mod = writeModule(
      "echo",
      `import { BaseClient } from "smoltalk";
       class EchoA extends BaseClient { async textSync() { return { success: true, value: { output: "x", toolCalls: [] } }; } }
       export function register({ registerProvider }) { registerProvider("echo-a", EchoA); }`,
    );
    await loadProviderModules({ providerModules: [mod] });
    const client = smoltalk.getClient({ model: "m", provider: "echo-a" });
    expect(client.constructor.name).toBe("EchoA");
  });

  it("reads paths from the AGENCY_PROVIDER_MODULES env var too", async () => {
    const mod = writeModule(
      "echo",
      `import { BaseClient } from "smoltalk";
       class EchoA extends BaseClient { async textSync() { return { success: true, value: { output: "x", toolCalls: [] } }; } }
       export function register({ registerProvider }) { registerProvider("echo-a", EchoA); }`,
    );
    process.env.AGENCY_PROVIDER_MODULES = mod;
    await loadProviderModules({ providerModules: [] });
    expect(smoltalk.getClient({ model: "m", provider: "echo-a" }).constructor.name).toBe("EchoA");
  });

  it("registers each module only once per process (loaded-Set guard)", async () => {
    const mod = writeModule(
      "count",
      `import { BaseClient } from "smoltalk";
       class CountA extends BaseClient { async textSync() { return { success: true, value: { output: "x", toolCalls: [] } }; } }
       export function register({ registerProvider }) {
         globalThis.__providerRegisterCount = (globalThis.__providerRegisterCount ?? 0) + 1;
         registerProvider("count-a", CountA);
       }`,
    );
    await loadProviderModules({ providerModules: [mod] });
    await loadProviderModules({ providerModules: [mod] });
    expect(globalThis.__providerRegisterCount).toBe(1);
  });

  it("throws a clear error when the module path does not resolve", async () => {
    await expect(
      loadProviderModules({ providerModules: ["./does-not-exist-xyz.mjs"] }),
    ).rejects.toThrow(/Failed to load provider module/);
  });

  it("throws when the module has no register export", async () => {
    const mod = writeModule("noreg", `export const nope = 1;`);
    await expect(
      loadProviderModules({ providerModules: [mod] }),
    ).rejects.toThrow(/does not export a "register" function/);
  });

  it("throws when register() itself throws", async () => {
    const mod = writeModule(
      "boom",
      `export function register() { throw new Error("kaboom"); }`,
    );
    await expect(
      loadProviderModules({ providerModules: [mod] }),
    ).rejects.toThrow(/threw during register\(\): kaboom/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test:run lib/runtime/providerModules.test.ts 2>&1 | tee /tmp/t4.txt`
Expected: FAIL — `./providerModules.js` does not exist (import error).

- [ ] **Step 3: Implement `loadProviderModules`**

Create `lib/runtime/providerModules.ts`:
```ts
import { pathToFileURL } from "node:url";
import path from "node:path";
import { registerProvider } from "smoltalk";

/** Absolute paths of provider modules already loaded + registered in this
 *  process. Registration writes to smoltalk's module-level registry, so a
 *  given module must be processed only once even though `loadProviderModules`
 *  runs on every fresh run, every `serve` request, and every resume. This
 *  guard is therefore load-bearing for long-running `serve` processes, not a
 *  mere optimization. */
const loadedModulePaths = new Set<string>();

/** Parse the comma-separated `AGENCY_PROVIDER_MODULES` env var. */
function envProviderModules(): string[] {
  const raw = process.env.AGENCY_PROVIDER_MODULES;
  if (!raw) return [];
  return raw.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
}

/** Resolve a configured path to absolute (cwd-relative when not absolute). */
function resolvePath(p: string): string {
  return path.isAbsolute(p) ? p : path.resolve(process.cwd(), p);
}

/**
 * Load every configured provider module and register its provider(s) into
 * agency's own smoltalk instance, before any user code or `llm()` call.
 *
 * A provider module is a user-authored ES module exporting
 * `register({ registerProvider })`. agency injects *its own*
 * `registerProvider` (rather than the module importing it from smoltalk) so
 * the provider lands in the registry this runtime resolves against — smoltalk
 * is a peer dependency of provider packages, and a globally-installed package
 * may otherwise carry a second smoltalk copy whose registry the runtime never
 * reads.
 *
 * Paths come from `ctx.providerModules` (baked from `agency.json`) merged with
 * `AGENCY_PROVIDER_MODULES`. Idempotent per process via `loadedModulePaths`.
 * Any failure is fatal and names the offending path — a misconfigured provider
 * module is a setup error, never silently skipped.
 */
export async function loadProviderModules(ctx: {
  providerModules?: string[];
}): Promise<void> {
  const configured = [...(ctx.providerModules ?? []), ...envProviderModules()];
  for (const raw of configured) {
    const resolved = resolvePath(raw);
    if (loadedModulePaths.has(resolved)) continue;

    let mod: { register?: unknown };
    try {
      // eslint-disable-next-line no-restricted-syntax -- The single sanctioned
      // dynamic import in the codebase. Provider modules are optional,
      // machine-specific, and resolved at runtime, so they cannot be statically
      // imported (which would also force a dependency on the provider package).
      // The specifier is a runtime-computed file URL, which additionally keeps
      // `agency pack`'s esbuild from attempting to bundle it.
      mod = (await import(pathToFileURL(resolved).href)) as { register?: unknown };
    } catch (err) {
      throw new Error(
        `Failed to load provider module "${raw}" (resolved to ${resolved}): ${(err as Error).message}`,
      );
    }

    if (typeof mod.register !== "function") {
      throw new Error(
        `Provider module "${raw}" (resolved to ${resolved}) does not export a "register" function. ` +
          `Expected: export function register({ registerProvider }) { ... }`,
      );
    }

    try {
      await (mod.register as (api: {
        registerProvider: typeof registerProvider;
      }) => unknown | Promise<unknown>)({ registerProvider });
    } catch (err) {
      throw new Error(
        `Provider module "${raw}" (resolved to ${resolved}) threw during register(): ${(err as Error).message}`,
      );
    }

    loadedModulePaths.add(resolved);
  }
}

/** Test-only: clear the per-process loaded-module guard. */
export function __resetLoadedProviderModules(): void {
  loadedModulePaths.clear();
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm test:run lib/runtime/providerModules.test.ts 2>&1 | tee /tmp/t4.txt`
Expected: PASS (6 tests). If `smoltalk.getClient` rejects an unknown model when a provider IS given, re-read `node_modules/smoltalk/dist/client.js` — the model-type check is skipped when `config.provider` is set, so passing `provider` is what makes an arbitrary `model` string acceptable.

- [ ] **Step 5: Lint the new file (confirms the eslint exception is correct)**

Run: `pnpm run lint:structure 2>&1 | tee /tmp/t4-lint.txt`
Expected: no error for `lib/runtime/providerModules.ts` (the `eslint-disable-next-line no-restricted-syntax` covers the `import()`).

- [ ] **Step 6: Commit**

```bash
git add lib/runtime/providerModules.ts lib/runtime/providerModules.test.ts
git commit -m "feat(runtime): loadProviderModules (config+env, dynamic import, register injection)"
```

---

### Task 5: Wire into the run and resume bootstraps

**Files:**
- Modify: `lib/runtime/node.ts` (import; call at the start of `initFreshExecCtx`, before `__initAllRegistered` at line ~154)
- Modify: `lib/runtime/interrupts.ts` (import; call at the start of `respondToInterrupts`, before the resume loop)

- [ ] **Step 1: Add the call in `initFreshExecCtx` (covers `runNode` + `runExportedFunction`/serve)**

In `lib/runtime/node.ts`, add to the imports near the other runtime imports (e.g. beside the `__initAllRegistered` import at line 16):
```ts
import { loadProviderModules } from "./providerModules.js";
```
In `initFreshExecCtx`, immediately before `await runInBootstrapFrame(execCtx, () => __initAllRegistered(execCtx), { moduleDir });` (line ~154), add:
```ts
  // Register custom/local LLM providers before any user code or llm() call.
  // Process-global + idempotent (see loadProviderModules), so it is safe and
  // cheap to call on every fresh run.
  await loadProviderModules(execCtx);
```

- [ ] **Step 2: Add the call in `respondToInterrupts` (resume path)**

In `lib/runtime/interrupts.ts`, add the import near the top:
```ts
import { loadProviderModules } from "./providerModules.js";
```
In `respondToInterrupts` (starts line ~416), add as the first statement inside the function body — before the `registerTopLevelCallbacks` block (~line 483) and before `runResumeLoop` (~line 499):
```ts
  // A cross-process resume starts with an empty provider registry (registration
  // is process-global, not part of serialized checkpoint state), so re-register
  // before resuming. Idempotent in-process via loadProviderModules' guard.
  await loadProviderModules(execCtx);
```
> Note: confirm the execution-context variable name in `respondToInterrupts` is `execCtx` (it is the same name `runResumeLoop(execCtx, ...)` uses at ~line 499). If different, match it.

- [ ] **Step 3: Build and run the full runtime test directory to confirm no regressions**

Run:
```bash
pnpm build 2>&1 | tee /tmp/t5-build.txt
pnpm test:run lib/runtime 2>&1 | tee /tmp/t5.txt
```
Expected: build succeeds; runtime unit tests pass (including `providerModules.test.ts`). The end-to-end proof that the wiring fires is Task 6.

- [ ] **Step 4: Commit**

```bash
git add lib/runtime/node.ts lib/runtime/interrupts.ts
git commit -m "feat(runtime): load provider modules in run and resume bootstraps"
```

---

### Task 6: End-to-end agency-js test (config → baked → loaded at run)

This proves the whole pipeline (`agency.json` `providerModules` → baked into the compiled program → `loadProviderModules` runs during a real `main()` → provider registered in agency's smoltalk). It asserts **registration**, not an `llm()` round-trip, so it is unaffected by the harness's deterministic-LLM mode (which would otherwise replace the client and bypass the provider registry).

**Files (all Create, in `tests/agency-js/provider-module/`):**

- [ ] **Step 1: Create the provider module fixture**

`tests/agency-js/provider-module/echo-setup.mjs`:
```js
import { BaseClient, promptResult, success } from "smoltalk";

class EchoClient extends BaseClient {
  async textSync() {
    return success(promptResult({ output: "ECHO_OK", toolCalls: [] }));
  }
}

export function register({ registerProvider }) {
  registerProvider("echo", EchoClient);
}
```

- [ ] **Step 2: Create the agency.json that points at it**

`tests/agency-js/provider-module/agency.json`:
```json
{
  "client": {
    "providerModules": ["./echo-setup.mjs"]
  }
}
```

- [ ] **Step 3: Create the agency program**

`tests/agency-js/provider-module/agent.agency`:
```
// Running this node triggers the run bootstrap, which loads the provider
// module declared in agency.json. The body itself does no LLM work.
node main(): string {
  return "ran"
}
```

- [ ] **Step 4: Create the test driver**

`tests/agency-js/provider-module/test.js`:
```js
import { main } from "./agent.js";
import * as smoltalk from "smoltalk";
import { writeFileSync } from "fs";

// Running main() executes the run bootstrap (initFreshExecCtx ->
// loadProviderModules), which loads ./echo-setup.mjs from agency.json and
// registers the "echo" provider into this same smoltalk instance.
await main();

let provider = null;
try {
  const client = smoltalk.getClient({ model: "echo-model", provider: "echo" });
  provider = client?.constructor?.name ?? null;
} catch (e) {
  provider = "ERR:" + e.message;
}

writeFileSync("__result.json", JSON.stringify({ provider }, null, 2));
```

- [ ] **Step 5: Create the expected fixture**

`tests/agency-js/provider-module/fixture.json`:
```json
{
  "provider": "EchoClient"
}
```

- [ ] **Step 6: Build, then run the single agency-js test**

Run:
```bash
pnpm build 2>&1 | tee /tmp/t6-build.txt
pnpm run agency test js tests/agency-js/provider-module 2>&1 | tee /tmp/t6.txt
```
Expected: the test passes — `__result.json` equals `fixture.json` (`{ "provider": "EchoClient" }`).

Troubleshooting if it fails:
- `provider` is `null` → the program ran but the provider was not registered: confirm the sibling `agency.json` was merged (it is read at `lib/cli/test.ts:988`) and that Task 3's bake emitted `providerModules`. Inspect the compiled `tests/agency-js/provider-module/agent.js` for `providerModules: ["./echo-setup.mjs"]`.
- `ERR:...` mentioning resolution → the relative `./echo-setup.mjs` did not resolve; the harness runs `node test.js` with `cwd` = this dir, so `process.cwd()` resolution should be correct — verify `loadProviderModules` uses `process.cwd()`.

- [ ] **Step 7: Commit**

```bash
git add tests/agency-js/provider-module
git commit -m "test(agency-js): end-to-end provider-module registration via agency.json"
```

---

### Task 7: `agency pack` smoke test

Guards against a future esbuild that hard-errors on the runtime-computed dynamic import, and confirms packing a program configured with `providerModules` succeeds.

**Files:**
- Modify: `lib/cli/pack.test.ts` (add one `it(...)` inside the existing `describe("agency pack", ...)`)

- [ ] **Step 1: Add the test**

Append inside the `describe("agency pack", ...)` block in `lib/cli/pack.test.ts`:
```ts
  it("packs a program configured with providerModules", async () => {
    const src = path.join(workDir, "withprov.agency");
    fs.writeFileSync(src, 'node main() { print("ok") }\n');
    const out = path.join(workDir, "withprov.js");
    await pack({
      config: { ...loadConfig(), client: { providerModules: ["./llama-setup.mjs"] } },
      inputFile: src,
      outputFile: out,
      target: "node",
    });
    expect(fs.existsSync(out)).toBe(true);
    const text = fs.readFileSync(out, "utf-8");
    // The runtime-computed dynamic import must survive bundling (esbuild
    // cannot statically resolve it, so it leaves it as a real import()).
    expect(text).toMatch(/import\(/);
  }, 60000);
```

- [ ] **Step 2: Run the test**

Run: `pnpm test:run lib/cli/pack.test.ts 2>&1 | tee /tmp/t7.txt`
Expected: PASS, including the existing pack tests and the new one.

Troubleshooting: if `pack` throws on `config`, check `pack`'s expected `config` shape in `lib/cli/pack.ts` and pass it the same way the existing tests do (they pass `config: loadConfig()`); spreading `client.providerModules` on top is the only change.

- [ ] **Step 3: Commit**

```bash
git add lib/cli/pack.test.ts
git commit -m "test(pack): smoke test packing with providerModules configured"
```

---

### Task 8: Documentation

**Files:**
- Create: `docs/site/guide/custom-providers.md`
- Modify: the guide navigation/sidebar (find where other `docs/site/guide/*.md` pages are listed — typically a VitePress config under `docs/site/.vitepress/` or a sidebar data file — and add a "Custom & local model providers" entry)

- [ ] **Step 1: Write the guide page**

Create `docs/site/guide/custom-providers.md`:
```markdown
# Custom & local model providers

Agency selects models through smoltalk, which ships providers for OpenAI,
Anthropic, Google, and Ollama. To use a **custom or local** provider — for
example a local model via [`smoltalk-llama-cpp`](https://github.com/egonSchiele/smoltalk/tree/main/packages/smoltalk-llama-cpp) —
you register it with a small **provider module** that Agency loads at startup.

Agency never depends on the provider package itself: you install it, and you
write the few lines that register it.

## 1. Install the provider package

```bash
npm install -g smoltalk-llama-cpp   # brings in node-llama-cpp
```

## 2. Write a provider module

A provider module is an ES module that exports `register`. It receives
Agency's `registerProvider` — do **not** import `registerProvider` from
`smoltalk` yourself; using the injected one guarantees the provider is
registered into the smoltalk instance Agency actually uses.

```js
// llama-setup.mjs
import { LlamaCPP } from "smoltalk-llama-cpp";

export function register({ registerProvider }) {
  registerProvider("llama-cpp", LlamaCPP);
}
```

## 3. Tell Agency to load it

Either in `agency.json` (relative paths resolve against the directory you run
Agency from):

```json
{
  "client": {
    "providerModules": ["./llama-setup.mjs"]
  }
}
```

…or via an environment variable (comma-separated, good for machine-specific
absolute paths):

```bash
export AGENCY_PROVIDER_MODULES="/abs/path/to/llama-setup.mjs"
```

Both sources are merged. A module that fails to load, lacks a `register`
export, or throws during `register` is a fatal startup error — Agency will not
silently fall back.

## 4. Use the provider

Select it like any other provider — by flag (agent), with `setModel` /
`setLlmOptions`, or per call. `smoltalk-llama-cpp` takes the `.gguf` path as
the model and the model directory via `metadata`:

```
import { setLlmOptions } from "std::llm"

node main() {
  setLlmOptions({ provider: "llama-cpp", model: "my-model.gguf" })
  return llm("Hello!", { metadata: { llamaCppModelDir: "./models" } })
}
```

For the Agency agent, the existing model flags work once the provider is
registered:

```bash
agency agent --provider llama-cpp --model my-model.gguf
```

## How it works

Agency loads provider modules once per process, before any `llm()` call, in
the same bootstrap that initializes globals — so a registered provider is
available everywhere, including forks, `agency serve`, and `agency pack`
artifacts. The provider package is loaded at runtime from your install; it is
never bundled into a packed artifact.
```

- [ ] **Step 2: Add it to the guide navigation**

Find the sidebar/nav config that lists the other guide pages (grep for an existing page slug, e.g. `error-handling`, under `docs/site/`):
```bash
grep -rn "error-handling" docs/site/.vitepress 2>/dev/null || grep -rln "guide/error-handling" docs/site
```
Add a `custom-providers` entry next to the other guide links, mirroring the existing entry format exactly.

- [ ] **Step 3: Commit**

```bash
git add docs/site/guide/custom-providers.md docs/site
git commit -m "docs: guide for custom and local model providers"
```

---

## Final verification

- [ ] **Run the full unit suite once and the new agency-js test**

Run:
```bash
pnpm build 2>&1 | tee /tmp/final-build.txt
pnpm test:run 2>&1 | tee /tmp/final-unit.txt
pnpm run agency test js tests/agency-js/provider-module 2>&1 | tee /tmp/final-js.txt
pnpm run lint:structure 2>&1 | tee /tmp/final-lint.txt
```
Expected: build clean; unit suite green; the agency-js test passes; lint clean. (Do not run the full agency test suite locally — CI runs it.)

- [ ] **Open the PR** (only when the user asks). Write the PR body to a file (apostrophes on the CLI error out) and end it with the Generated-with-Claude-Code line.

---

## Self-Review

**Spec coverage:**
- Provider-module contract w/ injected `registerProvider` → Tasks 4, 6 (`echo-setup.mjs`), 8.
- Trigger via `agency.json` `client.providerModules` → Tasks 1, 3, 6.
- Trigger via `AGENCY_PROVIDER_MODULES` env var → Tasks 4 (unit), 8 (docs).
- Merge + de-dupe + cwd-relative resolution → Task 4.
- The one sanctioned `import()` behind a single helper w/ lint exception → Task 4 (+ Step 5 lint check).
- Load before any user code, in run **and** resume bootstraps → Task 5.
- Process-level loaded-`Set` (load-bearing for `serve`) → Task 4 (impl + dedupe test).
- Fail-loud on all three error modes → Task 4 (3 error tests).
- `serve` compatibility → covered by hooking the shared `initFreshExecCtx` (used by `runExportedFunction`).
- `pack` compatibility → Task 7.
- Model-config passthrough (gguf dir) already works → documented in Task 8, no code task (per spec scope).
- Tests: unit + agency-js e2e + codegen + pack smoke → Tasks 4, 6, 3, 7.

**Placeholder scan:** none — every code step shows full code. The three "Note:" callouts ask the engineer to confirm an exact existing symbol name (exported schema name, array IR helper, resume-path var name) against the current source rather than trusting a possibly-stale line number; each gives the concrete fallback (grep target). This is verification, not a missing detail.

**Type/name consistency:** `providerModules` (field, config key, ctor arg, baked arg) and `loadProviderModules` / `__resetLoadedProviderModules` are spelled identically across Tasks 1–6. Provider name `"echo"` and class `EchoClient` are consistent between `echo-setup.mjs` and `fixture.json` (`EchoClient`). The unit-test fixtures use distinct names (`echo-a`, `count-a`, `EchoA`, `CountA`) and are unregistered in `afterEach`.
