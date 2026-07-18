---
name: "args"
description: "Parse command-line flags. Features: - required flags - default values - mutually-exclusive groups - auto-generated `--help` / `--version` - number coercion"
---

# args

Parse command-line flags.
  Features:
  - required flags
  - default values
  - mutually-exclusive groups
  - auto-generated `--help` / `--version`
  - number coercion

  Call `parseArgs` as the first thing in `main`.

  On a usage error it prints to stderr and exits 2.
  On `--help` / `--version` it prints to stdout and exits 0.

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

Invoking the program:

```
$ greet --name alice --out result.txt -v
Hello, alice!
```

```
$ greet --help
Usage: greet [options] [args...]

Print a friendly greeting.

Options:
  -n, --name <string>    Who to greet (default: "world")
  -r, --repeat <number>  How many times (default: 1)
  -v, --verbose          Chatty output
      --out <string>     Output path (required)
  -h, --help             Show this help and exit
```

## Important types (see below for details)
- `FlagSpec` - description of a single flag
- `FlagGroups` - optional constraints on groups of flags
- `ArgsSchema` - full schema for one call to `parseArgs`

## Values and coercion

- **String** values come straight through. `--name ""` is allowed.
- **Number** values are parsed strictly. We accept decimal integers and floats (`-1.5e3`). We reject empty strings, leading or trailing whitespace, hex (`0x10`), octal (`0o10`), binary (`0b10`), `NaN`, and `Infinity`.
- **Boolean** flags are `true` when present, `false` otherwise. There is no `--no-verbose` form.

Short flags accept either form: `-n alice` or `-nalice`. Boolean shorts can be clustered: `-vh`. Long flags accept either `--name alice` or `--name=alice`.

`--` ends option parsing: everything after it becomes a positional, even if it looks like a flag.

A parameter can't be both `required` and have a `default`.

Boolean flags default to `false` when no default is set. `default: true` is rejected as a schema bug, since without `--no-X` such a flag could never be turned off.

## Choices

String flags can constrain values to an enumerated set:

```ts
format: { type: "string", choices: ["json", "yaml", "toml"], default: "json" }
```

Comparison is case-sensitive.

## Auto-help and auto-version

`--help` / `-h` are auto-injected. They print the generated usage to stdout and exit `0`. If your schema declares its own `help` flag, yours wins and auto-help is disabled.

`--version` / `-V` are auto-injected **only** when `schema.version` is set:

```ts
parseArgs({ version: "1.2.3" ... })
```

When `--version` is passed, the parser prints the version and exits.

## What's not supported

- Repeated flags (`--include a --include b` → `["a", "b"]`).
- Subcommands (`mytool serve --port 3000`).
- Negatable booleans (`--no-verbose`).
- Per-flag custom validators.
- Env-var fallback (`MYTOOL_PORT=3000`).
- Typed positionals.
- `--help <topic>` per-flag help.
- "Did you mean --name?" suggestions.

## Types

### FlagSpec

Description of a single flag.

- `short` = single-character alias (eg `-n` for `--name`).
- `default` and `required` are mutually exclusive.
- `choices` constrains string flags to a fixed set of values.
- `hidden` flags still parse but are omitted from `--help`.
- a bare `--flag` is a missing-value error unless `optional` is set,
  in which case it yields "" instead of an error.

```ts
/** Description of a single flag.

- `short` = single-character alias (eg `-n` for `--name`).
- `default` and `required` are mutually exclusive.
- `choices` constrains string flags to a fixed set of values.
- `hidden` flags still parse but are omitted from `--help`.
- a bare `--flag` is a missing-value error unless `optional` is set,
  in which case it yields "" instead of an error. */
export type FlagSpec = {
  type: "string" | "number" | "boolean";
  short?: string;
  default?: string | number | boolean;
  required?: boolean;
  description?: string;
  choices?: string[];
  hidden?: boolean;
  optional?: boolean
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/args.agency#L121))

### FlagGroups

Optional flag-group constraints. `exclusive` declares sets of
    flags where at most one may be set. `requiredTogether` declares
    sets where setting one requires setting all. A flag with a
    `default` counts as "set" for group purposes.

```ts
/** Optional flag-group constraints. `exclusive` declares sets of
    flags where at most one may be set. `requiredTogether` declares
    sets where setting one requires setting all. A flag with a
    `default` counts as "set" for group purposes. */
export type FlagGroups = {
  exclusive?: string[][];
  requiredTogether?: string[][]
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/args.agency#L136))

### ArgsSchema

Full schema for one call to `parseArgs`.
    `programName` defaults to `process.argv[1]`'s basename if omitted.
    Set it explicitly when running under the agency CLI or a bundled
    agent. Setting `version` enables auto-generated `--version` / `-V`.

```ts
/** Full schema for one call to `parseArgs`.
    `programName` defaults to `process.argv[1]`'s basename if omitted.
    Set it explicitly when running under the agency CLI or a bundled
    agent. Setting `version` enables auto-generated `--version` / `-V`. */
export type ArgsSchema = {
  programName?: string;
  description?: string;
  version?: string;
  epilog?: string;
  flags: Record<string, FlagSpec>;
  groups?: FlagGroups
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/args.agency#L145))

### ParsedArgs

Result of a successful parse.
    `flags` is a map of declared flag names to coerced
    values (string / number / boolean per the schema). `positionals` is
    every argv token that wasn't a flag or flag-value, in original
    order, plus everything after `--`.

```ts
/** Result of a successful parse.
    `flags` is a map of declared flag names to coerced
    values (string / number / boolean per the schema). `positionals` is
    every argv token that wasn't a flag or flag-value, in original
    order, plus everything after `--`. */
export type ParsedArgs = {
  flags: Record<string, any>;
  positionals: string[]
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/args.agency#L159))

## Functions

### parseArgs

```ts
parseArgs(schema: ArgsSchema): ParsedArgs
```

Given the schema, parse `process.argv`.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| schema | [ArgsSchema](#argsschema) |  |

**Returns:** [ParsedArgs](#parsedargs)

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/args.agency#L164))
