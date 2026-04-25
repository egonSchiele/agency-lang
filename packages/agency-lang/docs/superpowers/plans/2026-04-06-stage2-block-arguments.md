# Stage 2: Block Arguments

## Goal

Add the ability to pass code blocks as the last argument to functions. Blocks are serializable, support substeps, and can contain interrupts. This is the foundation for user-defined fork strategies in Stage 4.

## Prerequisites

Stage 1 (Runner class) should be complete.

## Language Design

### Syntax

A block argument is an inline code block passed after the closing `)` of a function call:

```
// Block with no parameters
let results = sample(5) {
  llm("Classify: ${text}")
}

// Block with a single parameter
let results = map(items) as item {
  llm("Summarize: ${item}")
}

// Block with multiple parameters
let result = retry(3) as (prev, attempt) {
  if attempt == 1 {
    return llm("Write code for: ${spec}")
  } else {
    return llm("Fix: ${prev}. Errors: ${getErrors(prev)}")
  }
}
```

The `as <params>` clause is optional — if omitted, the block takes no parameters.

### Type System

A block type is written as `(params) -> returnType`:

```
// Function that accepts a block
def sample(n: number, block: () -> string): string[] { ... }

// Block with parameters
def map(items: any[], block: (any) -> any): any[] { ... }

// Block with multiple parameters
def retry(n: number, block: (any, number) -> any): any { ... }
```

The block is always the **last** parameter in the function signature.

### Optional Blocks

A block parameter can be optional:

```
def process(data: string, transform?: (string) -> string): string {
  if transform != null {
    return transform(data)
  }
  return data
}

// Called with block:
process("hello") as s { return uppercase(s) }

// Called without block:
process("hello")
```

Default values for block parameters are **not supported**. Use optional + null check for fallback behavior.

### Variadic Arguments + Blocks

Variadic arguments and blocks don't conflict — variadic args are inside the parens, blocks are trailing:

```
// Signature: variadic first, block last
def foo(...args: number[], block: () -> string): string { ... }

// Call: variadic collects [1, 2, 3], block is trailing
foo(1, 2, 3) {
  return "hello"
}
```

The parser sees `)` followed by `{` or `as` and knows it's a block, not another expression.

### Semantics

- A block is a **closure** — it captures variables from the enclosing scope.
- Captured variables are **copies** (value semantics). Mutations inside the block don't affect the outer scope. This is consistent with fork isolation (Stage 3).
- A block can contain **any Agency statements**: LLM calls, control flow, function calls, interrupts.
- A block can `return` a value. If no explicit return, the last expression's value is returned (or void).
- A block gets its own **substeps**, so interrupts can resume mid-block.

### Serialization

Blocks are directly serializable. A serialized block consists of:

1. **Block identity**: a compiler-generated ID that maps to the block's compiled function in the generated code.
2. **Captured variables**: copies of all variables from the enclosing scope that the block references. These are stored in the block's StateStack frame.
3. **Substep state**: the current step within the block, stored in the frame's step counter and substep variables.

On resume from an interrupt inside a block:
1. The function is re-entered (its frame is restored from StateStack)
2. The block is reconstructed from its identity + the serialized captured variables
3. The block's substeps are skipped to the right point using the Runner

This works because:
- The block's compiled code is always present in the generated TypeScript (it's not dynamic)
- All captured state is in the StateStack, which is already serialized
- The substep mechanism (from Stage 1's Runner) handles resume-to-correct-step

### Restrictions

- Blocks cannot contain node transitions (`return nodeCall()`) — nodes represent graph edges, which don't make sense inside a block.
- A function can accept at most one block argument, and it must be the last parameter.

## Deliverables

### 1. AST node types (`lib/types/`)

Create a new AST node for block arguments:

```typescript
// lib/types/blockArgument.ts
export type BlockArgument = {
  type: "blockArgument";
  params: FunctionParameter[];  // [] if no `as` clause
  body: AgencyNode[];
  loc?: SourceLocation;
};
```

Update the `FunctionCall` AST node to include an optional block:

```typescript
// Update existing FunctionCall type in lib/types/function.ts
export type FunctionCall = BaseNode & {
  type: "functionCall";
  functionName: string;
  arguments: (Expression | SplatExpression | NamedArgument)[];
  block?: BlockArgument;  // NEW
  async?: boolean;
  tools?: UsesTool;
};
```

Add a block type for the type system:

```typescript
// lib/types/blockType.ts
export type BlockType = {
  type: "blockType";
  params: { name: string; typeAnnotation: AgencyType }[];
  returnType: AgencyType;
  optional?: boolean;
};
```

Add both to the `AgencyNode` union in `lib/types.ts`.

### 2. Parser (`lib/parsers/`)

**Block argument parser**: Parse the trailing block after a function call. Check for `as` keyword to determine if the block has parameters:

```
functionCall = identifier "(" args ")" blockArg?
blockArg = "as" blockParams "{" body "}"
         | "{" body "}"
blockParams = identifier
            | "(" identifier ("," identifier)* ")"
```

**Block type parser**: Parse block types in type annotations:

```
blockType = "(" paramTypes ")" "->" returnType
          | "()" "->" returnType
```

Add unit tests in co-located `.test.ts` files.

### 3. Symbol table and program info

- `buildSymbolTable`: blocks don't introduce new symbols, but if a block is passed to a function, the function's signature should be checked for a block parameter.
- `collectProgramInfo`: track which function calls include block arguments, for the preprocessor.

### 4. Type checker (`lib/typeChecker.ts`)

- Validate block argument matches the expected block type in the function signature
- Type-check the block body in a scope that includes the block parameters
- Verify captured variables exist in the enclosing scope
- Error if a block argument is passed to a function that doesn't expect one
- Error if a non-optional block parameter has no block argument at call site
- Validate block return type matches the expected return type

### 5. Preprocessor (`lib/preprocessors/typescriptPreprocessor.ts`)

- Resolve variable scopes within block bodies — identify captured variables vs. block-local variables vs. block parameters
- The captured variables should be flagged so the builder knows to snapshot them when creating the block

### 6. Builder (`lib/backends/typescriptBuilder.ts`)

A block compiles to an async arrow function with its own substep tracking.

```typescript
// Agency:
let results = sample(5) as _ {
  let label: string = llm("Classify: ${text}")
  return label
}

// Generated TypeScript (simplified):
const __block_0_id = "block_0";
const results = await sample(5, async (_, __blockRunner) => {
  const __blockState = __blockRunner.getState();
  await __blockRunner.substep("b0", 0, async () => {
    __blockState.locals.label = await runPrompt(__ctx, ...);
  });
  await __blockRunner.substep("b0", 1, async () => {
    return __blockState.locals.label;
  });
}, __ctx);
```

Key aspects:
- The block gets a Runner (or sub-runner) so it has substep tracking
- The block gets its own State frame (or uses a substep scope within the calling function's frame) so its locals are on the StateStack
- Captured variables from the enclosing scope are copied into the block's state at block creation time
- The block's compiled function has a stable ID for serialization

### 7. Serialization support

When an interrupt occurs inside a block:
1. The block's substep state is saved in the StateStack (as part of the calling function's frame, using substep variables like `__substep_block_0`)
2. The block's captured variables are saved in the StateStack locals
3. On resume, the function is re-entered, the block is re-created, and the substep counter skips to the right point

The block identity (which block in the source) is implicit in the step path — the serialized substep path tells us exactly which block we're in and where.

### 8. Agency code generator (`lib/backends/agencyGenerator.ts`)

Update the Agency code formatter to handle block arguments in function calls, for `agency fmt`.

## Testing Strategy

### Unit tests
- Parser tests for block argument syntax (no params, single param, multiple params, optional)
- Parser tests for block type annotations
- Type checker tests: valid blocks, type mismatches, missing required blocks, optional blocks
- Preprocessor tests: variable scope resolution in blocks (captured vs local vs params)

### Integration test fixtures (`tests/typescriptGenerator/`)
- `block-basic.agency` / `.mts` — simple block argument
- `block-params.agency` / `.mts` — block with parameters
- `block-capture.agency` / `.mts` — block capturing outer variables
- `block-optional.agency` / `.mts` — optional block parameter
- `block-variadic.agency` / `.mts` — variadic args + block

### End-to-end tests (`tests/agency/blocks/`)
- Block executes correctly and returns value
- Captured variables are copies (mutations don't affect outer scope)
- Block with LLM calls (using mock)
- Block with control flow (if/else, loops inside blocks)
- Block with interrupt — interrupt pauses, resume continues mid-block
- Block passed to function that calls it multiple times
- Nested blocks (block inside a block)
- Optional block (function called with and without)

## Files to Modify

| File | Change |
|------|--------|
| `lib/types/blockArgument.ts` | **New** — BlockArgument AST node |
| `lib/types/blockType.ts` | **New** — BlockType for type system |
| `lib/types/function.ts` | Add `block` field to FunctionCall |
| `lib/types.ts` | Add to AgencyNode union, export new types |
| `lib/parsers/expression.ts` or `lib/parsers/block.ts` | Parser for block arguments and block types |
| `lib/parser.ts` | Wire in block parsers |
| `lib/typeChecker.ts` | Type check block arguments |
| `lib/preprocessors/typescriptPreprocessor.ts` | Variable scope resolution for blocks |
| `lib/backends/typescriptBuilder.ts` | Code generation for blocks |
| `lib/backends/agencyGenerator.ts` | Format block arguments |
| `lib/ir/tsIR.ts` | IR node for block arguments if needed |
| `lib/ir/prettyPrint.ts` | Print block-related IR |
| `tests/typescriptGenerator/block-*.agency` | **New** — integration fixtures |
| `tests/agency/blocks/` | **New** — end-to-end tests |
