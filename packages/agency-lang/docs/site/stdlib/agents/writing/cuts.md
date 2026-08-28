---
name: "cuts"
description: "A pass over prose that answers one question for each part: does"
---

# cuts

this reader need it? It returns cuts only, never rewrites. Runs beside
  the writing reviewer's main pass.

## Functions

### findCuts

```ts
findCuts(
  work: string,
  task: string,
  guidelines: string,
  context: string,
  model: string,
  provider: string,
): Feedback[]
```

Find the parts of the text this reader does not need and return them as
  cut findings.

  @param work - The text under review, or a request naming the files that hold it
  @param task - Who the text is for and what it must get across, or ""
  @param guidelines - The caller's own writing guidelines, or ""
  @param context - Extra material for the judgment, or ""
  @param model - Model override, or "" for the ambient model
  @param provider - Provider for the model override

**Parameters:**

| Name | Type | Default |
|---|---|---|
| work | `string` |  |
| task | `string` |  |
| guidelines | `string` |  |
| context | `string` |  |
| model | `string` |  |
| provider | `string` |  |

**Returns:** `Feedback[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/writing/cuts.agency#L71))

### cutsOrNothing

```ts
cutsOrNothing(
  work: string,
  task: string,
  guidelines: string,
  context: string,
  model: string,
  provider: string,
): Feedback[]
```

findCuts, with a failed call reported as no findings, so the main review
  is not lost because this pass could not run.

  @param work - The text under review, or a request naming the files that hold it
  @param task - Who the text is for and what it must get across, or ""
  @param guidelines - The caller's own writing guidelines, or ""
  @param context - Extra material for the judgment, or ""
  @param model - Model override, or "" for the ambient model
  @param provider - Provider for the model override

**Parameters:**

| Name | Type | Default |
|---|---|---|
| work | `string` |  |
| task | `string` |  |
| guidelines | `string` |  |
| context | `string` |  |
| model | `string` |  |
| provider | `string` |  |

**Returns:** `Feedback[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/writing/cuts.agency#L97))
