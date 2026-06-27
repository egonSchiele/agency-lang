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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency/local.agency#L21))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency/local.agency#L25))

## Functions

### localModelsSupported

```ts
localModelsSupported(): bool
```

True if smoltalk-llama-cpp is installed.

**Returns:** `bool`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency/local.agency#L37))

### resolveModelName

```ts
resolveModelName(value: string): string
```

Map a curated short name or alias to its Hugging Face URI; pass URIs and .gguf paths through. @param value - name, alias, hf: URI, or .gguf path

**Parameters:**

| Name | Type | Default |
|---|---|---|
| value | `string` |  |

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency/local.agency#L42))

### downloadModel

```ts
downloadModel(value: string, cacheDir: string): string
```

Download a model (curated name, alias, hf: URI) if not cached and return its local .gguf path. @param value - what to download @param cacheDir - download dir (empty string = per-user cache)

**Parameters:**

| Name | Type | Default |
|---|---|---|
| value | `string` |  |
| cacheDir | `string` | "" |

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency/local.agency#L47))

### listDownloadedModels

```ts
listDownloadedModels(cacheDir: string): DownloadedModel[]
```

List downloaded .gguf models. @param cacheDir - models dir (empty string = per-user cache)

**Parameters:**

| Name | Type | Default |
|---|---|---|
| cacheDir | `string` | "" |

**Returns:** `DownloadedModel[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency/local.agency#L52))

### listModelNames

```ts
listModelNames(): ModelName[]
```

List usable short names: curated built-ins and your aliases.

**Returns:** `ModelName[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency/local.agency#L57))

### aliasModel

```ts
aliasModel(name: string, uri: string): string
```

Add a short-name alias for a model URI; returns the edited agency.json path. @param name - the alias @param uri - the hf: URI it maps to

**Parameters:**

| Name | Type | Default |
|---|---|---|
| name | `string` |  |
| uri | `string` |  |

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency/local.agency#L62))

### unaliasModel

```ts
unaliasModel(name: string): string
```

Remove a short-name alias; returns the inspected agency.json path (file unchanged if the alias was missing). @param name - the alias to remove

**Parameters:**

| Name | Type | Default |
|---|---|---|
| name | `string` |  |

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency/local.agency#L67))

### removeModel

```ts
removeModel(name: string, cacheDir: string): bool
```

Delete a downloaded model file; false if it was not present. @param name - the .gguf filename @param cacheDir - models dir (empty string = per-user cache)

**Parameters:**

| Name | Type | Default |
|---|---|---|
| name | `string` |  |
| cacheDir | `string` | "" |

**Returns:** `bool`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency/local.agency#L72))

### registerLocalProvider

```ts
registerLocalProvider()
```

Register the llama-cpp provider so local models can be used by llm().

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency/local.agency#L77))

### registerLocalModel

```ts
registerLocalModel(value: string, cacheDir: string): string
```

Register the provider and ensure the model is downloaded; returns the local .gguf path to pass to setModel/setLlmOptions with provider "llama-cpp". @param value - name, alias, hf: URI, or .gguf path @param cacheDir - download dir (empty string = per-user cache)

**Parameters:**

| Name | Type | Default |
|---|---|---|
| value | `string` |  |
| cacheDir | `string` | "" |

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency/local.agency#L82))
