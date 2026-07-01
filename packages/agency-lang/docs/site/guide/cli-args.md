---
name: CLI argument parsing
description: How to use `std::args` to parse command-line flags in Agency programs — schema-driven, with auto-generated --help, strict number coercion, required/default handling, and exclusive / required-together flag groups.
---

# CLI argument parsing

When your Agency program is invoked from a shell, `std::args` parses the command line. You declare a schema; the parser returns a typed object of flags plus any positional arguments. On `--help` or a parse error, the parser prints the appropriate output and exits — your `main` only runs when the command line was valid.

## Quick start

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

```
$ greet
Error: missing required flag --out

Usage: greet [options] [args...]
  ...
```

## Usage contract

Call `parseArgs` as the **first thing** in `main`, before installing handlers, before starting a REPL (`std::ui` or `std::ui/cli`), before any side-effectful initialization. The parser exits the process on usage errors and on `--help` — running it before anything exists that would need cleanup keeps that exit safe.

## What the schema accepts

Each flag has a `type` (`"string"`, `"number"`, or `"boolean"`) and optional metadata. Long flag names must match `/^[a-z0-9][a-z0-9-]*$/` — lowercase with dashes.

```ts
type FlagSpec = {
  type: "string" | "number" | "boolean"
  short?: string             // single character
  default?: string | number | boolean
  required?: boolean
  description?: string       // shown in --help
  choices?: string[]         // string flags only; enum constraint
  hidden?: boolean           // parse but omit from --help
}
```

The top-level schema:

```ts
type ArgsSchema = {
  programName?: string       // defaults to basename(process.argv[1])
  description?: string       // shown in --help
  version?: string           // setting this enables --version / -V
  epilog?: string            // free text printed after the options block
  flags: Record<string, FlagSpec>
  groups?: {
    exclusive?: string[][]         // at most one set per inner array
    requiredTogether?: string[][]  // all set, or none
  }
}
```

## Values and coercion

- **String** values come straight through. `--name ""` is allowed.
- **Number** values are parsed strictly. We accept decimal integers and floats (`-1.5e3`); we reject empty strings, leading or trailing whitespace, hex (`0x10`), octal (`0o10`), binary (`0b10`), `NaN`, and `Infinity`.
- **Boolean** flags are `true` when present, `false` otherwise. There is no `--no-verbose` form in v1.

Short flags accept either form: `-n alice` or `-nalice`. Boolean shorts can be clustered: `-vh`. Long flags accept either `--name alice` or `--name=alice`.

`--` ends option parsing: everything after it becomes a positional, even if it looks like a flag.

## Required, default, and groups

- `required: true` means the flag must be provided. The program exits 2 with `missing required flag --out` if it's not.
- `default: <value>` is used when the flag is absent. `required` and `default` together is a schema bug.
- Boolean flags default to `false` when no default is set. `default: true` is rejected as a schema bug in v1, since without `--no-X` such a flag could never be turned off.
- `groups.exclusive` rejects calls that set more than one flag in the listed set: `--json and --yaml are mutually exclusive`.
- `groups.requiredTogether` requires all-or-none of the listed flags: `--output requires --format`. A flag with a `default` counts as "set" here.

## Choices

String flags can constrain values to an enumerated set:

```ts
format: { type: "string", choices: ["json", "yaml", "toml"], default: "json" }
```

Comparison is case-sensitive. An unlisted value triggers `invalid value for --format: "xml" (expected one of: json, yaml, toml)` and exit 2. The placeholder in `--help` is rendered as `<json|yaml|toml>`.

## Auto-help and auto-version

`--help` / `-h` are auto-injected. They print the generated usage to stdout and exit `0`. If your schema declares its own `help` flag, yours wins and auto-help is disabled.

`--version` / `-V` are auto-injected **only** when `schema.version` is set:

```ts
parseArgs({ version: "1.2.3", flags: { /* ... */ } })
```

When `--version` is passed, the parser prints the version string and exits `0`.

`--help` short-circuits before required-flag checking, so `mytool --help` always works even when a required flag would otherwise be missing.

## Errors

Every parse failure writes to **stderr**, prints the generated usage block, and exits with code `2` (the GNU convention for usage errors). The error catalog:

| Situation | Message |
|-----------|---------|
| Unknown long flag | `unknown flag --foo` |
| Unknown short flag | `unknown short flag -x` |
| Missing value | `missing value for --name` |
| Missing required flag | `missing required flag --out` |
| Bad number | `invalid number for --port: "abc"` |
| Bad choice | `invalid value for --format: "xml" (expected one of: json, yaml)` |
| Value passed to boolean | `flag --verbose does not take a value` |
| Greedy flag-value | `--name expects a value; got --verbose (use --name=--verbose to force)` |
| `-x=value` form | `invalid short flag syntax in "-n=alice": use -n alice or -nalice` |
| Repeated single-value flag | `flag --name was provided more than once` |
| Mutex group violation | `--json and --yaml are mutually exclusive` |
| Required-together violation | `--output requires --format` |

## Positionals

Anything in argv that isn't a flag or flag-value, plus everything after `--`, lands in `args.positionals` as a `string[]` in original order. v1 does not typecheck positionals — handle them yourself.

```ts
node main() {
  const args = parseArgs({ flags: { verbose: { type: "boolean" } } })
  for (file in args.positionals) {
    print("processing: " + file)
  }
}
```

## What's not supported (v1)

These have natural future shapes but were left out of v1:

- Repeated flags (`--include a --include b` → `["a", "b"]`).
- Subcommands (`mytool serve --port 3000`). Each subcommand needs its own schema, help, and usage line — a separate concept.
- Negatable booleans (`--no-verbose`). When this lands, `default: true` on booleans becomes meaningful.
- Per-flag custom validators.
- Env-var fallback (`MYTOOL_PORT=3000`).
- Typed positionals.
- `--help <topic>` per-flag help.
- "Did you mean --name?" suggestions.

## Security notes

- The parser produces a data object. It does not `eval`, `require`, or auto-read files referenced by flag values — those are caller decisions.
- The returned `flags` object has a `null` prototype, so a stray `--__proto__` flag (caught as unknown anyway because `strict: true` is on) can never pollute `Object.prototype`.
- Strict number parsing rejects the `0x10` / whitespace / `NaN` family of ambiguous inputs.
- No env-var fallback by default — leaking parent-shell state into flag defaults is a footgun for CI and sandboxed contexts.
