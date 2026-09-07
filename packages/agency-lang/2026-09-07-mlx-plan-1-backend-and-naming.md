# MLX Plan 1: Backend and Naming

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Teach `agency local` that a model has a backend, add the `mlx:` prefix and directory aliases, and let `run --local` and `agent --local` use an MLX server that is already running.

**Architecture:** A `Backend` type and a `backend` field run through the catalog, aliases, and config schema. One function, `_resolveModel`, returns both the backend and the target for any name. Every command that used `_resolveModelName` branches on the backend. Nothing in this PR starts or downloads an MLX model.

**Tech Stack:** TypeScript, zod, vitest. smoltalk 0.13.0 with the `mlx` provider.

**Spec:** `2026-09-07-mlx-local-models-spec.md`, sections 3.1, 3.2, 3.6, 3.7, 3.8. Read Part 1 of the spec first.

## Global Constraints

- `backend` is `"llama-cpp"` or `"mlx"`. It is required on every catalog entry and every object-form alias. A string-form alias reads its backend from its prefix.
- A directory is an MLX model when it contains `config.json` and at least one `.safetensors` file.
- `remove` keeps files unless `-f` is passed. This applies to GGUF too.
- No new npm dependency.
- Run commands from `packages/agency-lang` in the worktree.
- Save test output to a file. Run only the test files this plan touches, never the whole suite.
- Run `pnpm run fmt:ts` and `pnpm run lint:structure` before each commit.
- Commit messages go in a file and are passed with `git commit -F`.
- Never commit to `main`. Check `git branch --show-current` before every commit.

---

### Task 0: Branch and smoltalk pin

**Files:**
- Modify: `package.json` (`"smoltalk": "^0.12.1"`)

- [ ] **Step 1: Branch from main**

```bash
cd /Users/adityabhargava/agency-lang
git worktree add worktree-mlx-backend -b adit/mlx-backend main
cd worktree-mlx-backend/packages/agency-lang
```

Copy the spec and this plan from the `adit/mlx-spike` branch into this worktree so they travel with the PR:

```bash
git checkout adit/mlx-spike -- packages/agency-lang/2026-09-07-mlx-local-models-spec.md packages/agency-lang/2026-09-07-mlx-plan-1-backend-and-naming.md
```

- [ ] **Step 2: Pin smoltalk**

Change `"smoltalk": "^0.12.1"` to `"smoltalk": "^0.13.0"` in `package.json`, then:

```bash
pnpm install
pnpm exec node -e 'import("smoltalk").then(m => console.log(typeof m.getClient))'
```

Expected: `function`. If 0.13.0 is not published yet, use the smoltalk workspace path the way `pnpm-lock.yaml` did during the llama-cpp work, and note it in the PR.

- [ ] **Step 3: Build and commit**

```bash
make > /tmp/make.log 2>&1; tail -5 /tmp/make.log
git add package.json pnpm-lock.yaml packages/agency-lang/2026-09-07-mlx-*.md
printf 'mlx: pin smoltalk 0.13.0 and bring the spec and plan\n' > /tmp/msg.txt
git commit -F /tmp/msg.txt
```

---

### Task 1: The `Backend` type and URI classification

**Files:**
- Modify: `lib/stdlib/localModels.ts` (near `isGgufPath`, `isModelUri`, `isCatalogUri`, around line 336)
- Test: `lib/stdlib/localModels.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type Backend = "llama-cpp" | "mlx";
  export function isMlxUri(v: string): boolean;          // "mlx:org/repo" or "mlx:org/repo@rev"
  export function parseMlxUri(v: string): { repo: string; revision: string | undefined };
  export function isModelDir(p: string): boolean;        // config.json + a .safetensors file
  export function backendOfTarget(target: string): Backend;
  ```

- [ ] **Step 1: Write the failing tests**

Add to `lib/stdlib/localModels.test.ts`, importing the four new functions:

```ts
describe("backend of a target", () => {
  it("hf: URIs and .gguf paths are llama-cpp", () => {
    expect(backendOfTarget("hf:org/repo:Q4_K_M")).toBe("llama-cpp");
    expect(backendOfTarget("/models/x.gguf")).toBe("llama-cpp");
  });

  it("mlx: URIs are mlx, with and without a revision", () => {
    expect(isMlxUri("mlx:mlx-community/Qwen3-Coder-Next-4bit")).toBe(true);
    expect(parseMlxUri("mlx:mlx-community/Qwen3-Coder-Next-4bit")).toEqual({
      repo: "mlx-community/Qwen3-Coder-Next-4bit",
      revision: undefined,
    });
    expect(parseMlxUri("mlx:mlx-community/Qwen3-Coder-Next-4bit@7b9321e")).toEqual({
      repo: "mlx-community/Qwen3-Coder-Next-4bit",
      revision: "7b9321e",
    });
    expect(backendOfTarget("mlx:mlx-community/Qwen3-Coder-Next-4bit")).toBe("mlx");
  });

  it("a directory with config.json and a safetensors file is an mlx model", () => {
    const model = path.join(dir, "m");
    fs.mkdirSync(model);
    fs.writeFileSync(path.join(model, "config.json"), "{}");
    expect(isModelDir(model)).toBe(false);
    fs.writeFileSync(path.join(model, "model.safetensors"), "");
    expect(isModelDir(model)).toBe(true);
    expect(backendOfTarget(model)).toBe("mlx");
  });

  it("a path that is neither is an error", () => {
    expect(() => backendOfTarget(path.join(dir, "nothing-here"))).toThrow(
      /not a model: expected a \.gguf file or a directory containing config\.json/,
    );
  });
});
```

- [ ] **Step 2: Run and watch them fail**

```bash
pnpm exec vitest run lib/stdlib/localModels.test.ts > /tmp/t1.log 2>&1; grep -E "✓|✗|×|FAIL|Error" /tmp/t1.log | head -20
```

Expected: the new tests fail on missing exports.

- [ ] **Step 3: Implement**

In `lib/stdlib/localModels.ts`, next to `isGgufPath`:

```ts
export type Backend = "llama-cpp" | "mlx";

const MLX_URI = /^mlx:([^@\s/]+\/[^@\s/]+)(?:@([0-9a-fA-F]{7,40}|[\w.-]+))?$/;

export function isMlxUri(v: string): boolean {
  return MLX_URI.test(v);
}

/** Split "mlx:org/repo@rev" into its parts. Throws on any other shape. */
export function parseMlxUri(v: string): { repo: string; revision: string | undefined } {
  const m = MLX_URI.exec(v);
  if (m === null) {
    throw new Error(`"${v}" is not an mlx: URI. Expected mlx:<org>/<repo> or mlx:<org>/<repo>@<revision>.`);
  }
  return { repo: m[1], revision: m[2] };
}

/** A Hugging Face model directory: config.json plus at least one weights file. */
export function isModelDir(p: string): boolean {
  const located = wholePath(p);
  const info = stat(located.root, located.target);
  if (info === null || !info.isDirectory()) {
    return false;
  }
  const entries = list(root(p), ".");
  const hasConfig = entries.some((e) => e.type === "file" && e.name === "config.json");
  const hasWeights = entries.some((e) => e.type === "file" && e.name.endsWith(".safetensors"));
  return hasConfig && hasWeights;
}

/** Which engine runs a resolved target. */
export function backendOfTarget(target: string): Backend {
  if (isGgufPath(target) || /^(hf:|https?:)/.test(target)) {
    return "llama-cpp";
  }
  if (isMlxUri(target)) {
    return "mlx";
  }
  if (isModelDir(target)) {
    return "mlx";
  }
  throw new Error(
    `"${target}" is not a model: expected a .gguf file or a directory containing config.json.`,
  );
}
```

Update `isModelUri` to also accept `mlx:`, and `isCatalogUri` to accept `mlx:` while still refusing `http://`.

- [ ] **Step 4: Run, then commit**

```bash
pnpm exec vitest run lib/stdlib/localModels.test.ts > /tmp/t1.log 2>&1; tail -8 /tmp/t1.log
pnpm run fmt:ts && pnpm run lint:structure
git add lib/stdlib/localModels.ts lib/stdlib/localModels.test.ts
printf 'local models: a Backend type, mlx: URIs, and model directories\n' > /tmp/msg.txt
git commit -F /tmp/msg.txt
```

---

### Task 2: The `backend` field on entries, aliases, and the schema

**Files:**
- Modify: `lib/stdlib/localModels.ts` (`ModelInfo`, `AliasObject`, `CatalogModel`, `ModelNameEntry`, `CatalogModelSchema`, every entry of `CURATED_LOCAL_MODELS`, `readModelAliases`, `metaFrom`)
- Modify: `lib/config.ts` (`ModelAliasSchema`)
- Modify: `data/model-catalog.json` (every entry)
- Test: `lib/stdlib/localModels.test.ts`, `lib/config.modelAliases.test.ts`

**Interfaces:**
- Produces: `backend: Backend` on `ModelInfo`, `AliasObject`, `CatalogModel`, `ModelNameEntry`.
- Produces: `readModelAliases(file)` throws the messages below for a bad object alias.

- [ ] **Step 1: Write the failing tests**

In `lib/stdlib/localModels.test.ts`:

```ts
describe("backend field", () => {
  it("every curated entry has a backend that matches its uri", () => {
    for (const [name, info] of Object.entries(CURATED_LOCAL_MODELS)) {
      expect(info.backend, name).toBe(backendOfTarget(info.uri));
    }
  });

  it("an object alias without backend is an error naming the file", () => {
    fs.writeFileSync(
      aliasFile,
      JSON.stringify({ client: { modelAliases: { coder: { uri: "hf:org/repo:Q4_K_M" } } } }),
    );
    expect(() => _resolveModelName("coder", aliasFile)).toThrow(
      `alias "coder" has no "backend". Add "backend": "llama-cpp" or "backend": "mlx" to the entry in ${aliasFile}.`,
    );
  });

  it("an object alias whose backend disagrees with its uri is an error", () => {
    fs.writeFileSync(
      aliasFile,
      JSON.stringify({
        client: { modelAliases: { coder: { backend: "mlx", uri: "hf:org/repo:Q4_K_M" } } },
      }),
    );
    expect(() => _resolveModelName("coder", aliasFile)).toThrow(
      /says backend "mlx" but its uri "hf:org\/repo:Q4_K_M" is a GGUF file/,
    );
  });

  it("a string alias reads its backend from the prefix", () => {
    fs.writeFileSync(
      aliasFile,
      JSON.stringify({ client: { modelAliases: { coder: "mlx:mlx-community/Qwen3-Coder-Next-4bit" } } }),
    );
    const entry = _listModelNames(aliasFile).find((e) => e.name === "coder");
    expect(entry?.backend).toBe("mlx");
  });

  it("a remote catalog entry without backend is skipped with a warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const parsed = parseCatalog(
      JSON.stringify({
        version: 1,
        models: {
          ok: { backend: "llama-cpp", uri: "hf:org/ok:Q4_K_M" },
          bad: { uri: "hf:org/bad:Q4_K_M" },
        },
      }),
    );
    expect(Object.keys(parsed)).toEqual(["ok"]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('skipping "bad"'));
    warn.mockRestore();
  });
});
```

In `lib/config.modelAliases.test.ts`, add `backend: "llama-cpp"` to the fully-populated entry in the round-trip test, and add:

```ts
  it("an object alias needs a backend", () => {
    const result = AgencyConfigSchema.safeParse({
      client: { modelAliases: { x: { uri: "hf:org/repo:Q4_K_M" } } },
    });
    expect(result.success).toBe(false);
  });
```

- [ ] **Step 2: Run and watch them fail**

```bash
pnpm exec vitest run lib/stdlib/localModels.test.ts lib/config.modelAliases.test.ts > /tmp/t2.log 2>&1; grep -E "×|FAIL" /tmp/t2.log | head
```

- [ ] **Step 3: Implement**

1. Add `backend: Backend;` as the first field of `ModelInfo`, `AliasObject`, `CatalogModel`, and `ModelNameEntry` in `lib/stdlib/localModels.ts`.
2. Add `backend: "llama-cpp",` as the first line of every entry in `CURATED_LOCAL_MODELS` and every entry in `data/model-catalog.json`.
3. In `CatalogModelSchema`, add `backend: z.enum(["llama-cpp", "mlx"]),` with no `.optional()`. A missing field now fails the entry, and the existing skip-and-warn path handles it.
4. In `ModelAliasSchema` in `lib/config.ts`, add `backend: z.enum(["llama-cpp", "mlx"]),` to the object branch.
5. Replace `readModelAliases` with a version that validates object aliases:

```ts
export function readModelAliases(file: string = ""): Record<string, AliasValue> {
  const resolved = resolveAliasFile(file);
  const cfg = readJson(resolved);
  const aliases = (cfg.client?.modelAliases ?? {}) as Record<string, AliasValue>;
  for (const [name, value] of Object.entries(aliases)) {
    if (typeof value === "string") continue;
    if (value.backend === undefined) {
      throw new Error(
        `${path.basename(resolved)}: alias "${name}" has no "backend". Add "backend": "llama-cpp" or "backend": "mlx" to the entry in ${resolved}.`,
      );
    }
    const fromUri = backendOfTarget(value.uri);
    if (value.backend !== fromUri) {
      const what = fromUri === "llama-cpp" ? "a GGUF file" : "an MLX model";
      throw new Error(
        `${path.basename(resolved)}: alias "${name}" says backend "${value.backend}" but its uri "${value.uri}" is ${what}. Change one of them in ${resolved}.`,
      );
    }
  }
  return aliases;
}
```

6. In `metaFrom`, copy `backend` when the source is an object. In `_listModelNames`, set `backend: backendOfTarget(aliasUri(value))` for string aliases and `backend: info.backend` for curated entries.

- [ ] **Step 4: Run, then commit**

```bash
pnpm exec vitest run lib/stdlib/localModels.test.ts lib/config.modelAliases.test.ts lib/cli/local.test.ts > /tmp/t2.log 2>&1; tail -8 /tmp/t2.log
pnpm run fmt:ts && pnpm run lint:structure
git add lib/stdlib/localModels.ts lib/config.ts data/model-catalog.json lib/stdlib/localModels.test.ts lib/config.modelAliases.test.ts
printf 'local models: require a backend on every catalog entry and object alias\n' > /tmp/msg.txt
git commit -F /tmp/msg.txt
```

---

### Task 3: `_resolveModel` and the `resolve` command

**Files:**
- Modify: `lib/stdlib/localModels.ts` (next to `_resolveModelName`)
- Modify: `lib/cli/local.ts` (`runResolve`)
- Test: `lib/stdlib/localModels.test.ts`, `lib/cli/local.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type ResolvedModel = { backend: Backend; target: string };
  export function _resolveModel(value: string, file?: string): ResolvedModel;
  ```
  `_resolveModelName` stays and returns `_resolveModel(value, file).target`.

- [ ] **Step 1: Write the failing tests**

```ts
describe("_resolveModel", () => {
  it("returns backend and target for a curated name", () => {
    expect(_resolveModel("smollm2-135m")).toEqual({
      backend: "llama-cpp",
      target: CURATED_LOCAL_MODELS["smollm2-135m"].uri,
    });
  });

  it("returns mlx for an mlx: URI and for a directory alias", () => {
    const model = path.join(dir, "m");
    fs.mkdirSync(model);
    fs.writeFileSync(path.join(model, "config.json"), "{}");
    fs.writeFileSync(path.join(model, "model.safetensors"), "");
    fs.writeFileSync(aliasFile, JSON.stringify({ client: { modelAliases: { local: model } } }));
    expect(_resolveModel("mlx:org/repo")).toEqual({ backend: "mlx", target: "mlx:org/repo" });
    expect(_resolveModel("local", aliasFile)).toEqual({ backend: "mlx", target: model });
  });

  it("the unknown-name error mentions mlx: URIs", () => {
    expect(() => _resolveModel("nope")).toThrow(/or pass a \.gguf path, an "hf:" URI, an "mlx:" URI, or a model directory/);
  });
});
```

In `lib/cli/local.test.ts`, add a test that `runResolve("smollm2-135m")` prints `llama-cpp  hf:unsloth/SmolLM2-135M-Instruct-GGUF:Q4_K_M`, using the same console-capture pattern the file uses for `runList`.

- [ ] **Step 2: Run and watch them fail**

```bash
pnpm exec vitest run lib/stdlib/localModels.test.ts lib/cli/local.test.ts > /tmp/t3.log 2>&1; grep -E "×|FAIL" /tmp/t3.log | head
```

- [ ] **Step 3: Implement**

```ts
export type ResolvedModel = { backend: Backend; target: string };

export function _resolveModel(value: string, file: string = ""): ResolvedModel {
  if (isGgufPath(value) || isModelUri(value) || isModelDir(value)) {
    return { backend: backendOfTarget(value), target: value };
  }
  const aliases = readModelAliases(file);
  const aliasVal = aliases[value];
  const curated = CURATED_LOCAL_MODELS[value];
  if (aliasVal !== undefined) {
    const target = aliasUri(aliasVal);
    return { backend: backendOfTarget(target), target };
  }
  if (curated !== undefined) {
    return { backend: curated.backend, target: curated.uri };
  }
  const names = [...Object.keys(CURATED_LOCAL_MODELS), ...Object.keys(aliases)].join(", ");
  throw new Error(
    `Unknown local model "${value}". Known names: ${names || "(none)"}; ` +
      `or pass a .gguf path, an "hf:" URI, an "mlx:" URI, or a model directory.`,
  );
}

export function _resolveModelName(value: string, file: string = ""): string {
  return _resolveModel(value, file).target;
}
```

In `lib/cli/local.ts`:

```ts
export function runResolve(value: string): void {
  const { backend, target } = _resolveModel(value);
  console.log(`${backend}  ${target}`);
}
```

- [ ] **Step 4: Run, then commit**

```bash
pnpm exec vitest run lib/stdlib/localModels.test.ts lib/cli/local.test.ts > /tmp/t3.log 2>&1; tail -8 /tmp/t3.log
pnpm run fmt:ts && pnpm run lint:structure
git add lib/stdlib/localModels.ts lib/cli/local.ts lib/stdlib/localModels.test.ts lib/cli/local.test.ts
printf 'local models: _resolveModel returns the backend; resolve prints it\n' > /tmp/msg.txt
git commit -F /tmp/msg.txt
```

---

### Task 4: `run --local` and `agent --local` for MLX

**Files:**
- Modify: `lib/cli/localFlag.ts`
- Modify: `lib/agents/agency-agent/shared.agency` (`configureLocalModel`, around line 451)
- Modify: `lib/agents/agency-agent/lib/capabilities.agency` (`PROVIDER_CAPABILITIES`)
- Modify: `stdlib/agency/local.agency` (new `localModelBackend`, docstrings)
- Modify: `lib/agents/agency-agent/lib/args.agency` (the `--local` description, line 101)
- Test: `lib/cli/localFlag.test.ts`

**Interfaces:**
- Consumes: `_resolveModel` from Task 3.
- Produces in `lib/stdlib/localModels.ts`:
  ```ts
  /** The string the MLX server reports for this model: the directory path
   *  for a directory target, else the repo id from the mlx: URI. */
  export function _mlxServedName(resolved: ResolvedModel): string;
  ```
  Plan 2's `serve` uses the same function, which is what keeps the two sides equal.
- Produces in `local.agency`: `localModelBackend(value: string): string` and `mlxServedName(value: string): string`.

- [ ] **Step 1: Write the failing tests**

In `lib/cli/localFlag.test.ts`:

```ts
describe("resolveLocalRunFlag for mlx", () => {
  it("pins the mlx provider and passes the repo id, with no download", async () => {
    const flag = await resolveLocalRunFlag("mlx:mlx-community/Qwen3-Coder-Next-4bit");
    expect(flag).toEqual({
      model: "mlx-community/Qwen3-Coder-Next-4bit",
      explicitProvider: "mlx",
    });
    expect(smoltalkPkg.hasProvider("llama-cpp")).toBe(false);
  });

  it("passes a directory alias as its absolute path", async () => {
    const model = path.join(here, `__tmp_model_${process.pid}`);
    fs.mkdirSync(model, { recursive: true });
    fs.writeFileSync(path.join(model, "config.json"), "{}");
    fs.writeFileSync(path.join(model, "model.safetensors"), "");
    try {
      const flag = await resolveLocalRunFlag(model);
      expect(flag).toEqual({ model: model, explicitProvider: "mlx" });
    } finally {
      fs.rmSync(model, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run and watch them fail**

```bash
pnpm exec vitest run lib/cli/localFlag.test.ts > /tmp/t4.log 2>&1; grep -E "×|FAIL" /tmp/t4.log | head
```

- [ ] **Step 3: Implement**

In `lib/stdlib/localModels.ts`:

```ts
export function _mlxServedName(resolved: ResolvedModel): string {
  if (isMlxUri(resolved.target)) {
    return parseMlxUri(resolved.target).repo;
  }
  return path.resolve(resolved.target);
}
```

In `lib/cli/localFlag.ts`:

```ts
export async function resolveLocalRunFlag(value: string): Promise<ResolvedModelFlag> {
  const resolved = _resolveModel(value);
  if (resolved.backend === "mlx") {
    // The server is already running, started with `agency local serve`.
    return { model: _mlxServedName(resolved), explicitProvider: "mlx" };
  }
  const modelPath = await _registerLocalModel(value);
  return { model: path.resolve(modelPath), explicitProvider: "llama-cpp" };
}
```

In `stdlib/agency/local.agency`, add:

```
export def localModelBackend(value: string): string {
  """
  Which engine runs a model: "llama-cpp" for GGUF files, "mlx" for MLX
  models served by `agency local serve`.

  @param value - name, alias, hf: URI, mlx: URI, .gguf path, or model directory
  """
  return _resolveModel(value).backend
}

export def mlxServedName(value: string): string {
  """
  The model name to send to the MLX server for this model. It is the same
  string `agency local serve` gives the server.

  @param value - name, alias, mlx: URI, or model directory
  """
  return _mlxServedName(_resolveModel(value))
}
```

Import `_resolveModel` and `_mlxServedName` at the top of the file. Update the `registerLocalModel` docstring: "For an MLX model this registers nothing and returns the name to send to the server. Start the server first with `agency local serve`."

In `shared.agency`, at the top of `configureLocalModel`:

```
  const backend = localModelBackend(value)
  if (backend == "mlx") {
    const served = mlxServedName(value)
    const m: Resolved = {
      model: served,
      provider: "mlx",
      via: "local"
    }
    applyResolved({ main: m, reasoning: m, embedding: { model: "", provider: "mlx", via: "local" } })
    refreshCapabilities(value, "mlx")
    return
  }
```

Import `localModelBackend` and `mlxServedName` from `std::agency/local` next to `registerLocalModel`. Match the file's existing formatting for the `applyResolved` call.

In `capabilities.agency`, add after the `llama-cpp` entry:

```
  // No embeddings endpoint. The models are large enough for the full prompt.
  mlx: {
    memory: false
  }
```

In `args.agency`, change the `--local` description to: "Run a local model: a curated short name, an alias, an hf: URI, a .gguf path, an mlx: URI, or a model directory. GGUF models download if needed and need: npm i -g smoltalk-llama-cpp. MLX models need a running server: agency local serve <model>. Pins all slots to the local model; mutually exclusive with --model/--fastmodel/--slowmodel."

- [ ] **Step 4: Build, run, and commit**

```bash
make > /tmp/make.log 2>&1; tail -5 /tmp/make.log
pnpm exec vitest run lib/cli/localFlag.test.ts lib/stdlib/localModels.test.ts > /tmp/t4.log 2>&1; tail -8 /tmp/t4.log
pnpm run agency test tests/agency/agency-agent-smoke > /tmp/t4b.log 2>&1; tail -5 /tmp/t4b.log
pnpm run fmt:ts && pnpm run lint:structure
git add lib/cli/localFlag.ts lib/stdlib/localModels.ts stdlib/agency/local.agency lib/agents/agency-agent/shared.agency lib/agents/agency-agent/lib/capabilities.agency lib/agents/agency-agent/lib/args.agency lib/cli/localFlag.test.ts
printf 'run --local and agent --local: use a running MLX server for mlx models\n' > /tmp/msg.txt
git commit -F /tmp/msg.txt
```

`make` is needed because `.agency` files under `lib/agents` and `stdlib` compile at build time.

---

### Task 5: `list` with a BACKEND column and MLX directories

**Files:**
- Modify: `lib/stdlib/localModels.ts` (`formatLocalList`, `_listDownloadedModels`)
- Create: `lib/stdlib/mlxModelRecord.ts`
- Test: `lib/stdlib/localModels.test.ts`, `lib/stdlib/mlxModelRecord.test.ts`

**Interfaces:**
- Produces in `mlxModelRecord.ts`:
  ```ts
  export const MLX_SUBDIR = "mlx";
  export const RECORD_FILE = ".agency-model.json";
  export type MlxFileRecord = { size: number; sha256?: string; complete: boolean; chunks?: number[] };
  export type MlxModelRecord = { repo: string; revision: string; files: Record<string, MlxFileRecord> };
  export function mlxModelDirName(repo: string): string;            // "org--repo"
  export function mlxModelDir(cacheDir: string, repo: string): string;
  export function readMlxModelRecord(dir: string): MlxModelRecord | null;
  export function writeMlxModelRecord(dir: string, record: MlxModelRecord): void;
  export function isMlxModelComplete(record: MlxModelRecord): boolean;
  ```
- Produces: `_listDownloadedModels` entries gain `backend: Backend`. MLX entries have `name` = the repo id and `path` = the directory.

- [ ] **Step 1: Write the failing tests**

Create `lib/stdlib/mlxModelRecord.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  mlxModelDirName,
  mlxModelDir,
  readMlxModelRecord,
  writeMlxModelRecord,
  isMlxModelComplete,
  RECORD_FILE,
} from "./mlxModelRecord.js";

let dir: string;
beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mlxrec-")));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("mlx model record", () => {
  it("names the directory org--repo under mlx/", () => {
    expect(mlxModelDirName("mlx-community/Qwen3-Coder-Next-4bit")).toBe(
      "mlx-community--Qwen3-Coder-Next-4bit",
    );
    expect(mlxModelDir(dir, "org/repo")).toBe(path.join(dir, "mlx", "org--repo"));
  });

  it("round-trips a record and reports completeness", () => {
    const model = path.join(dir, "mlx", "org--repo");
    fs.mkdirSync(model, { recursive: true });
    const record = {
      repo: "org/repo",
      revision: "abc",
      files: {
        "config.json": { size: 10, complete: true },
        "model.safetensors": { size: 100, sha256: "00", complete: false, chunks: [0] },
      },
    };
    writeMlxModelRecord(model, record);
    expect(readMlxModelRecord(model)).toEqual(record);
    expect(isMlxModelComplete(record)).toBe(false);
    record.files["model.safetensors"].complete = true;
    expect(isMlxModelComplete(record)).toBe(true);
  });

  it("a missing or corrupt record reads as null", () => {
    const model = path.join(dir, "mlx", "org--repo");
    fs.mkdirSync(model, { recursive: true });
    expect(readMlxModelRecord(model)).toBeNull();
    fs.writeFileSync(path.join(model, RECORD_FILE), "{not json");
    expect(readMlxModelRecord(model)).toBeNull();
  });
});
```

In `lib/stdlib/localModels.test.ts`, extend the `formatLocalList` tests: build an `entries` list with one `backend: "mlx"` entry whose target is `mlx:org/repo`, a `files` list with an MLX entry `{ name: "org/repo", path, sizeBytes, backend: "mlx", complete: true }`, and assert the rendered table has a `BACKEND` header, the row shows `mlx`, and the row has the tick. Add one MLX file entry that no catalog row claims and assert it appears under `OTHER FILES` as `org/other  (mlx)  1.00 GB`.

- [ ] **Step 2: Run and watch them fail**

```bash
pnpm exec vitest run lib/stdlib/mlxModelRecord.test.ts lib/stdlib/localModels.test.ts > /tmp/t5.log 2>&1; grep -E "×|FAIL" /tmp/t5.log | head
```

- [ ] **Step 3: Implement `mlxModelRecord.ts`**

```ts
import * as path from "node:path";
import { root, stat, readText, writeText, mkdir } from "./contained.js";

export const MLX_SUBDIR = "mlx";
export const RECORD_FILE = ".agency-model.json";

export type MlxFileRecord = { size: number; sha256?: string; complete: boolean; chunks?: number[] };
export type MlxModelRecord = { repo: string; revision: string; files: Record<string, MlxFileRecord> };

export function mlxModelDirName(repo: string): string {
  return repo.replace("/", "--");
}

export function mlxModelDir(cacheDir: string, repo: string): string {
  return path.join(cacheDir, MLX_SUBDIR, mlxModelDirName(repo));
}

/** The record in `dir`, or null when it is missing or not valid JSON. */
export function readMlxModelRecord(dir: string): MlxModelRecord | null {
  const r = root(dir);
  if (stat(r, RECORD_FILE) === null) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(readText(r, RECORD_FILE));
    if (parsed === null || typeof parsed !== "object") {
      return null;
    }
    const rec = parsed as MlxModelRecord;
    if (typeof rec.repo !== "string" || typeof rec.revision !== "string" || typeof rec.files !== "object") {
      return null;
    }
    return rec;
  } catch {
    return null;
  }
}

/** Replaces the file through a temp file and rename, so a crash mid-write
 *  leaves the previous record. */
export function writeMlxModelRecord(dir: string, record: MlxModelRecord): void {
  const r = root(dir);
  mkdir(r, ".");
  writeText(r, RECORD_FILE, JSON.stringify(record, null, 2) + "\n");
}

export function isMlxModelComplete(record: MlxModelRecord): boolean {
  return Object.values(record.files).every((f) => f.complete);
}
```

- [ ] **Step 4: Implement the listing changes**

In `lib/stdlib/localModels.ts`:

1. Change the `_listDownloadedModels` return type to `{ name: string; path: string; sizeBytes: number; backend: Backend; complete: boolean }[]`. GGUF entries get `backend: "llama-cpp", complete: true`. Then append MLX entries: for each directory under `<dir>/mlx` that has a record, push `{ name: record.repo, path: <dir>, sizeBytes: <sum of file sizes on disk>, backend: "mlx", complete: isMlxModelComplete(record) }`. Sum sizes with `list(root(modelDir), ".")`.
2. In `formatLocalList`, add `"BACKEND"` between `"NAME"` and `"PARAMS"` in `headers`, a matching column, and `backend: e.backend` on each row. For an MLX entry, the tick comes from a file whose `name` equals `parseMlxUri(e.target).repo` (or whose `path` equals the target for a directory alias) and whose `complete` is true. For an MLX file under OTHER FILES, render `  ${f.name}  (mlx)  ${formatGB(f.sizeBytes)}`.

- [ ] **Step 5: Run, then commit**

```bash
pnpm exec vitest run lib/stdlib/mlxModelRecord.test.ts lib/stdlib/localModels.test.ts lib/cli/local.test.ts > /tmp/t5.log 2>&1; tail -8 /tmp/t5.log
pnpm run fmt:ts && pnpm run lint:structure
git add lib/stdlib/mlxModelRecord.ts lib/stdlib/mlxModelRecord.test.ts lib/stdlib/localModels.ts lib/stdlib/localModels.test.ts
printf 'agency local list: a BACKEND column and downloaded MLX models\n' > /tmp/msg.txt
git commit -F /tmp/msg.txt
```

---

### Task 6: `remove` keeps files unless `-f`

**Files:**
- Modify: `lib/cli/local.ts` (`runRemove`)
- Modify: `scripts/agency.ts` (the `remove` subcommand, around line 1747)
- Modify: `lib/stdlib/localModels.ts` (`_removeModel`, new `_removeMlxModel`)
- Modify: `stdlib/agency/local.agency` (`removeModel` docstring)
- Test: `lib/cli/local.test.ts`, `lib/stdlib/localModels.test.ts`

**Interfaces:**
- Produces: `runRemove(name: string, opts: { force: boolean })`.
- Produces: `_removeMlxModel(repo: string, cacheDir?: string): boolean`, which deletes `<cacheDir>/mlx/<org>--<repo>` and returns false if absent.

- [ ] **Step 1: Write the failing tests**

In `lib/cli/local.test.ts`, with console captured the way the file already does:

```ts
describe("runRemove", () => {
  it("without -f removes the alias, keeps the files, and says how to delete them", () => {
    // alias "coder" -> a .gguf in a temp models dir, via AGENCY_MODELS_DIR
    // ...set up as in the alias round-trip test...
    runRemove("coder", { force: false });
    expect(output).toContain(`Removed alias "coder" from ${aliasFile}.`);
    expect(output).toContain("The model files are still at");
    expect(output).toContain("Run again with -f to delete them.");
    expect(fs.existsSync(ggufPath)).toBe(true);
  });

  it("with -f deletes the files", () => {
    runRemove("coder", { force: true });
    expect(fs.existsSync(ggufPath)).toBe(false);
  });

  it("a curated name without -f says there is no alias and where the file is", () => {
    runRemove("smollm2-135m", { force: false });
    expect(output).toContain('"smollm2-135m" is a built-in catalog entry, so there is no alias to remove.');
  });
});
```

In `lib/stdlib/localModels.test.ts`:

```ts
it("_removeMlxModel deletes the model directory under mlx/ and refuses anything else", () => {
  const model = path.join(dir, "mlx", "org--repo");
  fs.mkdirSync(model, { recursive: true });
  fs.writeFileSync(path.join(model, "config.json"), "{}");
  expect(_removeMlxModel("org/repo", dir)).toBe(true);
  expect(fs.existsSync(model)).toBe(false);
  expect(_removeMlxModel("org/repo", dir)).toBe(false);
});
```

- [ ] **Step 2: Run and watch them fail**

```bash
pnpm exec vitest run lib/cli/local.test.ts lib/stdlib/localModels.test.ts > /tmp/t6.log 2>&1; grep -E "×|FAIL" /tmp/t6.log | head
```

- [ ] **Step 3: Implement**

In `lib/stdlib/localModels.ts`:

```ts
/** Delete an MLX model directory from the cache. Only directories under
 *  `<cacheDir>/mlx` are ever removed. */
export function _removeMlxModel(repo: string, cacheDir: string = ""): boolean {
  const cache = root(path.join(resolveCacheDir(cacheDir), MLX_SUBDIR));
  const name = mlxModelDirName(repo);
  const info = stat(cache, name);
  if (info === null || !info.isDirectory()) {
    return false;
  }
  remove(cache, name);
  return true;
}
```

In `lib/cli/local.ts`:

```ts
export function runRemove(name: string, opts: { force: boolean }): void {
  const resolved = _resolveModel(name);
  const aliases = readModelAliases();
  const where = describeModelFiles(resolved);   // path + size line, or null if nothing on disk

  if (!opts.force) {
    if (Object.hasOwn(aliases, name)) {
      const { file } = _unaliasModel(name);
      console.log(`Removed alias "${name}" from ${file}.`);
    } else if (name in CURATED_LOCAL_MODELS) {
      console.log(`"${name}" is a built-in catalog entry, so there is no alias to remove.`);
    }
    if (where !== null) {
      console.log(`The model files are still at ${where}.`);
      console.log("Run again with -f to delete them.");
    }
    return;
  }

  if (resolved.backend === "mlx") {
    gateMlxInsideCache(resolved);   // throws "That model is not in the models directory; remove it yourself."
    const removed = _removeMlxModel(parseMlxUri(resolved.target).repo);
    console.log(removed ? `Deleted ${where}` : `Not found: ${name}`);
    return;
  }
  gate();
  const removed = _removeModel(path.basename(resolved.target));
  console.log(removed ? `Deleted ${where}` : `Not found: ${name}`);
}
```

Write `describeModelFiles` and `gateMlxInsideCache` as small helpers in the same file. `describeModelFiles` returns `"<path> (44.9 GB)"` using the manifest for GGUF and the record for MLX, or `null`.

In `scripts/agency.ts`:

```ts
  localCmd
    .command("remove")
    .description("Remove a model's alias. With -f, delete its files from the models directory")
    .argument("<name>")
    .option("-f, --force", "Delete the model files")
    .action((name: string, opts: { force?: boolean }) => localRemove(name, { force: opts.force === true }));
```

Update the `removeModel` docstring in `local.agency` to say it deletes files and is what `agency local remove -f` calls.

- [ ] **Step 4: Run, then commit**

```bash
make > /tmp/make.log 2>&1; tail -3 /tmp/make.log
pnpm exec vitest run lib/cli/local.test.ts lib/stdlib/localModels.test.ts > /tmp/t6.log 2>&1; tail -8 /tmp/t6.log
pnpm run fmt:ts && pnpm run lint:structure
git add lib/cli/local.ts scripts/agency.ts lib/stdlib/localModels.ts stdlib/agency/local.agency lib/cli/local.test.ts lib/stdlib/localModels.test.ts
printf 'agency local remove: keep files unless -f is passed\n' > /tmp/msg.txt
git commit -F /tmp/msg.txt
```

---

### Task 7: Download picker and gate

**Files:**
- Modify: `lib/cli/local.ts` (`runDownload`, `downloadChoices`, `gate`)
- Modify: `lib/stdlib/localModels.ts` (`_downloadModel`)
- Test: `lib/cli/local.test.ts`

This PR does not download MLX models. It makes `download` say so clearly.

- [ ] **Step 1: Write the failing test**

```ts
it("download of an mlx model says it is not supported yet", async () => {
  await expect(_downloadModel("mlx:org/repo")).rejects.toThrow(
    "Downloading MLX models is not supported yet. Download it another way and alias its directory: agency local alias add <name> <dir>",
  );
});
```

- [ ] **Step 2: Implement**

At the top of `_downloadModel`, before `requireSupport()`:

```ts
  const resolved = _resolveModel(value);
  if (resolved.backend === "mlx") {
    throw new Error(
      "Downloading MLX models is not supported yet. Download it another way and alias its directory: agency local alias add <name> <dir>",
    );
  }
```

In `runDownload`, move `gate()` below the resolution so an `mlx:` value reaches the message above instead of the install hint. Change the custom picker choice text to `custom (hf: URI, .gguf path, mlx: URI, or model directory)…`.

- [ ] **Step 3: Run, then commit**

```bash
pnpm exec vitest run lib/cli/local.test.ts lib/stdlib/localModels.test.ts > /tmp/t7.log 2>&1; tail -8 /tmp/t7.log
pnpm run fmt:ts && pnpm run lint:structure
git add lib/cli/local.ts lib/stdlib/localModels.ts lib/cli/local.test.ts lib/stdlib/localModels.test.ts
printf 'agency local download: say that MLX downloads come later\n' > /tmp/msg.txt
git commit -F /tmp/msg.txt
```

Plan 3 replaces this message with the real downloader.

---

### Task 8: Dev doc

**Files:**
- Create: `docs/dev/llm/mlx-local-models.md`
- Modify: `docs/dev/llm/local-models.md` (one paragraph at the top)
- Modify: `CLAUDE.md` (the LLM plumbing index, near line 315)
- Modify: `.claude/skills/agency-llm-docs/SKILL.md`

- [ ] **Step 1: Write the doc**

`docs/dev/llm/mlx-local-models.md` with these sections, each a few paragraphs in the style of `local-models.md`:

1. Two backends. What `Backend` is, where `backendOfTarget` decides, the `mlx:` prefix, and the directory rule.
2. The `backend` field. Where it is required, the two error messages, and why string aliases are exempt.
3. Running against a server. `_mlxServedName` and why `serve` and `run --local` must produce the same string. The `mlx` capabilities entry.
4. The record file. `mlxModelRecord.ts`, the directory layout, and that `list` reads it.
5. `remove` and `-f`.
6. What is not here yet: `serve` (plan 2) and download (plan 3).

Add to the top of `local-models.md`: "This page covers the `llama-cpp` backend, which runs GGUF files in-process. MLX models, which run in a server, are in `mlx-local-models.md`."

Add the index line in `CLAUDE.md` and the skill file:

```
- `docs/dev/llm/mlx-local-models.md` — The `mlx` backend: the `backend` field and `mlx:` prefix, how a run finds the served model name, the per-model record file, and the serve and download commands.
```

- [ ] **Step 2: Commit**

```bash
git add docs/dev/llm/mlx-local-models.md docs/dev/llm/local-models.md CLAUDE.md .claude/skills/agency-llm-docs/SKILL.md
printf 'docs: mlx-local-models dev doc\n' > /tmp/msg.txt
git commit -F /tmp/msg.txt
```

---

### Task 9: Check on the Studio, then open the PR

- [ ] **Step 1: Run against a hand-started server**

On the Studio, with `~/mlx-env` from the spike:

```bash
~/mlx-env/bin/python -m mlx_lm.server --model /Volumes/adit-agency-models-sept-2026/hf/hub/models--mlx-community--Qwen3-Coder-Next-4bit/snapshots/7b9321eabb85ce79625cac3f61ea691e4ea984b5 --port 8080 --max-tokens 16384
```

In another terminal:

```bash
agency local alias add coder /Volumes/adit-agency-models-sept-2026/hf/hub/models--mlx-community--Qwen3-Coder-Next-4bit/snapshots/7b9321eabb85ce79625cac3f61ea691e4ea984b5
agency local resolve coder
agency local list
pnpm run agency run --local coder spikes/mlx-tool-calling/add.agency
pnpm run agency agent --local coder --approve FileRead --print "Read secret.txt in spikes/mlx-tool-calling and tell me the passphrase."
```

Expected: `resolve` prints `mlx  /Volumes/…`, `list` shows `coder` with backend `mlx`, the program prints `add called with 17 and 25`, and the agent returns the passphrase.

- [ ] **Step 2: Typecheck, then open the PR**

```bash
pnpm run typecheck > /tmp/tc.log 2>&1; tail -3 /tmp/tc.log
pnpm run fmt:ts && pnpm run lint:structure
git push -u origin adit/mlx-backend
```

Write the PR body to a file. Say what a user can now do, list the `remove` behaviour change, and link the spec. Open with `gh pr create --body-file`. Do not merge.
