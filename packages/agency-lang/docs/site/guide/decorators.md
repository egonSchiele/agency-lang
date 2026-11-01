---
name: Decorators
description: Explains decorators, written `@name(args)` above a def, which run the function's body as a block passed to a `decorator def`, with the `call` record, changing the arguments the body runs with, stacking, calling a decorator directly, the rules, and the error messages.
---

# Decorators


## A first decorator

```ts
decorator def logged(call: Call, block) {
  print("entering ${call.name}")
  const result = block(call.args)
  print("leaving ${call.name}")
  return result
}
```

You write it as a `decorator def`. Now you can use it:

```ts
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

## Passing arguments

A decorator can take arguments of its own. They go before the last two parameters:

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

`retry` calls the body up to three times and stops at the first success.

## The `call` record

What `call` contains:

| Field | Type | What it holds |
| --- | --- | --- |
| `call.name` | `string` | The decorated function's name. |
| `call.args` | `object` | The args it was called with. |
| `call.id` | `string` | A stable and unique id for this function. |
| `call.inToolCall` | `boolean` | `true` when the invocation began inside a tool call (directly or indirectly). |


::: warning
The caller's tool context does not cross subprocess or MCP boundaries. A decorated export called through `runFunction` or a tool returned by `learn` sees `false`. An export invoked directly through `agency serve` over MCP also sees `false`.
:::

## Changing the arguments

You call the block yourself, so you can change the args it runs with

```ts
block(call.args)                      // the arguments as passed
block({ ...call.args, name: "adit" }) // one argument changed
block()                               // no arguments
```

## Stacking decorators

You can put more than one decorator on a function:

```ts
@logged
@retry(2)
def careful(url: string): Result<string> {
  return success(url)
}
```

Both decorators get the info for the `careful` function. `logged` gets called first. It can modify the arguments that `careful` is called with, and `retry` will see those modified arguments. Note that `logged` does not call `retry`, nor does it ever see any of the data for `retry`. It also cannot modify any of `retry`'s parameters. It only sees and can modify the data for the function it is decorating, which is `careful`.

> Nuance: `logged` does not call `retry`, but `retry` won't run unless `logged` calls `block`.

A decorator can itself be decorated. Put the tag above the `decorator def` as you would above any def.

## Calling a decorator directly

A `decorator def` is still a function. You can call it yourself with a `Call` object and a block:

```ts
decorator def tagged(tag: string, call, block) {
  return "${tag}:${call.name}:${block()}"
}

node main() {
  const call = {
    name: "direct",
    args: {},
    id: "manual-example",
    inToolCall: false
  }
  return tagged("t", call: call) {
    return "body"
  }
}
```

## Decorators and tool calls
An llm never sees the decorators that a function is decorated with, and can never set one of the decorator's args directly. As we've seen, a decorator can reference a parameter that the function was called with. You can use this to have the LLM set the parameters for decorators if you wish. The built-in `@guarded` decorator is a good example:

```ts
// an LLM can set `maxCost` to set `cost` for @guarded
@guarded(cost: maxCost)
def research(topic: string, maxCost: number) {
  ...
}
```

## Agency vs Python decorators

Agency's decorators work like Python's at call time, but there are a few differences.

### A decorator runs on every call

A Python decorator runs once, when the function is defined. It takes the function and returns a new one. An Agency decorator runs every time the function is called. This lets Agency's decorators do things like reference args that the function was called with:

```ts
// not possible in Python
@guarded(cost: maxCost)
def research(topic: string, maxCost: number) {
  ...
}
```

### Every decorator in a stack sees the decorated function

In Python, a stacked decorator receives the function that the decorator below it returned. Here `logged` receives the wrapper that `retry` returned. It doesn't get `careful`:

```python
def logged(fn):
    def wrapper(*args, **kwargs):
        print(fn.__name__)
        return fn(*args, **kwargs)
    return wrapper

@logged
@retry(2)
def careful(url):
    ...

careful("a")  # prints "wrapper", unless retry used functools.wraps
```

In Agency, every decorator receives the call record for the decorated function itself. With the same stack, `call.name` is `"careful"` in both `logged` and `retry`.

### Tag arguments are evaluated on every call

In Python, a decorator's arguments are evaluated once, when the function is defined (eg the `2` in `@retry(2)`). In Agency, the decorator's arguments are evaluated on every call, so the decorator can read the params that the function was called with:

```ts
@retry(times: attempts)
def careful(url: string, attempts: number): Result<string> {
  return success(url)
}

careful("a", 3)  // retry runs with times set to 3
```

As we'd seen above, decorators can change the args that the function gets called with. If an outer decorator changes the value of `attempts`, `retry` will see the changed value.