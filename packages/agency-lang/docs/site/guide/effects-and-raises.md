---
name: Effect Sets and `raises`
description: Declare the interrupt effects a function may raise with a `raises` clause, group them into reusable `effectSet`s, and raise interrupts as statements with `raise` — all checked at compile time.
---

# Effect Sets and `raises`

We've already learned about [effects](/guide/effects), which are a name you can give to your interrupt. We've seen how you can raise an interrupt :

```
raise foo::bar("Here's an interrupt!")
```

Now we're going to see that you can also declare what types of effects a function can raise. If a function raises an effect that you don't expect, this lets you find that out at compile time instead of runtime.

## Declaring what a function raises

Add a `raises` clause to a `def` or `node` to declare its effect set:

```ts
// readFile is allowed to raise std::read, but nothing else.
def readFile(path: string): string raises <std::read> {
  return read(path)
}

// or with no return type:
def readFile(path: string) raises <std::read> {
  return read(path)
}

// The main node is allowed to raise std::read and std::write.
node main() raises <std::read, std::write> {
  // ...
}
```

### Unlabeled effects

An interrupt with no effect label has the effect **`unknown`**:

```ts
interrupt("Continue?")          // expression form
raise("Continue?")              // statement form
raise interrupt("Continue?")    // `raise` wrapping an interrupt expression
```

`unknown` is an ordinary effect label, so you declare it like any other:

```ts
def f() raises <unknown> {
  raise("Continue?")
}
```

### Allow any effect (`<*>`)

```ts
// All effects are allowed
def f() raises <*> {
  raise("Continue?")
  raise std::read("Continue?")
  raise std::write("Continue?")
}
```

### Allow no effects (`<>`)

```ts
// No effects are allowed
def f() raises <> {
  raise("Continue?")   // ❌ error
}
```

### Comparison table

| Clause | Meaning |
|---|---|
| `raises <>` | Raises **nothing**.
| `raises <std::read>` | Raises **at most** `std::read`. |
| `raises <*>` | Raises **anything** |
| *(omitted)* | Raises anything |


## Handlers

Handlers don't exempt effects. Even if your interrupt is handled by a handler, you still need to add it to the effect set.

```ts
// readFile is allowed to raise std::read, but nothing else.
def readFile(path: string): string raises <std::read> {
  handle {
    /*
    Function 'readFile' raises effect 'std::write',
    which exceeds its declared 'raises <std::read>'.
    Add 'std::write' to the clause.
    */
    write(filename: "myfile.txt", content: "Hello, world!")
  } with approve
}
```


## Effect sets

An `effectSet` is a reusable group of effects:

```ts
export effectSet FileRead = <std::read, std::grep, std::ls>
export effectSet FileWrite = <std::write, std::edit, std::rm>
export effectSet FileSystem = <FileRead, FileWrite>
```

You can use an effect set with `raises`:

```ts
def doStuff(): number raises FileRead {
  // no writes allowed here
}
```

`effectSet`s can be exported and imported like any type. Agency's standard library contains a few effect sets in [`std::capabilities`](/stdlib/capabilities). For example, if you want to make sure your code is only raising read interrupts from the standard library (no writes, no network), use `FileRead`:

```ts
import { FileRead } from "std::capabilities"
node main() raises FileRead {
  // do stuff
}
```

## `raises` on Function types

Function types can carry a `raises` clause too:

```ts
type Callback = (string) -> string raises <std::read>
```

The clause is enforced. A function value may not flow into a function type that
allows fewer effects than the value raises. This is checked when you assign the
value, pass it as an argument, or return it:

```ts
type Pure = (string) -> string raises <>          // allows no effects

def dangerous(s: string): string raises <std::read> {
  return read(s)
}

node main() {
  let cb: Pure = dangerous   // error: dangerous raises std::read, Pure allows nothing
}
```

A function type with no `raises` clause allows anything. So an opaque
function-typed value with no clause cannot flow into a constrained type:

```ts
def higherOrder(cb: (string) -> string) {   // cb's type has no raises clause
  let safe: Pure = cb                        // error: cb may raise anything
}
```

Calling a callback also counts toward the calling function's own `raises` clause:

```ts
def usesCallback(cb: (string) -> string raises <std::read>) raises <> {
  cb("x")   // error: usesCallback declares raises <>, but calling cb raises std::read
}
```

One v1 limitation: a callback declared `raises <*>` that you *call* inside a
constrained function is not flagged, because `<*>` has no concrete effects to
attribute. Assigning or passing such a value is still checked.