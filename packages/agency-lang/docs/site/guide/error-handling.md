---
name: Error handling
description: Describes Agency's exception-free approach to errors using the `Result` type, with `success`/`failure` constructors and patterns for unwrapping results.
---

# Error handling
Agency does not have exceptions:

- Exceptions can crash your program
- Exceptions can't be represented in the type system

Instead Agency has the `Result` type.

## The `Result` type

When you write a function you can either return a plain value:

```ts
def divide(a: number, b: number): number {
  return a / b;
}
```

Now if users divide by zero, you're out of luck. Instead, you can return a `Result`, which can be a `success` or a `failure`:

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

Or more idiomatically with pattern matching:

```ts
const result = divide(10, 0)
if (result is success(value)) {
  return "The result is ${value}"
} else {
  return "Error: ${result.error}"
}
```

Or:

```ts
const result = divide(10, 0)
return match (result) {
  success(value) => "The result is ${value}"
  failure(error) => "Error: ${error}"
}
```

## The `catch` keyword

You can use the `catch` keyword to specify a default value in case of failure.

```ts
node main(msg: string) {
  // `result` is a Result type
  const result = divide(10, 0)

  // `result2` is a number. If `divide` is a failure,
  // `result2` gets the default value of 3
  const result2 = divide(10, 0) catch 3
}
```

`catch` unwraps the Result type for you, and if it's a failure, uses the default value instead.

## The pipe operator (`|>`)
If can be a pain to unwrap the `Result` type all the time. Here is a function called `half`, which works if the number is even:

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

Pipe is a way to chain function calls together. The return value of one function is passed as the parameter to the next function. Pipe works with `Result` types, and it short-circuits on failures. So if the return value of a function is a success, pipe will unwrap it and pass it to the next function in the chain. But if it's a failure, it will short-circuit the chain and return that failure.

Printing the `result` variable, we see that it's an error, with the error message:

```
Number must be even to be halved, got 5
```

The first call to `half` succeeded, but the second call failed, and so the pipe chain short-circuited and did not make the third call to `half`.

### Pipes and PFA

You can use PFA on functions in a pipe chain:

```ts
const result = success([10, 20, 30]) |> map.partial(func: half)
```

This only works if the resulting function has exactly one parameter left.

## The `try` keyword

Agency has a `try` keyword. It is unrelated to `catch`. Even though Agency doesn't throw errors, you might call some TypeScript code that throws an error. The `try` keyword will catch the error and convert it to a failure for you:

```ts
// result is now a Result type
// if foo() throws an error, result will be a failure
const result = try foo()
```

Agency also adds an automatic try-catch around every function definition, and if an error is thrown, it returns a `Failure` type.

## Failure propagation

A failure is self-propagating. If you pass one to a function that is not
typed to accept Results, the function does not run. The call returns the
original failure instead, exactly like a pipe chain short-circuiting:

```ts
def getReport(id: string): Result {
  return failure("HTTP 404: report not found")
}

def wordCount(text: string): number {
  return text.split(" ").length
}

node main() {
  const report = getReport("abc")   // oops: never checked
  const count = wordCount(report)   // wordCount is skipped
  // count IS the original failure. count.error is the 404 message, and
  // count.skippedFunctions is [{ name: "wordCount", param: "text" }].
}
```

A parameter accepts failures only if its type says so. `Result`,
`Result<...>`, explicit `any`, or a union containing either accepts.
Untyped parameters reject.

Passing a failure to an imported TypeScript function throws an error
instead, because TypeScript code does not know about Results. Calling a
method on a Result (like `.split()` on a failure you forgot to unwrap)
also throws. Both errors name the function that produced the failure.
If your own TypeScript helper legitimately takes failures, tag it:

```ts
import { acceptsFailures } from "agency-lang";

export const myLogger = acceptsFailures((value) => {
  console.log(value);
});
```

Set `failurePropagation` in `agency.json` to `"warn"` (log a statelog
warning and a stderr line, keep legacy behavior) or `"off"` to disable.

## `Result` type parameters

The `Result` type has two type parameters, the success type and the failure type. If you don't specify them, they default to `any`:

```ts
// success value is `any`, failure value is `any`
const result1: Result = divide(10, 0)

// success value is `number`, failure value is `any`
const result2: Result<number> = divide(10, 0)

// success value is `number`, failure value is `string`
const result3: Result<number, string> = divide(10, 0)
```
