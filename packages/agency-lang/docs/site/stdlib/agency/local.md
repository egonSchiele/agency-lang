---
name: "local"
---

# local

Manage and run local models (GGUF via smoltalk-llama-cpp). Download by
  curated short name or Hugging Face URI, alias names, list/remove downloads,
  and register the local provider for `llm()` calls. Requires the
  smoltalk-llama-cpp package to be installed.

## Types

### DownloadedModel

```ts
export type DownloadedModel = {
  name: string;
  path: string;
  sizeBytes: number
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency/local.agency#L23))

### ModelName

A listed model name. Curated entries carry full metadata; user aliases
 *  carry only `name`/`target`/`source` (the metadata fields are undefined).

```ts
/** A listed model name. Curated entries carry full metadata; user aliases
 *  carry only `name`/`target`/`source` (the metadata fields are undefined). */
export type ModelName = {
  name: string;
  target: string;
  source: string;
  params?: string;
  sizeBytes?: number;
  category?: string;
  description?: string;
  contextWindow?: number;
  license?: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency/local.agency#L27))

### SkippedAlias

A catalog model whose name collided with one of your own aliases: refresh
 *  kept your alias (`keptUri`) and did not write the catalog's `remoteUri`.

```ts
/** A catalog model whose name collided with one of your own aliases: refresh
 *  kept your alias (`keptUri`) and did not write the catalog's `remoteUri`. */
export type SkippedAlias = {
  name: string;
  keptUri: string;
  remoteUri: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency/local.agency#L133))

### RefreshResult

The outcome of `refreshCatalog`. The name lists partition the catalog's
 *  managed (`source:"remote"`) entries by what changed; `skipped` are entries
 *  yielded to your own aliases; `modelCount` is the total catalog size, so
 *  `added + updated + unchanged + skipped == modelCount`.

```ts
/** The outcome of `refreshCatalog`. The name lists partition the catalog's
 *  managed (`source:"remote"`) entries by what changed; `skipped` are entries
 *  yielded to your own aliases; `modelCount` is the total catalog size, so
 *  `added + updated + unchanged + skipped == modelCount`. */
export type RefreshResult = {
  url: string;
  file: string;
  added: string[];
  updated: string[];
  unchanged: string[];
  removed: string[];
  skipped: SkippedAlias[];
  modelCount: number
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency/local.agency#L143))

## Functions

### localModelsSupported

```ts
localModelsSupported(): bool
```

True if smoltalk-llama-cpp is installed.

**Returns:** `bool`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency/local.agency#L39))

### resolveModelName

```ts
resolveModelName(value: string): string
```

Map a curated short name or alias to its Hugging Face URI; pass URIs and
  .gguf paths through unchanged.

  @param value - name, alias, hf: URI, or .gguf path

**Parameters:**

| Name | Type | Default |
|---|---|---|
| value | `string` |  |

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency/local.agency#L44))

### downloadModel

```ts
downloadModel(value: string, cacheDir: string): string
```

Download a model (curated name, alias, hf: URI) if not cached and return its
  local .gguf path.

  @param value - what to download
  @param cacheDir - download dir (empty string = per-user cache)

**Parameters:**

| Name | Type | Default |
|---|---|---|
| value | `string` |  |
| cacheDir | `string` | "" |

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency/local.agency#L54))

### listDownloadedModels

```ts
listDownloadedModels(cacheDir: string): DownloadedModel[]
```

List downloaded .gguf models.

  @param cacheDir - models dir (empty string = per-user cache)

**Parameters:**

| Name | Type | Default |
|---|---|---|
| cacheDir | `string` | "" |

**Returns:** `DownloadedModel[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency/local.agency#L65))

### listModelNames

```ts
listModelNames(): ModelName[]
```

List usable short names: curated built-ins and your aliases.

**Returns:** `ModelName[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency/local.agency#L74))

### aliasModel

```ts
aliasModel(name: string, uri: string): string
```

Add a short-name alias for a model URI; returns the edited agency.json path.

  @param name - the alias
  @param uri - the hf: URI it maps to

**Parameters:**

| Name | Type | Default |
|---|---|---|
| name | `string` |  |
| uri | `string` |  |

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency/local.agency#L79))

### unaliasModel

```ts
unaliasModel(name: string): string
```

Remove a short-name alias; returns the inspected agency.json path (file
  unchanged if the alias was missing).

  @param name - the alias to remove

**Parameters:**

| Name | Type | Default |
|---|---|---|
| name | `string` |  |

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency/local.agency#L89))

### removeModel

```ts
removeModel(name: string, cacheDir: string): bool
```

Delete a downloaded model file; false if it was not present.

  @param name - the .gguf filename
  @param cacheDir - models dir (empty string = per-user cache)

**Parameters:**

| Name | Type | Default |
|---|---|---|
| name | `string` |  |
| cacheDir | `string` | "" |

**Returns:** `bool`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency/local.agency#L99))

### registerLocalProvider

```ts
registerLocalProvider()
```

Register the llama-cpp provider so local models can be used by llm().

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency/local.agency#L109))

### registerLocalModel

```ts
registerLocalModel(value: string, cacheDir: string): string
```

Register the provider and ensure the model is downloaded; returns the local
  .gguf path to pass to setModel/setLlmOptions with provider "llama-cpp".

  @param value - name, alias, hf: URI, or .gguf path
  @param cacheDir - download dir (empty string = per-user cache)

**Parameters:**

| Name | Type | Default |
|---|---|---|
| value | `string` |  |
| cacheDir | `string` | "" |

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency/local.agency#L114))

### printLocalCatalog

```ts
printLocalCatalog()
```

Print the usable-model catalog (curated names + your aliases) as an
  aligned table — the same listing as `agency local alias list`.

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency/local.agency#L125))

### refreshCatalog

```ts
refreshCatalog(url: string): RefreshResult
```

Fetch the remote model catalog and update the `source:"remote"` aliases in
  the nearest `agency.json` from it. Adds/updates models from the catalog,
  removes ones it dropped, and skips (keeping yours) any name you've aliased
  yourself. Your hand-added aliases are never overwritten. Throws on a
  fetch/parse/validation failure, leaving `agency.json` untouched.

  This is the same operation as the `agency local refresh` CLI command.

  @param url - catalog URL override; empty string uses the
    `AGENCY_MODEL_CATALOG_URL` env var, then `client.modelCatalogUrl` in
    `agency.json`, then the built-in default.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| url | `string` | "" |

**Returns:** [RefreshResult](#refreshresult)

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency/local.agency#L154))
