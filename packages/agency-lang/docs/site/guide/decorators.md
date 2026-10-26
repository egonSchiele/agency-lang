---
name: Decorators
description: Explains decorators, written `@name(args)` above a def, which run the function's body as a block passed to a `decorator def`, with the `call` record, changing the arguments the body runs with, stacking, calling a decorator directly, the rules, and the error messages.
---

# Decorators

A decorator is a function that runs around the body of another function. You write it as a `decorator def` whose last two parameters receive a record about the call and the body as a [block](/guide/blocks), then put `@` and its name above the function you want to wrap.

## A first decorator

```ts
decorator def logged(call, block) {
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

`@logged` means "run `greet`'s body as the block passed to `logged`". The compiler builds a `Call` record for each invocation and passes it to `logged` along with the body. `greet` returns whatever `logged` returns, and the body only runs when `logged` calls its block.

The two parameters of `logged` have no types. The compiler knows what a decorator receives, so it types them for you: `call` is `Call` and `block` is `(args: object) -> any`. You can call them anything you like; `call` and `block` are the names this guide uses. You can also type them yourself, which the [budget decorator](#a-budget-decorator) below does.

## Passing arguments

A decorator can take arguments of its own. They go before the last two parameters, and you write them in the tag the way you would write them in a call:

```ts
decorator def retry(times: number, call, block): Result<string> {
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

`retry` calls the body up to three times and stops at the first success. A decorator may call its block as many times as it likes. Your own parameters may have defaults, even though the last two do not: the compiler always supplies those two.

The block is typed `(args: object) -> any`, so `last = block(call.args)` stores a value of type `any` in a variable declared `Result<string>`. The type checker allows that, because `any` can be assigned to any type. It means `retry` trusts the body to return a `Result<string>`; see [Typing a reusable decorator](#typing-a-reusable-decorator) below.

The tag's arguments are evaluated each time the function is called, inside the function. That means they can name the function's own parameters. You will see that in the budget example below.

## The `call` record

Every decorator receives a record describing the call it wraps, in its second-to-last parameter:

- `call.name` is the decorated function's name.
- `call.args` holds the function's arguments, keyed by parameter name. Block-typed parameters are left out, since a block cannot be stored in a record.
- `call.id` identifies the decorated function within the compiled program. Partial, renamed, and preapproved copies of that function use the same ID. Use it as a key, without parsing it or relying on it to remain the same across builds.
- `call.inToolCall` is `true` when the invocation began inside a tool call made by `llm()` in the same run. This includes functions called by the selected tool and calls made in its branches. Ordinary calls outside that context see `false`.

The caller's tool context does not cross subprocess or MCP boundaries. A decorated export called through `runFunction` or a tool returned by `learn` sees `false`. An export invoked directly through `agency serve` over MCP also sees `false`.

```ts
decorator def tagged(label: string, call, block) {
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

```ts
decorator def recorded(call, block) {
  print("${call.id}: ${call.inToolCall}")
  return block(call.args)
}

@recorded
def add(a: number, b: number): number {
  return a + b
}

def outer(): number {
  return add(1, 2)
}

node main() {
  add(1, 2)
  llm("Use the tools.", tools: [add, outer])
}
```

The first call prints `false` for `inToolCall`. If the model selects either `add` or `outer`, the decorator on `add` prints `true`. You can use this to count calls during tool execution. The boolean does not distinguish functions selected directly by the model from functions called by their bodies.

## Changing the arguments

The block takes a record of arguments, so the decorator decides what the body runs with:

```ts
block(call.args)                          // the arguments as passed
block({ ...call.args, name: "default" })  // one argument changed
block()                                   // no arguments at all
```

`block()` means every parameter is unset, as on a call that passes nothing: a parameter with a default takes its default, and one with no default is a missing argument. The record follows the rules of a call. A key that names no parameter is an error, a parameter written `name: T!` is checked again against the new value, and a variadic parameter takes an array. A failing rebind is the value `block()` returns, a failure the decorator can inspect with `isFailure`, and the body does not run.

`call.args` does not change when you rebind, so `block(call.args)` always means the arguments the decorator was handed, even after an earlier `block({ ... })` in the same call. The function's own block-typed parameters stay as they were; a record that names one is refused.

Call the block from one place at a time. The rebound values live on the function's frame, so a decorator that called `block` from several `fork` or `parallel` branches with different records would have the branches read each other's arguments. A second call to `block` while an earlier one is still running is refused: it returns a failure that says so, and the body does not run.

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

All stacked decorators receive the same `id` and the same captured `inToolCall` value. Those fields also keep their values when the invocation resumes after an interrupt.

A decorator can itself be decorated. Put the tag above the `decorator def` as you would above any def.

## Calling a decorator directly

A `decorator def` is still a function. To call it yourself, pass a record for the call slot by name and give it a block:

```ts
decorator def tagged(tag: string, call, block) {
  return "${tag}:${call.name}:${block()}"
}

node main() {
  return tagged("t", call: {
    name: "direct",
    args: {},
    id: "manual-example",
    inToolCall: false
  }) {
    return "body"
  }
}
```

`Call` is `{ name: string, args: object, id: string, inToolCall: boolean }`. A direct call supplies all four fields, including the identity and tool context the caller wants to report. It is checked like any other call, so leaving the record out is a missing argument.

Use `id` and `inToolCall` for reporting. Callers can supply them directly or change them in a checkpoint, so do not use them to grant permissions or skip approvals.

## A budget decorator

[Guards](/guide/guards) cap what a block of work may spend. A decorator can put a guard around a whole function:

```ts
decorator def budgeted(cost: number, call: Call, block: (args: object) -> string): Result<string> {
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
- The block is typed by hand, as `(args: object) -> string`, so the type checker checks the body's returns against `string`.

The standard library ships a finished version of this decorator as `@guarded` in `std::decorators`. It also labels the guard with the function's name, answers its own budget trip, and returns a saved draft as the answer when the budget runs out. See [Guarding a whole function](/guide/guards#guarding-a-whole-function).

## The rules

- A decorator says `decorator def`. A plain def is never a decorator, whatever its parameters look like.
- Its last two parameters are the call record and the block, in that order, with no defaults. Its own parameters come before them. Name the two as you like; the compiler types them `Call` and `(args: object) -> any` unless you type them yourself.
- A decorator can be called directly, with a record literal for the call slot and a block.
- A decorator calls its block. It never stores the block in a variable or returns it.
- Decorators go on a `def` only. A decorator tag on a node, a type, or a statement is an error.
- The model never sees a decorator. When a decorated function is used as a tool, its name, docstring, parameters, and schema are the function's own. So are the `handoff`, `destructive`, and `idempotent` markers.
- A decorator's effects count as the function's effects. If `budgeted` raises `std::guard`, so does every function it decorates, and a `raises` clause on that function must list it.

## Typing a reusable decorator

Agency has no generics, so a decorator's block has one return type. A decorator meant for one kind of function, like `budgeted`, can name that type, and the type checker then checks the body's returns against it.

A decorator meant for any function, like `logged` and `retry`, leaves its block untyped, which means `(args: object) -> any`. The body's returns are then not checked against anything. That is the trade-off for one decorator that fits every function.

## Mistakes and what they say

Some mistakes are always reported, whether or not the type checker runs:

```ts
@budgted(cost: 1.00)
def one(topic: string): string {
  return topic
}
```

```
error: Unknown decorator 'budgted' on 'one'. A decorator is a `decorator def` whose last two parameters are the call record and a block; declare or import 'budgted'.
```

A tag on a def that does not say `decorator` gives `'logged' is not a decorator, so '@logged' cannot go on 'one'. Declare it as `decorator def logged(...)`.`

A `decorator def` in the wrong shape is reported at the def, whether or not a tag uses it. Each message starts `'logged' is declared as a decorator, but` and ends with the rule it breaks:

| You wrote | The rest of the message |
| --- | --- |
| `decorator def logged(block)` | `a decorator takes at least two parameters: the call record and the body as a block.` |
| `decorator def logged(call, x: number)` | `its last parameter must take the body as a block, such as `block: (args: object) -> any`. Found 'x: number'.` |
| `decorator def logged(call: Call, tag: string, block)` | `'tag' receives the call record, so its type must be `Call` or left off.` |
| `decorator def logged(call, block = null)` | `'block' has a default, and a decorator always receives the call record and the block. Remove the default.` |
| `decorator def logged(call, ...block)` | `'block' is variadic, but the call record and the block are one argument each.` |

The same goes for a decorator on a node (`'@logged' is written on node 'main', but a decorator goes on a def.`), a decorator imported from JavaScript, and decorators that decorate each other in a loop.

The rest come from the type checker. `agency typecheck` always runs it. `agency run` and `agency compile` run it when `typechecker.enabled` is `true` in your [`agency.json`](/guide/agency-config-file#type-checking). With the `budgeted` decorator above:

| You wrote | The error |
| --- | --- |
| `@budgeted(cost: "a lot")` | `Decorator 'budgeted' on 'one' expects 'cost: number', got '"a lot"'.` |
| A body that does `return 42` | `The body of 'two' returns 'number', but decorator 'budgeted' takes a block returning 'string'.` |
| `@budgeted(cost: 1.00)` on a def declared `: string` | `'three' is declared to return 'string', but decorator 'budgeted' returns 'Result<string>'.` |
| `@budgeted` with no arguments | `Expected 1 argument(s) for 'budgeted', but got 0.` |
| A `raises <std::read>` clause on the decorated def | `Function 'five' raises effect 'std::guard', which exceeds its declared 'raises <std::read>'. It is raised by decorator 'budgeted'. Add 'std::guard' to the clause.` |

When two stacked decorators disagree, for example an inner one that returns `number` under an outer one whose block returns `string`, the error names both: `Decorator 'inner' returns 'number', but decorator 'budgeted' above it on 'five' takes a block returning 'string'.`
