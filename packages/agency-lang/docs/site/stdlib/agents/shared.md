---
name: "shared"
---

# shared

Shared helpers for the `std::agents` worker agents.

## Functions

### withContext

```ts
withContext(task: string, context: string): string
```

Fold optional context material into a task prompt. Returns the task
  unchanged when no context is given.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| task | `string` |  |
| context | `string` |  |

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/shared.agency#L8))

### unwrapGuard

```ts
unwrapGuard(r: Result<string, GuardFailureData>, label: string): string
```

Unwrap a `guard(...)` Result to the string an agent returns: the block's
  value on success, or a "<label> stopped..." message when the cost or time cap
  tripped. Shared by every string-returning worker so the trip wording lives in
  one place.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| r | `Result<string, GuardFailureData>` |  |
| label | `string` |  |

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/shared.agency#L16))
