# Built-in Functions

This page lists every user-facing built-in function and built-in language construct in Agency. These are available in every `.agency` file without an `import` statement.

For the auto-imported standard library (`print`, `sleep`, `read`, `fetch`, `range`, ...) see [Agency's Standard Library](/appendix/agency-stdlib) and the [stdlib reference](/stdlib/).

## LLM

| Name | Signature | Description |
|---|---|---|
| `llm` | `llm(prompt: any, options?): T` | Send a message to an LLM and return its response. The return type `T` is inferred from the variable annotation at the call site and compiled to a JSON schema. `options` accepts `model`, `provider`, `apiKey`, `maxTokens`, `temperature`, `stream`, `reasoningEffort` (`"low"`/`"medium"`/`"high"`), `thinking` (`{ enabled, budgetTokens? }`), `tools`, `memory`, `metadata`. See [LLMs](/guide/llm). |

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
| `fork` | `fork(labels) as <name> { ... }` | Run multiple branches in parallel and wait for all of them to finish. Returns an array of results, one per label. |
| `race` | `race(labels) as <name> { ... }` | Like `fork`, but returns as soon as the first branch completes and cancels the rest. See [Concurrency](/guide/concurrency). |

## Result Type

| Name | Signature | Description |
|---|---|---|
| `success` | `success(value): Result` | Wrap a value in a successful `Result`. |
| `failure` | `failure(error, value?): Result` | Wrap an error (and optionally a value) in a failed `Result`. |
| `isSuccess` | `isSuccess(result): boolean` | Check whether a `Result` is a success. |
| `isFailure` | `isFailure(result): boolean` | Check whether a `Result` is a failure. See [Error Handling](/guide/error-handling). |

## Types and Schemas

| Name | Signature | Description |
|---|---|---|
| `schema` | `schema<T>` | Expression that returns the Zod schema for a type `T`. Useful when passing a schema to a TypeScript function or validator. See [Schemas](/guide/schemas). |

## Debugging

| Name | Signature | Description |
|---|---|---|
| `debugger` | `debugger "<label>"?` | No-op when running the agent normally, but pauses execution when running under the Agency debugger. Accepts an optional label string. See [Debugger](/cli/debug). |