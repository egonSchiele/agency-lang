---
name: "review"
description: "The code reviewer of the Agency agent's coordinator brain. The"
---

# review

reviews live in `std::agents/review` and `std::agents/agency/review`.
  What is left here is the agent-shaped part: pulling code snippets out of
  a chat message, and choosing the reviewer.

## Functions

### reviewAgent

```ts
reviewAgent(
  settings: AgentSettings,
  userMsg: string,
  agencyTask: boolean = false,
): string
```

Review code and report what is wrong with it: errors, risks, and things
  worth changing.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| settings | [AgentSettings](../settings.md#agentsettings) |  |  |
| userMsg | `string` |  | the code to review, or a message describing what to review. |
| agencyTask | `boolean` | false | true when the code is Agency code, which routes to the reviewer that parses and typechecks it. Leave it false for every other language, where that reviewer has nothing useful to say. |

**Returns:** `string`

**Throws:** `std::guard`

**Needs:** `fileRead`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/brains/coordinator/review.agency#L19))

### review

```ts
review(settings: AgentSettings, userMsg: string): Result<Feedback[]>
```

Review the Agency code snippets in a message, on a thread of their own.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| settings | [AgentSettings](../settings.md#agentsettings) |  | The call's settings |
| userMsg | `string` |  | The message that holds the code |

**Returns:** `Result<Feedback[]>`

**Throws:** `std::guard`

**Needs:** `fileRead`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/brains/coordinator/review.agency#L43))
