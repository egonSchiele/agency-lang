---
name: "coding"
description: "Writes an Agency program for a task and iterates until it parses,"
---

# coding

typechecks, compiles, and has a node main.

  This agent's contract ends at VALID source. To also check the program's
  behavior, compose it with agencyVerifierAgent: generate source here, run
  agencyVerifierAgent on the result, and retry with its findings folded into
  the task.

## Types

### WriteFailure

A failed generation: the last source attempted, with the problems found
  in it (review findings, compile errors, or the reason generation stopped).

```ts
/** A failed generation: the last source attempted, with the problems found
  in it (review findings, compile errors, or the reason generation stopped). */
export type WriteFailure = {
  source: string;
  problems: string[]
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/agency/coding.agency#L19))

## Functions

### syntaxHintFor

```ts
syntaxHintFor(errors: string): string
```

Return a specific syntax reminder to inject next to a diagnostic, or ""
  when no known pattern matches.

  @param errors - The rendered diagnostic text to match against

**Parameters:**

| Name | Type | Default |
|---|---|---|
| errors | `string` |  |

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/agency/coding.agency#L88))

### agencyCodingAgent

```ts
agencyCodingAgent(
  task: string,
  context: string = "",
  maxAttempts: number = 3,
  maxCost: number = $20.00,
  maxTime: number = 15m,
  model: string = "",
  provider: string = "",
  session: string = "",
): Result<string, WriteFailure>
```

Write an Agency program for the task. Iterates until the source parses,
  typechecks, compiles, and has a node main, or attempts run out. On failure
  returns the last attempted source with the problems found in it.

  @param task - What the program should do
  @param context - Extra material folded into the prompt, or ""
  @param maxAttempts - Generation attempts before giving up
  @param maxCost - Hard spend cap
  @param maxTime - Hard wall-clock cap
  @param model - Model override, or "" for the ambient model
  @param provider - Provider for the model override
  @param session - Session name to share a thread across calls, or "" for isolated

**Parameters:**

| Name | Type | Default |
|---|---|---|
| task | `string` |  |
| context | `string` | "" |
| maxAttempts | `number` | 3 |
| maxCost | `number` | $20.00 |
| maxTime | `number` | 15m |
| model | `string` | "" |
| provider | `string` | "" |
| session | `string` | "" |

**Returns:** `Result<string, WriteFailure>`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/agency/coding.agency#L174))
