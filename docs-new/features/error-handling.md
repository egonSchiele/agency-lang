## Help my agent keeps failing!

Agents are non-deterministic creatures and will fail. Because of that, they'll fail much more often than other code, and you need to be able to handle failures. Here's how Agency handles failures: There are no exceptions, and there are no try-catch statements. Instead, failures are returned as values.
For example, here is a function that returns a success or a failure:

```ts
def divide(a: number, b: number) {
  if (b == 0) {
    return failure("Can't divide by zero!")
  }
  return success(a / b)
}
```

You can run it and check whether the result succeeded, and print out the result if it did.

```ts
node main() {
  const result = divide(10, 2)
  if (isSuccess(result)) {
    print("The result is ${result.value}")
  } else {
    print("The operation failed with message: ${result.error}")
  }
}
```

If the function fails, you can also retry. Every failure comes with a checkpoint at the start of the function where the failure occurred. You can simply use the checkpoint to try again:

```ts
node main() {
  const result = divide(10, 0)
  if (isSuccess(result)) {
    print("The result is ${result.value}")
  } else {
    print("Failure! ${result.functionName} called with ${JSON.stringify(result.args)}")
    restore(result.checkpoint)
  }
}
```

Note that you don't have to get the return value from the call to `restore` and check whether it is a success or failure. This is because restore isn't just calling the function again, it's rewinding time to the start of the function call. You can use this to retry transient LLM failures. In this case, obviously, there was a genuine failure: you can't divide by zero. You can also choose to retry but override the function arguments:

```ts
node main() {
  const result = divide(10, 0)
  if (isSuccess(result)) {
    print("The result is ${result.value}")
  } else {
    print("Failure! ${result.functionName} called with ${JSON.stringify(result.args)}")
    restore(result.checkpoint, { 
      args: {...result.args, b: 2}
    })
  }
}
```
This is great for handling transient LLM failures. Is Gemini down? Try Claude. Taking too long? Try a slightly different prompt.