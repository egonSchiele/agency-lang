---
name: "spill"
description: "Where long tool output goes, and how to read it back."
---

# spill

Use saved output to inspect long command results without sending the whole
  text to the model at once. A command's output past `MAX_STDOUT_LINES` lines
  or `MAX_STDOUT_LEN` characters is saved, and what comes back is its last
  lines and the path it can be read at, such as
  `/tmp/agency-spill-501/2026-09-04T01-02-03-000Z-a1b2c3.log`.

  Saved output survives checkpoints and resumes. The store holds about a
  million characters and removes its oldest entries when full. Reading a
  removed entry returns a failure.

  When an `llm()` call sets `spillToolResultsOver`, the tool loop uses the
  same store for any tool result longer than that or than
  `maxToolResultChars`, so a long page from `fetchMarkdown` reaches the
  model the same way: a preview and a path. Without the option, the loop
  cuts a long result at `maxToolResultChars`.

  The path reads like a file, with no interrupt: the output was already in
  the conversation the model was handed the path in. The stdlib's `read`
  takes it, and so does `safeBash`, with `cat`, `tail`, `grep`, `wc` or a
  real program, which reads a copy written just before it runs. Two tools
  here read it too, for an agent with neither: `readSpill` for the whole
  text or a slice of lines, and `grepSpill` to search it. Both take the
  path or the bare name. `spillTools()` in `std::agents/lib/toolkits` is
  the two, for an agent that fetches pages without running commands.

  ```agency
  import { keepOutput, readSpill, grepSpill } from "std::spill"

  const shown = keepOutput(hugeBuildLog, 1, "make")
  // shown ends with a line giving the path of the whole output
  const tail = readSpill("2026-09-04T01-02-03-000Z-a1b2c3.log", offset: 900, limit: 50)
  const errors = grepSpill("error", filename: "2026-09-04T01-02-03-000Z-a1b2c3.log")
  ```

## Constants

### MAX_STDOUT_LEN

How much of a command's output comes back inline: this many characters
  and `MAX_STDOUT_LINES` lines, whichever is reached first. Anything longer
  is saved and its last lines come back (see `keepOutput`).

```ts
/** How much of a command's output comes back inline: this many characters
  and `MAX_STDOUT_LINES` lines, whichever is reached first. Anything longer
  is saved and its last lines come back (see `keepOutput`). */
export static const MAX_STDOUT_LEN = 50000
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/spill.agency#L44))

### MAX_STDOUT_LINES

```ts
export static const MAX_STDOUT_LINES = 2000
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/spill.agency#L45))

## Functions

### keepOutput

```ts
keepOutput(text: string, exitCode: number | null, source: string = ""): string
```

Save long command output and return its last lines with the path it can be read at.

Use this when returning command output to an LLM. Short text passes through
unchanged. Long text is saved, and what comes back is its last lines, then a
line saying which lines those are and the path of the whole output. Give the
model something that reads a path: `read`, `safeBash`, or `readSpill`.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| text | `string` |  |  |
| exitCode | `number \| null` |  | The command's exit code, or null when there is none to show. The notice names a code only when there is one. |
| source | `string` | "" | The command that produced the output, or an empty string when none applies. |

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/spill.agency#L53))

### readSpill

```ts
readSpill(filename: string, offset: number = 0, limit: number = 0): Result
```

Read saved tool output, from a "saved as a file" notice. Returns the whole text, or a slice of lines when offset or limit is set.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| filename | `string` |  | The path from the notice, or its last part alone, such as 2026-09-04T01-02-03-000Z-a1b2c3.log. |
| offset | `number` | 0 | 1-indexed line to start at (0 means start of the text) |
| limit | `number` | 0 | Maximum number of lines to return (0 means read to the end) |

**Returns:** `Result`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/spill.agency#L63))

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
| filename | `string` |  | The path from a "saved as a file" notice, or its last part alone. |
| maxResults | `number` | 100 | Maximum matches per pattern. |
| morePatterns | `string[]` | [] | Additional patterns to search in the same output. |

**Returns:** `Result`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/spill.agency#L78))
