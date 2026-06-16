---
name: Effect Sets and `raises`
description: Declare the interrupt effects a function may raise with a `raises` clause, group them into reusable `effectSet`s, and raise interrupts as statements with `raise` — all checked at compile time.
---

# Effect Sets and `raises`

[Structured interrupts](./structured-interrupts) gave every interrupt an
**effect** — a label like `std::read` or `myapp::deploy`. This chapter adds
a way to **declare**, in a function's signature, which effects it may
raise, and to have the typechecker verify that declaration. Catching a
mismatch at compile time — before you run the program — is much cheaper
than discovering it at runtime.

## The `raise` statement

You already know two ways to raise an interrupt: as an expression you
capture (`const x = interrupt(...)`) and the `return interrupt(...)` idiom.
`raise` is a clearer spelling of that idiom:

```ts
def writeFile(path: string, content: string) {
  raise std::write("Write to ${path}?", { path: path })
  // ... reaches here only if the interrupt was approved
}
```

- On **reject**, the function exits immediately with a `failure`
  [Result](./error-handling).
- On **approve**, execution **continues** to the next statement.

Effects don't have to be namespaced — `raise deploy("Ship it?")` is fine,
as is `raise myapp::deploy(...)`. Use the bare `interrupt(...)` /
`raise(...)` form when you don't need an effect label.

> `raise` is for interrupts. It is unrelated to the `throw(...)` builtin,
> which raises a JavaScript exception.

## Declaring what a function raises

Add a `raises` clause to a `def` or `node` to declare its effect set:

```ts
def readFile(path: string): string raises <std::read> {
  return read(path)
}

node main() raises <std::read, std::write> {
  // ...
}
```

The clause is an **upper bound**: the typechecker infers every effect the
function actually raises — including effects raised transitively by
functions it calls — and reports any that exceed the declaration.

```ts
def f(): number raises <std::read> {
  raise std::write("oops", {})   // ❌ error
  return 1
}
// Function 'f' raises effect 'std::write', which exceeds its declared
// 'raises <std::read>'. Add 'std::write' to the clause.
```

### Local handling does not exempt declaration

Because [every handler in the chain runs](./handlers), an interrupt your
function catches locally is **still observed by every ancestor handler**.
So a locally-handled effect is part of the function's effect set and must
be declared:

```ts
def f(): number raises <std::read> {
  handle { raise std::write("x", {}) } with approve   // still counts!
  return 1
}
// 'std::write' must be in the raises clause even though it is handled here.
```

### `<>`, `<*>`, and omitting the clause

| Clause | Meaning |
|---|---|
| `raises <>` | Raises **nothing** (enforced — the body must raise no effects). |
| `raises <std::read>` | Raises **at most** `std::read`. |
| `raises <*>` | Raises **anything** (explicit; no upper bound). |
| *(omitted)* | Raises anything (no upper bound). |

`raises <>` is a strong contract: it lets you state, and have the compiler
guarantee, that a function performs no interrupting actions.

## Effect sets

An `effectSet` names a reusable group of effects:

```ts
effectSet FsKinds = <std::read, std::write>
effectSet NetKinds = <std::http, std::tcp>
effectSet Unsafe   = <FsKinds, NetKinds, std::shell>   // compose by spreading
```

Use a named set anywhere a `raises` clause is expected:

```ts
def doStuff(): number raises FsKinds { ... }
```

`effectSet`s can be exported and imported like any type:

```ts
// capabilities.agency
export effectSet FsKinds = <std::read, std::write>

// main.agency
import { FsKinds } from "./capabilities.agency"
def f(): number raises FsKinds { ... }
```

This is how you build a capability vocabulary: define the sets once, then
constrain functions with them — e.g. require that a function `raises <>`
(does nothing dangerous) or stays within a `ReadOnly` set.

## Function types

Function types can carry a `raises` clause too:

```ts
type Callback = (string) -> string raises <std::read>
```

(In this phase the clause is parsed and preserved, but compatibility of a
callback argument against a parameter's declared `raises` is not yet
checked.)
