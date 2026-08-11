# Local models

How `agency`'s local-model support is wired, end to end.

## Provider

Local inference runs through `smoltalk`'s `llama-cpp` provider. Since
smoltalk 0.11, smoltalk itself owns loading it: smoltalk-llama-cpp is
smoltalk's *optional peer dependency*, and smoltalk's `loadLlamaCpp()`
imports the package, validates its shape, and registers the provider —
re-registering from its cached module whenever the name is absent, so a
later `unregisterProvider` is undone by the next load call. `text()` calls
with `provider: "llama-cpp"` auto-load it.

Agency's half is `lib/runtime/localProvider.ts`, which owns finding the
package in layouts smoltalk cannot see:

- `loadLocalProvider()` calls smoltalk's `loadLlamaCpp`, picking the entry
  path via the pure `chooseEntryPath`: the `AGENCY_LLAMA_PROVIDER_MODULE`
  override first, then nothing when the package resolves locally (smoltalk
  bare-imports it), then the global npm/pnpm roots probe
  (`resolveSmoltalkLlamaCppFromRoots`) for `npm i -g` installs.
- `ensureConfiguredLocalProvider(execCtx)` runs at both bootstrap sites
  (`runtime/node.ts` fresh runs, `runtime/interrupts.ts` resumes) right
  after `loadProviderModules`: when the baked config's
  `smoltalkDefaults.provider` is `llama-cpp`, it pre-loads the provider so
  a compiled child process works even for global installs.

`AGENCY_LLAMA_PROVIDER_MODULE` is the test/advanced escape hatch: an entry
path to a *plugin-shaped* module — one exporting a `LlamaCPP` class and
`resolveModel(uriOrPath, cacheDir)`, the same shape smoltalk validates on
the real package. (Before smoltalk 0.11 it pointed at a `register()`-shaped
wrapper; the bundled `lib/stdlib/providers/llama-cpp.mjs` wrapper, the
`AGENCY_SMOLTALK_LLAMA_CPP_PATH` relay, and the path-splitting
`llamaModelConfig.ts` are all gone — `LlamaCPP` itself accepts a `.gguf`
path as the model now.)

Registration is lazy either way; nothing loads `node-llama-cpp` until a
local model is actually used.

## Name resolution

`_resolveModelName(value)` maps a value to a model URI/path:

1. A `.gguf` path or an `hf:`/`https:` URI passes through unchanged.
2. An alias in `client.modelAliases` (nearest `agency.json`) wins next — a
   value is either a bare URI string or an object
   `{ uri, …metadata, source?, sha256? }`.
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
  equals the file's content sha256 — verified end-to-end against a real
  download).
- After a **fresh** download (detected via a cache-dir snapshot,
  `snapshotFreshness` — we never re-hash an already-present file), we
  stream-hash the file and compare it to the pin (`verifyModelFile`).
- On a mismatch the file is renamed to `<file>.gguf.invalidSha` (kept for
  inspection, not loaded) and an error is thrown.
- Verification is **opportunistic**: models with no pin (user aliases, raw
  URIs) are simply not verified. A user alias may opt in by setting its own
  `sha256` on the alias object; it never borrows a curated model's hash.

Because we verify only freshly-downloaded files, a pin change (e.g. via
`agency local refresh`) does **not** retroactively re-check a file you already
have cached. Run `agency local remove <name>` to force a fresh, verified
re-download.

### Updating the pins

**When you add a curated model, change a model's `uri`/quant, or an upstream
repo re-uploads its GGUF, re-run the minting script** so the pinned hash matches
the file users will download:

```bash
cd packages/agency-lang
make build && node ./dist/scripts/genModelHashes.js
```

It HEADs each model's HF resolve URL, rewrites `data/model-catalog.json` with
the fresh `sha256` values, and prints the lines to paste into
`CURATED_LOCAL_MODELS`. A stale pin makes a legitimate file fail verification,
so treat the script as the source of truth and the committed hashes as a
snapshot.

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
