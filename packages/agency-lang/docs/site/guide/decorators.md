---
name: Decorators
description: Explains decorators, written `@name(args)` above a def, which run the function's body as a block passed to another function, with the `call` record, changing the arguments the body runs with, stacking, the rules, and the error messages.
---

# Decorators

A decorator is a function that runs around the body of another function. You write it as an ordinary `def` whose last two parameters are `call: Call` and a [block](/guide/blocks), then put `@` and its name above the function you want to wrap.

## A first decorator

```ts
def logged(call: Call, block: (args: object) -> any): any {
  print("entering ${call.name}")
  const result = block(call.args)
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
  return logged(call: { name: "greet", args: { name: name } }) {
    return "hello ${name}"
  }
}
```

So `greet` returns whatever `logged` returns, and the body only runs when `logged` calls its block.

## Passing arguments

A decorator can take arguments of its own. They go before `call` and the block, and you write them in the tag the way you would write them in a call:

```ts
def retry(times: number, call: Call, block: (args: object) -> any): Result<string> {
  let last: Result<string> = failure("never ran")
  for (i in range(0, times)) {
    last = block(call.args)
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

`retry` calls the body up to three times and stops at the first success. A decorator may call its block as many times as it likes. Your own parameters may have defaults, even though `call` and the block after them do not: the compiler always supplies those two.

The block is typed `(args: object) -> any`, so `last = block(call.args)` stores a value of type `any` in a variable declared `Result<string>`. The type checker allows that, because `any` can be assigned to any type. It means `retry` trusts the body to return a `Result<string>`; see [Typing a reusable decorator](#typing-a-reusable-decorator) below.

The tag's arguments are evaluated each time the function is called, inside the function. That means they can name the function's own parameters. You will see that in the budget example below.

## The `call` record

Every decorator receives a record describing the call it wraps, in the parameter named `call`, right before the block:

- `call.name` is the decorated function's name.
- `call.args` holds the function's arguments, keyed by parameter name. Block-typed parameters are left out, since a block cannot be stored in a record.

```ts
def tagged(label: string, call: Call, block: (args: object) -> any): any {
  print("${label}: ${call.name}")
  print(call.args)
  return block(call.args)
}

@tagged(label: "research")
def lookUp(topic: string): string {
  return topic
}
```

Calling `lookUp("owls")` prints `research: lookUp`, then `{ topic: 'owls' }`.

The compiler passes `call` by name. If you ever call a decorator directly, as a function, write `call:` by name too.

## Changing the arguments

The block takes a record of arguments, so the decorator decides what the body runs with:

```ts
block(call.args)                          // the arguments as passed
block({ ...call.args, name: "default" })  // one argument changed
block()                                   // no arguments at all
```

`block()` means every parameter is unset, as on a call that passes nothing: a parameter with a default takes its default, and one with no default is a missing argument. The record follows the rules of a call. A key that names no parameter is an error, a parameter written `name: T!` is checked again against the new value, and a variadic parameter takes an array. A failing rebind is the value `block()` returns, a failure the decorator can inspect with `isFailure`, and the body does not run.

`call.args` does not change when you rebind, so `block(call.args)` always means the arguments the decorator was handed, even after an earlier `block({ ... })` in the same call. The function's own block-typed parameters stay as they were; a record that names one is refused.

Call the block from one place at a time. The rebound values live on the function's frame, so a decorator that calls `block` from several `fork` or `parallel` branches with different records would have the branches read each other's arguments.

## Stacking decorators

You can put more than one decorator on a function. The top one runs outermost:

```ts
@logged
@retry(2)
def careful(url: string): Result<string> {
  return success(url)
}
```

This becomes `logged(call: …) { return retry(2, call: …) { ...body... } }`, so `logged` runs once around both attempts. When the outer decorator changes the arguments, the inner one sees the changed ones: its `call.args`, and any tag argument that names a parameter, are read after the outer rebind.

## A budget decorator

[Guards](/guide/guards) cap what a block of work may spend. A decorator can put a guard around a whole function:

```ts
def budgeted(cost: number, call: Call, block: (args: object) -> string): Result<string> {
  return guard(cost: cost) {
    return block(call.args)
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

The standard library ships a finished version of this decorator as `@guarded` in `std::strategy`. It also labels the guard with the function's name, answers its own budget trip, and returns a saved draft as the answer when the budget runs out. See [Guarding a whole function](/guide/guards#guarding-a-whole-function).

## The rules

- A decorator's last two parameters are `call: Call` and a block, in that order, with no defaults. Its own parameters come before them.
- A decorator calls its block. It never stores the block in a variable or returns it.
- Decorators go on a `def` only. A decorator tag on a node, a type, or a statement is an error.
- The model never sees a decorator. When a decorated function is used as a tool, its name, docstring, parameters, and schema are the function's own. So are the `handoff`, `destructive`, and `idempotent` markers.
- A decorator's effects count as the function's effects. If `budgeted` raises `std::guard`, so does every function it decorates, and a `raises` clause on that function must list it.

## Typing a reusable decorator

Agency has no generics, so a decorator's block has one return type. A decorator meant for one kind of function, like `budgeted`, can name that type, and the type checker then checks the body's returns against it.

A decorator meant for any function, like `logged` and `retry`, types its block `(args: object) -> any`. The body's returns are then not checked against anything. That is the trade-off for one decorator that fits every function.

## Mistakes and what they say

Some mistakes are always reported, whether or not the type checker runs:

```ts
@budgted(cost: 1.00)
def one(topic: string): string {
  return topic
}
```

```
error: Unknown decorator 'budgted' on 'one'. A decorator is a def whose last two parameters are `call: Call` and a block; declare or import 'budgted'.
```

A decorator with the wrong shape is reported the same way. `def logged(call: Call, tag: string, block: () -> any)` gives `'logged' cannot decorate 'one': a decorator's last two parameters are `call: Call` and a block, so `call` must come right before the block. Found 'tag' there.` A default on `call` or the block gives `'block' has a default, but a decorator always receives `call` and the block. Remove the default.` The same goes for a decorator on a node (`'@logged' is written on node 'main', but a decorator goes on a def.`), a decorator whose last parameter cannot take a block, a decorator imported from JavaScript, and decorators that decorate each other in a loop.

The rest come from the type checker. `agency typecheck` always runs it. `agency run` and `agency compile` run it when `typechecker.enabled` is `true` in your [`agency.json`](/guide/agency-config-file#type-checking). With the `budgeted` decorator above:

| You wrote | The error |
| --- | --- |
| `@budgeted(cost: "a lot")` | `Decorator 'budgeted' on 'one' expects 'cost: number', got '"a lot"'.` |
| A body that does `return 42` | `The body of 'two' returns 'number', but decorator 'budgeted' takes a block returning 'string'.` |
| `@budgeted(cost: 1.00)` on a def declared `: string` | `'three' is declared to return 'string', but decorator 'budgeted' returns 'Result<string>'.` |
| `@budgeted` with no arguments | `Expected 1 argument(s) for 'budgeted', but got 0.` |
| A `raises <std::read>` clause on the decorated def | `Function 'five' raises effect 'std::guard', which exceeds its declared 'raises <std::read>'. It is raised by decorator 'budgeted'. Add 'std::guard' to the clause.` |

When two stacked decorators disagree, for example an inner one that returns `number` under an outer one whose block returns `string`, the error names both: `Decorator 'inner' returns 'number', but decorator 'budgeted' above it on 'five' takes a block returning 'string'.`
