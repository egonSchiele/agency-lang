---
name: Built-in Functions
description: Reference table of every user-facing built-in function and language construct available in any `.agency` file without an import, covering LLM calls, checkpointing, interrupts, concurrency, and more.
---

# Built-in Functions

This page lists every user-facing built-in function and built-in language construct in Agency. These are available in every `.agency` file without an `import` statement.

For the auto-imported standard library (`print`, `sleep`, `read`, `fetch`, `range`, ...) see [Agency's Standard Library](/guide/agency-stdlib) and the [stdlib reference](/stdlib/).

## LLM

| Name | Signature | Description |
|---|---|---|
| `llm` | `llm(prompt: any, options?): T` | Send a message to an LLM and return its response. The prompt is a string, or an array mixing text and `image()`/`file()` attachments. The return type `T` is inferred from the variable annotation at the call site and compiled to a JSON schema. `options` accepts `model`, `provider`, `apiKey`, `maxTokens`, `temperature`, `stream`, `reasoningEffort` (`"low"`/`"medium"`/`"high"`), `thinking` (`{ enabled, budgetTokens? }`), `tools`, `hostedTools`, `memory`, `maxToolResultChars`, `retries`, `timeout`, `backoff` (`{ initial?, factor?, max? }`), and `metadata`. The same fields can also be passed as named arguments. See [LLMs](/guide/llm). |

## Checkpointing

| Name | Signature | Description |
|---|---|---|
| `checkpoint` | `checkpoint(): number` | Take a snapshot of the current execution state and return a checkpoint ID. |
| `getCheckpoint` | `getCheckpoint(id: number): any` | Return the full checkpoint object for a given ID. |
| `restore` | `restore(checkpoint, options?): void` | Restore execution to a previously captured checkpoint. Accepts either a checkpoint object or ID, plus an options object (e.g. `{ maxRestores: 3 }` or variable overrides). See [Checkpointing](/guide/checkpointing). |

## Interrupts and Handlers

| Name | Signature | Description |
|---|---|---|
| `interrupt` | `interrupt <kind>(message, payload?)` | Statement (not a regular function call) that throws an interrupt of the given kind. Execution state is captured so that, once responded to, execution resumes from exactly this point. See [Interrupts](/guide/interrupts). |
| `approve` | `approve(value?): any` | Used inside a `handle ... with` block to approve the wrapped action, optionally substituting a return value. |
| `reject` | `reject(value?): any` | Used inside a `handle ... with` block to block the wrapped action. |
| `propagate` | `propagate(): any` | Used inside a `handle ... with` block to pass the interrupt up to the next handler in the chain. See [Handlers](/guide/handlers). |

## Concurrency

| Name | Signature | Description |
|---|---|---|
| `fork` | `fork(items) as <name> { ... }` | Run multiple branches in parallel and wait for all of them to finish. Returns an array of results, one per item. Pass `shared: true` to share globals across branches (they're isolated by default). |
| `race` | `race(items) as <name> { ... }` | Like `fork`, but returns as soon as the first branch completes and cancels the rest. Also accepts `shared: true`. See [Concurrency](/guide/concurrency). |

## Callbacks

| Name | Signature | Description |
|---|---|---|
| `callback` | `callback(eventName) as <data> { ... }` | Register a callback for an event. The block receives the event's data as an argument. See [Callbacks](/guide/callbacks). |

## Result Type

| Name | Signature | Description |
|---|---|---|
| `success` | `success(value): Result` | Wrap a value in a successful `Result`. |
| `failure` | `failure(error, value?): Result` | Wrap an error (and optionally a value) in a failed `Result`. |
| `isSuccess` | `isSuccess(result): boolean` | Check whether a `Result` is a success. |
| `isFailure` | `isFailure(result): boolean` | Check whether a `Result` is a failure. See [Error Handling](/guide/error-handling). |

## Errors

| Name | Signature | Description |
|---|---|---|
| `throw` | `throw(message): void` | Raise an exception, unwinding the current function or node. The argument is coerced to a string for the error message. |

## Function and Tool Methods

These are built-in methods you can call on any Agency function or tool value (they each return a new tool, so they chain).

| Name | Signature | Description |
|---|---|---|
| `.partial` | `fn.partial(name: value, ...)` | Bind some of a function's arguments by name, producing a new function that takes the rest. See [Partial Application](/guide/partial-application). |
| `.describe` | `fn.describe(text): tool` | Override the tool description an LLM sees for this function. |
| `.rename` | `fn.rename(name): tool` | Give this tool a distinct name (the name the LLM sees). Use when deriving several tools from one function, since `.partial()`/`.describe()`/import aliases keep the base name and would collide in one `llm({ tools })` call. |
| `.preapprove` | `fn.preapprove(): tool` | Auto-approve every interrupt this function raises. |

## Types and Schemas

| Name | Signature | Description |
|---|---|---|
| `schema` | `schema<T>` | Expression that returns the Zod schema for a type `T`. Useful when passing a schema to a TypeScript function or validator. See [Schemas](/guide/schemas). |

## Debugging

| Name | Signature | Description |
|---|---|---|
| `debugger` | `debugger "<label>"?` | No-op when running the agent normally, but pauses execution when running under the Agency debugger. Accepts an optional label string. See [Debugger](/cli/debug). |