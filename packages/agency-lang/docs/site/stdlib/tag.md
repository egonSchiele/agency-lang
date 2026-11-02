---
name: "tag"
description: "Tag values and redact them in state logs."
---

# tag

```ts
import { redact } from "std::tag"

def hideSecret(apiKey: string) {
  redact(apiKey)
}
```

`redact` replaces a tagged value with `[REDACTED]` in state logs.
Pass a label to choose a different marker.

Primitive tags follow equal values: tagging one "secret" tags other equal
strings in the branch. Object and array tags follow their references,
so two objects with equal fields can have different tags.

Tags on primitives, extensible plain objects, and arrays survive forks and
checkpoint resume. Other objects, including ones already frozen when tagged,
use branch-local storage. Tags do not appear in ordinary JSON output.

## Functions

### tag

```ts
tag(value: any, key: string, val: any = true): any
```

Attach a tag to a value and return its current tags.
  Primitives share tags by value; objects use reference identity.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| value | `any` |  |
| key | `string` |  |
| val | `any` | true |

**Returns:** `any`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/tag.agency#L26))

### setTags

```ts
setTags(value: any, tags: any): any
```

Attach the entries of a tag object to a value and return its current tags.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| value | `any` |  |
| tags | `any` |  |

**Returns:** `any`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/tag.agency#L34))

### getTags

```ts
getTags(value: any): any
```

Return a value's tags, or an empty object if it has none.

The returned object is a shallow copy; nested tag values remain shared.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| value | `any` |  |

**Returns:** `any`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/tag.agency#L42))

### redact

```ts
redact(value: any, label: string = ""): any
```

Mark a value for replacement in state logs and return its current tags.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| value | `any` |  |  |
| label | `string` | "" | Replacement text, or "" for "[REDACTED]". |

**Returns:** `any`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/tag.agency#L49))

### removeTag

```ts
removeTag(value: any, key: string): any
```

Remove a single tag from a value. Returns the value's remaining tags.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| value | `any` |  |
| key | `string` |  |

**Returns:** `any`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/tag.agency#L59))

### removeAllTags

```ts
removeAllTags(value: any): any
```

Remove all tags from a value. Returns an empty object.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| value | `any` |  |

**Returns:** `any`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/tag.agency#L64))
