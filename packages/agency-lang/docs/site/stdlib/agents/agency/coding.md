---
name: "coding"
description: "Writes an Agency program for a task and iterates until it parses,"
---

# coding

typechecks, compiles, and (by default) has a node main.

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/agency/coding.agency#L27))

### CodingEvalInput

What an eval hands the writer: the assignment, the file to save the
  returned program as, and whether a `node main` entry point is required
  (false when the deliverable is a module whose exports a harness imports).
  The shape the `evals/agency-coding` suite uses as its input.

```ts
/** What an eval hands the writer: the assignment, the file to save the
  returned program as, and whether a `node main` entry point is required
  (false when the deliverable is a module whose exports a harness imports).
  The shape the `evals/agency-coding` suite uses as its input. */
export type CodingEvalInput = {
  assignment: string;
  outFile: string;
  requireMain: boolean
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/agency/coding.agency#L339))

## Functions

### buildTools

```ts
buildTools(): any[]
```

Return the Agency writer's tools: the bundled documentation, the source
  inspectors it checks drafts with, read-only access to the project it is
  writing for, and fetches for a named external resource. Not testFile: the
  writer returns source it has not saved, so there is nothing on disk for a
  harness to test yet.

**Returns:** `any[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/agency/coding.agency#L109))

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
): Result<string, WriteFailure>
```

Write an Agency program for the task. Iterates until the source parses,
  typechecks, compiles, and (when requireMain) has a node main, or attempts
  run out. On failure returns the last attempted source with the problems
  found in it.

  @param task - What the program should do
  @param context - Extra material folded into the prompt, or ""
  @param maxAttempts - Generation attempts before giving up
  @param maxCost - Hard spend cap
  @param maxTime - Hard wall-clock cap
  @param model - Model override, or "" for the ambient model
  @param provider - Provider for the model override
  @param session - Session name to share a thread across calls, or "" for isolated
  @param extraTools - Extra tools to offer the LLM, appended to the built-in set
  @param requireMain - Demand a `node main` entry point (default). Pass false
    when the deliverable is a library module whose exports the caller places.

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

**Returns:** `Result<string, WriteFailure>`

**Throws:** `std::guard`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/agency/coding.agency#L260))

## Nodes

### evalMain

```ts
evalMain(input: CodingEvalInput): string
```

Eval entry point: `agency eval run stdlib/agents/agency/coding.agency:evalMain
  --suite <dir>`. A node in a library module never runs when the module is
  imported; it only exists so a suite can score this writer without a
  wrapper file. Any other writer scored on the same suite supplies a node
  with this signature. The writer returns source without saving it, so
  saving into the workdir — where the suite's harness pairs grade it — is
  this node's own doing (`with approve`). A budget trip inside the writer is
  rejected (`with reject`) so the caps stay caps. A failed run still saves
  its last draft: the harness scores whatever partial credit it earns.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| input | [CodingEvalInput](#codingevalinput) |  |

**Returns:** `string`

**Throws:** `std::write`, `std::guard`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/agency/coding.agency#L354))
