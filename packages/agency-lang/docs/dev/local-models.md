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
