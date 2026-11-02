---
name: "oauth"
description: "Authorize API access with OAuth and manage stored tokens."
---

# oauth

Run the OAuth 2.0 authorization flow and manage the resulting tokens, so your
  agent can call APIs on the user's behalf. Register an app with the provider to
  get a client ID and secret. Then authorize once and fetch fresh access tokens
  as needed.

  ```ts
  import { authorize, getAccessToken, isAuthorized } from "std::auth/oauth"
  import { fetchJSON } from "std::http"
  import { env } from "std::system"

  node main() {
    if (!isAuthorized("google-calendar")) {
      const clientId = env("GOOGLE_CLIENT_ID") with approve
      const clientSecret = env("GOOGLE_CLIENT_SECRET") with approve
      if (clientId == null || clientSecret == null) {
        return failure("Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET first.")
      }
      authorize("google-calendar",
        authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
        tokenUrl: "https://oauth2.googleapis.com/token",
        clientId: clientId,
        clientSecret: clientSecret,
        scopes: "https://www.googleapis.com/auth/calendar",
        extraAuthParams: "access_type=offline prompt=consent"
      )
    }

    const token = getAccessToken("google-calendar")?

    const events = fetchJSON(
      baseUrl: "https://www.googleapis.com/calendar/v3/calendars/primary/events",
      headers: { "Authorization": "Bearer ${token}" }
    )
    print(events)
  }
  ```

  The flow uses PKCE. Tokens are saved per provider under
  `~/.agency/oauth/{name}.json` by default. Set `AGENCY_OAUTH_TOKEN_DIR` to
  choose another directory. Tokens are encrypted at rest when a key is available.

## Effects

### std::authorize

```ts
@always(name)
effect std::authorize {
  name: string;
  authUrl: string;
  scopes: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/auth/oauth.agency#L49))

### std::getAccessToken

```ts
@always(name)
effect std::getAccessToken {
  name: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/auth/oauth.agency#L51))

### std::revokeAuth

```ts
@always(name)
effect std::revokeAuth {
  name: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/auth/oauth.agency#L53))

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
): Result raises <std::authorize>
```

Open the browser to authorize an API provider and save its OAuth tokens.

Register the callback `http://127.0.0.1:8914/oauth/callback` with your
  provider, adjusting the port if needed. The user grants consent in a
  browser. Authorize again if credentials expire without a refresh token.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| name | `string` |  | Start with an ASCII letter or digit and use only letters, digits, dots, hyphens, or underscores. |
| authUrl | `string` |  | The provider authorization endpoint, using HTTPS except on localhost. |
| tokenUrl | `string` |  | The provider token endpoint, using HTTPS except on localhost. |
| clientId | `string` |  | The client ID registered with the provider. |
| clientSecret | `string` |  | The registered client secret, or empty for a public client. |
| scopes | `string` |  | Space-separated permissions to request. |
| port | `number` | 8914 | The port registered for the local OAuth callback. |
| extraAuthParams | `string` | "" | Space-separated key=value pairs, such as "access_type=offline prompt=consent". |

**Returns:** `Result`

**Throws:** `std::authorize`

**Needs:** `fileRead`, `fileWrite`, `network`, `subprocess`, `env`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/auth/oauth.agency#L61))

### getAccessToken

```ts
getAccessToken(name: string): Result raises <std::getAccessToken>
```

Get an access token for an authorized provider, refreshing it when needed.

Returns a failure when tokens are missing, refresh fails, or an expired
  token has no refresh token. In those cases, authorize the provider again.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| name | `string` |  | The provider identifier used during authorization. |

**Returns:** `Result`

**Throws:** `std::getAccessToken`

**Needs:** `fileRead`, `fileWrite`, `network`, `subprocess`, `env`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/auth/oauth.agency#L96))

### isAuthorized

```ts
isAuthorized(name: string): boolean
```

Check whether OAuth tokens are stored for a provider, without verifying their validity.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| name | `string` |  | The provider identifier used during authorization. |

**Returns:** `boolean`

**Needs:** `fileRead`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/auth/oauth.agency#L110))

### revokeAuth

```ts
revokeAuth(name: string): Result raises <std::revokeAuth>
```

Delete the locally stored OAuth tokens for a provider.

This removes local credentials. It does not call the provider to revoke
  the tokens remotely. Authorize again before using the provider locally.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| name | `string` |  | The provider identifier used during authorization. |

**Returns:** `Result`

**Throws:** `std::revokeAuth`

**Needs:** `fileRead`, `fileWrite`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/auth/oauth.agency#L124))
