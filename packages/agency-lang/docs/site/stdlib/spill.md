---
name: "spill"
description: "Where long tool output goes, and how to read it back."
---

# spill

Use saved output to inspect long command results without sending the whole
  text to the model at once. Output past `MAX_STDOUT_LEN` is saved and replaced
  by a preview with the exit code, the first and last lines, and a saved name.

  Saved output survives checkpoints and resumes. The store holds about a
  million characters and removes its oldest entries when full. Reading a
  removed entry returns a failure.

  When an `llm()` call sets `spillToolResultsOver`, the tool loop uses the
  same store for any tool result longer than that or than
  `maxToolResultChars`, so a long page from `fetchMarkdown` reaches the
  model the same way: a preview and a name. The call's tools must then
  include `readSpill`. Without the option, the loop cuts a long result at
  `maxToolResultChars`, whatever the tools are.

  Two tools read saved output back: `readSpill` for the whole text or a
  slice of lines, and `grepSpill` to search it. Both take a name, never a
  path, and raise no interrupt: the output was already in the conversation
  the model was handed the name in. `shellTools()` in
  `std::agents/lib/toolkits` includes the two, and `spillTools()` is the
  two on their own, for an agent that fetches pages without running
  commands.

  ```agency
  import { keepOutput, readSpill, grepSpill } from "std::spill"

  const shown = keepOutput(hugeBuildLog, 1, "make")
  // shown is a preview naming an output such as 2026-09-04T01-02-03-000Z-a1b2c3.log,
  // and saying it is the output of "make"
  const tail = readSpill("2026-09-04T01-02-03-000Z-a1b2c3.log", offset: 900, limit: 50)
  const errors = grepSpill("error", filename: "2026-09-04T01-02-03-000Z-a1b2c3.log")
  ```

## Constants

### MAX_STDOUT_LEN

How much of a command's output comes back inline. Anything longer is
  saved and replaced by a preview (see `keepOutput`).

```ts
/** How much of a command's output comes back inline. Anything longer is
  saved and replaced by a preview (see `keepOutput`). */
export static const MAX_STDOUT_LEN = 2000
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/spill.agency#L42))

## Functions

### keepOutput

```ts
keepOutput(text: string, exitCode: number | null, source: string = ""): string
```

Save long command output and return a preview with its saved name.

Use this when returning command output to an LLM. Short text passes through
unchanged. Long text becomes a preview that includes the exit code and a
saved name. Include `readSpill` and `grepSpill` in the model's tools so it can
inspect the complete output.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| text | `string` |  |  |
| exitCode | `number \| null` |  | The command's exit code, or null for one still running. The preview names a code only when there is one. |
| source | `string` | "" | The command that produced the output, or an empty string when none applies. |

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/spill.agency#L50))

### readSpill

```ts
readSpill(filename: string, offset: number = 0, limit: number = 0): Result
```

Read saved tool output, named in a "full output saved as" notice. Returns the whole text, or a slice of lines when offset or limit is set.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| filename | `string` |  | The name from the notice, such as 2026-09-04T01-02-03-000Z-a1b2c3.log. A name only, never a path. |
| offset | `number` | 0 | 1-indexed line to start at (0 means start of the text) |
| limit | `number` | 0 | Maximum number of lines to return (0 means read to the end) |

**Returns:** `Result`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/spill.agency#L60))

### grepSpill

```ts
grepSpill(
  pattern: string,
  filename: string,
  maxResults: number = 100,
  morePatterns: string[] = [],
): Result
```

Search saved tool output using JavaScript regular expressions. Returns matching
  lines with line numbers, grouped by pattern when morePatterns is supplied.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| pattern | `string` |  |  |
| filename | `string` |  | The saved name from a "full output saved as" notice. A name only, never a path. |
| maxResults | `number` | 100 | Maximum matches per pattern. |
| morePatterns | `string[]` | [] | Additional patterns to search in the same output. |

**Returns:** `Result`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/spill.agency#L75))
