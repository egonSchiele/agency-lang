---
name: "spill"
description: "Where long tool output goes, and how to read it back."
---

# spill

A command can print far more than a model should be handed in one tool
  result. Cutting the output off hid whether a build had finished, and the
  model re-ran the command to find out. So output past `MAX_STDOUT_LEN` is
  saved to a file instead, and the model gets a preview: the exit code, a
  few lines from each end, and the file's name.

  Saved files live in one fixed directory, `~/.agency-agent/tool-output`,
  outside every project. The model never chooses the location, nothing
  lands in a repository, and there is one place to clean up. Set
  `AGENCY_TOOL_OUTPUT_DIR` to move it.

  Two tools read the files back: `readSpill` for the whole file or a slice
  of lines, and `grepSpill` to search one. Both take a file name, never a
  path, so they cannot reach anything else. Each raises its own effect, so
  a policy can approve reading saved output without opening the
  general-purpose read tools any wider.

  ```agency
  import { keepOutput, readSpill, grepSpill } from "std::spill"

  const shown = keepOutput(hugeBuildLog, 1)
  // shown is a preview naming a file such as 2026-09-04T01-02-03-000Z-a1b2c3.log
  const tail = readSpill("2026-09-04T01-02-03-000Z-a1b2c3.log", offset: 900, limit: 50)
  const errors = grepSpill("error", filename: "2026-09-04T01-02-03-000Z-a1b2c3.log")
  ```

## Effects

### std::spill::write

Saving one long tool output to the spill directory.

```ts
/** Saving one long tool output to the spill directory. */
effect std::spill::write {
  filename: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/spill.agency#L51))

### std::spill::read

Reading or searching one saved output file.

```ts
/** Reading or searching one saved output file. */
effect std::spill::read {
  filename: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/spill.agency#L54))

## Constants

### MAX_STDOUT_LEN

```ts
export static const MAX_STDOUT_LEN = 2000
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/spill.agency#L40))

## Functions

### spillDir

```ts
spillDir(): string
```

The directory saved tool output lives in.

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/spill.agency#L56))

### keepOutput

```ts
keepOutput(text: string, exitCode: number): string raises <std::spill::write>
```

What the model gets back for a command's output.

  Short output comes back exactly as printed. Long output is saved to a
  file and replaced by a preview: the exit code, the first and last lines,
  and the file's name, with the tools that read it.

  If the file cannot be written, or the save is rejected, the output is cut
  at the cap with a visible marker.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| text | `string` |  |
| exitCode | `number` |  |

**Returns:** `string`

**Throws:** `std::spill::write`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/spill.agency#L63))

### readSpill

```ts
readSpill(
  filename: string,
  offset: number = 0,
  limit: number = 0,
): Result raises <std::spill::read>
```

Read a saved tool-output file, named in a "full output saved as" notice. Returns the whole file, or a slice of lines when offset or limit is set.

  @param filename - The file's name from the notice, such as 2026-09-04T01-02-03-000Z-a1b2c3.log. A name only, never a path.
  @param offset - 1-indexed line to start at (0 means start of file)
  @param limit - Maximum number of lines to return (0 means read to end of file)

**Parameters:**

| Name | Type | Default |
|---|---|---|
| filename | `string` |  |
| offset | `number` | 0 |
| limit | `number` | 0 |

**Returns:** `Result`

**Throws:** `std::spill::read`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/spill.agency#L100))

### grepSpill

```ts
grepSpill(
  pattern: string,
  filename: string = "",
  maxResults: number = 100,
): Result raises <std::spill::read>
```

Search a saved tool-output file for a regular expression. Each match comes back with its line number and line text. Patterns use JavaScript regex syntax.

  @param pattern - The regular expression to search for
  @param filename - The file's name from a "full output saved as" notice. Empty searches every saved file.
  @param maxResults - Most matches to return

**Parameters:**

| Name | Type | Default |
|---|---|---|
| pattern | `string` |  |
| filename | `string` | "" |
| maxResults | `number` | 100 |

**Returns:** `Result`

**Throws:** `std::spill::read`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/spill.agency#L118))
