---
name: "keyring"
---

# keyring

Store and retrieve secrets in the operating system's keyring, so API keys
  and tokens never touch plaintext files.

  ```ts
  import { setSecret, getSecret, deleteSecret, isKeyringAvailable } from "std::auth/keyring"

  node main() {
    if (isKeyringAvailable()) {
      setSecret("my-api-key", "sk-abc123")
      const key = getSecret("my-api-key")
      print(key)
      deleteSecret("my-api-key")
    }
  }
  ```

  On macOS this uses the Keychain, and on Linux the Secret Service. Windows is
  not yet supported, so fall back to environment variables there. Secrets live
  under the "agency-lang" service name unless you pass a custom `service`.

## Effects

### std::setSecret

```ts
effect std::setSecret {
  key: string;
  service: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/auth/keyring.agency#L25))

### std::getSecret

```ts
effect std::getSecret {
  key: string;
  service: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/auth/keyring.agency#L26))

### std::deleteSecret

```ts
effect std::deleteSecret {
  key: string;
  service: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/auth/keyring.agency#L27))

## Functions

### setSecret

```ts
setSecret(key: string, value: string, service: string = "agency-lang"): Result
```

Store a secret in the system keyring, overwriting any existing value for the same key.

  @param key - The secret key name
  @param value - The secret value to store
  @param service - Keyring namespace the secret is stored under

**Parameters:**

| Name | Type | Default |
|---|---|---|
| key | `string` |  |
| value | `string` |  |
| service | `string` | "agency-lang" |

**Returns:** `Result`

**Throws:** `std::setSecret`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/auth/keyring.agency#L29))

### getSecret

```ts
getSecret(key: string, service: string = "agency-lang"): Result
```

Retrieve a secret from the system keyring. Returns the secret value, or null if not found.

  @param key - The secret key name
  @param service - Keyring namespace to read from

**Parameters:**

| Name | Type | Default |
|---|---|---|
| key | `string` |  |
| service | `string` | "agency-lang" |

**Returns:** `Result`

**Throws:** `std::getSecret`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/auth/keyring.agency#L47))

### deleteSecret

```ts
deleteSecret(key: string, service: string = "agency-lang"): Result
```

Delete a secret from the system keyring. Returns true if deleted, false if the key did not exist.

  @param key - The secret key name
  @param service - Keyring namespace to delete from

**Parameters:**

| Name | Type | Default |
|---|---|---|
| key | `string` |  |
| service | `string` | "agency-lang" |

**Returns:** `Result`

**Throws:** `std::deleteSecret`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/auth/keyring.agency#L62))

### isKeyringAvailable

```ts
isKeyringAvailable(): boolean
```

Check if the system keyring is available on this platform. Returns true on macOS and on Linux with secret-tool installed, false otherwise.

**Returns:** `boolean`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/auth/keyring.agency#L79))
