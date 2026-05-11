# keyring

## Usage

  ```ts
  import { setSecret, getSecret, deleteSecret, isKeyringAvailable } from "std::keyring"

  node main() {
    if (isKeyringAvailable()) {
      setSecret("my-api-key", "sk-abc123")
      const key = getSecret("my-api-key")
      print(key)
      deleteSecret("my-api-key")
    }
  }
  ```

  ## How it works
  - macOS: Uses Keychain via the `security` CLI tool
  - Linux: Uses Secret Service via the `secret-tool` CLI tool
  - Windows: Not currently supported (use env vars instead)

  All secrets are stored under the "agency-lang" service name by default.
  Pass a custom `service` parameter to use a different namespace.
  No external dependencies required.

## Functions

### setSecret

```ts
setSecret(key: string, value: string, service: string): Result
```

Store a secret in the system keyring (macOS Keychain or Linux Secret Service). The secret is stored under the given service name (default "agency-lang") with the given key. Overwrites any existing value for the same key.

  @param key - The secret key name
  @param value - The secret value
  @param service - The service name in the keyring

**Parameters:**

| Name | Type | Default |
|---|---|---|
| key | `string` |  |
| value | `string` |  |
| service | `string` | "agency-lang" |

**Returns:** `Result`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/keyring.agency#L29))

### getSecret

```ts
getSecret(key: string, service: string): Result
```

Retrieve a secret from the system keyring by key. Returns the secret value as a string, or null if not found. Uses the "agency-lang" service by default.

  @param key - The secret key name
  @param service - The service name in the keyring

**Parameters:**

| Name | Type | Default |
|---|---|---|
| key | `string` |  |
| service | `string` | "agency-lang" |

**Returns:** `Result`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/keyring.agency#L45))

### deleteSecret

```ts
deleteSecret(key: string, service: string): Result
```

Delete a secret from the system keyring. Returns true if deleted, false if the key did not exist.

  @param key - The secret key name
  @param service - The service name in the keyring

**Parameters:**

| Name | Type | Default |
|---|---|---|
| key | `string` |  |
| service | `string` | "agency-lang" |

**Returns:** `Result`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/keyring.agency#L60))

### isKeyringAvailable

```ts
isKeyringAvailable(): boolean
```

Check if the system keyring is available on this platform. Returns true on macOS (Keychain) and Linux (with secret-tool installed), false otherwise.

**Returns:** `boolean`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/keyring.agency#L75))
