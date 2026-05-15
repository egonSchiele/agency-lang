# Destructuring and Pattern Matching Design Spec

**Date:** 2026-05-14
**Status:** Draft

## Summary

Add a unified pattern language to Agency that supports destructuring and structural pattern matching. Patterns are a single grammar construct, built recursively with parser combinators, that can appear in multiple language positions.

## Motivation

Agency code frequently works with structured data from LLM calls — especially tagged unions (discriminated unions). Today, dispatching on tagged unions requires verbose `if/else if` chains with manual field access:

```
if (step.type == "showPolicy") {
  let policy = step.policy
  handleShow(policy)
} else if (step.type == "writePolicy") {
  let policy = step.policy
  writePolicyFile(outputPath, policy)
} else if (step.type == "askQuestion") {
  print(step.question)
}
```

Similarly, extracting multiple values from an array requires repeated indexing:

```
let cliArgs = args()
let interruptKindsJson = cliArgs[0]
let outputPath = cliArgs[1]
```

Both cases are cleaner with destructuring and pattern matching.

## Pattern Language

### Parser Combinators

The pattern parser is recursive. All pattern forms can nest inside each other. Written in parser combinator style matching Agency's existing parser infrastructure:

```typescript
// Core pattern parser — recursive, all forms can nest
const patternParser: Parser<Pattern> = or(
  objectPatternParser,
  arrayPatternParser,
  restPatternParser,
  wildcardParser,        // "_"
  literalPatternParser,  // string | number | boolean | null
  identifierParser,      // bare name — binds the matched value
)

// Object patterns: { key: pattern, key: pattern, ...rest }
// Shorthand allowed: { name } means { name: name } (bind field to same-named variable)
const propPatternParser: Parser<PropPattern> = or(
  seqC(capture(keyParser, "key"), char(":"), optionalSpaces, capture(patternParser, "value")),
  restPatternParser,
  capture(identifierParser, "shorthand"),  // { name } shorthand — binds field to same-named var
)

const objectPatternParser: Parser<ObjectPattern> = seqC(
  set("type", "objectPattern"),
  char("{"),
  optionalSpacesOrNewline,
  capture(sepBy(propPatternParser, commaParser), "properties"),
  optionalSpacesOrNewline,
  char("}"),
)

// Array patterns: [p1, p2, ...rest]
const arrayPatternParser: Parser<ArrayPattern> = seqC(
  set("type", "arrayPattern"),
  char("["),
  optionalSpacesOrNewline,
  capture(sepBy(patternParser, commaParser), "elements"),
  optionalSpacesOrNewline,
  char("]"),
)

// Rest pattern: ...identifier (must appear last — enforced as semantic check after parsing)
const restPatternParser: Parser<RestPattern> = seqC(
  set("type", "restPattern"),
  str("..."),
  capture(identifierParser, "identifier"),
)

// Wildcard
const wildcardParser: Parser<Wildcard> = char("_")

// Match arm: pattern (with optional guard) => body
const matchArmParser: Parser<MatchBlockCase> = seqC(
  set("type", "matchBlockCase"),
  optionalSpaces,
  capture(or(wildcardParser, patternParser), "caseValue"),
  optionalSpaces,
  optional(seqC(str("if"), optionalSpaces, char("("), capture(exprParser, "guard"), char(")"))),
  optionalSpaces,
  str("=>"),
  optionalSpaces,
  capture(or(returnStatementParser, lazy(() => assignmentParser), exprParser), "body"),
  optionalSemicolon,
  optionalSpacesOrNewline,
)

// The `is` operator — plugged into the expression parser at the same
// precedence level as equality/comparison operators (==, !=, >, <).
// Left operand is an expression, right operand is a pattern.
// In boolean context: returns boolean, no bindings.
// In if/while/match context: introduces bindings into the block scope.
const isExprParser: Parser<IsExpression> = seqC(
  set("type", "isExpression"),
  capture(exprParser, "expression"),
  optionalSpaces,
  str("is"),
  optionalSpaces,
  capture(patternParser, "pattern"),
)
```

### Object Pattern Shorthand

Object patterns support a shorthand form: `{ name }` means `{ name: name }` — match the `name` field and bind its value to a variable called `name`. This shorthand is only available in pattern contexts (not in expression/object literal contexts), so it introduces no parsing ambiguity.

```
// These are equivalent:
{ type: "showPolicy", policy: policy }
{ type: "showPolicy", policy }
```

### Semantics

- **Literals** match by equality: `"showPolicy"`, `42`, `true`, `null`
- **Bare identifiers** bind the matched value to a new variable: `policy`, `name`
- **`_`** (wildcard) matches anything, binds nothing
- **Object patterns** `{ key: pattern, ... }` match objects. Each key's value is matched against its sub-pattern. Unmentioned fields are silently ignored.
- **Array patterns** `[p1, p2, p3]` match arrays positionally. `_` skips an element. Extra elements beyond the pattern length are silently ignored (like object patterns ignoring unmentioned fields).
- **Rest patterns** `...rest` capture remaining elements (in arrays) or remaining properties (in objects). Must appear last (enforced as a semantic check after parsing).
- **Nested patterns** are supported naturally via recursion: `{ address: { street: street, city: city } }`, `[{ name: name }, { name: name2 }]`, `{ coords: [x, y] }`
- **No default values** in patterns. Use `??` after destructuring if needed.

### Binding Rules

Bare identifiers always bind. There is no way to match against an existing variable's value inside a pattern — use a guard or a separate condition for that.

```
// `policy` binds the value of step.policy to a new variable
{ type: "showPolicy", policy }

// To match against an existing variable, use a guard:
{ type: type, policy } if (type == existingVar) => ...
```

### `const` vs `let` Propagation

When a destructuring appears in a `const` declaration, all bindings introduced by the pattern are `const`. When it appears in a `let` declaration, all bindings are `let`.

```
const [a, b] = items    // a and b are both const (cannot be reassigned)
let { name, age } = person  // name and age are both let (can be reassigned)
```

## The `is` Operator

`is` is a new binary operator that tests whether a value matches a pattern. It can also introduce bindings into the enclosing scope when used in positions that have a receiving block (`if`, `while`, `match`).

### Precedence

`is` has the same precedence as equality/comparison operators (`==`, `!=`, `>`, `<`). This means:

- `x is { a } && y > 5` parses as `(x is { a }) && (y > 5)`
- `x is { a } || fallback` parses as `(x is { a }) || fallback`
- `!(x is { a })` works with unary not

### As a boolean expression (no bindings)

When used as a standalone expression, `is` returns a boolean. No variables are bound.

```
let isShow = step is { type: "showPolicy" }
// isShow: boolean

filter(items, \item -> item is { type: "error" })
```

When a pattern contains only binding positions (no literals), `is` tests for structural presence. For example, `step is { type }` checks that `step` has a `type` field (compiles to `"type" in step` or `step.type !== undefined`). This is a field-existence check.

### With array patterns

`is` works with array patterns as well as object patterns:

```
let isPair = items is [_, _]
// checks that items has at least 2 elements
```

### In `if` conditions (with bindings)

When used inside an `if` condition, bindings introduced by the pattern are available in the `if` body.

```
if (step is { type: "showPolicy", policy }) {
  // `policy` is bound here
  handleShow(policy)
}
```

This replaces the common pattern:
```
if (step.type == "showPolicy") {
  let policy = step.policy
  handleShow(policy)
}
```

### In `while` conditions

```
while (queue.pop() is { status: "pending", task }) {
  process(task)
}
```

Note: if the pattern does not match, the loop exits, but the value returned by `queue.pop()` is consumed and lost. This matches how Rust's `while let` works.

## Runtime Failure Semantics

When a destructuring pattern does not match at runtime, the function returns a `failure` Result, consistent with Agency's error handling model (no exceptions).

Examples of runtime failures:
- `let { name } = null` — fails because `null` has no properties
- `let [a, b] = [1]` — fails because the array has fewer elements than the pattern requires
- A match arm pattern that accesses a field on `null`/`undefined`

For `match` blocks, if no arm matches and there is no `_` wildcard arm, the match block returns a `failure`.

For `is` in boolean context, a non-matching pattern simply returns `false` (no failure).

## Where Patterns Appear

### V1: Declarations

Array destructuring:
```
let [interruptKindsJson, outputPath] = args()
const [first, ...rest] = items
let [_, second, _] = triple
```

Object destructuring:
```
let { name: name, age: age } = person
const { status: status, body: body } = response
let { coords: [x, y] } = location
let { name: name, ...rest } = person
```

Or with shorthand:
```
let { name, age } = person
const { status, body } = response
let { name, ...rest } = person
```

### V1: `match(expr)` with pattern arms

Each arm's left-hand side is a pattern. The first matching arm executes. `_` serves as the default/wildcard arm.

```
match(step) {
  { type: "showPolicy", policy } => handleShow(policy)
  { type: "writePolicy", policy } => writePolicyFile(outputPath, policy)
  { type: "askQuestion", question } => print(question)
  _ => print("unknown step")
}
```

This extends the existing match block. Current literal-only arms continue to work unchanged.

Guards can be added to pattern arms using `if`:

```
match(response) {
  { status, body } if (status >= 400) => handleError(body)
  { status, body } => handleSuccess(body)
}
```

Guard expressions can reference variables bound by the pattern.

### V1: `match(expr is pattern)` with condition arms

The `is` in the match expression destructures once. Arms are then boolean conditions over the bound variables, not patterns.

```
match(response is { status, body }) {
  status >= 400 => handleError(body)
  status == 301 => handleRedirect(body)
  _ => handleSuccess(body)
}
```

This form is useful when you want to destructure once and branch on computed conditions rather than structural shape.

Parser disambiguation: the parser attempts to parse the match expression as `expr is pattern` first. If the `is` keyword is found after the expression, it's the condition-arm form. Otherwise, it's the standard pattern-arm form.

### V1: `if (expr is pattern)`

See the `is` operator section above.

### V1: `for` loops

Patterns can appear where the loop variable currently goes:

```
for ({ name, age } in users) {
  print("${name} is ${age}")
}

for ([key, value] in entries) {
  print("${key}: ${value}")
}
```

### V2: Function parameters (if costly to implement)

```
def greet({ name: name, age: age }: User) {
  print("${name} is ${age}")
}
```

The type annotation after the pattern is required for typechecking.

### V2: Block parameters (if costly to implement)

Trailing `as` syntax:
```
map(users) as { name, age } {
  return "${name}: ${age}"
}
```

Inline blocks:
```
map(users, \{ name, age } -> "${name}: ${age}")
```

## Compilation

Patterns compile to straightforward JavaScript/TypeScript. The compiler generates conditional checks and variable declarations.

### Declaration destructuring

```
// Agency
let { name, age } = person

// Compiles to (option A: native JS destructuring)
const { name, age } = person;

// Or (option B: explicit assignments)
const name = person.name;
const age = person.age;
```

Option A is simpler to generate. Option B gives more control for error messages and works better with Agency's step counter system for interrupt resume.

### Nested pattern compilation

```
// Agency
let { coords: [x, y] } = location

// Compiles to
const __temp = location.coords;
const x = __temp[0];
const y = __temp[1];
```

```
// Agency
let [{ name: name }, { name: name2 }] = users

// Compiles to
const name = users[0].name;
const name2 = users[1].name;
```

### Pattern matching in match arms

```
// Agency
match(step) {
  { type: "showPolicy", policy } => handleShow(policy)
  { type: "askQuestion", question } => print(question)
  _ => print("unknown")
}

// Compiles to
if (step.type === "showPolicy") {
  const policy = step.policy;
  handleShow(policy);
} else if (step.type === "askQuestion") {
  const question = step.question;
  print(question);
} else {
  print("unknown");
}
```

### Match arms with guards

```
// Agency
match(response) {
  { status, body } if (status >= 400) => handleError(body)
  { status, body } => handleSuccess(body)
}

// Compiles to
if (response.status >= 400) {
  const status = response.status;
  const body = response.body;
  handleError(body);
} else {
  const status = response.status;
  const body = response.body;
  handleSuccess(body);
}
```

### `is` operator

```
// Agency — boolean context (no bindings)
let isShow = step is { type: "showPolicy" }

// Compiles to
const isShow = step.type === "showPolicy";

// Agency — binding-only pattern in boolean context (field existence check)
let hasType = step is { type }

// Compiles to
const hasType = step.type !== undefined;

// Agency — with bindings in if context
if (step is { type: "showPolicy", policy }) {
  handleShow(policy)
}

// Compiles to
if (step.type === "showPolicy") {
  const policy = step.policy;
  handleShow(policy);
}

// Agency — is with array pattern
let isPair = items is [_, _]

// Compiles to
const isPair = items.length >= 2;
```

### `match(expr is pattern)` form

```
// Agency
match(response is { status, body }) {
  status >= 400 => handleError(body)
  _ => handleSuccess(body)
}

// Compiles to
const status = response.status;
const body = response.body;
if (status >= 400) {
  handleError(body);
} else {
  handleSuccess(body);
}
```

## Interaction with Existing Features

### Existing match blocks

Current match blocks with literal arms (`"start" => ...`, `200 => ...`) continue to work unchanged. Pattern arms are a superset — a string literal in arm position is just a literal pattern.

### Interrupts

Destructuring in declarations interacts with the step counter system. Each destructured declaration is one step. The compiler must ensure that on interrupt resume, the destructured variables are correctly restored from the serialized state.

### Type checking

- For `let { name, age } = expr`, the typechecker infers the types of `name` and `age` from the type of `expr`.
- For pattern arms in `match`, the typechecker narrows the type within each arm based on the matched pattern (similar to TypeScript's discriminated union narrowing).
- For `is` in boolean context, the result type is `boolean`.
- For `is` in `if` context, the bindings get their types from the narrowed type.

### Exhaustiveness checking

The typechecker emits a warning when a `match(expr)` block with pattern arms doesn't cover all variants of a union type. This applies when:

- The matched expression has a known union type (string literal union or discriminated object union)
- There is no `_` wildcard arm

For example:
```
type Category = "reminder" | "todo" | "general" | "quit"
const category: Category = llm("...")
match(category) {
  "reminder" => handleReminder()
  "todo" => handleTodo()
  // Warning: match is not exhaustive. Missing variants: "general", "quit"
}
```

Exhaustiveness checking for `match(expr is pattern)` (condition arms) is not supported, since the arms are arbitrary boolean expressions.

## Examples: Before and After

### CLI argument extraction (policy agent)

Before:
```
let cliArgs = args()
let interruptKindsJson = cliArgs[0]
let outputPath = cliArgs[1]
```

After:
```
let [interruptKindsJson, outputPath] = args()
```

### Tagged union dispatch (policy agent)

Before:
```
if (step.type == "showPolicy") {
  let policy = step.policy
  let policyStr = printJSON(policy)
  print(policyStr)
} else if (step.type == "writePolicy") {
  let policy = step.policy
  writePolicyFile(outputPath, policy)
} else if (step.type == "askQuestion") {
  print(step.question)
}
```

After:
```
match(step) {
  { type: "showPolicy", policy } => print(printJSON(policy))
  { type: "writePolicy", policy } => writePolicyFile(outputPath, policy)
  { type: "askQuestion", question } => print(question)
}
```

### Categorizer with pattern matching

Before:
```
type Category = "reminder" | "todo" | "general" | "quit"
const category: Category = llm("...")
if (category == "reminder") {
  handleReminder()
} else if (category == "todo") {
  handleTodo()
} else if (category == "quit") {
  return end()
} else {
  handleGeneral()
}
```

After:
```
type Category = "reminder" | "todo" | "general" | "quit"
const category: Category = llm("...")
match(category) {
  "reminder" => handleReminder()
  "todo" => handleTodo()
  "quit" => return end()
  _ => handleGeneral()
}
```

### Conditional destructuring with `if is`

Before:
```
if (nextAction.type == "askUser") {
  userMsg = input("${nextAction.question} ")
}
```

After:
```
if (nextAction is { type: "askUser", question }) {
  userMsg = input("${question} ")
}
```

### Loop destructuring

Before:
```
for (entry in Object.entries(config)) {
  let key = entry[0]
  let value = entry[1]
  print("${key}: ${value}")
}
```

After:
```
for ([key, value] in Object.entries(config)) {
  print("${key}: ${value}")
}
```

## Implementation Considerations

### Parser changes

The pattern parser is a single recursive parser combinator. It is then plugged into:
- Variable declaration parser (after `let`/`const`, when next token is `{` or `[`)
- Match arm parser (left-hand side of `=>`)
- Match expression parser (to detect `expr is pattern` form)
- Expression parser (`is` as a binary operator at comparison precedence)
- `for` loop parser (loop variable position)
- (V2) Function parameter parser
- (V2) Block parameter parser

### AST nodes

New AST node types needed:
- `ObjectPattern { properties: PatternProperty[] }` where `PatternProperty` is `{ key: string, value: Pattern }` or `{ shorthand: string }` or `RestPattern`
- `ArrayPattern { elements: Pattern[] }`
- `RestPattern { identifier: string }`
- `IsExpression { expression: Expr, pattern: Pattern }`

The existing `matchBlockCase` node's `caseValue` field expands from `literal | variableName | "_"` to `Pattern`. A new optional `guard` field is added for guard expressions.

### Code generation

Pattern matching compiles to `if/else if` chains with equality checks for literals and variable declarations for bindings. Nested patterns generate nested checks with temporary variables. The `is` operator compiles to the same checks, either as a boolean expression or with bindings in scope.

### Interrupt safety

Destructuring declarations must be treated as single steps in the step counter system. On resume, the serialized state must include all bound variables from the destructuring. This should work naturally if each `let`/`const` destructuring compiles to a single checkpoint step.
