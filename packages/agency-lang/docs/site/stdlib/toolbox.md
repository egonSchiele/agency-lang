---
name: "toolbox"
description: "Create, save, and run reusable Agency tools."
---

# toolbox

```ts
import { designTool, runTool } from "std::toolbox"

node main() {
  const saved = designTool(
    name: "addTax",
    purpose: "Add a tax rate to an amount.",
    request: "{ amount: number; rate: number }",
  )
  if (saved is failure) {
    return saved
  }
  return runTool("addTax", { amount: 100, rate: 0.08 })
}
```

Run interactively or supply handlers for the review and save requests.
`designTool` drafts and checks a tool, then lets the user accept it or ask
for changes. Use `writeTool` when the source is already written, and
`listTools` to inspect saved tools.

Each tool has an `impl.agency` exporting `Request` and `run`. A generated
`tool.agency` wraps it with cost and time limits. You can also import its
`tool` export directly from the saved directory.

## Types

### Unresolved

A review point the drafting agent could not fix, in the reviewer's
  words, and the agent's reason.

```ts
/** A review point the drafting agent could not fix, in the reviewer's
  words, and the agent's reason. */
export type Unresolved = {
  point: string;
  reason: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/toolbox.agency#L136))

### ModuleFacts

What `describe` says about a tool's `run` function.

```ts
/** What `describe` says about a tool's `run` function. */
export type ModuleFacts = {
  signature: string;
  docstring?: string;
  effects: string[]
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/toolbox.agency#L175))

### ToolMeta

What meta.json holds: how the tool was made, and how often it ran.
  `requestSchema` is the JSON Schema of the Request type, as the tool's
  own `requestSchema` node reported it at save time; null for a tool
  saved before schemas were recorded.

```ts
/** What meta.json holds: how the tool was made, and how often it ran.
  `requestSchema` is the JSON Schema of the Request type, as the tool's
  own `requestSchema` node reported it at save time; null for a tool
  saved before schemas were recorded. */
export type ToolMeta = {
  purpose: string;
  request: string;
  requestSchema?: Json;
  createdAt: string;
  maxTime: number;
  version: number;
  uses: number;
  lastUsedAt?: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/toolbox.agency#L185))

### ToolEntry

One tool in a toolbox. This is what `listTools` returns. If the tool
  could not be read correctly, `broken` holds the reason.

```ts
/** One tool in a toolbox. This is what `listTools` returns. If the tool
  could not be read correctly, `broken` holds the reason. */
export type ToolEntry = {
  name: string;
  dir: string;
  module: ModuleFacts;
  meta: ToolMeta;
  broken?: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/toolbox.agency#L198))

## Effects

### std::toolbox::scan

```ts
@alwaysUnder(dir)
effect std::toolbox::scan {
  dir: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/toolbox.agency#L83))

### std::toolbox::recordUse

```ts
@alwaysUnder(dir)
effect std::toolbox::recordUse {
  dir: string;
  name: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/toolbox.agency#L91))

### std::toolbox::writeFile

```ts
@alwaysUnder(root)
effect std::toolbox::writeFile {
  root: string;
  dir: string;
  filename: string;
  content: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/toolbox.agency#L99))

### std::toolbox::createStaging

```ts
@alwaysUnder(root)
effect std::toolbox::createStaging {
  root: string;
  dir: string;
  name: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/toolbox.agency#L109))

### std::toolbox::removeStaging

```ts
@alwaysUnder(root)
effect std::toolbox::removeStaging {
  root: string;
  dir: string;
  name: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/toolbox.agency#L118))

### std::toolbox::removeStagedFile

```ts
@alwaysUnder(root)
effect std::toolbox::removeStagedFile {
  root: string;
  dir: string;
  name: string;
  filename: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/toolbox.agency#L127))

### std::toolbox::review

```ts
effect std::toolbox::review {
  name: string;
  stagingDir: string;
  source: string;
  /** The draft the previous round showed, or "" on the first round. The
    approval prompt diffs `source` against it, so a redraft shows what
    changed rather than the whole tool again. */
  previous: string;
  effects: string[];
  tested: boolean;
  /** Reviewer findings that do not block the draft: advice to the user
    who asked for the tool. */
  notes: string[];
  /** Reviewer findings the author was asked to fix and the reviewer
    raised again. Empty unless the draft is here because of them. */
  blocking: string[];
  /** Review points the author reported it could not fix, with its reason. */
  unresolved: Unresolved[];
  /** True when this is a draft from earlier in the session that nobody
    accepted, shown again instead of writing a new one. */
  resumed: boolean
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/toolbox.agency#L141))

### std::toolbox::save

```ts
@alwaysUnder(dir)
effect std::toolbox::save {
  dir: string;
  name: string;
  source: string;
  effects: string[]
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/toolbox.agency#L167))

## Functions

### listTools

```ts
listTools(dir: string = "~/.agency-agent/tools"): Result<ToolEntry[]>
```

List saved tools and their metadata, marking unreadable or invalid entries as broken.

  @param dir - Nonempty toolbox directory to scan.

Use the catalog to select a tool before calling `runTool`. Each entry
includes its signature, tool description, effects, and saved metadata.
A `broken` entry explains why the tool cannot be used.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| dir | `string` | "~/.agency-agent/tools" |

**Returns:** `Result<ToolEntry[]>`

**Throws:** `std::toolbox::scan`, `std::ls`

**Needs:** `fileRead`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/toolbox.agency#L383))

### designTool

```ts
designTool(
  name: string,
  purpose: string,
  request: string,
  dir: string = "~/.agency-agent/tools",
  maxRounds: number = 3,
  maxTime: number = 3m,
  maxCost: number = $1.00,
  model: string = "",
  provider: string = "",
  review: boolean = false,
): Result<ToolEntry>
```

Draft a reusable tool, revise it with the user, and save it after acceptance.

  @param name - Unused camelCase name of at most 64 letters or digits, starting with a lowercase letter and excluding "staging".
  @param purpose - What the tool should do, in plain language.
  @param request - Input type as Agency text, such as `{ amount: number; rate: number }`.
  @param dir - Nonempty toolbox directory to write into.
  @param maxRounds - Maximum draft and revision rounds before returning a failure.
  @param maxTime - Saved tool's time limit in milliseconds, at most 59m30s.
  @param maxCost - Saved tool's cost limit in dollars.
  @param model - Model override for drafting and review, or "" for the configured model.
  @param provider - Provider for the model override.
  @param review - Have a review agent inspect drafts before their checks when true.

Use this when a tool still needs to be written or refined. The coding agent
writes against your fixed request type. Each draft gets sandbox compilation
and typechecking; pure, predictable tools also get generated tests.
Set `review: true` to add a review agent before those checks.

The user can accept the draft or give text feedback for another round.
Acceptance still requires the save approval shared with `writeTool`.
An unfinished draft stays available during the session for the same name,
request type, and purpose.

The saved tool runs under `maxTime` and `maxCost`. These limits apply to
future calls of the tool, rather than the drafting process.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| name | `string` |  |
| purpose | `string` |  |
| request | `string` |  |
| dir | `string` | "~/.agency-agent/tools" |
| maxRounds | `number` | 3 |
| maxTime | `number` | 3m |
| maxCost | `number` | $1.00 |
| model | `string` | "" |
| provider | `string` | "" |
| review | `boolean` | false |

**Returns:** `Result<ToolEntry>`

**Throws:** `std::toolbox::removeStaging`, `std::toolbox::createStaging`, `std::toolbox::review`, `std::toolbox::save`, `std::toolbox::scan`, `std::toolbox::writeFile`, `std::run`, `std::guard`, `std::toolbox::removeStagedFile`

**Needs:** `fileRead`, `fileWrite`, `subprocess`, `terminal`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/toolbox.agency#L1607))

### writeTool

```ts
writeTool(
  name: string,
  purpose: string,
  request: string,
  source: string,
  dir: string = "~/.agency-agent/tools",
  maxTime: number = 3m,
  maxCost: number = $1.00,
): Result<ToolEntry>
```

Save an already-written tool after checking its source and obtaining approval.

  @param name - Unused camelCase name of at most 64 letters or digits, starting with a lowercase letter and excluding "staging".
  @param request - Input type as Agency text, matching the source's Request type.
  @param source - Agency-only module exporting `Request` and `run(request: Request): Json`.
  @param dir - Nonempty toolbox directory to write into.
  @param maxTime - Saved tool's time limit in milliseconds, at most 59m30s.
  @param maxCost - Saved tool's cost limit in dollars.

Use this for source you have already written and tested. It compiles and
typechecks the source with a generated wrapper, shows the source and effects
for save approval, and publishes the tool. It makes no model calls and
generates no tests. Use `designTool` to draft or revise with the user.

The source must export a `Request` type matching `request` and a
`run(request: Request): Json` function. Import `Json` from `std::validation`.
The wrapper enforces `maxTime` and `maxCost` on later tool calls.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| name | `string` |  |
| purpose | `string` |  |
| request | `string` |  |
| source | `string` |  |
| dir | `string` | "~/.agency-agent/tools" |
| maxTime | `number` | 3m |
| maxCost | `number` | $1.00 |

**Returns:** `Result<ToolEntry>`

**Throws:** `std::toolbox::removeStaging`, `std::toolbox::createStaging`, `std::toolbox::save`, `std::toolbox::scan`, `std::toolbox::writeFile`, `std::run`, `std::guard`

**Needs:** `fileRead`, `fileWrite`, `subprocess`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/toolbox.agency#L1666))

### runTool

```ts
runTool(
  name: string,
  request: Json,
  dir: string = "~/.agency-agent/tools",
): Result<Json>
```

Run a saved tool with its input and return its result.

  @param name - The saved tool's name under dir.
  @param request - A value matching the tool's Request type.
  @param dir - Nonempty toolbox directory holding the tool.

Runs the saved `main` node in a subprocess under the tool's stored time
limit. Metadata must be readable before the tool starts. After the run,
recording its use count is best-effort: a rejected or failed metadata write
does not change the tool's result. The result itself is not recorded there.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| name | `string` |  |
| request | [Json](validation.md#json) |  |
| dir | `string` | "~/.agency-agent/tools" |

**Returns:** `Result<Json>`

**Throws:** `std::toolbox::scan`, `std::run`, `std::guard`, `std::toolbox::recordUse`

**Needs:** `fileRead`, `fileWrite`, `subprocess`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/toolbox.agency#L1718))
