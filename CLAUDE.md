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

### Tarsec Parser Structure

Tarsec is a parser combinator library that provides composable building blocks for creating parsers.

#### How Tarsec Parsers Work

**Parser Type:**
- A parser has type `Parser<T>` where `T` is the type of value it parses
- Parsers are functions that take a string input and return a `ParserResult<T>`

**Calling Parsers:**
```typescript
const result = numberParser("42");
// Parser is called directly as a function
```

**ParserResult Structure:**

Success case:
```typescript
{
  success: true,
  result: T,      // The parsed value (e.g., { type: "number", value: "42" })
  rest: string    // Remaining unparsed input
}
```

Failure case:
```typescript
{
  success: false,
  rest: string,   // The input that couldn't be parsed
  message: string // Error message (e.g., "expected at least one match")
}
```

#### Common Tarsec Combinators

**Basic Parsers:**
- `char(c)` - Matches a single character
- `str(s)` - Matches a string
- `digit` - Matches a digit (0-9)
- `alphanum` - Matches alphanumeric characters
- `space` - Matches a single space

**Combinators:**
- `or(p1, p2, ...)` - Tries parsers in order, returns first success
- `many(p)` - Matches parser zero or more times, returns array
- `many1(p)` - Matches parser one or more times
- `many1Till(terminator)` - Matches characters until terminator is found
- `manyTill(terminator)` - Matches zero or more characters until terminator
- `sepBy(separator, parser)` - Matches parser separated by separator

**Sequence Combinators:**
- `seqC(...)` - Sequence parser that **captures** specific parts
- `seqR(...)` - Sequence parser that returns the **rightmost** result

**Capture and Set:**
- `capture(parser, fieldName)` - Captures parser result into a field
- `set(fieldName, value)` - Sets a field to a constant value

**Transformers:**
- `map(parser, fn)` - Transforms parser result with a function

#### Example Parser Patterns

**Simple Value Parser:**
```typescript
// Parses a number and returns { type: "number", value: "123" }
export const numberParser: Parser<NumberLiteral> = seqC(
  set("type", "number"),                              // Set type field
  capture(many1WithJoin(or(char("-"), char("."), digit)), "value") // Capture digits
);
```

**Choice Parser:**
```typescript
// Try multiple parsers in order
export const literalParser: Parser<Literal> = or(
  promptParser,      // Try prompt first
  numberParser,      // Then number
  stringParser,      // Then string
  variableNameParser // Finally variable name (catch-all)
);
```

**Complex Sequence Parser:**
```typescript
// Parses `${variableName}` interpolations
export const interpolationSegmentParser: Parser<InterpolationSegment> = seqC(
  set("type", "interpolation"),           // Set type field
  char("$"),                               // Match $
  char("{"),                               // Match {
  capture(many1Till(char("}")), "variableName"), // Capture until }
  char("}")                                // Match }
);
```

**Parser with Transformation:**
```typescript
// Parses text and transforms into object
export const textSegmentParser: Parser<TextSegment> = map(
  many1Till(or(backtick, char("$"))),    // Parse until backtick or $
  (text) => ({
    type: "text",
    value: text,
  })
);
```

#### Key Patterns in lib/parsers/literals.ts

1. **Use `seqC` for building objects:** When you need to parse multiple things and build an object with specific fields
2. **Use `set()` for discriminated unions:** Set the `type` field for AST node types
3. **Use `capture()` to extract values:** Capture parsed values into named fields
4. **Use `or()` for alternatives:** Try different parsers in precedence order
5. **Use `map()` for transformations:** Transform parsed text into structured objects

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

### Automated Tests with Vitest

The project uses **vitest** for automated testing.

#### Running Tests

```bash
pnpm test         # Run tests in watch mode
pnpm test:run     # Run tests once
```

#### Writing Tests for Parsers

Test files are placed alongside source files with `.test.ts` extension:
- Source: `lib/parsers/literals.ts`
- Tests: `lib/parsers/literals.test.ts`

**Test Structure Pattern:**
```typescript
import { describe, it, expect } from 'vitest';
import { numberParser } from './literals';

describe('numberParser', () => {
  const testCases = [
    {
      input: "42",
      expected: {
        success: true,
        result: { type: "number", value: "42" }
      }
    },
    {
      input: "abc",
      expected: { success: false }
    }
  ];

  testCases.forEach(({ input, expected }) => {
    if (expected.success) {
      it(`should parse "${input}" successfully`, () => {
        const result = numberParser(input);
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.result).toEqual(expected.result);
        }
      });
    } else {
      it(`should fail to parse "${input}"`, () => {
        const result = numberParser(input);
        expect(result.success).toBe(false);
      });
    }
  });
});
```

**Key Testing Patterns:**

1. **Test Case Arrays:** Define test cases as arrays with `input` and `expected` fields
2. **Success Cases:** Check both `success: true` and the parsed `result` value
3. **Failure Cases:** Only check `success: false`
4. **Type Guards:** Use `if (result.success)` before accessing `result.result` for type safety
5. **Comprehensive Coverage:** Test happy paths, edge cases, and failure cases

**What to Test for Parsers:**

- **Happy path:** Valid inputs that should parse successfully
- **Edge cases:** Empty strings, single characters, boundary values
- **Special characters:** Whitespace, tabs, newlines, punctuation
- **Failure cases:** Invalid syntax, missing delimiters, wrong types
- **Precedence:** For choice parsers like `or()`, verify correct ordering

## Key Files

### `lib/adlParser.ts`
Main parser implementation. Exports:
- `parseADL(input: string)` - Parses ADL source code
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