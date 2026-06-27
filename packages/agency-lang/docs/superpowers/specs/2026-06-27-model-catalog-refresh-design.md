# Design: Refreshable local-model catalog (`agency local refresh`)

Date: 2026-06-27
Status: Approved (pending spec review)

## Goal

Let users pull an updated list of recommended local models from a GitHub-hosted
JSON blob and have those models appear in `agency local alias list` and resolve
via `agency agent --local-model <name>` — **without upgrading the agency
package**. New/updated model recommendations ship by editing one file on `main`.

The hardcoded `CURATED_LOCAL_MODELS` constant stays as an offline base layer; the
refreshed data layers on top through the existing alias-merge path.

## Decisions (from brainstorming)

1. **Don't replace `CURATED_LOCAL_MODELS`.** Layer refreshed data on top via the
   alias mechanism. The constant remains the always-available offline base.
2. **Generalize the alias model** to optionally carry rich metadata. No
   backwards compatibility is required, so the stored shape changes freely.
3. **Store refreshed entries in `agency.json` `client.modelAliases`, tagged**
   `source: "remote"`. Re-refresh rewrites only tagged entries; the user's own
   (untagged) aliases are never touched.
4. **Collision rule:** if a remote model's name equals one of the user's own
   aliases, the user's alias wins — the remote entry is skipped and a notice
   prints **both** the kept value and the remote value that was rejected.
5. **Source URL:** baked-in default with overrides (CLI arg → env → config →
   default). Canonical file lives in-repo, served raw from `main`.

## 1. Generalized alias model

A value in `client.modelAliases` becomes `string | AliasObject`:

- **string** — the URI, as today (hand-edit shorthand):
  `"my7b": "hf:Qwen/Qwen2.5-7B-Instruct-GGUF:Q4_K_M"`
- **object** — `AliasObject`:

```ts
type AliasObject = {
  uri: string;                 // required: hf: / https: URI or .gguf path
  source?: "remote";           // present ⇒ refresh-managed; absent ⇒ user-owned
  params?: string;
  sizeBytes?: number;
  category?: ModelCategory;
  contextWindow?: number;
  license?: string;
  description?: string;
};
```

Only `uri` is required; all metadata is optional. The address field is named
`uri` to match `ModelInfo` and the catalog blob (not `target`).

Touch points in `lib/stdlib/localModels.ts`:

- `readModelAliases` → `Record<string, string | AliasObject>`.
- New `normalizeAlias(name, value)` → `{ name, uri, source, ...metadata }`.
- `_resolveModelName` reads `uri` from either string or object form (alias still
  wins over curated, as today via `aliasTarget ?? curated?.uri`).
- `_listModelNames` merges curated + aliases, **deduped by name, alias wins**, so
  a remote `qwen3.5-2b` shadows the built-in and shows once. Metadata flows from
  the alias object into the existing optional fields of `ModelNameEntry`.
- `_aliasModel` (used by `agency local alias add`) keeps writing a **string**
  alias (user-owned, no `source`). Unchanged surface.

Edge case: a user string-alias whose name equals a curated model shadows it
fully (alias wins) and, lacking metadata, renders in the bare `ALIASES` section
rather than the table. This is rare and acceptable; refreshed entries always
carry metadata, so they always render richly.

## 2. Catalog JSON format & source

Canonical file: `packages/agency-lang/data/model-catalog.json`, served raw from
`main`. Seeded by serializing today's `CURATED_LOCAL_MODELS` into the schema
below (the constant and the file may diverge over time — the constant is the
offline base, the file is the live source).

```json
{
  "version": 1,
  "models": {
    "qwen3.5-2b": {
      "uri": "hf:unsloth/Qwen3.5-2B-GGUF:Q4_K_M",
      "params": "2B",
      "sizeBytes": 1280000000,
      "category": "general",
      "contextWindow": 131072,
      "license": "apache-2.0",
      "description": "Most popular modern small general model; runs on CPU comfortably."
    }
  }
}
```

- `version` (number) gates forward compatibility: refresh accepts `1` and refuses
  anything greater with a clear "upgrade agency" message.
- `models` is an object keyed by model name (mirrors `CURATED_LOCAL_MODELS`).

**URL resolution** (first wins):

1. CLI arg: `agency local refresh <url>`
2. env: `AGENCY_MODEL_CATALOG_URL`
3. config: `client.modelCatalogUrl` in the nearest `agency.json`
4. built-in default:
   `https://raw.githubusercontent.com/egonSchiele/agency-lang/main/packages/agency-lang/data/model-catalog.json`

## 3. The `agency local refresh [url]` command

Algorithm (in `_refreshCatalog`, see §5 for the injectable seams):

1. Resolve the URL via the precedence above.
2. `fetch` over HTTPS with an `AbortController` timeout (~15s) and a response
   size cap (~5 MB). Require `res.ok`; HTTPS-only for remote URLs (an injected
   fetcher bypasses this for tests).
3. Parse + validate:
   - **Blob-level** (abort the whole refresh on failure, leaving `agency.json`
     untouched): valid JSON, `version` supported, `models` is an object.
   - **Entry-level** (skip the offending entry with a warning, keep going):
     `uri` is a non-empty `hf:`/`https:`/`.gguf` value. Metadata fields are
     type-checked leniently — a bad field is dropped, the entry is kept.
4. Partition existing `modelAliases` into **managed** (`source === "remote"`) and
   **user** (everything else). Drop all managed entries.
5. For each model in the blob:
   - If its name collides with a **user** entry → **skip**, record
     `{ name, keptValue, remoteUri }`.
   - Else write `{ uri, source: "remote", ...metadata }`.
6. Write `agency.json`. On any failure before this point, the file is untouched.
7. Print, per skip:

   ```
   Skipped "qwen3.5-2b": kept your alias (hf:my/custom-qwen:Q4_K_M);
     remote would have set hf:unsloth/Qwen3.5-2B-GGUF:Q4_K_M
   ```

   then a summary:

   ```
   Refreshed N models from <url> → <agency.json path>
     (A added, U updated, R removed, S skipped)
   ```

   where, with `blobNames` = blob model names, `skipped` = blob names colliding
   with user entries, `applied` = `blobNames − skipped`, `oldManaged` = previous
   `source:"remote"` names: `added = applied − oldManaged`,
   `updated = applied ∩ oldManaged`, `removed = oldManaged − blobNames`.

8. Exit 0 on success (collisions are expected, not errors); exit 1 only on
   fetch/parse/blob-validation failure.

**No install gate.** Refreshing is metadata-only, so it works without
`smoltalk-llama-cpp` (like `alias add`/`list`, unlike `download`/`remove`).

## 4. How the list renders

`formatModelCatalog` (already extracted to `localModels.ts`):

- **Table** = every entry with metadata: curated built-ins + rich/remote
  aliases, deduped by name with the alias winning.
- **`ALIASES` section** = only metadata-less (plain `name→uri`) aliases.

So refreshed models render in the aligned table exactly like curated ones; the
agent's bare `--local-model` output (which calls the same formatter) gets them
for free.

## 5. Testing & security

**Injectable seams** (no live network in tests, mirrors the existing
`_aliasModel(file)` pattern): `_refreshCatalog({ url?, fetcher?, file? })` where
`fetcher(url) => Promise<string>` defaults to the real HTTPS fetch, and `file`
defaults to the resolved `agency.json`.

Test coverage:

- URL-resolution precedence (arg > env > config > default).
- Blob validation: well-formed, malformed JSON, unsupported `version`, `models`
  not an object, per-entry bad `uri` skipped-with-warning.
- Merge writer: drops old managed, preserves user aliases, **skips collisions and
  reports kept + remote values**, removes models dropped from the blob, computes
  added/updated/removed/skipped correctly.
- `_resolveModelName` / `_listModelNames` with object aliases (alias wins).
- `formatModelCatalog` renders rich/remote aliases in the table.

**Security**: the default URL is the project's own repo over HTTPS. Refresh only
stores `name→uri` + display metadata; the URI is not acted upon until a separate
explicit `--local-model <name>` / `local download` (the existing download trust
boundary). HTTPS-only + response-size cap + timeout guard the fetch. A failed or
malformed refresh never mutates `agency.json`.

## File-by-file changes

- `lib/stdlib/localModels.ts` — `AliasObject` type; `normalizeAlias`; update
  `readModelAliases`, `_resolveModelName`, `_listModelNames`, `formatModelCatalog`;
  add `catalogUrl` resolution + `_refreshCatalog`.
- `lib/cli/local.ts` — `runRefresh(url?)` calling `_refreshCatalog`, printing the
  skip notices + summary.
- `scripts/agency.ts` — wire `local refresh [url]`.
- `packages/agency-lang/data/model-catalog.json` — new seed file from
  `CURATED_LOCAL_MODELS`.
- `docs/site/cli/local.md` — document `refresh`, the URL precedence, and the
  rich-alias / `source:"remote"` storage.
- `docs/misc/config.md` (or the config reference) — note `client.modelCatalogUrl`.
- Tests: new `lib/stdlib/localModels.refresh.test.ts`; update existing
  `localModels.test.ts` for object aliases.

## Out of scope (YAGNI)

- Auto-refresh / refresh-on-a-schedule. Manual command only.
- Signing/checksums of the catalog beyond HTTPS.
- A dev script to regenerate `model-catalog.json` from `CURATED_LOCAL_MODELS`
  (optional later; the initial file is committed by hand).
