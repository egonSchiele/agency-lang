---
name: TypeScript interoperability
description: Covers two-way interop between Agency and TypeScript — importing TS functions and modules into Agency code, and importing compiled Agency nodes into TypeScript, along with the limitations of each direction.
---

# TypeScript interoperability

## Using TS in Agency

Interoperability is really easy: just import stuff from TypeScript and use it. You can import any function from a TypeScript file and use it, and most library imports will work as well.

`greet.js`:

```js
export function greet(name) {
  return `Hello, ${name}!`;
}
```

`main.agency`:

```ts
import { greet } from "./greet.js";

node main() {
  const name = input("What is your name? ")
  const greeting = greet(name)
  print(greeting)
}
```

As you can see, the import syntax is just the typical syntax for importing ESM modules.

## What doesn't work

Most interoperability works from TypeScript to Agency. However, some features do not work.

Most importantly, Agency doesn't support lambdas or first-class functions right now. This means you can't use the `.map` or `.forEach` methods on arrays, or pass a function as an argument to another function. Agency provides its own functions like `map`, `filter`, and `reduce` that you can use instead, in [std::array](/stdlib/array).

Don't import things that can't be serialized. For example if you import a plain old JavaScript object and some of its values are functions, there's no way for Agency to serialize and deserialize that. Similarly, instances of a class can't be serialized and deserialized. You can import these, you'll just miss out on Agency's features like interrupts and resumability when you use them.

## Using Agency in TS

Every node that you define in Agency can be imported and run as a function from TypeScript:

Agency code:

```ts
node main(name:string) {
  const result = llm(`What is a nice greeting for ${name}?`)
  return result
}
```

This agency code gets compiled to JavaScript (or TypeScript), and then you can import it.

TypeScript code:

```ts
// note you have to import the compiled .js file, not the .agency file
import { main } from "./main.js";

async function run() {
  const result = await main("Adit");
  console.log(result);
}

run();
```

Only nodes can be imported into TypeScript. Other things like functions cannot.

