---
name: "utils"
description: "Ask for a reply through a generic interrupt."
---

# utils

`ask` lets the host or a handler supply a value. For a named user-question
effect and a string reply, use `question` from `std::agent`.

## Functions

### ask

```ts
ask(question: string)
```

Ask a question through an interrupt and return the responder's value.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| question | `string` |  |

**Throws:** `unknown`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/composable/utils.agency#L8))
