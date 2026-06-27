# Local-model SHA-256 verification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After a local model is downloaded, hash the file and verify it against a known-good SHA-256 pinned in the catalog, quarantining a mismatch before it can be loaded.

**Architecture:** Add an optional `sha256` to the model metadata types (curated + catalog + alias). In `_downloadModel`, detect a *fresh* download (cache-dir snapshot before/after `resolveModel`) and, when a pin exists for that name, stream-hash the file and compare; on mismatch rename it to `<file>.gguf.invalidSha` and throw. Pins are minted by a maintainer-run script from Hugging Face's `X-Linked-ETag` (= the file's content sha256), with no multi-GB downloads.

**Tech Stack:** TypeScript (`lib/stdlib/localModels.ts`), `node:crypto` (streaming sha256), zod (catalog schema), vitest. Generation script uses global `fetch`.

## Global Constraints

- NEVER use dynamic imports in `lib/` source. `fetch`/`crypto`/`fs` are used directly.
- Use objects instead of maps; arrays instead of sets *except* where a `Set` is the natural fit (filename membership); `type` instead of `interface`.
- Pin source: Hugging Face `X-Linked-ETag` header (= content sha256). NEVER use the `etag` / `X-Xet-Hash` header (a different chunk hash).
- Verify the **actual downloaded bytes**, never a header, at verify time.
- Verify **once, on fresh download** — never re-hash an already-present file (no marker file).
- On mismatch: **rename** `<file>` → `<file>.invalidSha` (keep for inspection), then throw. Never delete.
- **Opportunistic**: verify only when a pin exists; otherwise skip silently.
- v1: **single-file models only**; sharded models carry no pin and are skipped (issue #348).
- Pin in BOTH `CURATED_LOCAL_MODELS` and `data/model-catalog.json`.
- Own-property checks (`Object.hasOwn`), never `in` / bare index, when testing membership of a JSON-derived map keyed by model name.
- Run `make build` after changing `lib/` TS. Save test output to a file when running suites. Do not run the full agency suite.
- The 2 pre-existing `resolveSmoltalkLlamaCppFromRoots` test failures are environmental (they fail on `main` too) — ignore them.

---

### Task 1: Thread `sha256` through the metadata types

Add an optional `sha256` everywhere a model's metadata travels, so a pin can be stored (curated + catalog) and flows through refresh into a remote alias.

**Files:**
- Modify: `packages/agency-lang/lib/stdlib/localModels.ts` (`ModelInfo`, `AliasObject`, `ModelNameEntry`, `EntryMeta`, `metaFrom`, `CatalogModel`, `CatalogModelSchema`, `parseCatalog` reassembly)
- Test: `packages/agency-lang/lib/stdlib/localModels.test.ts`

**Interfaces:**
- Consumes: existing `parseCatalog`, `_listModelNames`, `_refreshCatalog`.
- Produces: `sha256?: string` on `ModelInfo`, `AliasObject`, `CatalogModel`, `ModelNameEntry`; `parseCatalog` carries it; `_listModelNames` surfaces it; `_refreshCatalog` writes it into remote aliases (already flows via `{ ...model, source: "remote" }`).

- [ ] **Step 1: Write the failing tests**

Add to `localModels.test.ts` (the `parseCatalog` and `_refreshCatalog` describes already exist; add these cases inside them or as new `it`s near them):

```ts
it("parseCatalog keeps a valid sha256 and drops a non-string one", () => {
  const out = parseCatalog(
    JSON.stringify({
      version: 1,
      models: {
        good: { uri: "hf:org/g:Q4_K_M", sha256: "abc123" },
        bad: { uri: "hf:org/b:Q4_K_M", sha256: 123 },
      },
    }),
  );
  expect(out.good.sha256).toBe("abc123");
  expect(out.bad.sha256).toBeUndefined(); // wrong type dropped, entry kept
});

it("_refreshCatalog writes the catalog sha256 into the remote alias", async () => {
  fs.writeFileSync(aliasFile, "{}");
  await _refreshCatalog({
    file: aliasFile,
    fetcher: async () =>
      JSON.stringify({ version: 1, models: { m: { uri: "hf:org/m:Q4_K_M", sha256: "deadbeef" } } }),
  });
  const cfg = JSON.parse(fs.readFileSync(aliasFile, "utf8"));
  expect(cfg.client.modelAliases.m.sha256).toBe("deadbeef");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run lib/stdlib/localModels.test.ts -t "sha256|writes the catalog sha256" 2>&1 | tee /tmp/v1.log`
Expected: FAIL — `out.good.sha256` is undefined (schema strips it); the alias has no `sha256`.

- [ ] **Step 3: Add `sha256` to the four types**

In `ModelInfo` (after `license`):

```ts
  license: string;
  /** Pinned content SHA-256 (hex) of the resolved single-file GGUF, used to
   *  verify the download. Absent for sharded models (see issue #348). */
  sha256?: string;
```

In `AliasObject` (after `description`):

```ts
  description?: string;
  sha256?: string;
```

In `ModelNameEntry` (after `license`):

```ts
  license?: string;
  sha256?: string;
```

In `CatalogModel` (after `description`):

```ts
  description?: string;
  sha256?: string;
```

- [ ] **Step 4: Add `sha256` to `EntryMeta`, `metaFrom`, the zod schema, and the `parseCatalog` reassembly**

`EntryMeta` (add `"sha256"` to the `Pick`):

```ts
type EntryMeta = Pick<
  ModelNameEntry,
  "params" | "sizeBytes" | "category" | "description" | "contextWindow" | "license" | "sha256"
>;
```

In `metaFrom`, after the `license` copy:

```ts
  if (src.license !== undefined) out.license = src.license;
  if (src.sha256 !== undefined) out.sha256 = src.sha256;
  return out;
```

In `CatalogModelSchema`, after the `description` line:

```ts
  description: z.string().optional().catch(undefined),
  sha256: z.string().optional().catch(undefined),
});
```

In `parseCatalog`'s `compact({...})` reassembly, after `description: d.description,`:

```ts
        description: d.description,
        sha256: d.sha256,
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run lib/stdlib/localModels.test.ts -t "sha256|writes the catalog sha256" 2>&1 | tee /tmp/v1.log`
Expected: PASS.

- [ ] **Step 6: Typecheck + commit**

```bash
npx tsc --noEmit 2>&1 | grep -i localModels || echo "tsc clean"
git add packages/agency-lang/lib/stdlib/localModels.ts packages/agency-lang/lib/stdlib/localModels.test.ts
git commit -m "Thread optional sha256 through model metadata types"
```

---

### Task 2: Verification primitives

Pure, independently-testable helpers: stream-hash a file, verify against an expected hash (quarantine on mismatch), and look up a pin by model name.

**Files:**
- Modify: `packages/agency-lang/lib/stdlib/localModels.ts` (add `import { createHash }`; add `fileSha256`, `verifyModelFile`, `pinnedSha256`, `listGgufBasenames`)
- Test: `packages/agency-lang/lib/stdlib/localModels.test.ts`

**Interfaces:**
- Consumes: `isGgufPath`, `isModelUri`, `readModelAliases`, `CURATED_LOCAL_MODELS`, `fs`.
- Produces:
  - `function fileSha256(filePath: string): Promise<string>` (hex)
  - `function verifyModelFile(filePath: string, expected: string, name: string): Promise<void>` (resolves on match; on mismatch renames to `<filePath>.invalidSha` and throws)
  - `function pinnedSha256(value: string, file?: string): string | undefined`
  - `function listGgufBasenames(dir: string): Set<string>`

- [ ] **Step 1: Write the failing tests**

Add a new `describe` to `localModels.test.ts` (add `import { createHash } from "node:crypto";` at the top of the file):

```ts
describe("model file verification", () => {
  it("fileSha256 matches node:crypto over the same bytes", async () => {
    const p = path.join(dir, "m.gguf");
    fs.writeFileSync(p, "hello-bytes");
    const expected = createHash("sha256").update("hello-bytes").digest("hex");
    expect(await fileSha256(p)).toBe(expected);
  });

  it("verifyModelFile resolves on a match", async () => {
    const p = path.join(dir, "m.gguf");
    fs.writeFileSync(p, "good");
    const sha = createHash("sha256").update("good").digest("hex");
    await expect(verifyModelFile(p, sha, "m")).resolves.toBeUndefined();
    expect(fs.existsSync(p)).toBe(true); // left in place
  });

  it("verifyModelFile quarantines + throws on a mismatch", async () => {
    const p = path.join(dir, "m.gguf");
    fs.writeFileSync(p, "tampered");
    await expect(verifyModelFile(p, "0".repeat(64), "m")).rejects.toThrow(/SHA-256 verification failed/);
    expect(fs.existsSync(p)).toBe(false); // moved aside
    expect(fs.existsSync(p + ".invalidSha")).toBe(true); // kept for inspection
  });

  it("pinnedSha256: curated, alias-object wins, string-alias + raw → undefined", () => {
    const k = Object.keys(CURATED_LOCAL_MODELS)[0];
    // Curated entries don't carry a sha256 in the test build, so this is undefined…
    expect(pinnedSha256(k, aliasFile)).toBe(CURATED_LOCAL_MODELS[k].sha256);
    fs.writeFileSync(
      aliasFile,
      JSON.stringify({
        client: { modelAliases: { obj: { uri: "hf:o/x:Q4", sha256: "aa" }, str: "hf:o/y:Q4" } } },
      }),
    );
    expect(pinnedSha256("obj", aliasFile)).toBe("aa"); // alias object hash
    expect(pinnedSha256("str", aliasFile)).toBeUndefined(); // string alias has none
    expect(pinnedSha256("hf:o/z:Q4", aliasFile)).toBeUndefined(); // raw uri
    expect(pinnedSha256("/abs/x.gguf", aliasFile)).toBeUndefined(); // raw path
  });

  it("pinnedSha256: a user alias shadowing a curated name uses the alias (not curated)", () => {
    const k = Object.keys(CURATED_LOCAL_MODELS)[0];
    fs.writeFileSync(
      aliasFile,
      JSON.stringify({ client: { modelAliases: { [k]: "hf:mine/custom:Q4" } } }),
    );
    // string alias governs → no pin (must NOT fall back to the curated hash)
    expect(pinnedSha256(k, aliasFile)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run lib/stdlib/localModels.test.ts -t "model file verification" 2>&1 | tee /tmp/v2.log`
Expected: FAIL — helpers not defined.

- [ ] **Step 3: Add the `createHash` import**

At the top of `localModels.ts`, after the existing `node:` imports:

```ts
import { createHash } from "node:crypto";
```

- [ ] **Step 4: Implement the helpers**

Add near the `_downloadModel` area of `localModels.ts` (before `_downloadModel`):

```ts
/** Stream-hash a file's SHA-256 (hex), never buffering the whole file. */
export function fileSha256(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

/** Verify `filePath` against the expected hex SHA-256. On mismatch, rename the
 *  file to `<filePath>.invalidSha` (kept for inspection; won't be picked up, so
 *  the next run re-downloads) and throw. */
export async function verifyModelFile(
  filePath: string,
  expected: string,
  name: string,
): Promise<void> {
  const actual = await fileSha256(filePath);
  if (actual === expected) return;
  const quarantine = `${filePath}.invalidSha`;
  try {
    fs.renameSync(filePath, quarantine);
  } catch {
    /* best effort: leave the file where it is */
  }
  throw new Error(
    `SHA-256 verification failed for "${name}": expected ${expected}, got ${actual}. ` +
      `The downloaded file was moved to ${quarantine} for inspection and will be re-downloaded next time.`,
  );
}

/** The pinned SHA-256 for a model name/alias, or undefined when none is known
 *  (raw uri/path, string alias, alias/curated without a hash, or a sharded
 *  model). An alias entry governs the name entirely — a user alias shadowing a
 *  curated name must NOT borrow the curated hash. */
export function pinnedSha256(value: string, file: string = ""): string | undefined {
  if (isGgufPath(value) || isModelUri(value)) return undefined;
  const aliases = readModelAliases(file);
  if (Object.hasOwn(aliases, value)) {
    const v = aliases[value];
    return typeof v === "object" ? v.sha256 : undefined;
  }
  return CURATED_LOCAL_MODELS[value]?.sha256;
}

/** The set of `*.gguf` filenames already in `dir` (empty if it doesn't exist).
 *  Used to tell a fresh download from a cache hit. */
export function listGgufBasenames(dir: string): Set<string> {
  if (!fs.existsSync(dir)) return new Set();
  return new Set(fs.readdirSync(dir).filter((f) => f.endsWith(".gguf")));
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run lib/stdlib/localModels.test.ts -t "model file verification" 2>&1 | tee /tmp/v2.log`
Expected: PASS (the curated-hash assertion passes because curated entries have no `sha256` yet — both sides are `undefined`).

- [ ] **Step 6: Typecheck + commit**

```bash
npx tsc --noEmit 2>&1 | grep -i localModels || echo "tsc clean"
git add packages/agency-lang/lib/stdlib/localModels.ts packages/agency-lang/lib/stdlib/localModels.test.ts
git commit -m "Add SHA-256 verification primitives (fileSha256/verifyModelFile/pinnedSha256)"
```

---

### Task 3: Verify on fresh download in `_downloadModel`

Wire verification into the download path: hash the file only when it was just downloaded and a pin exists.

**Files:**
- Modify: `packages/agency-lang/lib/stdlib/localModels.ts` (`_downloadModel`)
- Test: `packages/agency-lang/lib/stdlib/localModels.test.ts` (update the existing fake-provider `describe`)

**Interfaces:**
- Consumes: `listGgufBasenames`, `pinnedSha256`, `verifyModelFile` (Task 2); existing `_resolveModelName`, `resolveCacheDir`, `bundledLlamaModule`, `requireSupport`, `exposeResolvedLlamaCppPath`.
- Produces: `_downloadModel(value, cacheDir)` now verifies a freshly-downloaded, pinned file before returning.

- [ ] **Step 1: Update the fake provider to write a real file, and rewrite the existing assertions**

The current fake `resolveModel` returns a non-file string (`"RESOLVED:" + target`), which can't be hashed. Replace the `fakeModule()` body in `localModels.test.ts` so `resolveModel` writes a real `.gguf` into the cache dir and returns its path:

```ts
  function fakeModule(): string {
    const p = path.join(here2, "__tmp_fakellama.mjs");
    fs.writeFileSync(p, `import { BaseClient } from "smoltalk";
      import * as fs from "node:fs";
      import * as path from "node:path";
      class FakeLlama extends BaseClient { async textSync() { return { success: true, value: { output: "x", toolCalls: [] } }; } }
      export function register({ registerProvider }) { registerProvider("llama-cpp", FakeLlama); }
      export async function resolveModel(target, dir) {
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, "model.gguf");
        fs.writeFileSync(file, "FAKE:" + target);
        return file;
      }`);
    fakes.push(p);
    return p;
  }
```

Then update the two existing assertions that expected the old `"RESOLVED:"` string. Replace:

```ts
  it("downloads (resolves) a curated name to a path", async () => {
    process.env.AGENCY_LLAMA_PROVIDER_MODULE = fakeModule();
    const k = Object.keys(CURATED_LOCAL_MODELS)[0];
    expect(await _downloadModel(k, "/cache")).toBe("RESOLVED:" + CURATED_LOCAL_MODELS[k].uri);
  });
  it("registerLocalModel registers and returns the resolved path", async () => {
    process.env.AGENCY_LLAMA_PROVIDER_MODULE = fakeModule();
    expect(await _registerLocalModel("/abs/my.gguf", "/cache")).toBe("RESOLVED:/abs/my.gguf");
    expect(smoltalkPkg.getClient({ model: "m", provider: "llama-cpp" }).constructor.name).toBe("FakeLlama");
  });
```

with (use a temp cache dir; raw inputs have no pin, so verification is skipped and these stay about resolution):

```ts
  it("downloads (resolves) a uri to a real path", async () => {
    process.env.AGENCY_LLAMA_PROVIDER_MODULE = fakeModule();
    const out = await _downloadModel("hf:org/repo:Q4", dir); // raw uri → no pin
    expect(out).toBe(path.join(dir, "model.gguf"));
    expect(fs.existsSync(out)).toBe(true);
  });
  it("registerLocalModel registers and returns the resolved path", async () => {
    process.env.AGENCY_LLAMA_PROVIDER_MODULE = fakeModule();
    const out = await _registerLocalModel("/abs/my.gguf", dir); // raw path → no pin
    expect(out).toBe(path.join(dir, "model.gguf"));
    expect(smoltalkPkg.getClient({ model: "m", provider: "llama-cpp" }).constructor.name).toBe("FakeLlama");
  });
```

- [ ] **Step 2: Add the verification integration tests**

Add to the same `describe` (these `chdir` into `dir` so `_downloadModel`'s `pinnedSha256(value, "")` / `_resolveModelName` find the temp `agency.json`):

```ts
  it("verifies a freshly-downloaded pinned model (match → ok)", async () => {
    process.env.AGENCY_LLAMA_PROVIDER_MODULE = fakeModule();
    const target = "hf:org/x:Q4";
    const sha = createHash("sha256").update("FAKE:" + target).digest("hex");
    fs.writeFileSync(aliasFile, JSON.stringify({ client: { modelAliases: { mymodel: { uri: target, sha256: sha } } } }));
    const cwd = process.cwd();
    process.chdir(dir);
    try {
      const out = await _downloadModel("mymodel", dir);
      expect(fs.existsSync(out)).toBe(true);
      expect(fs.existsSync(out + ".invalidSha")).toBe(false);
    } finally {
      process.chdir(cwd);
    }
  });

  it("quarantines a freshly-downloaded model whose hash is wrong", async () => {
    process.env.AGENCY_LLAMA_PROVIDER_MODULE = fakeModule();
    fs.writeFileSync(aliasFile, JSON.stringify({ client: { modelAliases: { mymodel: { uri: "hf:org/x:Q4", sha256: "0".repeat(64) } } } }));
    const cwd = process.cwd();
    process.chdir(dir);
    try {
      await expect(_downloadModel("mymodel", dir)).rejects.toThrow(/SHA-256 verification failed/);
      expect(fs.existsSync(path.join(dir, "model.gguf"))).toBe(false);
      expect(fs.existsSync(path.join(dir, "model.gguf.invalidSha"))).toBe(true);
    } finally {
      process.chdir(cwd);
    }
  });

  it("does NOT re-verify an already-present (cache-hit) file", async () => {
    process.env.AGENCY_LLAMA_PROVIDER_MODULE = fakeModule();
    // Pre-create the model file so it's in the before-snapshot → treated as cached.
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "model.gguf"), "pre-existing");
    // A deliberately-wrong pin would fail IF it verified — it must be skipped.
    fs.writeFileSync(aliasFile, JSON.stringify({ client: { modelAliases: { mymodel: { uri: "hf:org/x:Q4", sha256: "0".repeat(64) } } } }));
    const cwd = process.cwd();
    process.chdir(dir);
    try {
      await expect(_downloadModel("mymodel", dir)).resolves.toBe(path.join(dir, "model.gguf"));
      expect(fs.existsSync(path.join(dir, "model.gguf.invalidSha"))).toBe(false);
    } finally {
      process.chdir(cwd);
    }
  });
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run lib/stdlib/localModels.test.ts -t "fake bundled module" 2>&1 | tee /tmp/v3.log`
Expected: FAIL — the match/quarantine tests fail because `_downloadModel` doesn't verify yet (and the cache-hit test may pass incidentally).

- [ ] **Step 4: Wire verification into `_downloadModel`**

Replace the body of `_downloadModel` (currently ends with `return await mod.resolveModel(target, resolveCacheDir(cacheDir));`):

```ts
export async function _downloadModel(value: string, cacheDir: string = ""): Promise<string> {
  requireSupport();
  exposeResolvedLlamaCppPath();
  const target = _resolveModelName(value);
  const dir = resolveCacheDir(cacheDir);
  const fsPath = bundledLlamaModule();
  let mod: LlamaBundle;
  try {
    // eslint-disable-next-line no-restricted-syntax -- on-demand load of the optional provider module
    mod = (await import(pathToFileURL(fsPath).href)) as LlamaBundle;
  } catch (err) {
    throw new Error(`Failed to load the local-model provider: ${(err as Error).message}`);
  }
  if (typeof mod.resolveModel !== "function") {
    throw new Error(`Local-model provider module must export resolveModel().`);
  }
  // Snapshot the cache dir so we can tell a fresh download from a cache hit and
  // verify the bytes only once, right after they're downloaded.
  const before = listGgufBasenames(dir);
  const resolved = await mod.resolveModel(target, dir);
  const expected = pinnedSha256(value);
  if (expected !== undefined && !before.has(path.basename(resolved))) {
    await verifyModelFile(resolved, expected, value);
  }
  return resolved;
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run lib/stdlib/localModels.test.ts -t "fake bundled module" 2>&1 | tee /tmp/v3.log`
Expected: PASS (all fake-provider tests, including the three new verification cases).

- [ ] **Step 6: Run the whole localModels + cli suites for regressions**

Run: `npx vitest run lib/stdlib/localModels.test.ts lib/cli/local.test.ts 2>&1 | tee /tmp/v3-all.log`
Expected: all PASS except the 2 known-environmental `resolveSmoltalkLlamaCppFromRoots` failures.

- [ ] **Step 7: Typecheck + commit**

```bash
npx tsc --noEmit 2>&1 | grep -i localModels || echo "tsc clean"
git add packages/agency-lang/lib/stdlib/localModels.ts packages/agency-lang/lib/stdlib/localModels.test.ts
git commit -m "Verify SHA-256 of freshly-downloaded local models in _downloadModel"
```

---

### Task 4: Hash-generation script + populate real pins

A maintainer-run script that mints pins from `X-Linked-ETag` and writes them into the catalog; then run it to fill in the real hashes for the curated set.

**Files:**
- Create: `packages/agency-lang/scripts/genModelHashes.ts`
- Modify: `packages/agency-lang/lib/stdlib/localModels.ts` (`CURATED_LOCAL_MODELS` — paste the generated hashes)
- Modify: `packages/agency-lang/data/model-catalog.json` (regenerated with hashes)
- Test: `packages/agency-lang/lib/stdlib/genModelHashes.test.ts` (parsing logic only, injected fetcher)

**Interfaces:**
- Consumes: `CURATED_LOCAL_MODELS`, `ModelInfo`.
- Produces: `parseHfUri(uri): { user, repo, quant } | null` and `pickSingleQuantFile(files: string[], quant: string): string | null` (exported for testing); a `main()` that fetches + writes.

- [ ] **Step 1: Write the failing test for the pure parsing helpers**

Create `packages/agency-lang/lib/stdlib/genModelHashes.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { parseHfUri, pickSingleQuantFile } from "../../scripts/genModelHashes.js";

describe("genModelHashes helpers", () => {
  it("parseHfUri splits hf:user/repo:quant", () => {
    expect(parseHfUri("hf:unsloth/Qwen3.5-2B-GGUF:Q4_K_M")).toEqual({
      user: "unsloth",
      repo: "Qwen3.5-2B-GGUF",
      quant: "Q4_K_M",
    });
  });
  it("parseHfUri returns null for non-hf or file-form uris", () => {
    expect(parseHfUri("https://x/y.gguf")).toBeNull();
    expect(parseHfUri("/abs/m.gguf")).toBeNull();
    expect(parseHfUri("hf:user/repo/file.gguf")).toBeNull(); // file-form, not :quant
  });
  it("pickSingleQuantFile returns the lone matching gguf, else null", () => {
    expect(
      pickSingleQuantFile(["README.md", "Model-Q4_K_M.gguf", "Model-Q8_0.gguf"], "Q4_K_M"),
    ).toBe("Model-Q4_K_M.gguf");
    // sharded → more than one match → null (no pin)
    expect(
      pickSingleQuantFile(["m-Q4_K_M-00001-of-00002.gguf", "m-Q4_K_M-00002-of-00002.gguf"], "Q4_K_M"),
    ).toBeNull();
    expect(pickSingleQuantFile(["only-Q8_0.gguf"], "Q4_K_M")).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run lib/stdlib/genModelHashes.test.ts 2>&1 | tee /tmp/v4.log`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the script**

Create `packages/agency-lang/scripts/genModelHashes.ts`:

```ts
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { CURATED_LOCAL_MODELS } from "../lib/stdlib/localModels.js";

/** Split `hf:user/repo:quant` (the curated short form). Returns null for the
 *  file-form (`hf:user/repo/file.gguf`), https, or local paths. */
export function parseHfUri(uri: string): { user: string; repo: string; quant: string } | null {
  const m = /^hf:([^/]+)\/([^/:]+):([^/]+)$/.exec(uri);
  if (!m) return null;
  return { user: m[1], repo: m[2], quant: m[3] };
}

/** The lone `.gguf` whose name contains `quant`; null if zero or many (a sharded
 *  model has many → we record no pin for it). */
export function pickSingleQuantFile(files: string[], quant: string): string | null {
  const matches = files.filter((f) => f.endsWith(".gguf") && f.includes(quant));
  return matches.length === 1 ? matches[0] : null;
}

async function repoFiles(user: string, repo: string): Promise<string[]> {
  const res = await fetch(`https://huggingface.co/api/models/${user}/${repo}`);
  if (!res.ok) throw new Error(`HF API ${res.status} for ${user}/${repo}`);
  const json = (await res.json()) as { siblings?: { rfilename: string }[] };
  return (json.siblings ?? []).map((s) => s.rfilename);
}

/** HEAD the resolve URL and read X-Linked-ETag (= the file's content sha256).
 *  NEVER use `etag`/`x-xet-hash` (a different chunk hash). */
async function fetchSha256(user: string, repo: string, file: string): Promise<string | null> {
  const url = `https://huggingface.co/${user}/${repo}/resolve/main/${encodeURIComponent(file)}`;
  const res = await fetch(url, { method: "HEAD", redirect: "follow" });
  const etag = res.headers.get("x-linked-etag");
  if (!etag) return null;
  return etag.replace(/"/g, "");
}

async function main(): Promise<void> {
  const out: Record<string, string> = {};
  for (const [name, info] of Object.entries(CURATED_LOCAL_MODELS)) {
    const parsed = parseHfUri(info.uri);
    if (!parsed) {
      console.warn(`skip ${name}: not an hf:user/repo:quant uri`);
      continue;
    }
    const files = await repoFiles(parsed.user, parsed.repo);
    const file = pickSingleQuantFile(files, parsed.quant);
    if (!file) {
      console.warn(`skip ${name}: not a single-file ${parsed.quant} gguf (sharded?)`);
      continue;
    }
    const sha = await fetchSha256(parsed.user, parsed.repo, file);
    if (!sha) {
      console.warn(`skip ${name}: no X-Linked-ETag`);
      continue;
    }
    out[name] = sha;
    console.log(`${name}: ${sha}`);
  }

  // Rewrite the seed catalog with the new sha256 values. Resolved from cwd
  // (run this script from the `packages/agency-lang` directory) so it edits the
  // SOURCE data file whether run from `dist/` or via tsx.
  const catalogPath = path.resolve("data/model-catalog.json");
  const catalog = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
  for (const [name, sha] of Object.entries(out)) {
    if (catalog.models[name]) catalog.models[name].sha256 = sha;
  }
  fs.writeFileSync(catalogPath, JSON.stringify(catalog, null, 2) + "\n");

  console.log("\n--- paste these into CURATED_LOCAL_MODELS ---");
  for (const [name, sha] of Object.entries(out)) console.log(`  ${name}: sha256 "${sha}"`);
}

// Run only when invoked directly.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
```

- [ ] **Step 4: Run the helper test to verify it passes**

Run: `npx vitest run lib/stdlib/genModelHashes.test.ts 2>&1 | tee /tmp/v4.log`
Expected: PASS.

- [ ] **Step 5: Build, then run the script to mint real hashes**

Run from the `packages/agency-lang` directory (so the script's cwd-relative
`data/model-catalog.json` write hits the source file):

```bash
export PATH="$PWD/node_modules/.bin:$PATH"
make build > /tmp/v4-build.log 2>&1 && echo BUILD_OK
node ./dist/scripts/genModelHashes.js 2>&1 | tee /tmp/v4-hashes.log
```
Expected: one `name: <64-hex>` line per single-file curated model (≈13), and `data/model-catalog.json` rewritten with `sha256` fields. (Network required.)

- [ ] **Step 6: Paste the hashes into `CURATED_LOCAL_MODELS`**

For each line printed under "paste these into CURATED_LOCAL_MODELS", add a `sha256:` field to the matching entry in `CURATED_LOCAL_MODELS` in `lib/stdlib/localModels.ts`, e.g.:

```ts
  "smollm2-135m": {
    uri: "hf:unsloth/SmolLM2-135M-Instruct-GGUF:Q4_K_M",
    params: "135M", sizeBytes: 105_000_000, category: "general",
    contextWindow: 8192, license: "apache-2.0",
    sha256: "<the hex from the script>",
    description: "Smallest practical chat model; used by our integration tests, runs anywhere.",
  },
```

- [ ] **Step 7: Verify the catalog and curated agree**

```bash
export PATH="$PWD/node_modules/.bin:$PATH"
make build > /tmp/v4-build2.log 2>&1 && echo BUILD_OK
node -e '
const fs=require("fs");
const { CURATED_LOCAL_MODELS } = require("./packages/agency-lang/dist/lib/stdlib/localModels.js");
const cat = JSON.parse(fs.readFileSync("packages/agency-lang/data/model-catalog.json","utf8"));
let bad=0;
for (const [n,info] of Object.entries(CURATED_LOCAL_MODELS)) {
  const c = (cat.models[n]||{}).sha256, k = info.sha256;
  if (k && c && k!==c) { console.log("MISMATCH", n); bad++; }
}
console.log(bad? "MISMATCH found" : "curated and catalog sha256 agree");
'
```
Expected: `curated and catalog sha256 agree`.

- [ ] **Step 8: Commit**

```bash
git add packages/agency-lang/scripts/genModelHashes.ts packages/agency-lang/lib/stdlib/genModelHashes.test.ts packages/agency-lang/lib/stdlib/localModels.ts packages/agency-lang/data/model-catalog.json
git commit -m "Add genModelHashes script and pin curated model sha256 hashes"
```

---

### Task 5: Developer documentation

A developer overview of the local-model system, including the SHA-verification behavior and the sharded gap.

**Files:**
- Create: `packages/agency-lang/docs/dev/local-models.md`
- Modify: `CLAUDE.md` (doc index)

**Interfaces:** none (docs only).

- [ ] **Step 1: Write `docs/dev/local-models.md`**

Create `packages/agency-lang/docs/dev/local-models.md`:

```markdown
# Local models

How `agency`'s local-model support is wired, end to end.

## Provider

Local inference runs through `smoltalk`'s `llama-cpp` provider, registered on
demand from the bundled `lib/stdlib/providers/llama-cpp.mjs` (which wraps
`node-llama-cpp`). Registration is lazy (`_registerLocalProvider`); nothing
loads `node-llama-cpp` until a local model is actually used.

## Name resolution

`_resolveModelName(value)` maps a value to a model URI/path:

1. A `.gguf` path or an `hf:`/`https:` URI passes through unchanged.
2. An alias in `client.modelAliases` (nearest `agency.json`) wins next — a
   value is either a bare URI string or an object `{ uri, …metadata, source?, sha256? }`.
3. Otherwise a curated short name in `CURATED_LOCAL_MODELS`.

`_listModelNames` merges curated + aliases (alias wins on a name clash) for the
`agency local alias list` table and the agent's `--local-model` discovery output.

## Catalog refresh

`agency local refresh [url]` (`_refreshCatalog`) fetches a JSON catalog and
writes its models into `client.modelAliases` as `source:"remote"` aliases,
preserving the user's own aliases. The seed catalog lives at
`data/model-catalog.json` and is served from `main`. See `docs/site/cli/local.md`.

## Download + verification

`_downloadModel(value)` resolves the URI and calls the provider's
`resolveModel`, which downloads via `node-llama-cpp` (single file, or sharded —
see below). We then verify integrity:

- A known-good SHA-256 is **pinned** per curated/catalog model (in
  `CURATED_LOCAL_MODELS` and `data/model-catalog.json`), minted by
  `scripts/genModelHashes.ts` from Hugging Face's `X-Linked-ETag` header (which
  equals the file's content sha256).
- After a **fresh** download (detected via a cache-dir snapshot — we never
  re-hash an already-present file), we stream-hash the file and compare it to
  the pin (`verifyModelFile`).
- On a mismatch the file is renamed to `<file>.gguf.invalidSha` (kept for
  inspection, not loaded) and an error is thrown.
- Verification is **opportunistic**: models with no pin (user aliases, raw
  URIs) are simply not verified.

### Sharded models are NOT verified yet

`node-llama-cpp` handles two multi-part layouts: GGUF-split keeps the parts as
separate files; binary-split splices them into one combined file. Our pin is a
single content sha256, which only applies to **single-file** models — the entire
curated Q4_K_M set is single-file. Sharded models therefore carry no pin and are
**skipped** by verification. Extending coverage (per-part hashes for GGUF-split;
compute-and-pin for binary-split) is tracked in
[issue #348](https://github.com/egonSchiele/agency-lang/issues/348).

## Tests

See `docs/dev/local-model-integration.md` for the real-download integration
suite; the deterministic unit tests live in `lib/stdlib/localModels.test.ts`,
`lib/cli/local.test.ts`, and `tests/agency-js/local-model/`.
```

- [ ] **Step 2: Add the doc to the `CLAUDE.md` index**

In the root `CLAUDE.md`, under "Pipeline and architecture" (or the nearest doc list), add:

```markdown
- `docs/dev/local-models.md` — Local-model support: provider, name resolution, catalog refresh, and SHA-256 download verification
```

- [ ] **Step 3: Commit**

```bash
git add packages/agency-lang/docs/dev/local-models.md CLAUDE.md
git commit -m "Document local-model system + SHA-256 verification"
```

---

## Final verification (run after all tasks)

- [ ] Build + suites + lint:
```bash
export PATH="$PWD/node_modules/.bin:$PATH"
make build > /tmp/final-build.log 2>&1 && echo BUILD_OK
npx vitest run lib/stdlib/localModels.test.ts lib/stdlib/genModelHashes.test.ts lib/cli/local.test.ts 2>&1 | tee /tmp/final-tests.log
pnpm run lint:structure 2>&1 | tail -3
```
Expected: build OK; all pass except the 2 known-environmental `resolveSmoltalkLlamaCppFromRoots` failures; lint clean.

- [ ] Smoke test (real download of the smallest model, verifies against its pin):
```bash
AGENCY_MODELS_DIR=$(mktemp -d) node ./dist/scripts/agency.js local download smollm2-135m 2>&1 | tail -3
```
Expected: downloads + exits 0 (verification passes). Tamper check: re-run after truncating the file → expect a `SHA-256 verification failed` error and a `.invalidSha` file. (Optional — needs network + ~105 MB.)

---

## Self-review notes (already checked)

- **Spec coverage:** schema (Task 1), verification primitives (Task 2), verify-on-fresh-download in `_downloadModel` (Task 3), generation script + real pins in both curated and catalog (Task 4), dev doc + sharded caveat + #348 link (Task 5). All spec sections map to a task.
- **Type consistency:** `sha256?: string` added uniformly to `ModelInfo`/`AliasObject`/`CatalogModel`/`ModelNameEntry`; `fileSha256`/`verifyModelFile`/`pinnedSha256`/`listGgufBasenames` defined in Task 2 are used in Task 3 with the same signatures; `parseHfUri`/`pickSingleQuantFile` defined and tested in Task 4.
- **Pinning correctness:** `pinnedSha256` uses an own-property check so a user alias governs its name and never borrows a curated hash (tested).
- **Verify-once:** the cache-dir snapshot makes a cache hit skip hashing (tested), so startup with a present model pays nothing.
- **Header discipline:** the script reads `X-Linked-ETag` only, never `etag`/`x-xet-hash`.
- **Known caveat:** the 2 `resolveSmoltalkLlamaCppFromRoots` tests fail environmentally, unrelated to this work.
```
