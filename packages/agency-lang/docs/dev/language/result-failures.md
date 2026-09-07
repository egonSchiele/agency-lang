# The `Result` failure

Every failure in Agency carries a string message, and optionally an object
of extra data. This note records the shape, the places that depend on it,
and the two things that are easy to break later.

## The shape

`lib/runtime/result.ts`:

```ts
{
  __type: "resultType",
  success: false,
  error: "Guard 'research' exceeded its cost budget: spent 0.42 of 0.3.",
  data: { type: "guardFailure", maxCost: 0.3, actualCost: 0.42 },
  checkpoint, neverStarted, destructiveRan, rejected, functionName, args,
  skippedFunctions,
}
```

`data` sits beside `error`, not inside it. So a reader writes
`result.data.maxCost`, never `result.error.data.maxCost`.

`data` is `{}` when the producer passed none, never null. That is so a
reader can write `err.data.status` without checking first: a missing field
reads as null the way any missing field does. The cost is that
`result.data == null` is never true, which matters for the `| null` data
type below.

## The two coercions

`failure()` coerces its message with `coerceMessage` and its data with
`coerceData`. Anything that is not a string becomes one; anything that is
not a plain object becomes `{}`.

These are a backstop, not the boundary. A person who writes `failure(42)`
in Agency sees diagnostic AG2013 and never reaches this code. The coercion
exists because two callers are outside the type checker's view: imported
TypeScript, and a rejected interrupt's value.

## `runtimeFailure`, and the arity that codegen depends on

Codegen calls `failure()` from three mustache templates and two raw strings
inside the TypeScript builder. None of those are typechecked: they are text
that becomes source later.

Two things follow.

First, twelve of those calls carry no user data, so they go through
`runtimeFailure(error, opts)` instead. That keeps the three-argument
positional shape in one place a compiler can see.

Second, the builder at `lib/backends/typescriptBuilder.ts:2614` injects an
options object carrying the checkpoint, the function name, and the call's
arguments, and it injects it **positionally**. A user-written
`failure(msg)` must therefore be padded with a `null` data argument so the
options always land in the third slot. Without the pad, a two-argument
`failure(msg, data)` puts the user's data where the options belong, the
failure loses its checkpoint, and the program cannot resume from that line.
`tests/agency/result/failure-with-data-args.agency` is the test for this.

## Why the second type parameter is the data type

`Result<T, D>` reads as: succeeds with a `T`, or fails with a message plus
`D` of data. The message is always a string and is never named in the type.

`D` must be an object. `Result<T, string>` is refused (AG2016), because no
`failure()` call can produce string data. `Result<T>` and bare `Result`
leave `D` as `any`, and so does the wrapper around a validated return
(`resultTypeForValidation`) — a validation failure carries a message and no
structured data.

## Why a declared data type is required

A function that declares `Result<Policy, ParsePolicyFailure>` and then
returns a bare `failure(msg)` is a compile error. Otherwise the type says
the data is there when it is not.

This needed no new machinery. A one-argument `failure` synthesizes as
`Result<any, null>` (`synthFailureCall` in `synthesizer.ts`), and the
Result branch of `isAssignable` is covariant in both parameters, so `null`
is assignable to `any` and to `D | null` and not to a real object type.

What it did need is a message. The generic one reads "Result<any, null> is
not assignable to Result<Policy, ParsePolicyFailure>", which does not tell
anyone what to do. `emitAssignabilityError` in `lib/typeChecker/utils.ts`
intercepts that case and reports AG2015 instead, naming the second argument
and the `| null` alternative. It resolves the target type first, so an
alias for the Result reaches the check.

The same site reports AG2016 when the declared data type is not an object,
ahead of AG2015 — otherwise a `Result<T, string>` annotation would tell the
author to pass string data, which is advice nobody can act on.

## `| null` is a permission, not a value

`Result<T, D | null>` means the producer may omit the data. It does not
mean `.data` can come back null: at runtime it is always `{}`. Code that
wants to tell the two apart tests a field of the data, not the data itself.

One consequence, worth knowing if it ever bites: for a
`Result<T, D | null>` that is itself validated (a `!` return, or structured
output), the generated Zod schema is `data: z.union([D, z.null()])`, and a
runtime `{}` matches neither arm when `D` has required fields. Widening the
schema would stop it checking `D` at all, so the schema is left strict.

## Files

- `lib/runtime/result.ts` — the shape, both coercions, `runtimeFailure`,
  `guardFailureMessage`.
- `lib/typeChecker/resultUnion.ts` — the discriminated-union view, which is
  the single source of truth for what fields a Result has.
- `lib/typeChecker/synthesizer.ts` — `synthFailureCall`, AG2013, AG2014.
- `lib/typeChecker/utils.ts` — AG2015 and AG2016.
- `lib/typeChecker/dataShape.ts` — `isDataShaped`, shared by the two above.
- `lib/backends/typescriptBuilder.ts:2614` — the arity padding.
