## Help my agent keeps failing!

Agents are non-deterministic creatures and will fail. Because of that, they'll fail much more often than other code, and you need to be able to handle failures. Here's how Agency handles failures: There are no exceptions, and there are no try-catch statements. Instead, failures are returned as values.
For example, here is a function that returns a success or a failure:

```ts

```

You can run it and check whether the result succeeded, and print out the result if it did.

If the function fails, you can also retry. Every failure comes with a checkpoint at the start of the function where the failure occurred. You can simply use the checkpoint to try again:

```ts

```

This will rewind the state exactly to how things were at the start of the function. You can use this to retry transient LLM failures. In this case, obviously, there was a genuine failure: you can't divide by zero. You can also choose to retry but override the function arguments:

```ts

```

This is great for handling transient LLM failures. Is Gemini down? Try Claude. Taking too long? Try a slightly different prompt.

The maximum number of retries is configurable and defaults to 50, but you can also use a counter yourself. Any local or global variables you use will get reset when you rewind time, but a shared variable won't. Shared variables operate outside agency checkpoints. Their values aren't stored as part of the checkpoint, and their values aren't restored when you rewind to a previous checkpoint.

```ts

```