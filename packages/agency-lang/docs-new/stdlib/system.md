# system

## Functions

### screenshot

```ts
screenshot(filepath: string, x: number, y: number, width: number, height: number)
```

A tool for taking a screenshot and saving it to a file. Optionally specify x, y, width, and height to capture a specific region.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| filepath | `string` |  |
| x | `number` | -1 |
| y | `number` | -1 |
| width | `number` | -1 |
| height | `number` | -1 |

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/system.agency#L2))

### cwd

```ts
cwd(): string
```

Return the absolute path of the current working directory of the Agency process.

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/system.agency#L9))

### env

```ts
env(name: string): string | null
```

Read an environment variable. Returns null if the variable is not set.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| name | `string` |  |

**Returns:** `string | null`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/system.agency#L16))

### setEnv

```ts
setEnv(name: string, value: string): Result
```

Set an environment variable in the current process. Fails if the name is empty or contains '='. The change is visible to child processes spawned afterward but does not persist outside the current process.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| name | `string` |  |
| value | `string` |  |

**Returns:** `Result`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/system.agency#L23))

### openUrl

```ts
openUrl(url: string): Result
```

Open a URL in the user's default browser. Currently macOS-only.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| url | `string` |  |

**Returns:** `Result`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/system.agency#L34))
