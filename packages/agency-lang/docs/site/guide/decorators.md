---
name: Decorators
description: Explains decorators, written `@name(args)` above a def, which run the function's body as a block passed to another function, with the `call` record, stacking, the rules, and the error messages.
---

# Decorators

A decorator is a function that runs around the body of another function. You write it as an ordinary `def` whose last parameter is a [block](/guide/blocks), then put `@` and its name above the function you want to wrap.

## A first decorator

```ts
def logged(call: Call, block: () -> any): any {
  print("entering ${call.name}")
  const result = block()
  print("leaving ${call.name}")
  return result
}

@logged
def greet(name: string): string {
  return "hello ${name}"
}

node main() {
  print(greet("ada"))
}
```

This prints:

```
entering greet
leaving greet
hello ada
```

`@logged` means "run `greet`'s body as the block passed to `logged`". The compiler turns `greet` into this:

```ts
def greet(name: string): string {
  return logged({ name: "greet", args: { name: name } }) {
    return "hello ${name}"
  }
}
```

So `greet` returns whatever `logged` returns, and the body only runs when `logged` calls `block()`.

## Passing arguments

A decorator can take arguments of its own, before the block. Write them in the tag the way you would write them in a call:

```ts
def retry(times: number, block: () -> any): Result<string> {
  let last: Result<string> = failure("never ran")
  for (i in range(0, times)) {
    last = block()
    if (!isFailure(last)) {
      return last
    }
  }
  return last
}

@retry(3)
def fetchSummary(url: string): Result<string> {
  const page = llm("Summarize ${url}")
  return success(page)
}
```

`retry` calls the body up to three times and stops at the first success. A decorator may call `block()` as many times as it likes.

The tag's arguments are evaluated each time the function is called, inside the function. That means they can name the function's own parameters. You will see that in the budget example below.

## The `call` record

If a decorator's first parameter is named `call`, it receives a record describing the call it wraps:

- `call.name` is the decorated function's name.
- `call.args` holds the function's arguments, keyed by parameter name. Block-typed parameters are left out, since a block cannot be stored in a record.

The record comes first, before the tag's own arguments:

```ts
def tagged(call: Call, label: string, block: () -> any): any {
  print("${label}: ${call.name}")
  print(call.args)
  return block()
}

@tagged(label: "research")
def lookUp(topic: string): string {
  return topic
}
```

Calling `lookUp("owls")` prints `research: lookUp`, then `{ topic: 'owls' }`.

The rule goes by the parameter's name, not its type. If your decorator's first parameter is not meant to be the record, give it another name.

## Stacking decorators

You can put more than one decorator on a function. The top one runs outermost:

```ts
@logged
@retry(2)
def careful(url: string): Result<string> {
  return success(url)
}
```

This becomes `logged(...) { return retry(2) { ...body... } }`, so `logged` runs once around both attempts.

## A budget decorator

[Guards](/guide/guards) cap what a block of work may spend. A decorator can put a guard around a whole function:

```ts
def budgeted(cost: number, block: () -> string): Result<string> {
  return guard(cost: cost) {
    return block()
  }
}

@budgeted(cost: maxCost)
def research(topic: string, maxCost: number): Result<string> {
  return llm("Research ${topic} and write a short summary.")
}
```

In this example:

- The tag uses `maxCost`, one of `research`'s parameters. Each caller can pass a different budget.
- The body returns a `string`, because it is the block, and `budgeted`'s block returns `string`. The function is declared to return `Result<string>`, because that is what `budgeted` returns.

The standard library ships a finished version of this decorator as `@guard` in `std::strategy`. It also labels the guard with the function's name, answers its own budget trip, and returns a saved draft as the answer when the budget runs out. See [Guarding a whole function](/guide/guards#guarding-a-whole-function).

## The rules

- A decorator calls its block. It never stores the block in a variable or returns it.
- Decorators go on a `def` only. A decorator tag on a node, a type, or a statement is an error.
- The model never sees a decorator. When a decorated function is used as a tool, its name, docstring, parameters, and schema are the function's own. So are the `handoff`, `destructive`, and `idempotent` markers.
- A decorator's effects count as the function's effects. If `budgeted` raises `std::guard`, so does every function it decorates, and a `raises` clause on that function must list it.

## Typing a reusable decorator

Agency has no generics, so a decorator's block has one return type. A decorator meant for one kind of function, like `budgeted`, can name that type, and the type checker then checks the body's returns against it.

A decorator meant for any function, like `logged` and `retry`, types its block `() -> any`. The body's returns are then not checked against anything. That is the trade-off for one decorator that fits every function.

## Mistakes and what they say

Some mistakes are always reported, whether or not the type checker runs:

```ts
@budgted(cost: 1.00)
def one(topic: string): string {
  return topic
}
```

```
error: Unknown decorator 'budgted' on 'one'. A decorator is a def whose last parameter is a block; declare or import 'budgted'.
```

The same goes for a decorator on a node (`'@logged' is written on node 'main', but a decorator goes on a def.`), a decorator whose last parameter cannot take a block, a decorator imported from JavaScript, and decorators that decorate each other in a loop.

The rest come from the type checker. `agency typecheck` always runs it. `agency run` and `agency compile` run it when `typechecker.enabled` is `true` in your [`agency.json`](/guide/agency-config-file#type-checking). With the `budgeted` decorator above:

| You wrote | The error |
| --- | --- |
| `@budgeted(cost: "a lot")` | `Decorator 'budgeted' on 'one' expects 'cost: number', got '"a lot"'.` |
| A body that does `return 42` | `The body of 'two' returns 'number', but decorator 'budgeted' takes a block returning 'string'.` |
| `@budgeted(cost: 1.00)` on a def declared `: string` | `'three' is declared to return 'string', but decorator 'budgeted' returns 'Result<string>'.` |
| `@budgeted` with no arguments | `Expected 1 argument(s) for 'budgeted', but got 0.` |
| A `raises <std::read>` clause on the decorated def | `Function 'five' raises effect 'std::guard', which exceeds its declared 'raises <std::read>'. It is raised by decorator 'budgeted'. Add 'std::guard' to the clause.` |

When two stacked decorators disagree, for example an inner one that returns `number` under an outer one whose block returns `string`, the error names both: `Decorator 'inner' returns 'number', but decorator 'budgeted' above it on 'five' takes a block returning 'string'.`
