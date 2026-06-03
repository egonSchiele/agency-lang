---
title: Error handling
description: Describes Agency's exception-free approach to errors using the `Result` type, with `success`/`failure` constructors and patterns for unwrapping results.
---

# Error handling
Agency does not have exceptions. If an exception is thrown and not caught, it crashes your entire program, which is rarely what you want (unless you're Erlang). An exception can't be represented in the type system – the types won't tell you whether some function down the chain is going to throw an exception. Who wants a system full of hard-to-detect code that can crash the whole program?

Instead Agency has the `Result` type.

When you write a function you can either return a plain value:

```ts
def divide(a: number, b: number):number {
  return a / b;
}
```

Now if users divide by zero, you're out of luck. You could return `null` in case of error...or you can return a `Result`, which can be a `success` or a `failure`:

```ts
def divide(a: number, b: number): Result {
  if (b == 0) {
    return failure("Can't divide by zero!")
  }
  return success(a / b)
}
```

Now, `divide` returns a Result type. You can unwrap it to see if it's a success or a failure:

```ts
const result = divide(10, 0)
  if (isSuccess(result)) {
    return "The result is ${result.value}"
  } else {
    return "Error: ${result.error}"
  }
```

You can also use result patterns for more concise unwrapping — see
[Pattern Matching](pattern-matching.md#result-patterns).

### `Success` and `Failure` type aliases

`Result` has two built-in companion aliases that read more naturally when
you want to signal which branch a value belongs to:

```ts
def makeOk(): Success<number> { return success(42) }
def makeBad(): Failure<string> { return failure("boom") }

const ok: Success<number> = success(1)   // Result<number, any>
const bad: Failure = failure("oops")     // Result<any, any>
```

- `Success<T>` is sugar for `Result<T, any>`
- `Failure<E>` is sugar for `Result<any, E>`
- Bare `Success` and `Failure` are both sugar for `Result<any, any>`

These are purely type-level aliases — the runtime representation is still
a `Result`, so `isSuccess`, `isFailure`, `match`, `catch`, etc. all work
the same way on them.

Let's see some reasons you might want to use a Result type instead.

## Default value

You can use the `catch` keyword to specify a default value in case of failure.

```ts
node main(msg: string) {
  const result = divide(10, 0)
  // false
  print(isSuccess(result))
  
  const result2 = divide(10, 0) catch 3
  // 3
  print(result2)
}
```

`catch` unwraps the Result type for you, and if it's a failure, uses the default value instead.

## Chaining with pipe operator
Obviously, one reason that returning a `failure` is better than returning `null` is that you can give some helpful information in that failure. But it can be a pain to unwrap the `Result` type all the time.

Here is a function called `half`, which works if the number is even:

```ts
def half(x: number): Result {
  if (x % 2 != 0) {
    return failure("Number must be even to be halved, got ${x}")
  }
  return divide(x, 2)
}
```

Suppose I want to call `half` on some number three times. Unwrapping it each time as a pain:

```ts
  let result = half(10)
  if (isSuccess(result)) {
    result = half(result.value)
    if (isSuccess(result)) {
      result = half(result.value)
      return result
    }
  }
  return "Error: ${result.error}"
```

Use the pipe operator (`|>`) instead:

```ts
const result = success(10) |> half |> half |> half
```

Pipe is a way to chain function calls together. The return value of one function is passed as the parameter to the next function. Pipe works with result types, and it short-circuits on failures. So if the return value of a function is a success, it will unwrap it and pass it to the next function in the chain. But if it's a failure, it will short-circuit the chain and return that failure.

Printing the `result` variable, we see that it's an error, with the error message:

```
Number must be even to be halved, got 5
```

Cool, so the first call to `half` succeeded, but the second call failed, and so the pipe chain short-circuited and did not make the third call to `half`.

You can also use functions that take multiple arguments in a pipe chain using `.partial()`. Here is a chain that halves a number and then divides it by 3:

```
const result = success(10) |> half |> divide.partial(b: 3)
```

The `.partial()` call binds the `b` parameter to 3, producing a function that takes a single argument (the piped value).


## The `try` keyword

Agency has a `try` keyword. Even though Agency doesn't throw errors, you might call some TypeScript code that throws an error. The `try` keyword will catch the error and convert it to a failure for you:

```ts
// foo throws an error
// result is now a Result type
// (it would be even foo did not throw an error)
const result = try foo()
```

Agency also adds an automatic try-catch around every function definition, and if an error is thrown it returns a `failure` type.