---
name: Tags and Redaction
description: Attach arbitrary tags to values with std::tag, and use the built-in redact tag to keep secrets like API keys out of state logs.
---

# Tags and Redaction

The `std::tag` module lets you attach arbitrary tags to values and read them
back anywhere in your program.

```ts
import { tag, setTags, getTags, removeTag, removeAllTags } from "std::tag"

tag(x, "source", "user-upload")        // attach a key/value tag
tag(x, "reviewed")                     // value defaults to true
setTags(x, { team: "growth", tier: 2 }) // attach several at once
const tags = getTags(x)                // { source: "user-upload", reviewed: true, team: "growth", tier: 2 }
removeTag(x, "reviewed")               // drop one tag
removeAllTags(x)                       // drop them all
```

Every function returns the value's current tags (an empty object once cleared),
which doubles as a confirmation when one of these is used as an LLM tool.

## Value vs. reference semantics

How a tag is stored depends on the kind of value:

- **Primitives** (string, number, boolean) are keyed by **value**. Tagging one
  copy of `"secret"` tags every equal `"secret"`. This is what makes redacting
  an API key work no matter how the string was copied.
- **Objects and arrays** are keyed by **reference**. Tagging one object does
  *not* tag a structurally-equal but distinct object.

> Object and array tags are branch-local: they do not survive `fork`, `race`,
> or `parallel` branches, or an interrupt/resume. Primitive (value) tags
> survive both.

## Redaction

The built-in `redact` tag marks a value so it is replaced with `"[REDACTED]"`
in [state logs](/guide/observability). Use it for API keys and other secrets:

```ts
import { redact } from "std::tag"

def callApi(apiKey: string) {
  redact(apiKey)
  return fetch("https://api.example.com", { headers: { key: apiKey } })
}
```

`redact(x)` is shorthand for `tag(x, "redact", true)`.

Four limits to know:

- **Whole-value only.** A secret is redacted where it appears as a logged value
  on its own. A secret concatenated into a larger logged string (for example a
  URL query parameter) is *not* scrubbed — tag the exact string that gets
  logged.
- **Values, never keys.** Redaction rewrites values, not object keys. A secret
  used as a key (e.g. `{ "sk-...": {...} }`) still appears in the log verbatim —
  tag the value, not the thing that becomes a key.
- **State logs only.** Redaction governs what `std::statelog` records. It does
  not affect `print()` or other direct output.
- **Not a secrecy guarantee.** Redaction is best-effort scrubbing of state-log
  events emitted while your program runs. It is not an information-flow or
  security control — treat it as a way to keep secrets out of routine telemetry,
  not as a guarantee a secret can never be observed.
