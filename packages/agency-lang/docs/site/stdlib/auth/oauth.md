---
name: "oauth"
description: "Run the OAuth 2.0 authorization flow and manage the resulting tokens, so your agent can call APIs on the user's behalf."
---

# oauth

Run the OAuth 2.0 authorization flow and manage the resulting tokens, so your
  agent can call APIs on the user's behalf. Register an app with the provider to
  get a client ID and secret. Then authorize once and fetch fresh access tokens
  as needed.

  ```ts
  import { authorize, getAccessToken, isAuthorized } from "std::auth/oauth"

  node main() {
    if (!isAuthorized("google-calendar")) {
      authorize("google-calendar",
        authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
        tokenUrl: "https://oauth2.googleapis.com/token",
        clientId: env("GOOGLE_CLIENT_ID"),
        clientSecret: env("GOOGLE_CLIENT_SECRET"),
        scopes: "https://www.googleapis.com/auth/calendar",
        extraAuthParams: "access_type=offline prompt=consent"
      )
    }

    const token = getAccessToken("google-calendar")

    const events = fetchJSON("https://www.googleapis.com/calendar/v3/calendars/primary/events", {
      headers: { "Authorization": "Bearer ${token}" }
    })
    print(events)
  }
  ```

  The flow uses PKCE. Tokens are saved per provider under
  `~/.agency/oauth/{name}.json`, encrypted at rest when a key is available.

## Effects

### std::authorize

```ts
effect std::authorize {
  name: string;
  authUrl: string;
  scopes: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/auth/oauth.agency#L39))

### std::getAccessToken

```ts
effect std::getAccessToken {
  name: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/auth/oauth.agency#L40))

### std::revokeAuth

```ts
effect std::revokeAuth {
  name: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/auth/oauth.agency#L41))

## Functions

### authorize

```ts
authorize(
  name: string,
  authUrl: string,
  tokenUrl: string,
  clientId: string,
  clientSecret: string,
  scopes: string,
  port: number = 8914,
  extraAuthParams: string = "",
): Result
```

Start an OAuth 2.0 authorization flow. Opens the user's browser for consent, captures the callback, exchanges the code for tokens, and saves them locally. Only needs to be run once per provider.

  @param name - Provider identifier like "google-calendar"
  @param authUrl - Authorization endpoint URL
  @param tokenUrl - Token endpoint URL
  @param clientId - OAuth client ID
  @param clientSecret - OAuth client secret
  @param scopes - Space-separated OAuth scopes
  @param port - Local port the callback listener binds to
  @param extraAuthParams - Space-separated key=value pairs for provider-specific auth params, e.g. "access_type=offline prompt=consent"

**Parameters:**

| Name | Type | Default |
|---|---|---|
| name | `string` |  |
| authUrl | `string` |  |
| tokenUrl | `string` |  |
| clientId | `string` |  |
| clientSecret | `string` |  |
| scopes | `string` |  |
| port | `number` | 8914 |
| extraAuthParams | `string` | "" |

**Returns:** `Result`

**Throws:** `std::authorize`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/auth/oauth.agency#L43))

### getAccessToken

```ts
getAccessToken(name: string): Result
```

Get a valid OAuth access token for a previously authorized provider. Refreshes the token automatically if it has expired. Returns the access token string; throws if the provider is not yet authorized.

  @param name - Provider identifier

**Parameters:**

| Name | Type | Default |
|---|---|---|
| name | `string` |  |

**Returns:** `Result`

**Throws:** `std::getAccessToken`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/auth/oauth.agency#L73))

### isAuthorized

```ts
isAuthorized(name: string): boolean
```

Check whether OAuth tokens are stored for a provider. Returns true if tokens exist locally; does not verify they are still valid.

  @param name - Provider identifier

**Parameters:**

| Name | Type | Default |
|---|---|---|
| name | `string` |  |

**Returns:** `boolean`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/auth/oauth.agency#L86))

### revokeAuth

```ts
revokeAuth(name: string): Result
```

Delete stored OAuth tokens for a provider. Re-authorization is required before the provider can be used again.

  @param name - Provider identifier

**Parameters:**

| Name | Type | Default |
|---|---|---|
| name | `string` |  |

**Returns:** `Result`

**Throws:** `std::revokeAuth`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/auth/oauth.agency#L95))
