---
name: "args"
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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/args.agency#L47))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/args.agency#L62))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/args.agency#L71))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/args.agency#L85))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/args.agency#L90))
