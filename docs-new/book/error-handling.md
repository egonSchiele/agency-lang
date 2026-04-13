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

You can also use functions that take multiple arguments in a pipe chain using the placeholder syntax. Here is a chain that halves a number and then divides it by 3:

```
const result = success(10) |> half |> divide(?, 3)
```

The placeholder (`?`) says which parameter the result value should be assigned to.

## Checkpoints
If you're still holding out for a good reason to use the `Result` type, this may be the one. Every failure also contains a checkpoint. The checkpoint is from the start of the function where the failure occurred. The failure also contains the function name and the arguments it was called with.

Let's go back to the `half` chain now and examine the failure a little more closely.

```ts
const result = success(10) |> half |> half |> half
  if (isFailure(result)) {
    print(result.functionName)
    print(result.args)
  }
```

prints

```
half
{ x: 5 }
```

you can now use the checkpoint to rewind time and rerun the function with new arguments:

```ts
const result = success(10) |> half |> half |> half
  if (isFailure(result)) {
    restore(result.checkpoint, { 
      args: { 
        x: 8
      }
    })
  }
  print(result)
```

If the result is a failure we set the args to `8` and try again. Notice that we're not capturing the return value of the `restore` function, because there is nothing to return. `restore` isn't calling the function again, it's actually rewinding time and replaying. Let's add two `print` statements so we can clearly see what's going on. Here's the complete code, if you want to run it yourself:

```ts
def divide(a: number, b: number): Result {
  if (b == 0) {
    return failure("Can't divide by zero!")
  }
  return success(a / b)
}

def half(x: number): Result {
  // new print statement
  print("Halving ${x}")
  if (x % 2 != 0) {
    return failure("Number must be even to be halved, got ${x}")
  }
  return divide(x, 2)
}

node main() {
  const result = success(10) |> half |> half |> half
  if (isFailure(result)) {
    // new print statement
    print("Restoring...")
    restore(result.checkpoint, { 
      args: { 
        x: 8
      }
    })
  }
  print(result)
}
```

This prints:

```
Halving 10
Halving 5
Restoring...
Halving 8
Halving 4
{ success: true, value: 2 }
```

So we
1. called one half function
2. failed on the second half function
3. tried it again with 8 and succeeded
4. ran the last half function and succeeded
5. got the return value of 2.

Checkpoints are pretty cool, especially when dealing with LLMs when there can be all sorts of transient failures. Having a mechanism to retry is super useful.

## The `try` keyword

Bit of an anti-climax after that awesome section on checkpoints, but here we go. Agency has a `try` keyword. Even though Agency doesn't throw errors, you might call some TypeScript code that throws an error. The `try` keyword will catch the error and convert it to a failure for you:

```ts
// foo throws an error
// result is now a Result type
// (it would be even foo did not throw an error)
const result = try foo()
```

Agency also adds an automatic try-catch around every function definition, and if an error is thrown it returns a `failure` type.