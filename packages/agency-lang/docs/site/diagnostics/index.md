---
name: "Diagnostics"
---

# Diagnostic codes

Every type-checker error and warning carries a stable `AG####` code.
Look one up with `agency explain <code>` (e.g. `agency explain AG2005`),
or suppress one on the next line with `// @tc-ignore AG####`.

## Types and aliases

| Code | Message |
| --- | --- |
| [AG1001](types-aliases.md#ag1001) | Type parameter '{param}' (no default) must come before parameters that have defaults in '{alias}'. |
| [AG1002](types-aliases.md#ag1002) | Type '{alias}' is not a value-parameterized type but was given {count} value {argumentWord} (referenced in '{context}'). |
| [AG1003](types-aliases.md#ag1003) | {alias} expects at most {max} value {argumentWord}, got {count} (referenced in '{context}'). |
| [AG1004](types-aliases.md#ag1004) | '{alias}' is a value-parameterized type and requires value arguments — write '{alias}({formals})' (referenced in '{context}'). |
| [AG1005](types-aliases.md#ag1005) | {alias} requires at least {min} value {argumentWord} (referenced in '{context}'). |
| [AG1006](types-aliases.md#ag1006) | Type alias '{alias}' is not defined (referenced in '{context}'). |
| [AG1007](types-aliases.md#ag1007) | Generic type '{alias}' requires type arguments (referenced in '{context}'). |
| [AG1008](types-aliases.md#ag1008) | {alias} expects {expected} type {argumentWord}, got {count} (referenced in '{context}'). |
| [AG1009](types-aliases.md#ag1009) | Unknown generic type '{alias}' (referenced in '{context}'). |
| [AG1010](types-aliases.md#ag1010) | Type '{alias}' is not a generic type (referenced in '{context}'). |
| [AG1011](types-aliases.md#ag1011) | {alias} expects at most {max} type {argumentWord}, got {count} (referenced in '{context}'). |
| [AG1012](types-aliases.md#ag1012) | {alias} requires at least {min} type {argumentWord} (referenced in '{context}'). |

## Assignability and checking

| Code | Message |
| --- | --- |
| [AG2001](checking.md#ag2001) | Type '{actual}' is not assignable to type '{expected}' ({context}). |
| [AG2002](checking.md#ag2002) | Type '{actual}' is not assignable to type 'boolean' (condition). |
| [AG2003](checking.md#ag2003) | Unknown property '{key}' on type '{expected}' ({context}). |
| [AG2004](checking.md#ag2004) | Variable '{name}' has no type annotation (strict mode). |
| [AG2005](checking.md#ag2005) | Type '{actual}' is not assignable to type '{expected}'. |
| [AG2006](checking.md#ag2006) | For-loop iterable must be an array or Record, got '{actual}'. |
| [AG2007](checking.md#ag2007) | {kind} '{name}' has validated parameters but its return type is not a Result type. Validated parameters can short-circuit with a failure, so the return type must be 'Result<...>'. |
| [AG2008](checking.md#ag2008) | Property '{field}' is not available on every member of '{union}'; narrow the value (e.g. with a guard) before accessing it. |
| [AG2009](checking.md#ag2009) | '.{field}' is only available on a {branch} Result; guard with 'if (isSuccess(r))' / 'if (isFailure(r))', use 'r catch …', or 'match (r) {{ … }}'. |
| [AG2010](checking.md#ag2010) | Cannot {op} values of different dimensions ({leftDim} and {rightDim}): '{left}' and '{right}'. |
| [AG2011](checking.md#ag2011) | Property '{property}' does not exist on type '{type}'. |
| [AG2012](checking.md#ag2012) | Not all code paths return a value in '{fn}'. |

## Interrupts, effects, and handlers

| Code | Message |
| --- | --- |
| [AG3001](effects.md#ag3001) | The '!' validation syntax is not allowed on handler parameters. Validate the data inside the handler body if needed. |
| [AG3002](effects.md#ag3002) | Effect '{effect}' is declared more than once in the same file. |
| [AG3003](effects.md#ag3003) | Conflicting payload types for effect '{effect}'. All declarations of an effect must agree on its payload. |
| [AG3004](effects.md#ag3004) | Named arguments are not allowed on 'raise'/'interrupt'. Pass the data positionally. |
| [AG3005](effects.md#ag3005) | Effect '{effect}' expects data {payload}, but none was supplied. |
| [AG3006](effects.md#ag3006) | Effect '{effect}' data field '{field}' is missing. |
| [AG3007](effects.md#ag3007) | Effect '{effect}' data field '{field}' has the wrong type. |
| [AG3008](effects.md#ag3008) | Effect '{effect}' data does not match the declared {payload}. |
| [AG3009](effects.md#ag3009) | Function '{fn}' may throw interrupts [{effects}] but is not inside a handler. |
| [AG3010](effects.md#ag3010) | Handler {handler} may raise interrupts [{effects}]. That would re-enter the handler chain (the dispatcher visits every handler, even the one currently running) and recurse until `HandlerRecursionError` fires at runtime. Restructure so the handler doesn't call interrupt-raising code (e.g. hoist file I/O out of the handler), or suppress this error with `// @tc-ignore` on the line above the `handle` block. |
| [AG3011](effects.md#ag3011) | `interrupt` is not allowed inside a callback body (callback registered on '{hook}' may raise [{effects}]). Callbacks fire as side effects; their body cannot pause execution to ask the user a question. Move the `interrupt` into the calling node/function instead, or use a runtime guard if you wanted budget enforcement. |
| [AG3012](effects.md#ag3012) | 'raises {ref}' is not an effect set. Declare '{ref}' with 'effectSet' (not 'type'), or use an inline set like '<...>'. |
| [AG3013](effects.md#ag3013) | {kind} '{name}' raises effect '{effect}', which exceeds its declared 'raises {declared}'. Add '{effect}' to the clause. |
| [AG3014](effects.md#ag3014) | {who} may raise any effect (its type has no 'raises' clause), which exceeds the 'raises <{allowed}>' allowed by type '{type}'. Add a 'raises' clause to the value's type. |
| [AG3015](effects.md#ag3015) | {who} raises effect '{effect}', which exceeds the 'raises <{allowed}>' allowed by type '{type}'. Add '{effect}' to the clause, or use a target type that allows it. |

## Names, scope, and reserved words

| Code | Message |
| --- | --- |
| [AG4001](names.md#ag4001) | '{name}' shadows an imported function. |
| [AG4002](names.md#ag4002) | '{name}' is a reserved built-in; cannot be redefined. |
| [AG4003](names.md#ag4003) | '{name}' is a reserved built-in type; cannot be redefined. |
| [AG4004](names.md#ag4004) | Function '{name}' is not defined. |
| [AG4005](names.md#ag4005) | Cannot reassign to constant '{name}'. |
| [AG4006](names.md#ag4006) | `{keyword}` is a reserved block keyword. Write `{keyword} {{ ... }}` or `{keyword}(args) {{ ... }}` directly — the `as` keyword is not supported on {keyword} blocks (there's nothing to bind). |
| [AG4007](names.md#ag4007) | Variable '{name}' is not defined. |

## Match and narrowing

| Code | Message |
| --- | --- |
| [AG5002](match.md#ag5002) | match is not exhaustive: missing {missing}. |

## Calls, tools, and LLM usage

| Code | Message |
| --- | --- |
| [AG6001](tools.md#ag6001) | 'regex' cannot appear in an llm() structured-output type ({context}); LLMs can't return regex values through JSON. |
| [AG6002](tools.md#ag6002) | Cannot interpolate parameter '{param}' in doc string — parameter values are not known when the tool description is sent to the LLM. Use a global variable instead. |
| [AG6003](tools.md#ag6003) | .partial() requires named arguments, e.g. fn.partial(a: 5). |
| [AG6004](tools.md#ag6004) | Unknown parameter '{name}' in .partial() call. '{fn}' has parameters: {params}. |
| [AG6005](tools.md#ag6005) | Argument type '{actual}' is not assignable to parameter type '{expected}' in .partial() call to '{fn}'. |
| [AG6006](tools.md#ag6006) | Named arguments are not supported on built-in method '.{method}()'. |
| [AG6007](tools.md#ag6007) | Method '.{method}()' expects {expected} argument(s), got {count}. |
| [AG6008](tools.md#ag6008) | Method '.{method}()' expects at least {min} argument(s), got {count}. |
| [AG6009](tools.md#ag6009) | Method '.{method}()' expects {min}–{max} argument(s), got {count}. |
| [AG6010](tools.md#ag6010) | Argument type '{actual}' is not assignable to parameter type '{expected}' in call to '.{method}()'. |
| [AG6011](tools.md#ag6011) | Named arguments can only be used with Agency-defined functions, not '{fn}'. |
| [AG6012](tools.md#ag6012) | '{fn}' does not accept the named argument '{name}'. Allowed: {allowed}. |
| [AG6013](tools.md#ag6013) | Duplicate named argument '{name}' in call to '{fn}'. |
| [AG6014](tools.md#ag6014) | Named argument '{name}' on '{fn}' expects type '{expected}', got '{actual}'. |
| [AG6015](tools.md#ag6015) | '{fn}' does not accept a block argument. |
| [AG6016](tools.md#ag6016) | Expected {expected} argument(s) for '{fn}', but got {count}. |
| [AG6017](tools.md#ag6017) | Expected at least {min} argument(s) for '{fn}', but got {count}. |
| [AG6018](tools.md#ag6018) | Expected {min}-{max} argument(s) for '{fn}', but got {count}. |
| [AG6019](tools.md#ag6019) | Argument type '{actual}' is not assignable to parameter type '{expected}' in call to '{fn}'. |
| [AG6020](tools.md#ag6020) | Splat argument must be an array, got '{actual}' in call to '{fn}'. |
| [AG6021](tools.md#ag6021) | Splat element type '{actual}' is not assignable to parameter type '{expected}' in call to '{fn}'. |
| [AG6022](tools.md#ag6022) | Type '{actual}' is not assignable to pipe slot of type '{expected}'. |
| [AG6023](tools.md#ag6023) | Splat argument cannot follow a named argument in call to '{fn}'. |
| [AG6024](tools.md#ag6024) | Positional argument cannot follow a named argument in call to '{fn}'. |
| [AG6025](tools.md#ag6025) | Unknown named argument '{name}' in call to '{fn}'. |
| [AG6026](tools.md#ag6026) | Named argument '{name}' conflicts with positional argument at position {position} in call to '{fn}'. |
| [AG6027](tools.md#ag6027) | Positional argument cannot feed variadic parameter '{param}' when it is also bound by name in call to '{fn}'. |
| [AG6028](tools.md#ag6028) | Tool '{tool}' has required function-typed parameter '{param}' is unbound. Bind it with .partial({param}: <value>) before passing as a tool. |
| [AG6029](tools.md#ag6029) | Tool '{tool}' has required function-typed parameter '{param}' is unbound ({type}). Bind it with .partial({param}: <value>) before passing as a tool. |
| [AG6030](tools.md#ag6030) | Tool '{tool}' will be exposed to the LLM without optional function-typed parameter(s): {params}. The function body must be prepared to run with the declared default for each. |

## Static init, config, and imports

| Code | Message |
| --- | --- |
| [AG7001](static-init.md#ag7001) | Only 'static const' declarations can be exported. Use 'export static const {name} = ...' instead. |
| [AG7002](static-init.md#ag7002) | {contextLabel} cannot call `{builtin}(...)` — {reason}, but static initializers run once at process startup before any per-run state exists. Move this call into a node or a function called from a node. |
| [AG7003](static-init.md#ag7003) | {contextLabel} cannot `interrupt(...)` — interrupts pause the per-run execution stack, but static initializers run once at process startup before any agent run has begun. Move this into a node body. |
| [AG7004](static-init.md#ag7004) | Cannot reassign static `{name}` at module top level — statics are immutable after initialization. Use a global (`const`/`let` without `static`) if you need a mutable value. |
| [AG7005](static-init.md#ag7005) | Cannot mutate static `{name}` via `.{method}(...)` at module top level — statics are deep-frozen after initialization. Use a global (`const`/`let` without `static`) if you need a mutable value. |
| [AG7006](static-init.md#ag7006) | Function '{name}' cannot be both destructive and idempotent — those markers are contradictory. Pick one. |
