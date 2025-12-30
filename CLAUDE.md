# ADL (Agent Definition Language) - Project Documentation

## Overview

ADL is a domain-specific language for defining AI agent workflows. It compiles ADL code to executable TypeScript that calls OpenAI's structured output API.

## Project Structure

```
adl-lang/
├── lib/                           # Core implementation
│   ├── adlParser.ts              # Parser using tarsec combinators
│   ├── types.ts                  # AST type definitions
│   ├── generate-ts-file.ts       # CLI tool to generate TS from ADL
│   └── backends/                 # Code generation backends
│       └── typescript.ts         # TypeScript code generator
├── tests/                        # Example ADL programs
│   ├── assignment.adl           # Type hints and prompt assignments
│   └── function.adl             # Function definitions
├── dist/                        # Compiled JavaScript output
├── adl                          # Shell script to run ADL programs
├── index.ts                     # File for testing parser
├── test-generator.ts            # Generator unit test
└── test-full-pipeline.ts        # Full pipeline integration test
```

## Language Features

### Type Hints
Declare variable types using `::` syntax:
```adl
bar :: number
test :: string
```

### Assignments
Assign values to variables:
```adl
x = 5
name = "Alice"
result = someVariable
```

### Prompt Literals
Backtick-delimited prompts for LLM generation:
```adl
bar = `the number 1`
greeting = `say hello`
```

### Function Definitions
Define functions with the `def` keyword:
```adl
def test() {
  foo = 1
  bar = `say hello`
  bar
}
```

## Parser Architecture

The parser uses **tarsec** parser combinators. See docs for tarsec here: https://egonschiele.github.io/tarsec/.

### AST Types

All types defined in `lib/types.ts`.

## Code Generation

### TypeScript Backend (`lib/backends/typescript.ts`)

The TypeScript generator converts ADL to runnable TypeScript code:

### Generator Implementation Details

1. **Two-Pass Processing**
   - Pass 1: Collect all type hints
   - Pass 2: Generate code for all nodes

2. **Type Mapping**
   - `number` → `z.number()`
   - `string` → `z.string()`
   - `boolean` → `z.boolean()`

3. **Node Processing**
   - **TypeHint**: Store type mapping (no code generated)
   - **Assignment (prompt)**: Generate async function + call
   - **Assignment (literal)**: Generate const declaration
   - **FunctionDefinition**: Generate TypeScript function
   - **Literals**: Generate expression statements

## Build & Run

### Building the Project
```bash
pnpm run build  # Compiles TypeScript to dist/
```

### Running ADL Programs

**Using the adl script:**
```bash
./adl tests/assignment.adl
```
This will:
1. Parse `assignment.adl` to AST
2. Generate `assignment.ts`
3. Execute `assignment.ts` with Node.js

**Manual pipeline:**
```bash
# 1. Parse to JSON
pnpm run start tests/assignment.adl

# 2. Generate TypeScript (programmatically)
node dist/lib/generate-ts-file.js input.adl output.ts

# 3. Run TypeScript
node output.ts
```

## Testing

### Parser Test
```bash
pnpm run start tests/assignment.adl
```
Outputs parsed JSON AST.

### Generator Unit Test
```bash
node dist/test-generator.js
```
Tests generator with hardcoded JSON input.

### Full Pipeline Test
```bash
node dist/test-full-pipeline.js tests/assignment.adl
```
Tests: ADL → Parser → Generator → TypeScript output.

## Key Files

### `lib/adlParser.ts`
Main parser implementation. Exports:
- `adlParser(input: string)` - Parses ADL source code
- Individual parsers: `typeHintParser`, `assignmentParser`, etc.

### `lib/types.ts`
TypeScript type definitions for the AST. All node types implement a discriminated union based on the `type` field.

### `lib/backends/typescript.ts`
TypeScript code generator. Exports:
- `generateTypeScript(program: ADLProgram): string`
- `TypeScriptGenerator` class

### `lib/generate-ts-file.ts`
CLI tool that reads an ADL file and writes generated TypeScript to a file.

### `adl` (shell script)
Convenience script to run ADL programs end-to-end.

## Extension Points

### Adding New Backends
Create `lib/backends/<language>.ts` with:
```typescript
export function generate<Language>(program: ADLProgram): string {
  // Implementation
}
```

### Adding New Type Mappings
Edit `mapTypeToZodSchema()` in `lib/backends/typescript.ts`:
```typescript
case "array":
  return "z.array(z.any())";
case "object":
  return "z.object({})";
```

### Adding New Language Features
1. Add AST node type to `lib/types.ts`
2. Add parser in `lib/adlParser.ts`
3. Add code generation in backend generator

## Common Tasks

### Adding a new ADL language feature
1. Define the AST node type in `lib/types.ts`
2. Create parser combinator in `lib/adlParser.ts`
3. Add to main `adlParser` parser
4. Add code generation case in `lib/backends/typescript.ts`
5. Test with a new test file in `tests/`

### Debugging parser issues
1. Use `test-full-pipeline.ts` to see parsed JSON
2. Check parser combinator return values
3. Verify `type` field is set correctly on all nodes

### Debugging generator issues
1. Use `test-generator.ts` with hardcoded JSON
2. Check type hints are collected in first pass
3. Verify node type switches match correctly