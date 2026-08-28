---
name: "tics"
description: "A second pass over prose that finds verbal tics: phrases a"
---

# tics

language model reaches for that a careful editor cuts. The list is the
  prompt; edit it here. `docs/dev/contributing/verbal-tics.md` points at
  this file.

## Functions

### findVerbalTics

```ts
findVerbalTics(
  work: string,
  task: string,
  guidelines: string,
  context: string,
  model: string,
  provider: string,
): Feedback[]
```

Find verbal tics in the text and return them as advisory findings.

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/writing/tics.agency#L116))

### verbalTicsOrNothing

```ts
verbalTicsOrNothing(
  work: string,
  task: string,
  guidelines: string,
  context: string,
  model: string,
  provider: string,
): Feedback[]
```

findVerbalTics, with a failed call reported as no findings. The main
  review must not be lost because this advisory pass could not run.

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/writing/tics.agency#L141))
