---
name: "agent"
description: "Ask the user a question and wait for the reply."
---

# agent

Give `question` to an LLM when it needs information only the user can
provide. Its interrupt lets a terminal, an application, or a handler supply
the reply.

```ts
import { question } from "std::agent"

node main() {
  const name = question("What should the report be called?")
  print(name)
}
```

## Effects

### std::question

```ts
effect std::question {
  prompt: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agent.agency#L18))

## Functions

### question

```ts
question(prompt: string): string raises <std::question>
```

Ask the user for information needed to continue and wait for their reply.
  Use it for facts only the user can provide. Do not ask for anything you can
  look up, and do not guess at a fact you could ask for.

Use this for user input in terminal, hosted, or embedded runs.
A handler can answer with `approve("reply")`.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| prompt | `string` |  |

**Returns:** `string`

**Throws:** `std::question`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agent.agency#L24))
