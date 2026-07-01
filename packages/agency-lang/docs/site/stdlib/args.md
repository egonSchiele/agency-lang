---
name: "args"
---

# args

## Module: std::args

  Parse the program's command-line flags. Thin wrapper over Node's
  built-in `node:util.parseArgs` with Agency-friendly defaults:

  - Number coercion with strict parsing (rejects `0x10`, whitespace,
    `NaN`, `Infinity`, etc.).
  - Required-flag and default-value handling.
  - Auto-generated `--help` / `--version`.
  - Mutually-exclusive / required-together flag groups.
  - On parse error: writes a formatted message + usage to stderr and
    exits 2. On `--help` / `--version`: writes to stdout and exits 0.

  ## Usage contract

  Call `parseArgs` as the **first thing** in `main`, before installing
  handlers, before starting a REPL (`std::ui` / `std::ui/cli`), before
  any side-effectful initialization. The function exits the process
  on usage errors and on `--help`; running it before any handlers /
  checkpoints / TUI exist keeps that exit safe.

  ## Example

  ```ts
  import { parseArgs } from "std::args"

  node main() {
    const args = parseArgs({
      programName: "greet",
      description: "Print a friendly greeting.",
      flags: {
        name:    { type: "string",  short: "n", default: "world", description: "Who to greet" },
        repeat:  { type: "number",  short: "r", default: 1,       description: "How many times" },
        verbose: { type: "boolean", short: "v",                   description: "Chatty output" },
        out:     { type: "string",  required: true,               description: "Output path" },
      },
    })

    for (i in range(args.flags.repeat)) {
      print("Hello, " + args.flags.name + "!")
    }
  }
  ```
**

## Types

## Functions

### parseArgs

```ts
parseArgs(schema: ArgsSchema): ParsedArgs
```

Parse `process.argv` against `schema`.

    See the module docstring for the usage contract — call this before
    installing handlers or starting a REPL.

    Returns `{ flags, positionals }`. On usage error, writes a message
    + usage block to stderr and exits 2. On `--help` / `--version`,
    writes to stdout and exits 0. Schema bugs (duplicate `short`,
    `required` + `default`, etc.) throw at call time before any argv
    is touched.

    @param schema - Flag schema describing the program's CLI. See
    `FlagSpec` and `ArgsSchema` for the field reference.
    @returns Parsed `{ flags, positionals }`.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| schema | [ArgsSchema](#argsschema) |  |

**Returns:** [ParsedArgs](#parsedargs)

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/args.agency#L120))
