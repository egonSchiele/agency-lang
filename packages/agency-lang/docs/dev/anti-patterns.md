# Anti-Pattern Catalog

Common mistakes to avoid when writing code in the Agency codebase. Each entry has a concrete before/after example. Read this before starting a task.

---

### 1. Unnecessary wrapper classes

**What it looks like:** Creating a class to wrap simple data or a thin layer over an existing API when a plain object or direct function would suffice.

**Bad:**
```ts
class CompilationResult {
  private output: string;
  private errors: string[];

  constructor(output: string, errors: string[]) {
    this.output = output;
    this.errors = errors;
  }

  getOutput(): string { return this.output; }
  getErrors(): string[] { return this.errors; }
  hasErrors(): boolean { return this.errors.length > 0; }
}
```

**Good:**
```ts
type CompilationResult = {
  output: string
  errors: string[]
}

// hasErrors is just a check on the array — inline it where needed
if (result.errors.length > 0) { ... }
```

**Why:** The class adds indirection without adding value. The data is simple, the accessors do nothing, and `hasErrors()` is a trivial check that's clearer inline.

---

### 2. Premature abstraction

**What it looks like:** Extracting a helper or utility for something that's only used once, or creating a shared function before there are multiple callers.

**Bad:**
```ts
function formatNodeName(name: string): string {
  return `node_${name}`;
}

// used in exactly one place:
const id = formatNodeName(node.name);
```

**Good:**
```ts
const id = `node_${node.name}`;
```

**Why:** Three similar lines of code are better than a premature abstraction. Extract a helper when you actually have multiple callers, not before.

---

### 3. Over-engineered configuration

**What it looks like:** Adding options, flags, or configurability for things that only have one use case.

**Bad:**
```ts
type ProcessOptions = {
  includeComments: boolean
  stripWhitespace: boolean
  maxDepth: number
  outputFormat: "json" | "text"
}

function processNode(node: AgencyNode, options: ProcessOptions) {
  // only ever called with the same options
}
```

**Good:**
```ts
function processNode(node: AgencyNode) {
  // hardcode the behavior — there's only one use case
}
```

**Why:** Build for the current need, not hypothetical future requirements. If a second use case arises, add the option then.

---

### 4. Logic in the wrong layer

**What it looks like:** Putting functionality in the builder/codegen that should live in the runtime, or vice versa.

**Bad:**
```ts
// In typescriptBuilder.ts — generating complex logic as code strings
function processRetryLogic(node: AgencyNode): TsNode {
  return ts.raw(`
    let attempts = 0;
    while (attempts < 3) {
      try {
        const result = await ${funcCall};
        if (isValid(result)) return result;
      } catch (e) { /* retry */ }
      attempts++;
    }
  `);
}
```

**Good:**
```ts
// In lib/runtime/retry.ts — a real function that's testable and type-safe
function runWithRetry<T>(fn: () => Promise<T>, maxAttempts: number): Promise<T> {
  let attempts = 0;
  while (attempts < maxAttempts) {
    try {
      const result = await fn();
      if (isValid(result)) return result;
    } catch (e) { /* retry */ }
    attempts++;
  }
  throw new Error("Max retries exceeded");
}

// In typescriptBuilder.ts — just generate a call to the runtime function
function processRetryLogic(node: AgencyNode): TsNode {
  return ts.call("runWithRetry", [funcCallNode, ts.raw("3")]);
}
```

**Why:** Runtime code is testable, type-safe, and reusable. Generated code is hard to read, debug, and refactor. Push logic into runtime libs whenever possible.

---

### 5. Duplicating existing code

**What it looks like:** Reimplementing something that already exists in the codebase instead of finding and reusing it.

**Bad:**
```ts
// Writing a new function to walk AST nodes
function findAllFunctions(nodes: AgencyNode[]): FunctionDefinition[] {
  const result: FunctionDefinition[] = [];
  for (const node of nodes) {
    if (node.kind === "functionDefinition") {
      result.push(node);
    }
    if ("body" in node && Array.isArray(node.body)) {
      result.push(...findAllFunctions(node.body));
    }
  }
  return result;
}
```

**Good:**
```ts
// Use the existing walkNodesArray from lib/utils/node.ts
import { walkNodesArray } from "@/utils/node.js";

const functions = walkNodesArray(nodes)
  .filter((n): n is FunctionDefinition => n.kind === "functionDefinition");
```

**Why:** The codebase already has utilities for common operations. Always search for existing implementations before writing new code.

---

### 6. Unnecessary error handling

**What it looks like:** Validating things that can't happen, adding fallbacks for impossible states, or wrapping in try-catch when the framework already handles errors.

**Bad:**
```ts
function getNodeName(node: GraphNode): string {
  if (!node) {
    throw new Error("Node is null");
  }
  if (!node.name) {
    throw new Error("Node has no name");
  }
  if (typeof node.name !== "string") {
    throw new Error("Node name is not a string");
  }
  return node.name;
}
```

**Good:**
```ts
function getNodeName(node: GraphNode): string {
  return node.name;
}
```

**Why:** TypeScript's type system guarantees `node` exists and `node.name` is a string. Trust internal code and framework guarantees. Only validate at system boundaries (user input, external APIs).

---

### 7. Imperative code where declarative would work

**What it looks like:** Writing long sequences of imperative steps when the intent could be expressed more clearly with a declarative approach.

**Bad:**
```ts
const result: string[] = [];
for (const node of nodes) {
  if (node.kind === "functionDefinition") {
    if (node.exported) {
      const name = node.name;
      if (!result.includes(name)) {
        result.push(name);
      }
    }
  }
}
```

**Good:**
```ts
const result = [...new Set(
  nodes
    .filter(n => n.kind === "functionDefinition" && n.exported)
    .map(n => n.name)
)];
```

**Why:** The declarative version says *what* we want (exported function names, deduplicated), not *how* to get it. Imperative code should be encapsulated behind a clear declarative interface.

---

### 8. Order-dependent mutable state

**What it looks like:** Code where multiple variables must be set in a specific sequence to work correctly. Reordering lines breaks things silently.

**Bad:**
```ts
let scopeType = "global";
let prefix = "";
let needsAwait = false;

// these must happen in this exact order or things break
scopeType = determineScopeType(node);
prefix = scopeType === "function" ? "__fn_" : "__node_";
needsAwait = prefix === "__fn_" && hasAsyncCalls(node);
```

**Good:**
```ts
const scopeType = determineScopeType(node);
const prefix = scopeType === "function" ? "__fn_" : "__node_";
const needsAwait = scopeType === "function" && hasAsyncCalls(node);
```

**Why:** Using `const` and deriving each value from its inputs (not from other mutable variables) makes the dependencies explicit. You can read any line in isolation without worrying about what happened before it.

---

### 9. Leaky abstractions

**What it looks like:** Code where understanding one piece requires reading many other pieces because they're all connected. The internal implementation details leak into the interface.

**Bad:**
```ts
// Caller has to know about internal stack structure
function resumeExecution(checkpoint: Checkpoint) {
  const stack = checkpoint.__internalStack;
  const step = stack.locals.__substep_0;
  const branch = stack.locals.__condbranch_0;
  // manually reconstruct state from internal details...
}
```

**Good:**
```ts
// Clean interface that hides internals
function resumeExecution(checkpoint: Checkpoint) {
  restoreState(checkpoint);
  // restoreState handles all the internal stack reconstruction
}
```

**Why:** Good abstractions have clear boundaries. You should be able to understand what a unit does without reading its internals, and change the internals without breaking consumers.
