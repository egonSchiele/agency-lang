# Design: SHA-256 verification for local-model downloads

Date: 2026-06-27
Status: Approved (pending spec review)

## Goal

After a local model is downloaded, verify the file's SHA-256 against a
known-good hash pinned in the model catalog, so a tampered or corrupted GGUF is
caught before it's ever loaded. Pins are sourced cheaply from Hugging Face (no
multi-GB downloads at catalog-generation time) and the actual downloaded bytes
are hashed at verify time.

## Background / research (settled facts)

- **node-llama-cpp does not verify checksums.** Its `resolveModelFile({verify})`
  only re-checks file presence/size; there's no sha256 anywhere in its dist. Its
  downloader (`ipull`) validates `content-length` only. This matches the
  ecosystem norm (huggingface_hub doesn't enforce sha256 by default; llama.cpp
  has it only as open feature requests) — cryptographic verification against a
  *known-good* hash is the application's job. We are that layer.
- **The pin source is `X-Linked-ETag`.** A `HEAD` on a model's
  `…/resolve/<rev>/<file>.gguf` returns `X-Linked-ETag`, which equals the file's
  content SHA-256 — for both LFS- and Xet-stored repos (the `etag`/`X-Xet-Hash`
  headers are a *different* chunk hash; do not use them). Verified end-to-end:
  for SmolLM2-135M, `X-Linked-ETag` == `sha256(downloaded file)` exactly.
- **Sharding.** node-llama-cpp keeps GGUF-split parts (`-00001-of-N.gguf`) as
  separate files (each has its own content sha256) but splices binary-split
  parts (`.partNofM`) into one combined file (no single per-part hash). Our
  entire curated Q4_K_M catalog is **single-file** (confirmed: even the 18.5 GB
  Qwen3-Coder-30B is one file). So v1 verifies single-file models only;
  sharded models are skipped (tracked in issue #348).

## Decisions

1. **Verify the actual downloaded bytes** against the pinned hash. The header is
   used only at generation time to *mint* the pin; at verify time we hash the
   file on disk.
2. **Verify once, on download** — not on every startup. No marker file. We
   detect a fresh download by snapshotting the cache dir before/after
   `resolveModel`; an already-present file is assumed previously verified and is
   not re-hashed (the file doesn't change locally).
3. **On mismatch, rename** `<file>.gguf` → `<file>.gguf.invalidSha` (so it isn't
   picked up and triggers a clean re-download next time, but is left for the
   user to inspect) and throw a clear error.
4. **Opportunistic.** Verify when a pin exists; skip silently otherwise
   (sharded, user aliases, raw URIs) — see the "No pin" case below.
5. **Pin in both** `CURATED_LOCAL_MODELS` and the seed catalog, so the default
   offline `--local-model <name>` (no refresh) is verified too.
6. **v1 single-file only.** One `sha256` string per entry; sharded skipped.

## Schema changes

Add an optional `sha256` everywhere a model's metadata travels:

- `ModelInfo` (curated): `sha256?: string` (the pinned content hash).
- `CatalogModel` + `CatalogModelSchema` (zod): `sha256: z.string().optional().catch(undefined)`.
- `AliasObject`: `sha256?: string` (so refreshed remote aliases carry it — it
  already flows through `_refreshCatalog`'s `{ ...model, source: "remote" }`).
- `ModelNameEntry` + `metaFrom`: include `sha256` so it surfaces in listings
  (optional; not displayed, but keeps the projection complete).

## Verification flow (`lib/stdlib/localModels.ts`)

A pure helper:

```ts
/** Stream-hash a file's SHA-256 (hex). */
export async function fileSha256(path: string): Promise<string>

/** Verify `path` against `expected` (hex sha256). On mismatch, rename the file
 *  to `<path>.invalidSha` (left for inspection) and throw. */
export async function verifyModelFile(path: string, expected: string, name: string): Promise<void>
```

`fileSha256` streams via `crypto.createHash("sha256")` + `fs.createReadStream`
(never buffers the whole file). `verifyModelFile` renames on mismatch
(`fs.renameSync(path, path + ".invalidSha")`) and throws
`SHA-256 verification failed for "<name>": expected <e>, got <a>. The file was kept at <path>.invalidSha for inspection.`

Pin lookup:

```ts
/** The pinned sha256 for a model name/alias, or undefined when none is known
 *  (raw uri/path, user alias without a hash, or a sharded model). */
export function pinnedSha256(value: string, file?: string): string | undefined
```

`pinnedSha256` mirrors `_resolveModelName`'s lookup: an alias object's `sha256`
wins, else the curated entry's `sha256`, else undefined. A raw `hf:`/`https:`/
`.gguf` value has no entry → undefined → skip.

`_downloadModel` integration (verify only on fresh download):

```ts
export async function _downloadModel(value, cacheDir = "") {
  // … resolve provider as today …
  const dir = resolveCacheDir(cacheDir);
  const before = listGgufBasenames(dir);           // {} when dir absent
  const path = await mod.resolveModel(target, dir);
  const expected = pinnedSha256(value, "");
  const freshlyDownloaded = !before.has(basename(path));
  if (expected !== undefined && freshlyDownloaded) {
    await verifyModelFile(path, expected, value);
  }
  return path;
}
```

`listGgufBasenames(dir)` returns the set of `*.gguf` filenames already present
(empty if the dir doesn't exist). A cache hit (file already there) → not fresh →
skip. A genuine download → fresh → verify once.

## Generating the pins (maintainer dev script)

`scripts/genModelHashes.ts` (run by a maintainer, not CI; analogous to seeding
`model-catalog.json`):

For each `CURATED_LOCAL_MODELS` entry whose `uri` is `hf:user/repo:quant`:
1. List the repo's files via the HF API (`/api/models/<user>/<repo>`).
2. Find the GGUF matching the quant (`*<QUANT>*.gguf`). **Exactly one** → single
   file; **zero or many** → sharded/ambiguous → skip (no pin, warn).
3. `HEAD` `https://huggingface.co/<user>/<repo>/resolve/main/<file>` and read
   `X-Linked-ETag` → strip quotes → that's the `sha256`.
4. Write `sha256` into the curated entry and the seed `model-catalog.json`.

The script prints the curated `sha256` values to paste into
`CURATED_LOCAL_MODELS` (hand-maintained, 13 entries, infrequent) and rewrites
`data/model-catalog.json`. It does **no** multi-GB downloads.

## Failure & edge behavior

- **Mismatch** → file renamed to `.invalidSha`, hard error; `--local-model`
  already exits on a failed setup, so it surfaces cleanly and never loads.
- **No pin** (sharded, user alias, raw uri) → skip silently (verification is
  best-effort; no output, so normal unpinned use isn't noisy).
- **Cache hit** → no re-hash (verify-once-on-download).
- **Catalog pin changed** (model updated via `refresh`) → the cached file is the
  *old* file; on the next genuine download of the new bytes it's verified against
  the new pin. (We do not re-hash existing files, so a stale cached file is not
  retroactively re-checked — acceptable: changing the pin doesn't force eviction,
  but any fresh fetch is verified.)

## Documentation

- **New `docs/dev/local-models.md`** — a developer overview of the whole
  local-model system: provider registration (`llama-cpp.mjs` / smoltalk),
  name resolution (curated / alias / `hf:`/`.gguf`), download + resolve
  (`_downloadModel` → node-llama-cpp), the generalized alias model, catalog
  refresh, and **this** SHA-256 verification. Explicitly states: **we do not
  verify SHAs for sharded models yet** (link issue #348). The existing
  `docs/dev/local-model-integration.md` (integration-test focused) is linked
  from it.
- Add the new doc to the doc index in `CLAUDE.md`.

## Testing

- `fileSha256` / `verifyModelFile`: a small temp file with known content/hash.
  match → resolves; mismatch → file renamed to `.invalidSha` + throws; the
  original path no longer exists.
- `pinnedSha256`: curated hit, alias-object hit (wins over curated), raw uri →
  undefined.
- `_downloadModel` verify-on-fresh-download: extend the existing fake-provider
  pattern (`AGENCY_LLAMA_PROVIDER_MODULE`) so the fake `resolveModel` writes a
  file with known bytes into the cache dir. Assert: pinned + matching hash →
  ok; pinned + mismatched → renamed + throws; **second call with the file
  already present → no re-verify** (e.g. a deliberately-wrong pin is *not*
  enforced on the cache-hit path); no pin → skipped.
- No multi-GB downloads in any test.

## Out of scope (→ issue #348)

- GGUF-split per-part verification and binary-split compute-and-pin.
- Re-verifying already-cached files / eviction on pin change.

## File-by-file

- `lib/stdlib/localModels.ts` — `sha256` on the types + zod schema;
  `fileSha256`, `verifyModelFile`, `pinnedSha256`, `listGgufBasenames`;
  `_downloadModel` integration.
- `scripts/genModelHashes.ts` — new maintainer script.
- `data/model-catalog.json` — regenerated with `sha256` per model.
- `lib/stdlib/localModels.test.ts` — verification + pin-lookup + fresh-download tests.
- `docs/dev/local-models.md` — new overview doc; `CLAUDE.md` doc index updated.
