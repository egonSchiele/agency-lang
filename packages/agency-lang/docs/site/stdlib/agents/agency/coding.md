---
name: "coding"
description: "Generate Agency source and check that it parses, typechecks, and compiles."
---

# coding

`agencyCodingAgent` returns source text for the caller to save or run.
By default it also requires `node main`. Pass `requireMain: false` for a
library module, and set `dir` when the source imports local files.

```ts
import { agencyCodingAgent } from "std::agents/agency/coding"

node main() {
  const generated = agencyCodingAgent("Return the squares of the numbers 1 through 5")
  print(generated)
}
```

Use `agencyVerifierAgent` separately to run the generated program and
judge its behavior. Generation checks establish source validity.

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/agency/coding.agency#L43))

## Functions

### buildTools

```ts
buildTools(strict: boolean = false, projectTools: boolean = true): any[]
```

Return documentation, source checks, project lookups, and fetch tools for an Agency writer.

  @param strict - Offer the typecheck restrictions used by sandboxed compilation.
  @param projectTools - False omits the file and Git lookup tools.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| strict | `boolean` | false |
| projectTools | `boolean` | true |

**Returns:** `any[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/agency/coding.agency#L224))

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
  extraTools: any[] = [],
  requireMain: boolean = true,
  dir: string = "",
  strict: boolean = false,
  projectTools: boolean = true,
): Result<string, WriteFailure>
```

Generate checked Agency source for a task, returning source text for the caller to save.
  Failures include the last attempted source and its problems.

  @param maxAttempts - Maximum generation attempts before returning a failure.
  @param maxCost - Cost budget in USD.
  @param maxTime - Time budget in milliseconds.
  @param model - Model override, or "" for the ambient model.
  @param provider - Provider for the model override, ignored when model is empty.
  @param session - Name a conversation to reuse across calls, or "" for an isolated thread.
  @param extraTools - Additional tools, ignoring any whose names duplicate built-in tools.
  @param requireMain - False allows library modules without a `node main` entry point.
  @param dir - Base directory for the source's relative imports.
  @param strict - True checks drafts with the restrictions used by sandboxed compilation.
  @param projectTools - False omits project file and Git lookup tools.

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
| extraTools | `any[]` | [] |
| requireMain | `boolean` | true |
| dir | `string` | "" |
| strict | `boolean` | false |
| projectTools | `boolean` | true |

**Returns:** `Result<string, WriteFailure>`

**Throws:** `std::guard`

**Needs:** `fileRead`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/agency/coding.agency#L415))
