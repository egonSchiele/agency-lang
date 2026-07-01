# Agency Configuration Guide

The Agency compiler can be configured using an `agency.json` file in your project root.

## Configuration Options

### Basic Options

- **`verbose`** (boolean): Enable verbose logging during compilation
- **`outDir`** (string): Output directory for compiled TypeScript files

### Node Type Filtering

- **`excludeNodeTypes`** (string[]): Array of AST node types to exclude from code generation

This allows you to filter out specific types of nodes from the generated code. For example, you might want to exclude all comments in production builds.

**Example:**
```json
{
  "excludeNodeTypes": ["comment", "typeHint"]
}
```

**Available node types:**
- `comment` - Comments in the source code
- `typeHint` - Type hint declarations
- `typeAlias` - Type alias definitions
- `newLine` - Newline nodes
- And more...

### Builtin Function Filtering

- **`excludeBuiltinFunctions`** (string[]): Array of built-in function names to exclude from code generation

This lets you prevent specific built-in functions from being generated in the output. Useful for restricting certain operations in sandboxed environments.

**Example:**
```json
{
  "excludeBuiltinFunctions": ["write", "fetch"]
}
```

**Available builtin functions:**
- `print` - Console logging
- `input` - User input
- `read` - File reading
- `readImage` - Image file reading
- `write` - File writing
- `fetch` - HTTP fetch
- `fetchJSON` / `fetchJson` - JSON fetch
- `sleep` - Async sleep

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
    `"warn"`. Exempt: functions with no return type, or a `void`/`never` return
    type, and graph nodes. This first release also **skips any function that uses
    a `match`** — whether a match-ending function returns on every path depends on
    match exhaustiveness, which will be integrated in a follow-up; until then such
    functions are never flagged (no false positives).

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

### Fetch Domain Restrictions

- **`allowedFetchDomains`** (string[]): Safelist of domains allowed for fetch operations
- **`disallowedFetchDomains`** (string[]): Blocklist of domains disallowed for fetch operations

These options control which domains can be accessed via the `fetch`, `fetchJSON`, and `fetchJson` built-in functions. This is useful for security and compliance requirements.

**Behavior:**
- If only `allowedFetchDomains` is set: Only those domains are allowed
- If only `disallowedFetchDomains` is set: All domains except those are allowed
- If both are set: Only domains in `allowedFetchDomains` that are NOT in `disallowedFetchDomains` are allowed

**Example:**
```json
{
  "allowedFetchDomains": ["api.openai.com", "api.example.com"],
  "disallowedFetchDomains": ["malicious.com"]
}
```

**Note:** Domain validation only works for string literal URLs at compile time. Variable URLs cannot be validated during compilation.

## Example Configuration

```json
{
  "verbose": false,
  "outDir": "./dist",
  "excludeNodeTypes": ["comment"],
  "excludeBuiltinFunctions": ["write"],
  "allowedFetchDomains": [
    "api.openai.com",
    "api.anthropic.com",
    "api.example.com"
  ],
  "disallowedFetchDomains": [
    "malicious.com",
    "blocked.site.com"
  ]
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
