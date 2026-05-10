# Anti-Pattern Catalog

Common mistakes to avoid when writing code in the Agency codebase. Each entry has a concrete before/after example. Read this before starting a task.

### Duplicating existing code

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

### Imperative code everywhere

**What it looks like:** Writing imperative code everywhere, instead of encapsulating it in a few places and exposing a nice abstraction that the user can use to write their code in a declarative manner. The logic for the "what" and the logic for the "how" should be split apart, so in the future, it's easier to make changes... you simply need to change the code for the "what" and not touch the code for the "how."

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
const names = nodes
  .filter(n => n.kind === "functionDefinition" && n.exported)
  .map(n => n.name);
const result = names.filter((name, i) => names.indexOf(name) === i);
```

**Why:** The declarative version says *what* we want (exported function names, deduplicated), not *how* to get it. Imperative code should be encapsulated behind a clear declarative interface.

---

### Order-dependent mutable state

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

Note: this rule does not apply to parsers, which need to have a specific order due to their very nature.

---

### Leaky abstractions

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

### Useless special cases

**Bad:**
```ts
if (arr.length === 0) {
  return [];
} else {
  return arr.map(x => x * 2);
}
```

**Good:**
```ts
return arr.map(x => x * 2);
```

**Why:** Special cases add cognitive overhead. If the code works correctly without the special case, don't add it.

### Inconsistent patterns

**What it looks like:** Similar operations are implemented in different ways across the codebase, making it harder to read and maintain.

**Bad:**
```ts// In one file
function getUser(id: string): User {
  // implementation A
}

// In another file
function fetchUser(id: string): User {
  // implementation B
}
```

**Good:**
```ts
// Standardize on one pattern for fetching users
function getUser(id: string): User {
  // consistent implementation
}
```

**Why:** Consistency makes it easier to understand and predict code behavior. When similar operations follow the same pattern, developers can quickly grasp new code by relating it to what they already know.

### Nested ternaries

**Bad:**
```ts
const status = isLoading ? "loading" : isError ? "error" : "success";
```

**Good:**
```ts
let status: "loading" | "error" | "success";
if (isLoading) {
  status = "loading";
} else if (isError) {
  status = "error";
} else {
  status = "success";
}
```

**Why:** Nested ternaries can be hard to read and understand at a glance. Using if/else statements improves readability, especially for more complex conditions.