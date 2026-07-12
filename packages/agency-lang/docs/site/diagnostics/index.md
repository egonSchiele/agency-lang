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
| [AG1001](types-aliases.md#ag1001) | Type parameter '&#123;param&#125;' (no default) must come before parameters that have defaults in '&#123;alias&#125;'. |
| [AG1002](types-aliases.md#ag1002) | Type '&#123;alias&#125;' is not a value-parameterized type but was given &#123;count&#125; value &#123;argumentWord&#125; (referenced in '&#123;context&#125;'). |
| [AG1003](types-aliases.md#ag1003) | &#123;alias&#125; expects at most &#123;max&#125; value &#123;argumentWord&#125;, got &#123;count&#125; (referenced in '&#123;context&#125;'). |
| [AG1004](types-aliases.md#ag1004) | '&#123;alias&#125;' is a value-parameterized type and requires value arguments — write '&#123;alias&#125;(&#123;formals&#125;)' (referenced in '&#123;context&#125;'). |
| [AG1005](types-aliases.md#ag1005) | &#123;alias&#125; requires at least &#123;min&#125; value &#123;argumentWord&#125; (referenced in '&#123;context&#125;'). |
| [AG1006](types-aliases.md#ag1006) | Type alias '&#123;alias&#125;' is not defined (referenced in '&#123;context&#125;'). |
| [AG1007](types-aliases.md#ag1007) | Generic type '&#123;alias&#125;' requires type arguments (referenced in '&#123;context&#125;'). |
| [AG1008](types-aliases.md#ag1008) | &#123;alias&#125; expects &#123;expected&#125; type &#123;argumentWord&#125;, got &#123;count&#125; (referenced in '&#123;context&#125;'). |
| [AG1009](types-aliases.md#ag1009) | Unknown generic type '&#123;alias&#125;' (referenced in '&#123;context&#125;'). |
| [AG1010](types-aliases.md#ag1010) | Type '&#123;alias&#125;' is not a generic type (referenced in '&#123;context&#125;'). |
| [AG1011](types-aliases.md#ag1011) | &#123;alias&#125; expects at most &#123;max&#125; type &#123;argumentWord&#125;, got &#123;count&#125; (referenced in '&#123;context&#125;'). |
| [AG1012](types-aliases.md#ag1012) | &#123;alias&#125; requires at least &#123;min&#125; type &#123;argumentWord&#125; (referenced in '&#123;context&#125;'). |

## Assignability and checking

| Code | Message |
| --- | --- |
| [AG2001](checking.md#ag2001) | Type '&#123;actual&#125;' is not assignable to type '&#123;expected&#125;' (&#123;context&#125;). |
| [AG2002](checking.md#ag2002) | Type '&#123;actual&#125;' is not assignable to type 'boolean' (condition). |
| [AG2003](checking.md#ag2003) | Unknown property '&#123;key&#125;' on type '&#123;expected&#125;' (&#123;context&#125;). |
| [AG2004](checking.md#ag2004) | Variable '&#123;name&#125;' has no type annotation (strict mode). |
| [AG2005](checking.md#ag2005) | Type '&#123;actual&#125;' is not assignable to type '&#123;expected&#125;'. |
| [AG2006](checking.md#ag2006) | For-loop iterable must be an array or Record, got '&#123;actual&#125;'. |
| [AG2007](checking.md#ag2007) | &#123;kind&#125; '&#123;name&#125;' has validated parameters but its return type is not a Result type. Validated parameters can short-circuit with a failure, so the return type must be 'Result&lt;...&gt;'. |
| [AG2008](checking.md#ag2008) | Property '&#123;field&#125;' is not available on every member of '&#123;union&#125;'; narrow the value (e.g. with a guard) before accessing it. |
| [AG2009](checking.md#ag2009) | '.&#123;field&#125;' is only available on a &#123;branch&#125; Result; guard with 'if (isSuccess(r))' / 'if (isFailure(r))', use 'r catch …', or 'match (r) &#123; … &#125;'. |
| [AG2010](checking.md#ag2010) | Cannot &#123;op&#125; values of different dimensions (&#123;leftDim&#125; and &#123;rightDim&#125;): '&#123;left&#125;' and '&#123;right&#125;'. |
| [AG2011](checking.md#ag2011) | Property '&#123;property&#125;' does not exist on type '&#123;type&#125;'. |
| [AG2012](checking.md#ag2012) | Not all code paths return a value in '&#123;fn&#125;'. |

## Interrupts, effects, and handlers

| Code | Message |
| --- | --- |
| [AG3001](effects.md#ag3001) | The '!' validation syntax is not allowed on handler parameters. Validate the data inside the handler body if needed. |
| [AG3002](effects.md#ag3002) | Effect '&#123;effect&#125;' is declared more than once in the same file. |
| [AG3003](effects.md#ag3003) | Conflicting payload types for effect '&#123;effect&#125;'. All declarations of an effect must agree on its payload. |
| [AG3004](effects.md#ag3004) | Named arguments are not allowed on 'raise'/'interrupt'. Pass the data positionally. |
| [AG3005](effects.md#ag3005) | Effect '&#123;effect&#125;' expects data &#123;payload&#125;, but none was supplied. |
| [AG3006](effects.md#ag3006) | Effect '&#123;effect&#125;' data field '&#123;field&#125;' is missing. |
| [AG3007](effects.md#ag3007) | Effect '&#123;effect&#125;' data field '&#123;field&#125;' has the wrong type. |
| [AG3008](effects.md#ag3008) | Effect '&#123;effect&#125;' data does not match the declared &#123;payload&#125;. |
| [AG3009](effects.md#ag3009) | Function '&#123;fn&#125;' may throw interrupts [&#123;effects&#125;] but is not inside a handler. |
| [AG3010](effects.md#ag3010) | Handler &#123;handler&#125; may raise interrupts [&#123;effects&#125;]. That would re-enter the handler chain (the dispatcher visits every handler, even the one currently running) and recurse until `HandlerRecursionError` fires at runtime. Restructure so the handler doesn't call interrupt-raising code (e.g. hoist file I/O out of the handler), or suppress this error with `// @tc-ignore` on the line above the `handle` block. |
| [AG3011](effects.md#ag3011) | `interrupt` is not allowed inside a callback body (callback registered on '&#123;hook&#125;' may raise [&#123;effects&#125;]). Callbacks fire as side effects; their body cannot pause execution to ask the user a question. Move the `interrupt` into the calling node/function instead, or use a runtime guard if you wanted budget enforcement. |
| [AG3012](effects.md#ag3012) | 'raises &#123;ref&#125;' is not an effect set. Declare '&#123;ref&#125;' with 'effectSet' (not 'type'), or use an inline set like '&lt;...&gt;'. |
| [AG3013](effects.md#ag3013) | &#123;kind&#125; '&#123;name&#125;' raises effect '&#123;effect&#125;', which exceeds its declared 'raises &#123;declared&#125;'. Add '&#123;effect&#125;' to the clause. |
| [AG3014](effects.md#ag3014) | &#123;who&#125; may raise any effect (its type has no 'raises' clause), which exceeds the 'raises &lt;&#123;allowed&#125;&gt;' allowed by type '&#123;type&#125;'. Add a 'raises' clause to the value's type. |
| [AG3015](effects.md#ag3015) | &#123;who&#125; raises effect '&#123;effect&#125;', which exceeds the 'raises &lt;&#123;allowed&#125;&gt;' allowed by type '&#123;type&#125;'. Add '&#123;effect&#125;' to the clause, or use a target type that allows it. |

## Names, scope, and reserved words

| Code | Message |
| --- | --- |
| [AG4001](names.md#ag4001) | '&#123;name&#125;' shadows an imported function. |
| [AG4002](names.md#ag4002) | '&#123;name&#125;' is a reserved built-in; cannot be redefined. |
| [AG4003](names.md#ag4003) | '&#123;name&#125;' is a reserved built-in type; cannot be redefined. |
| [AG4004](names.md#ag4004) | Function '&#123;name&#125;' is not defined. |
| [AG4005](names.md#ag4005) | Cannot reassign to constant '&#123;name&#125;'. |
| [AG4006](names.md#ag4006) | `&#123;keyword&#125;` is a reserved block keyword. Write `&#123;keyword&#125; &#123; ... &#125;` or `&#123;keyword&#125;(args) &#123; ... &#125;` directly — the `as` keyword is not supported on &#123;keyword&#125; blocks (there's nothing to bind). |
| [AG4007](names.md#ag4007) | Variable '&#123;name&#125;' is not defined. |
| [AG4008](names.md#ag4008) | '&#123;name&#125;' is not defined in '&#123;module&#125;'. |
| [AG4009](names.md#ag4009) | Cannot find module '&#123;module&#125;'. |

## Match and narrowing

| Code | Message |
| --- | --- |
| [AG5002](match.md#ag5002) | match is not exhaustive: missing &#123;missing&#125;. |

## Calls, tools, and LLM usage

| Code | Message |
| --- | --- |
| [AG6001](tools.md#ag6001) | 'regex' cannot appear in an llm() structured-output type (&#123;context&#125;); LLMs can't return regex values through JSON. |
| [AG6002](tools.md#ag6002) | Cannot interpolate parameter '&#123;param&#125;' in doc string — parameter values are not known when the tool description is sent to the LLM. Use a global variable instead. |
| [AG6003](tools.md#ag6003) | .partial() requires named arguments, e.g. fn.partial(a: 5). |
| [AG6004](tools.md#ag6004) | Unknown parameter '&#123;name&#125;' in .partial() call. '&#123;fn&#125;' has parameters: &#123;params&#125;. |
| [AG6005](tools.md#ag6005) | Argument type '&#123;actual&#125;' is not assignable to parameter type '&#123;expected&#125;' in .partial() call to '&#123;fn&#125;'. |
| [AG6006](tools.md#ag6006) | Named arguments are not supported on built-in method '.&#123;method&#125;()'. |
| [AG6007](tools.md#ag6007) | Method '.&#123;method&#125;()' expects &#123;expected&#125; argument(s), got &#123;count&#125;. |
| [AG6008](tools.md#ag6008) | Method '.&#123;method&#125;()' expects at least &#123;min&#125; argument(s), got &#123;count&#125;. |
| [AG6009](tools.md#ag6009) | Method '.&#123;method&#125;()' expects &#123;min&#125;–&#123;max&#125; argument(s), got &#123;count&#125;. |
| [AG6010](tools.md#ag6010) | Argument type '&#123;actual&#125;' is not assignable to parameter type '&#123;expected&#125;' in call to '.&#123;method&#125;()'. |
| [AG6011](tools.md#ag6011) | Named arguments can only be used with Agency-defined functions, not '&#123;fn&#125;'. |
| [AG6012](tools.md#ag6012) | '&#123;fn&#125;' does not accept the named argument '&#123;name&#125;'. Allowed: &#123;allowed&#125;. |
| [AG6013](tools.md#ag6013) | Duplicate named argument '&#123;name&#125;' in call to '&#123;fn&#125;'. |
| [AG6014](tools.md#ag6014) | Named argument '&#123;name&#125;' on '&#123;fn&#125;' expects type '&#123;expected&#125;', got '&#123;actual&#125;'. |
| [AG6015](tools.md#ag6015) | '&#123;fn&#125;' does not accept a block argument. |
| [AG6016](tools.md#ag6016) | Expected &#123;expected&#125; argument(s) for '&#123;fn&#125;', but got &#123;count&#125;. |
| [AG6017](tools.md#ag6017) | Expected at least &#123;min&#125; argument(s) for '&#123;fn&#125;', but got &#123;count&#125;. |
| [AG6018](tools.md#ag6018) | Expected &#123;min&#125;-&#123;max&#125; argument(s) for '&#123;fn&#125;', but got &#123;count&#125;. |
| [AG6019](tools.md#ag6019) | Argument type '&#123;actual&#125;' is not assignable to parameter type '&#123;expected&#125;' in call to '&#123;fn&#125;'. |
| [AG6020](tools.md#ag6020) | Splat argument must be an array, got '&#123;actual&#125;' in call to '&#123;fn&#125;'. |
| [AG6021](tools.md#ag6021) | Splat element type '&#123;actual&#125;' is not assignable to parameter type '&#123;expected&#125;' in call to '&#123;fn&#125;'. |
| [AG6022](tools.md#ag6022) | Type '&#123;actual&#125;' is not assignable to pipe slot of type '&#123;expected&#125;'. |
| [AG6023](tools.md#ag6023) | Splat argument cannot follow a named argument in call to '&#123;fn&#125;'. |
| [AG6024](tools.md#ag6024) | Positional argument cannot follow a named argument in call to '&#123;fn&#125;'. |
| [AG6025](tools.md#ag6025) | Unknown named argument '&#123;name&#125;' in call to '&#123;fn&#125;'. |
| [AG6026](tools.md#ag6026) | Named argument '&#123;name&#125;' conflicts with positional argument at position &#123;position&#125; in call to '&#123;fn&#125;'. |
| [AG6027](tools.md#ag6027) | Positional argument cannot feed variadic parameter '&#123;param&#125;' when it is also bound by name in call to '&#123;fn&#125;'. |
| [AG6028](tools.md#ag6028) | Tool '&#123;tool&#125;' has required function-typed parameter '&#123;param&#125;' is unbound. Bind it with .partial(&#123;param&#125;: &lt;value&gt;) before passing as a tool. |
| [AG6029](tools.md#ag6029) | Tool '&#123;tool&#125;' has required function-typed parameter '&#123;param&#125;' is unbound (&#123;type&#125;). Bind it with .partial(&#123;param&#125;: &lt;value&gt;) before passing as a tool. |
| [AG6030](tools.md#ag6030) | Tool '&#123;tool&#125;' will be exposed to the LLM without optional function-typed parameter(s): &#123;params&#125;. The function body must be prepared to run with the declared default for each. |

## Static init, config, and imports

| Code | Message |
| --- | --- |
| [AG7001](static-init.md#ag7001) | Only 'static const' declarations can be exported. Use 'export static const &#123;name&#125; = ...' instead. |
| [AG7002](static-init.md#ag7002) | &#123;contextLabel&#125; cannot call `&#123;builtin&#125;(...)` — &#123;reason&#125;, but static initializers run once at process startup before any per-run state exists. Move this call into a node or a function called from a node. |
| [AG7003](static-init.md#ag7003) | &#123;contextLabel&#125; cannot `interrupt(...)` — interrupts pause the per-run execution stack, but static initializers run once at process startup before any agent run has begun. Move this into a node body. |
| [AG7004](static-init.md#ag7004) | Cannot reassign static `&#123;name&#125;` at module top level — statics are immutable after initialization. Use a global (`const`/`let` without `static`) if you need a mutable value. |
| [AG7005](static-init.md#ag7005) | Cannot mutate static `&#123;name&#125;` via `.&#123;method&#125;(...)` at module top level — statics are deep-frozen after initialization. Use a global (`const`/`let` without `static`) if you need a mutable value. |
| [AG7006](static-init.md#ag7006) | Function '&#123;name&#125;' cannot be both destructive and idempotent — those markers are contradictory. Pick one. |
