# Agency Configuration Guide

The Agency compiler can be configured using an `agency.json` file in your project root.

## Configuration Options

### Basic Options

- **`verbose`** (boolean): Enable verbose logging during compilation
- **`outDir`** (string): Output directory for compiled TypeScript files

### Type Checker

- **`typechecker`** (object): Type checker configuration

  - **`enabled`** (boolean): Run type checking during compilation. Default: `false`
  - **`strict`** (boolean): Type errors are fatal (implies `enabled: true`). Default: `false`
  - **`strictTypes`** (boolean): Untyped variables are errors. Default: `false`
  - **`undefinedFunctions`** (`"silent" | "warn" | "error"`): What to do when a called
    function (or `Namespace.method(...)` chain on a JS global) cannot be resolved.
    Default: `"silent"`. Recommend setting to `"warn"` once your codebase is clean.
  - **`strictMemberAccess`** (`"silent" | "warn" | "error"`): What to do when a property
    that exists on only some members of an un-narrowed union is accessed — most
    importantly `r.value` / `r.error` on an un-guarded `Result`. Default: `"error"`.
    Narrow first to access branch-specific members safely: an `if (isSuccess(r))` /
    `if (isFailure(r))` guard, `r catch …`, or `match (r) { … }`. Set to `"silent"`
    to restore the old lenient behavior (such accesses type as `any`).
  - **`matchExhaustiveness`** (`"silent" | "warn" | "error"`): What to do when a
    `match` over a closed value type (a `Result`, or a closed literal/value union
    like `"a" | "b"`) doesn't cover every case and has no `_` arm. Default:
    `"error"`. Conservative: open types (`string`/`number`/`any`, effect sets)
    are never required to be exhaustive; a guarded arm doesn't count toward
    coverage; a `_` arm always satisfies it.
  - **`definiteReturns`** (`"silent" | "warn" | "error"`): What to do when a
    function that declares a non-void return type can reach the end of its body
    without `return`ing a value (Agency has no implicit returns). Default:
    `"warn"`; set `"error"` to make it a compile failure (the same
    promote-when-baked path `matchExhaustiveness` took). Exempt: functions with
    no return type, or a `void`/`never` return type, and graph nodes.
    Match-containing functions are fully checked: since match expressions, an
    arm cannot return from the enclosing function (a statement-position arm
    `return` is a compile error; an expression-arm `return` yields to the
    match), so what matters is the code around the match — use
    `return match(...)` to return a match's value. `while (true)` with no
    `break` counts as never falling through.

**Example:**
```json
{
  "typechecker": {
    "enabled": true,
    "strictTypes": true,
    "undefinedFunctions": "warn"
  }
}
```

## Example Configuration

```json
{
  "verbose": false,
  "outDir": "./dist"
}
```

## Usage

1. Create an `agency.json` file in your project root
2. Add your configuration options
3. Run the Agency compiler normally

The configuration will be automatically loaded and applied during compilation.

## Command Line

You can also specify a custom config file path using the `-c` or `--config` flag:

```bash
agency -c custom-config.json compile input.agency
```
