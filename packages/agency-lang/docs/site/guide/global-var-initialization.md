---
name: Global variable initialization
description: How Agency initializes top-level values that reference other top-level values from different modules.
---

# Global variable initialization

*This section is optional reading. The TLDR is that you can have global variables that depend on other global variables, even ones in other modules, and Agency will correctly initialize them in the right order, but with limitations. See the [Dependency graph limitations](#dependency-graph-limitations) section.*

When you write a global or static variable that references another global or static variable from another module, the compiler builds a dependency graph and initializes the variables in the correct order. For example...

```
// greet.agency
export static const greeting = "hello"

// foo.agency
import { greeting } from "./greet.agency"
static const excitedGreeting = greeting + "!"
```

The compiler looks at these files and makes sure that the `greeting` variable is initialized first.

The compiler also looks **one function deep** when discovering these dependencies. If your var calls a function, the compiler will check that function's body for dependencies too:

```
// greet.agency
export static const greeting = "hello"
export def getGreeting() { return greeting }

// foo.agency
import { getGreeting } from "./greet.agency"

static const excitedGreeting = getGreeting() + "!"
```

Now, `excitedGreeting` has an *indirect dependency* on `greeting`. It calls the `getGreeting` function, which returns `greeting`.

Note that agency only looks one function deep.

## Dependency graph limitations

There are several cases where the dependency graph will not resolve correctly.

1. Dependency that is 2+ function calls deep:

```ts
// greet.agency
export static const greeting = "hello"
export def getGreeting() { return greeting }
export def getGreetingWrapper() { return getGreeting() }

// foo.agency
import { getGreetingWrapper } from "./greet.agency"
static const excitedGreeting = getGreetingWrapper() + "!"
```

2. Function values stored in variables:

```ts
// greet.agency
export static const greeting = "hello"
export def getGreeting() { return greeting }
export const funcVar = getGreeting

// foo.agency
import { funcVar } from "./greet.agency"
static const excitedGreeting = funcVar() + "!"
```

3. Anything in TypeScript.