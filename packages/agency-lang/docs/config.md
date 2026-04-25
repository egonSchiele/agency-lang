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

### Fetch Domain Restrictions

- **`allowedFetchDomains`** (string[]): Whitelist of domains allowed for fetch operations
- **`disallowedFetchDomains`** (string[]): Blacklist of domains disallowed for fetch operations

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
