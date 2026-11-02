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

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| strict | `boolean` | false | Offer the typecheck restrictions used by sandboxed compilation. |
| projectTools | `boolean` | true | False omits the file and Git lookup tools. |

**Returns:** `any[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/agency/coding.agency#L220))

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

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| task | `string` |  |  |
| context | `string` | "" |  |
| maxAttempts | `number` | 3 | Maximum generation attempts before returning a failure. |
| maxCost | `number` | $20.00 | Cost budget in USD. |
| maxTime | `number` | 15m | Time budget in milliseconds. |
| model | `string` | "" | Model override, or "" for the ambient model. |
| provider | `string` | "" | Provider for the model override, ignored when model is empty. |
| session | `string` | "" | Name a conversation to reuse across calls, or "" for an isolated thread. |
| extraTools | `any[]` | [] | Additional tools, ignoring any whose names duplicate built-in tools. |
| requireMain | `boolean` | true | False allows library modules without a `node main` entry point. |
| dir | `string` | "" | Base directory for the source's relative imports. |
| strict | `boolean` | false | True checks drafts with the restrictions used by sandboxed compilation. |
| projectTools | `boolean` | true | False omits project file and Git lookup tools. |

**Returns:** `Result<string, WriteFailure>`

**Throws:** `std::guard`

**Needs:** `fileRead`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/agency/coding.agency#L411))
