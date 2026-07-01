# Model Data: Refresh-to-stdout + opt-in `loadModelData` — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax. (Per project preference, do NOT use subagent-driven development — implement directly in the main session.)

**Goal:** Make `agency models refresh` print the fetched model-data JSON to stdout, and add an opt-in `std::llm.loadModelData(path)` that loads a model-data file and registers it (accumulating over prior loads and the baked catalog).

**Architecture:** Two TS natives in `lib/stdlib/llm.ts` — `_fetchModelData` (fetch → serialized blob, no side effects) and `_loadModelData` (read file → merge over `getRegisteredModelData()` → `registerModelData`). A thin `std::llm.loadModelData` Agency wrapper turns the native's status into a `Result`. The CLI `models refresh` prints the blob to stdout. Nothing auto-loads at bootstrap — loading is entirely opt-in.

**Tech Stack:** TypeScript native shims (`lib/stdlib/*.ts`, vitest), smoltalk 0.7.0 (`refreshModels` / `registerModelData` / `getRegisteredModelData` / `clearModelData` / `mergeModelData` / `mergeHostedTools`), Agency (`.agency` → TS), commander CLI (`scripts/agency.ts`), agency-js test harness.

## Global Constraints

- **Design spec:** `docs/superpowers/specs/2026-07-01-model-data-refresh-and-load-design.md`. Every task implicitly includes it.
- **smoltalk is already at `^0.7.0`** (installed via the merged Phase 2). Relevant exports, all verified in `node_modules/smoltalk/dist`: `refreshModels(opts?): Promise<Result<ModelDataBlob>>`, `registerModelData(blob)` — **pure replace** (`registeredModelData = blob`), `getRegisteredModelData(): ModelDataBlob | null`, `clearModelData(): void`, `mergeModelData(base, overlay)` — overlay wins on the `provider:modelName` key and **deep-merges** fields, `mergeHostedTools(base, overlay)`. `ModelDataBlob = { schemaVersion, generatedAt, models: ModelType[], hostedTools: HostedTool[] }`.
- **`registerModelData` replaces smoltalk's single registered slot** — the accumulate design pre-merges (`mergeModelData(prior, blob)`) and registers the whole result. `getAllModels`/`getModel` then layer the registered blob over the baked catalog (registered wins).
- Agency rules: use `null` not `undefined`; `success(...)`/`failure(...)`/`is success(v)`/`isFailure(...)` are auto-imported (no import needed — see `stdlib/llm.agency` `pickProvider`). Record index + optional fields compare with `== null`.
- **Do NOT whole-file `fmt` `stdlib/llm.agency`** — it is already fmt-dirty on main (`pickProvider`/`setModel` reformat even untouched). Keep only the new additions clean and consistent with the surrounding style; leave pre-existing lines alone.
- Build with `make` before running the built CLI or any agency/agency-js test from `dist`. TS unit tests: `pnpm exec vitest run <file>`. Agency-js test: `node ./dist/scripts/agency.js test js <dir>`.
- Do NOT commit unless the user asks.

---

## File Structure

- `lib/stdlib/llm.ts` — **modify.** Add `fs` import; extend the smoltalk import with `getRegisteredModelData`/`mergeModelData`/`mergeHostedTools`; add `_loadModelData` (Task 1); replace `_refreshHostedCatalog` with `_fetchModelData` (Task 3).
- `lib/stdlib/modelData.load.test.ts` — **new.** Real-smoltalk unit tests for `_loadModelData` (Task 1).
- `stdlib/llm.agency` — **modify.** Import `_loadModelData`; add the `loadModelData` wrapper (Task 2).
- `tests/agency-js/llm-load-model-data/` — **new** (`agent.agency` + `test.js` + `fixture.json`). End-to-end wrapper test (Task 2).
- `lib/cli/hostedModels.ts` — **modify.** Import `_fetchModelData`; rewrite `modelsRefresh` to print JSON (Task 3).
- `lib/cli/hostedModels.test.ts` — **modify.** Rewrite the mock + `agency models refresh` describe block (Task 3).
- `scripts/agency.ts` — **modify.** Update the `models refresh` subcommand description (Task 3).
- `docs/site/cli/models.md` — **new.** CLI docs for the `agency models` command (Task 4).

**Task order note:** `_loadModelData` (Task 1) is added *before* `_refreshHostedCatalog` is removed (Task 3). Both use smoltalk's `registerModelData`, so keeping `_loadModelData` in place first means the import is never left unused between tasks — every intermediate state builds cleanly.

---

## Task 1: `_loadModelData` native (read → merge → register)

**Files:**
- Modify: `lib/stdlib/llm.ts` (imports + new function)
- Create/Test: `lib/stdlib/modelData.load.test.ts`

**Interfaces — Produces (TS):**
- `function _loadModelData(path: string): { ok: boolean; count: number; error: string }` — reads a model-data JSON file, merges it over any currently-registered data (this file wins on `provider:modelName` collisions), calls `registerModelData`, and returns the count of models **in this file**. Never throws; failures come back as `{ ok: false, count: 0, error }`.

- [ ] **Step 1: Write the failing test** — create `lib/stdlib/modelData.load.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { clearModelData, getModel, getRegisteredModelData } from "smoltalk";
import { _loadModelData } from "./llm.js";

function tmpFile(name: string, contents: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agency-models-"));
  const p = path.join(dir, name);
  fs.writeFileSync(p, contents);
  return p;
}

const A = JSON.stringify({
  schemaVersion: 1,
  generatedAt: "t",
  models: [
    { type: "text", modelName: "custom-a", provider: "acme", inputTokenCost: 1, outputTokenCost: 2, maxInputTokens: 1000, family: "a" },
    { type: "text", modelName: "shared", provider: "acme", inputTokenCost: 5, outputTokenCost: 5, maxInputTokens: 2000, family: "a" },
  ],
  hostedTools: [{ name: "tool-a" }],
});
// B adds custom-b, and overrides acme:shared's input price to 9. Models-only (no hostedTools).
const B = JSON.stringify({
  schemaVersion: 1,
  generatedAt: "t",
  models: [
    { type: "text", modelName: "custom-b", provider: "acme", inputTokenCost: 2, outputTokenCost: 3, maxInputTokens: 3000, family: "b" },
    { type: "text", modelName: "shared", provider: "acme", inputTokenCost: 9, outputTokenCost: 5, maxInputTokens: 2000, family: "a" },
  ],
});

describe("_loadModelData", () => {
  beforeEach(() => clearModelData());

  it("registers a file's models (visible via getModel) and returns its count", () => {
    const res = _loadModelData(tmpFile("a.json", A));
    expect(res).toEqual({ ok: true, count: 2, error: "" });
    expect(getModel("custom-a" as any)?.provider).toBe("acme");
  });

  it("accumulates: later load layers over earlier, overlay wins on collision", () => {
    _loadModelData(tmpFile("a.json", A));
    const res = _loadModelData(tmpFile("b.json", B));
    expect(res.ok).toBe(true);
    expect(getModel("custom-a" as any)).toBeDefined();
    expect(getModel("custom-b" as any)).toBeDefined();
    expect((getModel("shared" as any) as any)?.inputTokenCost).toBe(9); // B wins
  });

  it("preserves prior hostedTools when a later file omits them", () => {
    _loadModelData(tmpFile("a.json", A)); // has hostedTools
    _loadModelData(tmpFile("b.json", B)); // models-only
    expect((getRegisteredModelData()?.hostedTools ?? []).some((t: any) => t.name === "tool-a")).toBe(true);
  });

  it("returns count = this file's models, not the running total", () => {
    _loadModelData(tmpFile("a.json", A));            // 2
    expect(_loadModelData(tmpFile("b.json", B)).count).toBe(2); // this file's 2, not 4
  });

  it("fails on missing file / invalid JSON / no models array, leaving prior registration intact", () => {
    _loadModelData(tmpFile("a.json", A));
    expect(_loadModelData("/no/such/file.json").ok).toBe(false);
    expect(_loadModelData(tmpFile("bad.json", "{not json")).ok).toBe(false);
    expect(_loadModelData(tmpFile("nomodels.json", "{}")).ok).toBe(false);
    expect(getModel("custom-a" as any)).toBeDefined();
  });

  it("fails on schemaVersion mismatch after a prior load", () => {
    _loadModelData(tmpFile("v1.json", A)); // schemaVersion 1
    const v2 = JSON.stringify({
      schemaVersion: 2,
      models: [{ type: "text", modelName: "z", provider: "acme", inputTokenCost: 0, outputTokenCost: 0, maxInputTokens: 1 }],
    });
    const res = _loadModelData(tmpFile("v2.json", v2));
    expect(res.ok).toBe(false);
    expect(res.error).toContain("schemaVersion");
    expect(getModel("custom-a" as any)).toBeDefined(); // v1 intact
  });
});
```

- [ ] **Step 2: Run test, verify it fails** — `pnpm exec vitest run lib/stdlib/modelData.load.test.ts`
Expected: FAIL — `_loadModelData` is not exported from `./llm.js`.

- [ ] **Step 3: Add the imports** — in `lib/stdlib/llm.ts`, add an `fs` import after the existing top imports (line 3, after the `loadProviderModuleByPath` import):

```ts
import * as fs from "node:fs";
```

and extend the smoltalk import (currently `getAllModels`, `getModel`, `refreshModels`, `registerModelData`) to:

```ts
import {
  getAllModels,
  getModel,
  refreshModels,
  registerModelData,
  getRegisteredModelData,
  mergeModelData,
  mergeHostedTools,
} from "smoltalk";
```

- [ ] **Step 4: Implement `_loadModelData`** — append to `lib/stdlib/llm.ts`:

```ts
/** Read a model-data JSON file (the shape `agency models refresh` prints) and
 *  register it, ACCUMULATING over any previously registered data (this file
 *  wins on provider+name collisions, deep-merging fields) and over the baked
 *  catalog. Errors are returned, never thrown, so the Agency wrapper can map
 *  them to a Result. Returns the number of models in THIS file. */
export function _loadModelData(
  path: string,
): { ok: boolean; count: number; error: string } {
  let text: string;
  try {
    text = fs.readFileSync(path, "utf-8");
  } catch (err) {
    return { ok: false, count: 0, error: `cannot read ${path}: ${(err as Error).message}` };
  }
  let blob: any;
  try {
    blob = JSON.parse(text);
  } catch (err) {
    return { ok: false, count: 0, error: `${path} is not valid JSON: ${(err as Error).message}` };
  }
  if (!blob || !Array.isArray(blob.models)) {
    return { ok: false, count: 0, error: `${path} is not model data (missing "models" array)` };
  }
  const prior = getRegisteredModelData();
  // Refuse to stitch models of a different schema version onto the prior blob —
  // a cross-version merge could mix incompatible field shapes. Fail loudly.
  if (prior && blob.schemaVersion != null && prior.schemaVersion != null && blob.schemaVersion !== prior.schemaVersion) {
    return {
      ok: false,
      count: 0,
      error: `${path} has schemaVersion ${blob.schemaVersion} but ${prior.schemaVersion} is already loaded; re-run "agency models refresh" to regenerate the file at the current schema version`,
    };
  }
  const merged = prior
    ? {
        schemaVersion: blob.schemaVersion ?? prior.schemaVersion,
        generatedAt: blob.generatedAt ?? prior.generatedAt,
        // Overlay (this file) wins on provider:modelName and deep-merges, so a
        // partial hand-edited entry augments the prior one.
        models: mergeModelData(prior.models, blob.models),
        // `?? []` on the overlay means "no new tools" (base preserved), NOT
        // "clear" — mergeHostedTools merges overlay into base, so prior tools
        // survive a models-only file. Do not change to pass undefined.
        hostedTools: mergeHostedTools(prior.hostedTools ?? [], blob.hostedTools ?? []),
      }
    : blob;
  // registerModelData REPLACES smoltalk's single registered slot, so `merged`
  // must carry everything (hence the pre-merge). No double-apply.
  registerModelData(merged);
  return { ok: true, count: blob.models.length, error: "" };
}
```

- [ ] **Step 5: Run test, verify it passes** — `pnpm exec vitest run lib/stdlib/modelData.load.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 6: Typecheck** — `npx tsc --noEmit -p tsconfig.json`
Expected: exit 0, no errors.

- [ ] **Step 7: Commit** *(only if asked)*
```bash
git add lib/stdlib/llm.ts lib/stdlib/modelData.load.test.ts
git commit -m "feat(stdlib): _loadModelData native (accumulate model data over smoltalk catalog)"
```

---

## Task 2: `std::llm.loadModelData` Agency wrapper + agency-js test

**Files:**
- Modify: `stdlib/llm.agency` (native import + wrapper)
- Create: `tests/agency-js/llm-load-model-data/agent.agency`, `.../test.js`, `.../fixture.json`

**Interfaces — Consumes:** `_loadModelData` (Task 1). **Produces (Agency):**
- `def loadModelData(path: string): Result<number, string>` — `success(count)` on load, `failure(reason)` otherwise.

- [ ] **Step 1: Write the failing agency-js test** — create the three files under `tests/agency-js/llm-load-model-data/`.

> **Note:** `env(name)` returns `string | null`, and `loadModelData(path: string)` requires a non-null `string` — passing `env(...)` directly is a hard type error (verified). The program narrows with `if (p != null)` before calling, mirroring `pickProvider` in `stdlib/llm.agency`. The test loads TWO files and checks both custom models are visible, so accumulation is proven end-to-end through the Agency layer (not just the TS native).

`agent.agency`:
```agency
import { loadModelData, hostedModelInfo } from "std::llm"
import { env } from "std::system"

// test.js writes two model-data files to temp paths and passes them via
// MODELS_FIXTURE_A / MODELS_FIXTURE_B. Asserts: each load succeeds with a
// count, BOTH custom models are visible after loading both (accumulation
// survives the Agency layer), and a bad path fails.
node main(): any {
  let countA = -1
  const pa = env("MODELS_FIXTURE_A")
  if (pa != null) {
    const ra = loadModelData(pa)
    if (ra is success(n)) {
      countA = n
    }
  }
  let countB = -1
  const pb = env("MODELS_FIXTURE_B")
  if (pb != null) {
    const rb = loadModelData(pb)
    if (rb is success(n)) {
      countB = n
    }
  }
  let seenA = "no"
  const ia = hostedModelInfo("custom-load-a")
  if (ia != null) {
    seenA = ia.provider
  }
  let seenB = "no"
  const ib = hostedModelInfo("custom-load-b")
  if (ib != null) {
    seenB = ib.provider
  }
  const bad = loadModelData("/no/such/models-file.json")
  return {
    countA: countA,
    countB: countB,
    seenA: seenA,
    seenB: seenB,
    badFailed: isFailure(bad)
  }
}
```

`test.js`:
```js
import { main } from "./agent.js";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Write each model-data file to a temp path (not the test dir) and hand the
// absolute path to the agency program via env — no cwd assumptions.
function writeModelFile(suffix, modelName) {
  const p = join(tmpdir(), `agency-models-load-${process.pid}-${suffix}.json`);
  writeFileSync(
    p,
    JSON.stringify({
      schemaVersion: 1,
      generatedAt: "test",
      models: [
        { type: "text", modelName, provider: "acme", inputTokenCost: 1, outputTokenCost: 2, maxInputTokens: 4096, family: "acme" },
      ],
      hostedTools: [],
    }),
  );
  return p;
}
process.env.MODELS_FIXTURE_A = writeModelFile("a", "custom-load-a");
process.env.MODELS_FIXTURE_B = writeModelFile("b", "custom-load-b");

const result = await main({});
writeFileSync(
  new URL("./__result.json", import.meta.url),
  JSON.stringify(result.data, null, 2),
);
```

`fixture.json`:
```json
{
  "countA": 1,
  "countB": 1,
  "seenA": "acme",
  "seenB": "acme",
  "badFailed": true
}
```

- [ ] **Step 2: Add the wrapper** — in `stdlib/llm.agency`, extend the native import (currently `_setLlmOptions`, `_registerProviderModule`, `_listHostedModels`, `_hostedModelInfo`) with `_loadModelData`:

```agency
import {
  _setLlmOptions,
  _registerProviderModule,
  _listHostedModels,
  _hostedModelInfo,
  _loadModelData,
} from "agency-lang/stdlib-lib/llm.js"
```

Then add at the end of the file (after `hostedModelInfo`):

```agency
export def loadModelData(path: string): Result<number, string> {
  """
  Load additional model data from a JSON file (the shape printed by
  `agency models refresh`) and register it for this program. Both the file's
  `models` and its optional `hostedTools` are layered over any previously
  loaded data and over the built-in catalog, with this file winning on
  provider+name collisions; unlisted fields on an existing entry are preserved.
  Affects llm() model resolution and cost accounting as well as
  listHostedModels() / hostedModelInfo().

  Returns the number of models in THIS file (not the running total registered),
  or a failure describing why the file could not be loaded.

  @param path - Path to a model-data JSON file (relative to the working
    directory, or absolute)
  """
  const res = _loadModelData(path)
  if (res.ok) {
    return success(res.count)
  }
  return failure(res.error)
}
```

- [ ] **Step 3: parse + typecheck the touched Agency file FIRST** (faster than a full `make` for catching type errors like the `env` narrowing above) — 
```bash
node ./dist/scripts/agency.js parse stdlib/llm.agency && node ./dist/scripts/agency.js typecheck stdlib/llm.agency
```
Expected: parses; `No type errors found`. (Do NOT whole-file `fmt` — see Global Constraints; just confirm the new lines match the surrounding indentation.) The test's `agent.agency` is typechecked as part of the `make`/run in the next steps.

- [ ] **Step 4: Build + run, verify it PASSES** — `make && node ./dist/scripts/agency.js test js tests/agency-js/llm-load-model-data`
Expected: PASS (`__result.json` matches `fixture.json`). `make` also regenerates `docs/site/stdlib/llm.md` from the new `loadModelData` docstring — include that regenerated file in this task's commit (the Task 4 CLI doc links to it).

> If you want to see the red state first: before Step 2, run `make && node ./dist/scripts/agency.js test js tests/agency-js/llm-load-model-data` — it FAILS because `loadModelData` isn't exported from `std::llm` yet.

- [ ] **Step 5: Commit** *(only if asked)*
```bash
git add stdlib/llm.agency tests/agency-js/llm-load-model-data docs/site/stdlib/llm.md
git commit -m "feat(stdlib): std::llm.loadModelData opt-in model-data loader"
```

---

## Task 3: `agency models refresh` prints JSON to stdout

**Files:**
- Modify: `lib/stdlib/llm.ts` (replace `_refreshHostedCatalog` with `_fetchModelData`)
- Modify: `lib/cli/hostedModels.ts` (import + `modelsRefresh`)
- Modify: `lib/cli/hostedModels.test.ts` (mock + refresh describe)
- Modify: `scripts/agency.ts` (subcommand description)

**Interfaces — Produces (TS):**
- `function _fetchModelData(url: string): Promise<{ ok: boolean; json: string; error: string }>` — fetches the latest model-data blob and returns it pre-serialized (`JSON.stringify(blob, null, 2)`). No registration.
- `async function modelsRefresh(url?: string): Promise<void>` — prints `json` to stdout on success; error to stderr + `process.exitCode = 1` on failure.

- [ ] **Step 1: Rewrite the failing CLI test** — replace the mock and the `agency models refresh` describe block in `lib/cli/hostedModels.test.ts`.

Change the mock at the top from `_refreshHostedCatalog: vi.fn()` to `_fetchModelData: vi.fn()`:
```ts
vi.mock("../stdlib/llm.js", () => ({
  _listHostedModels: () => [],
  _fetchModelData: vi.fn(),
}));
```
Change the import `import { _refreshHostedCatalog } from "../stdlib/llm.js";` to:
```ts
import { _fetchModelData } from "../stdlib/llm.js";
```
Also add `beforeEach`, `afterEach` to the vitest import at the top of the file (currently `import { describe, it, expect, vi } from "vitest";`):
```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
```
Replace the entire `describe("agency models refresh", …)` block with:
```ts
describe("agency models refresh", () => {
  beforeEach(() => {
    process.exitCode = 0;
    vi.mocked(_fetchModelData).mockReset();
  });
  // The failure test sets exitCode = 1; clear it so it doesn't fail the run.
  afterEach(() => {
    process.exitCode = 0;
  });

  it("prints the fetched JSON to stdout and nothing to stderr on success", async () => {
    const blob = { schemaVersion: 1, models: [{ modelName: "x" }] };
    vi.mocked(_fetchModelData).mockResolvedValue({ ok: true, json: JSON.stringify(blob, null, 2), error: "" });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await modelsRefresh();
    expect(log).toHaveBeenCalledTimes(1);
    expect(JSON.parse(log.mock.calls[0][0] as string)).toHaveProperty("models");
    expect(err).not.toHaveBeenCalled();
    log.mockRestore();
    err.mockRestore();
  });
  it("reports the error on stderr, exits non-zero, and prints nothing to stdout on failure", async () => {
    vi.mocked(_fetchModelData).mockResolvedValue({ ok: false, json: "", error: "network down" });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await modelsRefresh();
    expect(err).toHaveBeenCalledWith(expect.stringContaining("network down"));
    expect(process.exitCode).toBe(1);
    expect(log).not.toHaveBeenCalled();
    log.mockRestore();
    err.mockRestore();
  });
});
```

- [ ] **Step 2: Run test, verify it fails** — `pnpm exec vitest run lib/cli/hostedModels.test.ts`
Expected: FAIL — `_fetchModelData` is not exported (and `modelsRefresh` still prints a count).

- [ ] **Step 3: Replace `_refreshHostedCatalog` with `_fetchModelData`** — in `lib/stdlib/llm.ts`, replace the whole `_refreshHostedCatalog` function with:

```ts
/** Fetch the latest model-data blob and return it pre-serialized. No
 *  registration — the CLI prints this to stdout for the user to save and later
 *  load with `std::llm.loadModelData`. */
export async function _fetchModelData(
  url: string,
): Promise<{ ok: boolean; json: string; error: string }> {
  const res = await refreshModels(url ? { url } : {});
  if (res.success) {
    return { ok: true, json: JSON.stringify(res.value, null, 2), error: "" };
  }
  return { ok: false, json: "", error: res.error };
}
```

- [ ] **Step 4: Update the CLI** — in `lib/cli/hostedModels.ts`, change the import (line 3) from `_refreshHostedCatalog` to `_fetchModelData`:
```ts
import {
  _listHostedModels,
  _fetchModelData,
  type HostedModelInfo,
} from "../stdlib/llm.js";
```
and replace `modelsRefresh`:
```ts
export async function modelsRefresh(url?: string): Promise<void> {
  const res = await _fetchModelData(url ?? "");
  if (res.ok) {
    console.log(res.json); // stdout only — clean JSON for redirection
  } else {
    console.error(`Refresh failed: ${res.error}`);
    process.exitCode = 1;
  }
}
```

- [ ] **Step 5: Run test, verify it passes** — `pnpm exec vitest run lib/cli/hostedModels.test.ts`
Expected: PASS (selection + format + both refresh tests).

- [ ] **Step 6: Update the subcommand description** — in `scripts/agency.ts`, change the `models refresh` description line (currently `"Refresh the hosted model catalog from the remote source"`) to:
```ts
  modelsCmd.command("refresh").description("Fetch the latest model data and print it as JSON (redirect to a file, then load with std::llm loadModelData)")
    .argument("[url]", "Optional URL to fetch model data from (defaults to the built-in source)").action((url?: string) => modelsRefresh(url));
```

- [ ] **Step 7: Typecheck + build + smoke** — 
```bash
npx tsc --noEmit -p tsconfig.json && make
node ./dist/scripts/agency.js models refresh > /tmp/mr.json 2>/dev/null && [ -s /tmp/mr.json ] && head -3 /tmp/mr.json && node -e "JSON.parse(require('fs').readFileSync('/tmp/mr.json','utf8')); console.log('valid JSON')" || echo "refresh failed or offline — rely on the unit test"
```
Expected: tsc/build clean; the smoke writes JSON to `/tmp/mr.json`, prints its first lines and `valid JSON`. The `-s` check + `JSON.parse` mean an empty/failed fetch does NOT silently look like success (it prints the offline message instead). Network-dependent; the unit test is the authoritative check.

- [ ] **Step 8: Commit** *(only if asked)*
```bash
git add lib/stdlib/llm.ts lib/cli/hostedModels.ts lib/cli/hostedModels.test.ts scripts/agency.ts
git commit -m "feat(cli): agency models refresh prints model-data JSON to stdout"
```

---

## Task 4: CLI docs — `docs/site/cli/models.md`

**Files:**
- Create: `docs/site/cli/models.md`

The `agency models` command shipped in Phase 2 with no doc page (only `docs/site/cli/local.md` exists). Add one covering `list` (with filters) and the new `refresh` → save → `loadModelData` workflow.

- [ ] **Step 1: Write the doc** — create `docs/site/cli/models.md`:

````markdown
# `agency models`

Browse the hosted model catalog and fetch fresh model data.

## `agency models list`

List hosted text models from the built-in catalog (plus anything loaded this
process). Filterable:

```bash
agency models list                       # all models
agency models list --provider openai     # one provider
agency models list --max-price 1         # input cost <= $1 / 1M tokens
agency models list --min-context 200000  # context window >= 200k tokens
```

Columns: name, provider, open-weights, input $/1M, output $/1M, context window.

## `agency models refresh`

Fetch the latest model data and **print it as JSON to stdout**. It does not
save or register anything — redirect it to a file you control:

```bash
agency models refresh > my-models.json
# optionally override the source URL:
agency models refresh https://example.com/model-data.json > my-models.json
```

Errors go to stderr with a non-zero exit code, so a failed fetch is detectable
in a pipeline (and leaves stdout empty).

## Using a saved file

Load a saved model-data file in an Agency program with
[`std::llm.loadModelData`](../stdlib/llm.md):

```agency
import { loadModelData } from "std::llm"

node main() {
  const r = loadModelData("my-models.json")
  // r is success(count) or failure(reason)
}
```

`loadModelData` **accumulates**: multiple calls layer over each other and over
the built-in catalog, with the most recently loaded file winning on
provider+name collisions. Loaded data affects `llm()` model resolution and cost
accounting as well as `listHostedModels()` / `hostedModelInfo()`.
````

- [ ] **Step 2: Register the page in the VitePress sidebar** — in `docs/site/.vitepress/config.mts`, add a `models` entry to the `"/cli/"` sidebar `items` array, alphabetically between `lsp / mcp` and `optimize`:
```ts
            { text: "lsp / mcp", link: "/cli/editor-integration" },
            { text: "models", link: "/cli/models" },
            { text: "optimize", link: "/cli/optimize" },
```
(Without this the page ships unreachable. Note: `cli/local` is also absent from this sidebar — a pre-existing gap left out of scope here; we only add `models`.)

- [ ] **Step 3: Verify the cross-link target exists** — `models.md` links `../stdlib/llm.md`. Confirm it's present and carries the new function:
```bash
grep -q "loadModelData" docs/site/stdlib/llm.md && echo "stdlib/llm.md has loadModelData (regenerated by make in Task 2)"
```
Expected: prints the confirmation. (If missing, re-run `make` — it regenerates `docs/site/stdlib/llm.md` from the `loadModelData` docstring.)

- [ ] **Step 4: Commit** *(only if asked)*
```bash
git add docs/site/cli/models.md docs/site/.vitepress/config.mts
git commit -m "docs(cli): document agency models list + refresh + loadModelData"
```

---

## Self-Review

**Spec coverage:**
- `agency models refresh` prints JSON to stdout, stderr+exit-1 on failure → Task 3 (`_fetchModelData` + `modelsRefresh`). ✓
- `loadModelData(path): Result<number, string>`, accumulate, affects all catalog reads → Task 1 (`_loadModelData`) + Task 2 (wrapper). ✓
- Precedence latest-load > earlier > baked; overlay-wins deep-merge → Task 1 (`mergeModelData(prior, blob)`) + Global Constraints. ✓
- schemaVersion mismatch → failure → Task 1 (guard + test). ✓
- hostedTools merged/preserved → Task 1 (`mergeHostedTools` + test). ✓
- count = this file's models → Task 1 (`blob.models.length` + explicit test + docstring). ✓
- Errors returned not thrown, mapped to Result → Task 1 (status object) + Task 2 (`success`/`failure`). ✓
- Tests: stderr-clean-on-success (Task 3), hostedTools accumulation + schema mismatch (Task 1), Agency wrapper end-to-end (Task 2). ✓
- Migration: remove `_refreshHostedCatalog` (Task 3 removes it and its "does not persist" note); CLI docs `models.md` + VitePress sidebar entry so it's reachable (Task 4); stdlib doc regen for `loadModelData` — `make` in Task 2 Step 4 regenerates `docs/site/stdlib/llm.md` and that file is committed in Task 2 (so Task 4's `../stdlib/llm.md` cross-link resolves). ✓

**Placeholder scan:** none — every step has concrete code or an exact command.

**Type consistency:** `_loadModelData` returns `{ ok, count, error }` (Task 1), consumed by `loadModelData` (Task 2) as `res.ok`/`res.count`/`res.error`. `_fetchModelData` returns `{ ok, json, error }` (Task 3), consumed by `modelsRefresh` as `res.ok`/`res.json`/`res.error`, and mocked with the same shape in the test. `loadModelData` returns `Result<number, string>` (spec + wrapper). smoltalk helper names (`getRegisteredModelData`/`mergeModelData`/`mergeHostedTools`/`clearModelData`) match the verified 0.7.0 exports.

**Ordering:** `_loadModelData` (Task 1) is added before `_refreshHostedCatalog` is removed (Task 3), so smoltalk's `registerModelData` import is always in use — no unused-import break between tasks.
