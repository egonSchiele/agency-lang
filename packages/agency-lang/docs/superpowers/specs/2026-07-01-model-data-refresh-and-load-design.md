# Model Data: Refresh-to-stdout + opt-in `loadModelData` — Design

**Status:** Design (approved to spec)
**Date:** 2026-07-01
**Supersedes:** the Phase-2 (PR #379) behavior of `agency models refresh`, which registered the fetched blob into smoltalk's in-memory catalog and printed a count — which is a documented no-op across CLI processes because the registration does not persist. This design replaces that with an explicit, opt-in refresh→save→load flow.

## Motivation

`agency models refresh` (Phase 2) fetched smoltalk's model-data blob and called `registerModelData`, which writes an in-process module global that evaporates when the CLI process exits. So a later `agency models list` saw only the baked catalog — the refresh had no durable effect.

Rather than invent a fixed on-disk cache that every program loads at startup (a hidden startup cost + coupling forced on programs that never touch model metadata), this design makes persistence and loading **explicit and opt-in**:

- `agency models refresh` becomes a pure fetch-and-print. It writes the fetched JSON to **stdout** and does nothing else. The user decides where it goes.
- A new `std::llm.loadModelData(path)` lets a program **explicitly** load a model-data file, layering it over smoltalk's catalog for that program only.

Programs that don't call `loadModelData` pay nothing.

## Goals

- `agency models refresh [url]` prints a model-data JSON blob to stdout (redirectable to any file).
- `std::llm.loadModelData(path): Result<number, string>` loads a model-data file and registers it, affecting **all** catalog reads in that program: `llm()` model resolution + cost accounting, and `listHostedModels()` / `hostedModelInfo()`.
- Multiple `loadModelData` calls **accumulate** (later loads layer over earlier; both over baked).
- The file is a hand-editable JSON file the user owns; its shape is exactly what `refresh` prints.

## Non-goals (YAGNI)

- No fixed `models.json` location, no walk-up resolution, no bootstrap auto-load.
- No merge-policy/source-tagging file format — the file is a plain smoltalk `ModelDataBlob`; "user overrides" happen by hand-editing that file, and accumulation order (load order) resolves precedence.
- `agency models list` stays a viewer of the **baked** catalog for the CLI process; it does not read a user file. (A `--file` preview flag is a possible future extension, not in scope.)

## Data flow

```
$ agency models refresh > my-models.json     # fetch latest, save (user's choice of path)
# (optional) hand-edit my-models.json to add/override a model

# in an Agency program:
const r = loadModelData("my-models.json")    # opt-in; registers the blob
# from here, llm(), cost accounting, listHostedModels(), hostedModelInfo()
# all see my-models.json's models, layered over smoltalk's baked catalog.
```

## File format

The file is a smoltalk `ModelDataBlob` — exactly what `refresh` prints and what `loadModelData` reads:

```jsonc
{
  "schemaVersion": 1,
  "generatedAt": "2026-07-01T...",
  "models": [ /* ModelType[] — text/image/embeddings/etc. */ ],
  "hostedTools": [ /* HostedTool[] */ ]
}
```

`loadModelData` requires only that `models` is an array; `hostedTools`, `schemaVersion`, `generatedAt` are optional. A hand-editing user typically keeps a trimmed file with just the `models` they care about.

## Interfaces

### TS natives — `lib/stdlib/llm.ts`

Replace `_refreshHostedCatalog` (register + count) with a fetch-only helper, and add the loader. Both keep smoltalk types out of their callers by returning plain status objects.

```ts
// Fetch the latest model-data blob; return it pre-serialized. No registration.
export async function _fetchModelData(
  url: string,
): Promise<{ ok: boolean; json: string; error: string }> {
  const res = await refreshModels(url ? { url } : {});
  if (res.success) {
    return { ok: true, json: JSON.stringify(res.value, null, 2), error: "" };
  }
  return { ok: false, json: "", error: res.error };
}

// Read a model-data file and register it, ACCUMULATING over any previously
// registered data (this file wins on name collisions) and over the baked
// catalog. Errors are returned, not thrown, so the Agency wrapper can surface
// them as a Result.
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
  // a cross-version merge could mix incompatible field shapes. Fail loudly
  // instead of silently producing a corrupt blob. (Same-version accumulation is
  // the normal path; this only trips if two files from different smoltalk
  // versions are loaded in one process.)
  if (prior && blob.schemaVersion != null && prior.schemaVersion != null && blob.schemaVersion !== prior.schemaVersion) {
    return {
      ok: false,
      count: 0,
      error: `${path} has schemaVersion ${blob.schemaVersion} but ${prior.schemaVersion} is already loaded; load only matching-version data`,
    };
  }
  const merged = prior
    ? {
        schemaVersion: blob.schemaVersion ?? prior.schemaVersion,
        generatedAt: blob.generatedAt ?? prior.generatedAt,
        // Overlay (this file) wins on the `provider:modelName` key and
        // deep-merges fields, so a partial hand-edited entry augments the prior
        // one rather than clobbering unlisted fields.
        models: mergeModelData(prior.models, blob.models),
        hostedTools: mergeHostedTools(prior.hostedTools ?? [], blob.hostedTools ?? []),
      }
    : blob;
  // registerModelData REPLACES smoltalk's single registered slot (verified:
  // `registeredModelData = blob` in smoltalk/dist/models.js), so `merged` must
  // carry everything — hence the pre-merge above. No double-apply.
  registerModelData(merged);
  return { ok: true, count: blob.models.length, error: "" };
}
```

Smoltalk helpers used (all already exported by smoltalk 0.7.0, verified in `dist/models.js` / `dist/modelData.js`): `refreshModels`, `registerModelData` (pure replace), `getRegisteredModelData`, `mergeModelData` (overlay-wins on `provider:modelName`, deep-merges fields), `mergeHostedTools`. The `catch` blocks return the error text in the status object (the Agency wrapper turns it into `failure(...)`) — they do not swallow it.

### Agency wrapper — `stdlib/llm.agency`

Extend the native import with `_loadModelData` (the Agency layer does not need `_fetchModelData` — that is CLI-only) and add:

```agency
export def loadModelData(path: string): Result<number, string> {
  """
  Load additional model data from a JSON file (the shape printed by
  `agency models refresh`) and register it for this program. Both the file's
  `models` and its (optional) `hostedTools` are layered over any previously
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

`_fetchModelData` is consumed only by the CLI (below), so it is not re-exported through `std::llm`.

### CLI — `lib/cli/hostedModels.ts` + `scripts/agency.ts`

`modelsRefresh` prints the JSON to stdout; errors go to stderr with a non-zero exit code (so `agency models refresh > f.json` yields a clean file, and a failed run is detectable in a pipeline):

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

Update the `models refresh` subcommand description in `scripts/agency.ts` to:
> "Fetch the latest model data and print it as JSON (redirect to a file, then load it with `std::llm.loadModelData`)."

`selectHostedModels` / `formatHostedCatalog` / `modelsList` are unchanged.

## Precedence

After N `loadModelData` calls: **latest-loaded file > earlier-loaded files > smoltalk baked catalog.** `mergeModelData(base, overlay)` (overlay wins) is applied with `base = getRegisteredModelData()` and `overlay = the new file`, and smoltalk's own `getModel`/`getAllModels` then layer the single registered blob over the baked catalog.

## Error handling

- **refresh:** network / parse failure → `Refresh failed: <error>` on stderr, `process.exitCode = 1`, nothing on stdout. Caveat: the shell truncates the redirect target before the command runs, so a failed `agency models refresh > f.json` leaves `f.json` empty; the user re-runs. We do not try to work around shell redirection.
- **loadModelData:** missing file, invalid JSON, or a payload with no `models` array → `failure("<reason>")`. The `models` array is the only structural requirement; individual malformed model entries are smoltalk's concern at use time, not validated here.
- **loadModelData schema-version guard:** if a file's `schemaVersion` is present and differs from the version already registered by a prior load, the call returns a `failure` rather than stitching different-shape models together. Same-version accumulation is the normal path; this only trips when two files produced by different smoltalk versions are loaded in one process. (A first load, or a file without `schemaVersion`, is never blocked.)

## Testing

- **CLI (`lib/cli/hostedModels.test.ts`)** — mock the native:
  - `modelsRefresh` on success writes a single `console.log` whose argument is valid JSON parseable back into an object with a `models` array — **and writes nothing to `console.error`** (a script parsing stdout must not get stderr contamination on the happy path).
  - on failure writes to `console.error`, sets `process.exitCode = 1`, and writes nothing to `console.log`.
- **`_loadModelData` (`lib/stdlib/llm.test.ts`)** — using temp fixture files (or a mocked `fs` + real smoltalk merge):
  - loading file A then file B → `getAllModels()` (or `_listHostedModels`) contains models from both; on a `provider:modelName` collision, B's version wins and B's fields deep-merge over A's (accumulate + overlay-wins).
  - **`hostedTools` accumulation:** file A carries `hostedTools`, file B carries only `models` → after both loads, A's hosted tools survive and B's models are present (the models-only overlay doesn't wipe prior hosted tools); and two files each carrying a hosted tool → both present.
  - returns `{ ok: true, count }` equal to **the file's** `models` length (not the running total).
  - missing file / invalid JSON / no `models` array → `{ ok: false, error }` (non-empty message), and the registered data is unchanged.
  - schema-version mismatch: load a v1 file, then a v2 file → second call returns `{ ok: false }` and leaves the v1 registration intact.
- **Agency (`tests/` under stdlib or agency-agent)** — `loadModelData(fixture)` returns `success(n)`, and a subsequent `listHostedModels()` includes the fixture's model; `loadModelData("nope.json")` returns a `failure`.

## Migration notes

- `_refreshHostedCatalog` is removed; `_fetchModelData` replaces it. Update `lib/cli/hostedModels.test.ts` (the current success/failure refresh tests assert a printed count; they change to assert printed JSON).
- Remove the "KNOWN LIMITATION — refresh does not persist" note from the Phase-2 plan/code; this design resolves it by making persistence explicit.
- The `std::llm` stdlib docs regenerate (`make`) to include `loadModelData`.
- **CLI docs:** the `agency models` command currently has **no** doc page (only `docs/site/cli/local.md` exists). Add `docs/site/cli/models.md` documenting `models list` (with filters) and the new `models refresh` → stdout + `loadModelData` workflow, including an `agency models refresh > my-models.json` example.
