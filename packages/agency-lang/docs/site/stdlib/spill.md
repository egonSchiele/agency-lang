---
name: "spill"
description: "Where long tool output goes, and how to read it back."
---

# spill

A command can print far more than a model should be handed in one tool
  result. Cutting the output off hid whether a build had finished, and the
  model re-ran the command to find out. So output past `MAX_STDOUT_LEN` is
  saved instead, and the model gets a preview: the exit code, a few lines
  from each end, and the name the output was saved under.

  Saved output lives in the run, not on disk: it is kept in the run's
  globals, so it is copied into every checkpoint and is still there after a
  pause and resume, in this process or another. Nothing is written to a
  directory. The store holds about a million characters; when it is full,
  the oldest output goes, and reading its name back says it is no longer
  available.

  When an `llm()` call offers `readSpill`, the tool loop uses the same store
  for any tool result over the `maxToolResultChars` cap, so a long page from
  `fetchMarkdown` reaches the model the same way: a preview and a name.
  When it does not, the loop cuts the result at the cap.

  Two tools read saved output back: `readSpill` for the whole text or a
  slice of lines, and `grepSpill` to search it. Both take a name, never a
  path, and raise no interrupt: the output was already in the conversation
  the model was handed the name in. `shellTools()` in
  `std::agents/lib/toolkits` includes the two, and `spillTools()` is the
  two on their own, for an agent that fetches pages without running
  commands.

  ```agency
  import { keepOutput, readSpill, grepSpill } from "std::spill"

  const shown = keepOutput(hugeBuildLog, 1)
  // shown is a preview naming an output such as 2026-09-04T01-02-03-000Z-a1b2c3.log
  const tail = readSpill("2026-09-04T01-02-03-000Z-a1b2c3.log", offset: 900, limit: 50)
  const errors = grepSpill("error", filename: "2026-09-04T01-02-03-000Z-a1b2c3.log")
  ```

## Constants

### MAX_STDOUT_LEN

```ts
export static const MAX_STDOUT_LEN = 2000
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/spill.agency#L43))

## Functions

### keepOutput

```ts
keepOutput(text: string, exitCode: number): string
```

What the model gets back for a command's output.

  Short output comes back exactly as printed. Long output is saved in the
  run and replaced by a preview: the exit code, the first and last lines,
  and the name it was saved under, with the tools that read it.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| text | `string` |  |
| exitCode | `number` |  |

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/spill.agency#L45))

### readSpill

```ts
readSpill(filename: string, offset: number = 0, limit: number = 0): Result
```

Read saved tool output, named in a "full output saved as" notice. Returns the whole text, or a slice of lines when offset or limit is set.

  @param filename - The name from the notice, such as 2026-09-04T01-02-03-000Z-a1b2c3.log. A name only, never a path.
  @param offset - 1-indexed line to start at (0 means start of the text)
  @param limit - Maximum number of lines to return (0 means read to the end)

**Parameters:**

| Name | Type | Default |
|---|---|---|
| filename | `string` |  |
| offset | `number` | 0 |
| limit | `number` | 0 |

**Returns:** `Result`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/spill.agency#L56))

### grepSpill

```ts
grepSpill(pattern: string, filename: string, maxResults: number = 100): Result
```

Search saved tool output for a regular expression. Each match comes back with its line number and line text. Patterns use JavaScript regex syntax.

  @param pattern - The regular expression to search for
  @param filename - The name from a "full output saved as" notice. A name only, never a path.
  @param maxResults - Most matches to return

**Parameters:**

| Name | Type | Default |
|---|---|---|
| pattern | `string` |  |
| filename | `string` |  |
| maxResults | `number` | 100 |

**Returns:** `Result`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/spill.agency#L71))
