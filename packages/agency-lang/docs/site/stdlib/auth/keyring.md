---
name: "keyring"
description: "Store and retrieve secrets in the system keyring."
---

# keyring

Store and retrieve secrets in the operating system's keyring, so API keys
  and tokens can be stored without plaintext credential files.

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
@always(service, key)
effect std::setSecret {
  key: string;
  service: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/auth/keyring.agency#L27))

### std::getSecret

```ts
@always(service, key)
effect std::getSecret {
  key: string;
  service: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/auth/keyring.agency#L29))

### std::deleteSecret

```ts
@always(service, key)
effect std::deleteSecret {
  key: string;
  service: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/auth/keyring.agency#L31))

## Functions

### setSecret

```ts
setSecret(
  key: string,
  value: string,
  service: string = "agency-lang",
): Result raises <std::setSecret>
```

Store a secret in the system keyring, replacing any existing value.

  @param key - A non-empty name identifying the secret within its service.
  @param value - The non-empty secret to store.
  @param service - The namespace shared by calls that store and retrieve this secret.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| key | `string` |  |
| value | `string` |  |
| service | `string` | "agency-lang" |

**Returns:** `Result`

**Throws:** `std::setSecret`

**Needs:** `subprocess`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/auth/keyring.agency#L34))

### getSecret

```ts
getSecret(
  key: string,
  service: string = "agency-lang",
): Result raises <std::getSecret>
```

Retrieve a secret from the system keyring, or null when it is missing.

  @param key - The name used when storing the secret.
  @param service - The namespace used when storing the secret.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| key | `string` |  |
| service | `string` | "agency-lang" |

**Returns:** `Result`

**Throws:** `std::getSecret`

**Needs:** `subprocess`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/auth/keyring.agency#L53))

### deleteSecret

```ts
deleteSecret(
  key: string,
  service: string = "agency-lang",
): Result raises <std::deleteSecret>
```

Delete a secret from the system keyring, returning whether it existed.

  @param key - The name used when storing the secret.
  @param service - The namespace used when storing the secret.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| key | `string` |  |
| service | `string` | "agency-lang" |

**Returns:** `Result`

**Throws:** `std::deleteSecret`

**Needs:** `subprocess`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/auth/keyring.agency#L69))

### isKeyringAvailable

```ts
isKeyringAvailable(): boolean
```

Check whether this platform has a supported keyring command available.

Checks whether macOS `security` or Linux `secret-tool` can run.
  A successful check does not guarantee access to a stored secret.

**Returns:** `boolean`

**Needs:** `subprocess`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/auth/keyring.agency#L91))
