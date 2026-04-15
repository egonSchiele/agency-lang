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
| filepath | string |  |
| x | number | -1 |
| y | number | -1 |
| width | number | -1 |
| height | number | -1 |

### cwd

```ts
cwd(): string
```

Return the absolute path of the current working directory of the Agency process.

**Returns:** string

### env

```ts
env(name: string): string | null
```

Read an environment variable. Returns null if the variable is not set.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| name | string |  |

**Returns:** string | null

### setEnv

```ts
setEnv(name: string, value: string): Result
```

Set an environment variable in the current process. Fails if the name is empty or contains '='. The change is visible to child processes spawned afterward but does not persist outside the current process.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| name | string |  |
| value | string |  |

**Returns:** Result
