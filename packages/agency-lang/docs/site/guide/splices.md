---
name: Splices
description: A guide to using compile-time splices in Template Agency.
---

# Splices

*Before reading this section, make sure you understand how [Template Agency](/guide/template-agency) works.*

We know that we can use Template Agency to generate code, and then run it using `runCode`. `runCode` runs the code in a subprocess and returns the result. What if we wanted to add the code to the current file instead? That is what splices do.

## Example

Here's a function that returns `Code`:

```ts
// greeter.agency
import { Code } from "std::agency"

export def makeGreeter(): Code {
  return [|
    def greet(): string {
      return "hello"
    }
  |]
}
```

Let's use a splice to add it to another file. Splices use the `$(...)` syntax:

```ts
// main.agency: the file that uses it
import { makeGreeter } from "./greeter.agency"

$( makeGreeter() )

node main(): string {
  // now we can use the generated function!
  return greet()
}
```

## Code literals vs splices

| | Code literal | Splice |
| --- | --- | --- |
| Syntax | `[\| ... \|]` | `$( ... )` |
| What it does | Generates code | Adds generated code to a file |

## Splices execute at compile time

!! Important !!

It's important to understand that splices run at compile time, not at runtime. That means that the generator runs while your file is still being compiled. It also means that in order to typecheck your code, the compiler has to run your generator first. **If you use the Agency plugin, the generators run every time the plugin needs to typecheck your file.** So it is important that your generators are fast and deterministic.

## Where a splice can go

- **Declaration position**, at the top level of a file
- **Expression position**, anywhere a value goes

## The rules of splices

*(For all of these, a generator is the function that returns `Code` and is called inside a splice.)*

1. **A generator may import only Agency code.** That means the standard library and other `.agency` files in your project. No npm packages, and nothing they reach either. Basically, JS code doesn't raise interrupts, so it is riskier, so we don't allow generated code to use it. If a generator genuinely needs a JavaScript library, set `allowNonAgencyGenerators: true` in your `agency.json`.

2. **The generator lives in another file,** because it has to be compiled before the file that splices it can be.

3. **A generator may not raise interrupts.** Reading a file, making a network call, and running a command all raise interrupts in Agency. Generators run at compile time, and there's no way to respond to interrupts during compilation.

4. **Splice arguments may use only literals, code literals, and imported names.** The generator runs while your file is still being compiled, so anything declared in it does not exist yet. You can't rely on other code getting executed before your generator runs.

5. **Generated code may use only names it declares or imports.**

6. **Generated declarations cannot be exported.** They work in the file that spliced them and are invisible everywhere else. This is because as outlined above, generators need to run quite often – whenever you typecheck your file, or whenever your code editor plugin does so. So if declarations could be exported, that would expand the potential blast radius, and we'd need to run generators more often, which would be slow. So we don't allow it.

```ts
export def makeThing(): Code {
  return [|
    // can't export this, because it is generated code
    export def shared(): string {
      return "x"
    }
  |]
}
```

7. **Generated declarations may not take a name already in use.** Two functions with the same name is an error in Agency.

8. Finally, **generators must be fast and deterministic.** They run every time you typecheck your file, so they need to be fast. They also need to produce the same code every time, because if they don't, your file will compile sometimes and not others.

## How generators run

A generator runs in a child process with a 30-second and 512mb ceiling, so one that loops forever becomes an error rather than a hung compiler. Results are cached against the generator's content and the exact call, so an unchanged generator does not re-run. That matters most in an editor, where the symbol table is rebuilt on every keystroke.