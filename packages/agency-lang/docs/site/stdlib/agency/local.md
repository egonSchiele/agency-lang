---
name: "local"
description: "Manage and run local models: GGUF files through llama.cpp, and MLX models through a server."
---

# local

Manage and run local models. A GGUF model downloads by curated short name
  or Hugging Face URI and runs inside the Agency process; that needs the
  smoltalk-llama-cpp package. An MLX model is named with an mlx: URI or a
  model directory and runs in mlx_lm.server, which you start yourself.

  ```ts
  import { registerLocalModel } from "std::agency/local"

  node main() {
    // download if needed, register the provider, and get the local path
    const model = registerLocalModel("smollm2-135m")
    print(model)
  }
  ```

## Types

### DownloadedModel

A model on disk. For a GGUF file, `name` is the file name. For an MLX
    model, `name` is the repo id and `path` is its directory. `complete` is
    false for an MLX model whose download was interrupted.

```ts
/** A model on disk. For a GGUF file, `name` is the file name. For an MLX
    model, `name` is the repo id and `path` is its directory. `complete` is
    false for an MLX model whose download was interrupted. */
export type DownloadedModel = {
  name: string;
  path: string;
  sizeBytes: number;
  backend: string;
  complete: boolean
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency/local.agency#L40))

### ModelName

```ts
export type ModelName = {
  name: string;
  backend: string;
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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency/local.agency#L48))

### SkippedAlias

Used when refreshing the model catalog. If a catalog model's name collides with one of your own aliases,
    we'll keep your alias and skip the catalog entry. This type describes what was skipped.

```ts
/** Used when refreshing the model catalog. If a catalog model's name collides with one of your own aliases,
    we'll keep your alias and skip the catalog entry. This type describes what was skipped. */
export type SkippedAlias = {
  name: string;
  keptUri: string;
  remoteUri: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency/local.agency#L191))

### RefreshResult

The outcome of `refreshCatalog`. modelCount = total catalog size.

```ts
/** The outcome of `refreshCatalog`. modelCount = total catalog size. */
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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency/local.agency#L198))

## Functions

### localModelsSupported

```ts
localModelsSupported(): bool
```

True if smoltalk-llama-cpp is installed.

**Returns:** `bool`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency/local.agency#L61))

### resolveModelName

```ts
resolveModelName(value: string): string
```

Map a curated short name or alias to its target: an hf: URI or .gguf path
  for a GGUF model, an mlx: URI or directory for an MLX model. Pass URIs and
  paths through unchanged.

  @param value - name, alias, hf: URI, mlx: URI, .gguf path, or model directory

**Parameters:**

| Name | Type | Default |
|---|---|---|
| value | `string` |  |

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency/local.agency#L68))

### downloadModel

```ts
downloadModel(value: string, cacheDir: string = ""): string
```

Download a model and return its local .gguf path, or the model directory
  for an MLX model. Skips what is already in the cache dir. An MLX download
  resumes if it was interrupted.

  @param value - what to download
  @param cacheDir - download dir (empty string = per-user cache)

**Parameters:**

| Name | Type | Default |
|---|---|---|
| value | `string` |  |
| cacheDir | `string` | "" |

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency/local.agency#L79))

### listDownloadedModels

```ts
listDownloadedModels(cacheDir: string = ""): DownloadedModel[]
```

List downloaded models: .gguf files and MLX model directories.

  @param cacheDir - models dir (empty string = per-user cache)

**Parameters:**

| Name | Type | Default |
|---|---|---|
| cacheDir | `string` | "" |

**Returns:** `DownloadedModel[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency/local.agency#L91))

### listModelNames

```ts
listModelNames(): ModelName[]
```

List usable short names: curated built-ins and your aliases.

**Returns:** `ModelName[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency/local.agency#L100))

### aliasModel

```ts
aliasModel(name: string, uri: string): string
```

Add a short-name alias for a model URI
  Returns the path to the agency.json file that the alias was written to.

  @param name - the alias
  @param uri - the hf: URI, mlx: URI, .gguf path, or model directory it maps to

**Parameters:**

| Name | Type | Default |
|---|---|---|
| name | `string` |  |
| uri | `string` |  |

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency/local.agency#L107))

### unaliasModel

```ts
unaliasModel(name: string): string
```

Remove a short-name alias.
  Returns the path to the agency.json file that was modified.

  @param name - the alias to remove

**Parameters:**

| Name | Type | Default |
|---|---|---|
| name | `string` |  |

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency/local.agency#L118))

### removeModel

```ts
removeModel(name: string, cacheDir: string = ""): bool
```

Delete a downloaded GGUF file from the models directory. This is what
  `agency local remove -f` does; without -f that command only removes the
  alias. Returns false if the file was not present.

  @param name - the .gguf filename
  @param cacheDir - models dir (empty string = per-user cache)

**Parameters:**

| Name | Type | Default |
|---|---|---|
| name | `string` |  |
| cacheDir | `string` | "" |

**Returns:** `bool`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency/local.agency#L128))

### localModelBackend

```ts
localModelBackend(value: string): string
```

Which engine runs a model: "llama-cpp" for GGUF files, "mlx" for MLX
  models served by mlx_lm.server.

  @param value - name, alias, hf: URI, mlx: URI, .gguf path, or model directory

**Parameters:**

| Name | Type | Default |
|---|---|---|
| value | `string` |  |

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency/local.agency#L140))

### mlxServedName

```ts
mlxServedName(value: string): string
```

The model name to send to the MLX server for this model: the repo id for
  an mlx: URI, or the absolute path for a model directory. Start
  mlx_lm.server with the same string.

  @param value - name, alias, mlx: URI, or model directory

**Parameters:**

| Name | Type | Default |
|---|---|---|
| value | `string` |  |

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency/local.agency#L150))

### registerLocalProvider

```ts
registerLocalProvider()
```

Register the llama-cpp provider so local models can be used for LLM calls.

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency/local.agency#L161))

### registerLocalModel

```ts
registerLocalModel(value: string, cacheDir: string = ""): string
```

Register the provider and ensure the model is downloaded. Returns the local
  .gguf path to use as the model for LLM calls with provider "llama-cpp".
  For an MLX model this registers nothing and returns the name to send to
  the server. Start mlx_lm.server on that model first.

  @param value - name, alias, hf: URI, mlx: URI, .gguf path, or model directory
  @param cacheDir - download dir (empty string = per-user cache)

**Parameters:**

| Name | Type | Default |
|---|---|---|
| value | `string` |  |
| cacheDir | `string` | "" |

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency/local.agency#L168))

### printLocalCatalog

```ts
printLocalCatalog()
```

Print the usable-model catalog (curated names + your aliases) as an
    aligned table, the same listing as `agency local alias list`.

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency/local.agency#L181))

### mlxServerModels

```ts
mlxServerModels(baseUrl: string = ""): string[] | null
```

The models the MLX server is serving, or null if no server is running.
  Use it to check a model is up before starting work. The server is the one
  `agency local serve` started, or any mlx_lm.server.

  @param baseUrl - the server's URL (empty string = the mlx provider's default,
    `MLX_BASE_URL` or `http://127.0.0.1:8080/v1`)

**Parameters:**

| Name | Type | Default |
|---|---|---|
| baseUrl | `string` | "" |

**Returns:** `string[] | null`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency/local.agency#L209))

### mlxServerRunning

```ts
mlxServerRunning(baseUrl: string = ""): boolean
```

Whether an MLX server answers at the base URL. The same probe as
  `mlxServerModels`, as a yes or no.

  @param baseUrl - the server's URL (empty string = the mlx provider's default)

**Parameters:**

| Name | Type | Default |
|---|---|---|
| baseUrl | `string` | "" |

**Returns:** `boolean`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency/local.agency#L221))

### refreshCatalog

```ts
refreshCatalog(url: string = ""): RefreshResult
```

Fetch the remote model catalog and update the `source:"remote"` aliases in
  the nearest `agency.json` from it. Adds/updates models from the catalog,
  removes ones it dropped, and skips any name you've aliased
  yourself. Your hand-added aliases are never overwritten. Throws on a
  fetch/parse/validation failure, leaving `agency.json` untouched.

  @param url - catalog URL override; empty string uses the
    `AGENCY_MODEL_CATALOG_URL` env var, then `client.modelCatalogUrl` in
    `agency.json`, then the built-in default.

Same operation as the `agency local refresh` CLI command.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| url | `string` | "" |

**Returns:** [RefreshResult](#refreshresult)

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency/local.agency#L232))
