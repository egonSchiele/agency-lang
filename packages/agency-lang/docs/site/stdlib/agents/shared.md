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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/shared.agency#L7))
