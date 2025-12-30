# ADL (Agent Definition Language) - Project Documentation

## Overview

ADL is a domain-specific language for defining AI agent workflows that generate structured outputs using LLMs. It compiles ADL code to executable TypeScript that calls OpenAI's structured output API.

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
├── index.ts                     # Parser CLI (outputs JSON)
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

The parser uses **tarsec** parser combinators:
- `seqC()` - Sequential composition, keeps captured values
- `seqR()` - Sequential composition, keeps right value
- `capture()` - Captures parser result with field name
- `set()` - Sets object properties
- `or()` - Alternative parsers
- `many()`, `many1()` - Repetition
- `sepBy()` - Separated list parsing

### AST Types

All types defined in `lib/types.ts`:

```typescript
// Literals
type Literal = NumberLiteral | StringLiteral | VariableNameLiteral | PromptLiteral

// AST Nodes
type ADLNode = TypeHint | FunctionDefinition | Assignment | Literal

// Root program type
type ADLProgram = {
  type: "adlProgram"
  nodes: ADLNode[]
}
```

## Code Generation

### TypeScript Backend (`lib/backends/typescript.ts`)

The TypeScript generator converts ADL to runnable TypeScript code:

**Input (ADL):**
```adl
bar :: number
bar = `the number 1`
```

**Output (TypeScript):**
```typescript
import OpenAI from "openai";
import { zodResponseFormat } from "openai/helpers/zod";
import { z } from "zod";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

async function _bar() {
  const completion = await openai.chat.completions.create({
    model: "gpt-4o-2024-08-06",
    messages: [{ role: "user", content: "the number 1" }],
    response_format: zodResponseFormat(
      z.object({ value: z.number() }),
      "number_response"
    ),
  });
  const result = completion.choices[0].message.parsed;
  console.log(result);
  console.log(result?.value);
  return result;
}
const bar = await _bar();
```

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

## Dependencies

### Runtime
- **tarsec** (^0.0.20) - Parser combinator library

### Development
- **typescript** (^5.9.3) - TypeScript compiler
- **@types/node** (^25.0.3) - Node.js type definitions

### Generated Code Requirements
The generated TypeScript requires:
- **openai** - OpenAI API client
- **zod** - Schema validation
- Node.js with TypeScript support

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

## Configuration

### `tsconfig.json`
- Target: ES2016
- Module: CommonJS
- Strict mode enabled
- Excludes: `references/` directory (contains examples needing external deps)

### `package.json`
- Scripts:
  - `build`: Compile TypeScript
  - `start`: Run index.js with arguments

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

## Known Limitations

1. **Prompts in functions**: Currently marked as TODO - functions containing prompts need async/await handling
2. **Complex types**: Only supports primitive types (number, string, boolean)
3. **Error handling**: Limited error reporting in generated code
4. **Single file output**: Generated code is monolithic

## Architecture Decisions

### Why tarsec?
Parser combinator libraries provide composable, maintainable parsing logic without code generation.

### Why two-pass generation?
Type hints can appear before or after their usage, so we collect all type information first.

### Why separate backends?
Modular architecture allows supporting multiple target languages (Python, Go, etc.) in the future.

### Why OpenAI structured outputs?
Provides reliable, schema-validated responses from LLMs with built-in retry logic.
