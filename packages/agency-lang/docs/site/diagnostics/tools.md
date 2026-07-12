---
name: "Calls, tools, and LLM usage"
---

# Calls, tools, and LLM usage

## AG6001 — 'regex' cannot appear in an llm() structured-output type ({context}); LLMs can't return regex values through JSON.

*Default severity: error.*

An `llm()` call returns its result as structured JSON, and a `regex` value has no JSON representation the model can produce — so `regex` may not appear anywhere in an `llm()` output type.

**How to fix:** return the matched text as a `string` (or another JSON-friendly type) and build the regex yourself afterward.

## AG6002 — Cannot interpolate parameter '{param}' in doc string — parameter values are not known when the tool description is sent to the LLM. Use a global variable instead.

*Default severity: error.*

A function's doc string becomes the tool description sent to the LLM, and that description is fixed before any call happens — so a parameter's runtime value is not available to interpolate into it.

**How to fix:** reference a global variable instead of a parameter, or reword the doc string to not depend on per-call values.

## AG6003 — .partial() requires named arguments, e.g. fn.partial(a: 5).

*Default severity: error.*

`.partial()` binds arguments by name so it is unambiguous which parameters you are fixing. It does not accept positional arguments.

**How to fix:** name the arguments, e.g. `fn.partial(a: 5)`.

## AG6004 — Unknown parameter '{name}' in .partial() call. '{fn}' has parameters: {params}.

*Default severity: error.*

A `.partial()` call named a parameter that the function does not have. Binding an unknown parameter has no meaning.

**How to fix:** bind one of the function's real parameters (the message lists them), or fix a typo.

## AG6005 — Argument type '{actual}' is not assignable to parameter type '{expected}' in .partial() call to '{fn}'.

*Default severity: error.*

An argument passed to `.partial()` has a type that does not match the parameter it binds. A partially-applied argument must still satisfy the parameter's type.

**How to fix:** pass a value of the parameter's declared type.

## AG6006 — Named arguments are not supported on built-in method '.{method}()'.

*Default severity: error.*

Built-in methods take their arguments positionally; named arguments are only supported on Agency-defined functions. This call used names on a built-in method.

**How to fix:** pass the arguments positionally.

## AG6007 — Method '.{method}()' expects {expected} argument(s), got {count}.

*Default severity: error.*

A built-in method was called with the wrong number of arguments; this method takes an exact count.

**How to fix:** pass exactly the number of arguments the message names.

## AG6008 — Method '.{method}()' expects at least {min} argument(s), got {count}.

*Default severity: error.*

A built-in method was called with too few arguments; it requires at least a minimum number.

**How to fix:** supply at least the number of arguments the message names.

## AG6009 — Method '.{method}()' expects {min}–{max} argument(s), got {count}.

*Default severity: error.*

A built-in method accepts a range of argument counts, and this call fell outside it.

**How to fix:** pass a number of arguments within the range the message names.

## AG6010 — Argument type '{actual}' is not assignable to parameter type '{expected}' in call to '.{method}()'.

*Default severity: error.*

An argument to a built-in method has a type that does not match the parameter it fills.

**How to fix:** pass a value of the expected type.

## AG6011 — Named arguments can only be used with Agency-defined functions, not '{fn}'.

*Default severity: error.*

Named arguments work only with functions defined in Agency. The target here is not one of those (for example a built-in or an imported host function), so its arguments must be positional.

**How to fix:** pass the arguments positionally.

## AG6012 — '{fn}' does not accept the named argument '{name}'. Allowed: {allowed}.

*Default severity: error.*

A named argument was supplied that the function does not declare. The checker knows the function's parameter names and rejects names outside that set.

**How to fix:** use one of the function's declared parameter names (the message lists the allowed ones), or fix a typo.

## AG6013 — Duplicate named argument '{name}' in call to '{fn}'.

*Default severity: error.*

The same named argument was supplied twice in one call. Each parameter can be bound at most once.

**How to fix:** remove the duplicate.

## AG6014 — Named argument '{name}' on '{fn}' expects type '{expected}', got '{actual}'.

*Default severity: error.*

A named argument's value has a type that does not match the parameter's declared type.

**How to fix:** pass a value of the expected type for that parameter.

## AG6015 — '{fn}' does not accept a block argument.

*Default severity: error.*

A block argument (a trailing `{ ... }`) was passed to a function that does not declare a block parameter.

**How to fix:** remove the block, or call a function that takes one.

## AG6016 — Expected {expected} argument(s) for '{fn}', but got {count}.

*Default severity: error.*

A function was called with the wrong number of positional arguments; it takes an exact count.

**How to fix:** pass exactly the number of arguments the message names.

## AG6017 — Expected at least {min} argument(s) for '{fn}', but got {count}.

*Default severity: error.*

A function was called with too few positional arguments; it requires at least a minimum number.

**How to fix:** supply at least the number of arguments the message names.

## AG6018 — Expected {min}-{max} argument(s) for '{fn}', but got {count}.

*Default severity: error.*

A function accepts a range of argument counts (some parameters have defaults or are variadic), and this call fell outside that range.

**How to fix:** pass a number of arguments within the range the message names.

## AG6019 — Argument type '{actual}' is not assignable to parameter type '{expected}' in call to '{fn}'.

*Default severity: error.*

A positional argument's type does not match the parameter it fills. Each argument must be assignable to its parameter's type.

**How to fix:** pass a value of the expected type, or adjust the parameter's type if the call is correct.

## AG6020 — Splat argument must be an array, got '{actual}' in call to '{fn}'.

*Default severity: error.*

A splat argument (`...xs`) spreads an array's elements into positional arguments, so the splatted value must be an array. This value is not.

**How to fix:** splat an array, or convert the value into one first.

## AG6021 — Splat element type '{actual}' is not assignable to parameter type '{expected}' in call to '{fn}'.

*Default severity: error.*

The array being splatted has an element type that does not match the parameters the elements would fill.

**How to fix:** splat an array whose element type matches the target parameters.

## AG6022 — Type '{actual}' is not assignable to pipe slot of type '{expected}'.

*Default severity: error.*

A pipe feeds its left-hand value into a slot on the right, and that value's type does not match the slot's type.

**How to fix:** pipe a value of the slot's type, or transform it before the pipe.

## AG6023 — Splat argument cannot follow a named argument in call to '{fn}'.

*Default severity: error.*

A splat argument cannot come after a named argument in a call. The splat fills positional slots, and those are resolved before names.

**How to fix:** move the splat ahead of any named arguments.

## AG6024 — Positional argument cannot follow a named argument in call to '{fn}'.

*Default severity: error.*

Once a call uses a named argument, every following argument must also be named — a positional argument cannot come after a named one.

**How to fix:** move positional arguments before the named ones, or name them too.

## AG6025 — Unknown named argument '{name}' in call to '{fn}'.

*Default severity: error.*

A named argument in this call does not correspond to any parameter of the function.

**How to fix:** use a declared parameter name, or fix a typo.

## AG6026 — Named argument '{name}' conflicts with positional argument at position {position} in call to '{fn}'.

*Default severity: error.*

A parameter was filled both positionally and by name in the same call, so it is bound twice.

**How to fix:** supply the argument once — either positionally or by name, not both.

## AG6027 — Positional argument cannot feed variadic parameter '{param}' when it is also bound by name in call to '{fn}'.

*Default severity: error.*

A positional argument would feed a variadic parameter that is also being bound by name in the same call. The parameter cannot collect positionals and take a named value at once.

**How to fix:** bind the variadic parameter one way — either by name or with positional arguments.

## AG6028 — Tool '{tool}' has required function-typed parameter '{param}' is unbound. Bind it with .partial({param}: <value>) before passing as a tool.

*Default severity: error.*

A function passed as a tool has a required function-typed parameter that is still unbound. The LLM cannot supply a function value, so a required function parameter must be fixed before the function becomes a tool.

**How to fix:** bind it first with `.partial(...)` — e.g. `fn.partial(callback: myImpl)` — then pass the result as the tool.

## AG6029 — Tool '{tool}' has required function-typed parameter '{param}' is unbound ({type}). Bind it with .partial({param}: <value>) before passing as a tool.

*Default severity: error.*

This is the same problem as an unbound required function-typed tool parameter, with the parameter's function type shown. The LLM cannot provide a function value, so the parameter must be bound before the function is used as a tool.

**How to fix:** bind it with `.partial(...)` before passing the function as a tool.

## AG6030 — Tool '{tool}' will be exposed to the LLM without optional function-typed parameter(s): {params}. The function body must be prepared to run with the declared default for each.

*Default severity: warning.*

A function passed as a tool has optional function-typed parameters that the LLM cannot fill, so they are dropped and the tool runs with each parameter's declared default. This is a warning, not an error, because a default exists — but the body must be prepared to run without those functions.

**How to fix:** confirm the defaults are correct for the tool use, or bind the parameters explicitly with `.partial(...)` if you need specific implementations.
