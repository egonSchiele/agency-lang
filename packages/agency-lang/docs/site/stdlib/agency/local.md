---
name: "local"
description: "Download local models, manage aliases, and prepare GGUF or MLX inference."
---

# local

Manage and run local models. A GGUF model downloads by curated short name
  or Hugging Face URI and runs inside the Agency process through
  smoltalk-llama-cpp. MLX models run in a separate server. Start that server
  with `agency local serve`, or start `mlx_lm.server` yourself.

  Names and downloads also support `diffusers:` image-model targets. The
  chat registration helpers are intended for GGUF and MLX models.

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

A downloaded model. GGUF entries use the filename as `name`; served
    models use a repository ID and directory path. Check `complete` before
    trying to serve a model whose download may have been interrupted.

```ts
/** A downloaded model. GGUF entries use the filename as `name`; served
    models use a repository ID and directory path. Check `complete` before
    trying to serve a model whose download may have been interrupted. */
export type DownloadedModel = {
  name: string;
  path: string;
  sizeBytes: number;
  backend: string;
  complete: boolean;
  kind?: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency/local.agency#L43))

### ModelName

A usable short name, its backend and target, and available catalog metadata.

```ts
/** A usable short name, its backend and target, and available catalog metadata. */
export type ModelName = {
  name: string;
  backend: string;
  target: string;
  source: string;
  params?: string;
  sizeBytes?: number;
  kind?: string;
  tags?: string[];
  description?: string;
  contextWindow?: number;
  license?: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency/local.agency#L53))

### SkippedAlias

A remote catalog entry skipped because a user-owned alias keeps the same name.

```ts
/** A remote catalog entry skipped because a user-owned alias keeps the same name. */
export type SkippedAlias = {
  name: string;
  keptUri: string;
  remoteUri: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency/local.agency#L222))

### RefreshResult

Catalog refresh changes, including skipped aliases and the total catalog size.

```ts
/** Catalog refresh changes, including skipped aliases and the total catalog size. */
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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency/local.agency#L229))

## Functions

### localModelsSupported

```ts
localModelsSupported(): bool
```

Check whether the smoltalk-llama-cpp provider package can be found.

Checks local and global package locations. This is a GGUF-provider check;
  it does not probe MLX or image-model servers.

**Returns:** `bool`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency/local.agency#L71))

### resolveModelName

```ts
resolveModelName(value: string): string
```

Resolve a local-model short name or alias to its URI or filesystem target.

  @param value - A catalog name, alias, model URI, GGUF path, or model directory.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| value | `string` |  |

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency/local.agency#L78))

### downloadModel

```ts
downloadModel(value: string, cacheDir: string = ""): string
```

Download a local model or find its existing cached copy.

  @param value - A catalog name, alias, model URI, GGUF path, or model directory.
  @param cacheDir - The models directory, or empty to use the configured per-user cache.

Reuses cached files and resumes interrupted served-model downloads.
  Returns the local GGUF file path or served-model directory. The default
  cache comes from `AGENCY_MODELS_DIR`, then `client.modelsDir`, then
  `~/.agency-agent/models`.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| value | `string` |  |
| cacheDir | `string` | "" |

**Returns:** `string`

**Needs:** `fileRead`, `fileWrite`, `network`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency/local.agency#L94))

### listDownloadedModels

```ts
listDownloadedModels(cacheDir: string = ""): DownloadedModel[]
```

List downloaded GGUF files and served-model directories.

  @param cacheDir - The models directory, or empty to use the configured per-user cache.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| cacheDir | `string` | "" |

**Returns:** `DownloadedModel[]`

**Needs:** `fileRead`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency/local.agency#L105))

### listModelNames

```ts
listModelNames(): ModelName[]
```

List curated model short names and configured aliases.

**Returns:** `ModelName[]`

**Needs:** `fileRead`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency/local.agency#L115))

### aliasModel

```ts
aliasModel(name: string, uri: string): string
```

Save a short-name alias for a model target.

  @param uri - A model URI, GGUF path, or model directory to associate with the alias.

Writes the alias to the selected Agency configuration and returns that
  file’s path. An alias with the same name as a curated entry takes precedence.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| name | `string` |  |
| uri | `string` |  |

**Returns:** `string`

**Needs:** `fileRead`, `fileWrite`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency/local.agency#L127))

### unaliasModel

```ts
unaliasModel(name: string): string
```

Remove a configured model alias.

Removes the alias from its configuration file and returns that file’s
  path. Downloaded model files remain on disk.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| name | `string` |  |

**Returns:** `string`

**Needs:** `fileRead`, `fileWrite`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency/local.agency#L141))

### removeModel

```ts
removeModel(name: string, cacheDir: string = ""): bool
```

Delete a downloaded model file from the models cache.

  @param name - The model filename within the cache, rather than an alias or model directory.
  @param cacheDir - The models directory, or empty to use the configured per-user cache.

Deletes a cached file without removing its aliases. Returns false if
  the target is missing or is a directory. Use `unaliasModel` when you only
  want to remove the short name.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| name | `string` |  |
| cacheDir | `string` | "" |

**Returns:** `bool`

**Needs:** `fileRead`, `fileWrite`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency/local.agency#L154))

### localModelBackend

```ts
localModelBackend(value: string): string
```

Identify a model’s backend: llama-cpp, mlx, or diffusers.

  @param value - A catalog name, alias, model URI, GGUF path, or model directory.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| value | `string` |  |

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency/local.agency#L164))

### mlxServedName

```ts
mlxServedName(value: string): string
```

Resolve the model name to send to an MLX server.

  @param value - An MLX model name, alias, URI, or model directory.

For an MLX URI, returns the repository ID. For a model directory, returns
  its absolute path. Configure the server with the same model name.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| value | `string` |  |

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency/local.agency#L177))

### registerLocalProvider

```ts
registerLocalProvider()
```

Register the llama-cpp provider so local models can be used for LLM calls.

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency/local.agency#L186))

### registerLocalModel

```ts
registerLocalModel(value: string, cacheDir: string = ""): string
```

Prepare a GGUF model for local inference, or resolve an MLX server model name.

  @param value - A GGUF or MLX catalog name, alias, URI, file path, or model directory.
  @param cacheDir - The GGUF download directory, or empty to use the configured per-user cache.

For GGUF, registers llama-cpp and downloads the model if needed, then
  returns its local path. For MLX, returns the server model name without
  downloading or starting a server. Start the server before calling the
  model through the mlx provider.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| value | `string` |  |
| cacheDir | `string` | "" |

**Returns:** `string`

**Needs:** `fileRead`, `fileWrite`, `network`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency/local.agency#L200))

### printLocalCatalog

```ts
printLocalCatalog()
```

Print curated model names and aliases as an aligned terminal table.

Displays the same catalog as `agency local alias list`.

**Needs:** `fileRead`, `terminal`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency/local.agency#L214))

### mlxServerModels

```ts
mlxServerModels(baseUrl: string = ""): string[] | null
```

List the model IDs an MLX server reports, or null when the probe fails.

  @param baseUrl - The server’s OpenAI-compatible base URL, or empty for the configured mlx endpoint.

Use this to check the server before selecting a model. Null also covers
  an unsuccessful or unreadable response, so it does not prove the server
  process is absent. URL precedence is the explicit argument,
  `client.baseUrl.mlx`, `MLX_BASE_URL`, then `http://127.0.0.1:8080/v1`.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| baseUrl | `string` | "" |

**Returns:** `string[] | null`

**Needs:** `network`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency/local.agency#L247))

### mlxServerRunning

```ts
mlxServerRunning(baseUrl: string = ""): boolean
```

Check whether the configured MLX endpoint answers the model-list probe.

  @param baseUrl - The server’s OpenAI-compatible base URL, or empty for the configured mlx endpoint.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| baseUrl | `string` | "" |

**Returns:** `boolean`

**Needs:** `network`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency/local.agency#L257))

### refreshCatalog

```ts
refreshCatalog(url: string = ""): RefreshResult
```

Refresh remote-managed model aliases from the model catalog, preserving user-owned aliases.

  @param url - Leave empty to use AGENCY_MODEL_CATALOG_URL, then client.modelCatalogUrl, then the built-in catalog URL.

Performs the same refresh as `agency local refresh`. It updates aliases
  marked `source: "remote"`, adds new catalog entries, and removes entries
  the remote catalog dropped. User-owned aliases win name collisions.
  Fetch, parse, or validation failures leave the configuration untouched.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| url | `string` | "" |

**Returns:** [RefreshResult](#refreshresult)

**Needs:** `fileRead`, `fileWrite`, `network`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency/local.agency#L273))
