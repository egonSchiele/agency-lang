---
name: Tags and Redaction
description: Attach arbitrary tags to values with std::tag, and use the built-in redact tag to keep secrets like API keys out of state logs.
---

# Tags and Redaction

## Adding tags

The `std::tag` module lets you attach arbitrary tags to values and read them
back anywhere in your program.

```ts
import { tag, setTags, getTags, removeTag, removeAllTags } from "std::tag"

// attach a key/value tag
tag(x, "source", "user-upload")

// value defaults to true
tag(x, "reviewed")

// attach several at once
setTags(x, { team: "growth", tier: 2 })

// Now read them back
const tags = getTags(x)
// { source: "user-upload", reviewed: true, team: "growth", tier: 2 }

// removing tags
removeTag(x, "reviewed")
removeAllTags(x)
```

All of these functions return the value's current tags.

## What you can tag

You can add tags to primitives, arrays and objects. Tags on other kinds of objects (eg Date, Map, Set) are best-effort and currently may not survive an interrupt.

## Redaction

The built-in `redact` tag marks a value as redacted, and it gets replaced with `"[REDACTED]"`
in the [ logs](/guide/observability). Use it for API keys and other secrets:

```ts
import { redact } from "std::tag"

def callApi(apiKey: string) {
  redact(apiKey)
  return fetch("https://api.example.com", { headers: { key: apiKey } })
}
```

`redact(x)` is shorthand for `tag(x, "redact", true)`.

Four limits to know:

- **Whole-value only.** A secret is redacted only when it appears as a logged value
  on its own. A secret concatenated into a larger logged string (for example a
  URL query parameter) is *not* redacted.
- **Values, not keys.** Redaction rewrites values, not object keys. A secret
  used as a key (e.g. `{ "sk-...": {...} }`) still appears in the log verbatim.
- **State logs only.** Redaction governs what Agency's logging feature records. It does
  not affect `print()` or other functions.
- **Not a secrecy guarantee.** Redaction is best-effort. Treat it as a way to keep secrets out of routine telemetry,
  not as a guarantee a secret can never be observed.
