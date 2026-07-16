---
name: "Calls, tools, and LLM usage"
---

# Calls, tools, and LLM usage

<a id="ag6001"></a>

## AG6001 — 'regex' cannot appear in an llm() structured-output type (&#123;context&#125;); LLMs can't return regex values through JSON.

*Default severity: error.*

An `llm()` call returns its result as structured JSON, and a `regex` value has no JSON representation the model can produce — so `regex` may not appear anywhere in an `llm()` output type.

**How to fix:** return the matched text as a `string` (or another JSON-friendly type) and build the regex yourself afterward.

<a id="ag6002"></a>

## AG6002 — Cannot interpolate parameter '&#123;param&#125;' in doc string — parameter values are not known when the tool description is sent to the LLM. Use a global variable instead.

*Default severity: error.*

A function's doc string becomes the tool description sent to the LLM, and that description is fixed before any call happens — so a parameter's runtime value is not available to interpolate into it.

**How to fix:** reference a global variable instead of a parameter, or reword the doc string to not depend on per-call values.

<a id="ag6003"></a>

## AG6003 — .partial() requires named arguments, e.g. fn.partial(a: 5).

*Default severity: error.*

`.partial()` binds arguments by name so it is unambiguous which parameters you are fixing. It does not accept positional arguments.

**How to fix:** name the arguments, e.g. `fn.partial(a: 5)`.

<a id="ag6004"></a>

## AG6004 — Unknown parameter '&#123;name&#125;' in .partial() call. '&#123;fn&#125;' has parameters: &#123;params&#125;.

*Default severity: error.*

A `.partial()` call named a parameter that the function does not have. Binding an unknown parameter has no meaning.

**How to fix:** bind one of the function's real parameters (the message lists them), or fix a typo.

<a id="ag6005"></a>

## AG6005 — Argument type '&#123;actual&#125;' is not assignable to parameter type '&#123;expected&#125;' in .partial() call to '&#123;fn&#125;'.

*Default severity: error.*

An argument passed to `.partial()` has a type that does not match the parameter it binds. A partially-applied argument must still satisfy the parameter's type.

**How to fix:** pass a value of the parameter's declared type.

<a id="ag6006"></a>

## AG6006 — Named arguments are not supported on built-in method '.&#123;method&#125;()'.

*Default severity: error.*

Built-in methods take their arguments positionally; named arguments are only supported on Agency-defined functions. This call used names on a built-in method.

**How to fix:** pass the arguments positionally.

<a id="ag6007"></a>

## AG6007 — Method '.&#123;method&#125;()' expects &#123;expected&#125; argument(s), got &#123;count&#125;.

*Default severity: error.*

A built-in method was called with the wrong number of arguments; this method takes an exact count.

**How to fix:** pass exactly the number of arguments the message names.

<a id="ag6008"></a>

## AG6008 — Method '.&#123;method&#125;()' expects at least &#123;min&#125; argument(s), got &#123;count&#125;.

*Default severity: error.*

A built-in method was called with too few arguments; it requires at least a minimum number.

**How to fix:** supply at least the number of arguments the message names.

<a id="ag6009"></a>

## AG6009 — Method '.&#123;method&#125;()' expects &#123;min&#125;–&#123;max&#125; argument(s), got &#123;count&#125;.

*Default severity: error.*

A built-in method accepts a range of argument counts, and this call fell outside it.

**How to fix:** pass a number of arguments within the range the message names.

<a id="ag6010"></a>

## AG6010 — Argument type '&#123;actual&#125;' is not assignable to parameter type '&#123;expected&#125;' in call to '.&#123;method&#125;()'.

*Default severity: error.*

An argument to a built-in method has a type that does not match the parameter it fills.

**How to fix:** pass a value of the expected type.

<a id="ag6011"></a>

## AG6011 — Named arguments can only be used with Agency-defined functions, not '&#123;fn&#125;'.

*Default severity: error.*

Named arguments work only with functions defined in Agency. The target here is not one of those (for example a built-in or an imported host function), so its arguments must be positional.

**How to fix:** pass the arguments positionally.

<a id="ag6012"></a>

## AG6012 — '&#123;fn&#125;' does not accept the named argument '&#123;name&#125;'. Allowed: &#123;allowed&#125;.

*Default severity: error.*

A named argument was supplied that the function does not declare. The checker knows the function's parameter names and rejects names outside that set.

**How to fix:** use one of the function's declared parameter names (the message lists the allowed ones), or fix a typo.

<a id="ag6013"></a>

## AG6013 — Duplicate named argument '&#123;name&#125;' in call to '&#123;fn&#125;'.

*Default severity: error.*

The same named argument was supplied twice in one call. Each parameter can be bound at most once.

**How to fix:** remove the duplicate.

<a id="ag6014"></a>

## AG6014 — Named argument '&#123;name&#125;' on '&#123;fn&#125;' expects type '&#123;expected&#125;', got '&#123;actual&#125;'.

*Default severity: error.*

A named argument's value has a type that does not match the parameter's declared type.

**How to fix:** pass a value of the expected type for that parameter.

<a id="ag6015"></a>

## AG6015 — '&#123;fn&#125;' does not accept a block argument.

*Default severity: error.*

A block argument (a trailing `{ ... }`) was passed to a function that does not declare a block parameter.

**How to fix:** remove the block, or call a function that takes one.

<a id="ag6016"></a>

## AG6016 — Expected &#123;expected&#125; argument(s) for '&#123;fn&#125;', but got &#123;count&#125;.

*Default severity: error.*

A function was called with the wrong number of positional arguments; it takes an exact count.

**How to fix:** pass exactly the number of arguments the message names.

<a id="ag6017"></a>

## AG6017 — Expected at least &#123;min&#125; argument(s) for '&#123;fn&#125;', but got &#123;count&#125;.

*Default severity: error.*

A function was called with too few positional arguments; it requires at least a minimum number.

**How to fix:** supply at least the number of arguments the message names.

<a id="ag6018"></a>

## AG6018 — Expected &#123;min&#125;-&#123;max&#125; argument(s) for '&#123;fn&#125;', but got &#123;count&#125;.

*Default severity: error.*

A function accepts a range of argument counts (some parameters have defaults or are variadic), and this call fell outside that range.

**How to fix:** pass a number of arguments within the range the message names.

<a id="ag6019"></a>

## AG6019 — Argument type '&#123;actual&#125;' is not assignable to parameter type '&#123;expected&#125;' in call to '&#123;fn&#125;'.

*Default severity: error.*

A positional argument's type does not match the parameter it fills. Each argument must be assignable to its parameter's type.

**How to fix:** pass a value of the expected type, or adjust the parameter's type if the call is correct.

<a id="ag6020"></a>

## AG6020 — Splat argument must be an array, got '&#123;actual&#125;' in call to '&#123;fn&#125;'.

*Default severity: error.*

A splat argument (`...xs`) spreads an array's elements into positional arguments, so the splatted value must be an array. This value is not.

**How to fix:** splat an array, or convert the value into one first.

<a id="ag6021"></a>

## AG6021 — Splat element type '&#123;actual&#125;' is not assignable to parameter type '&#123;expected&#125;' in call to '&#123;fn&#125;'.

*Default severity: error.*

The array being splatted has an element type that does not match the parameters the elements would fill.

**How to fix:** splat an array whose element type matches the target parameters.

<a id="ag6022"></a>

## AG6022 — Type '&#123;actual&#125;' is not assignable to pipe slot of type '&#123;expected&#125;'.

*Default severity: error.*

A pipe feeds its left-hand value into a slot on the right, and that value's type does not match the slot's type.

**How to fix:** pipe a value of the slot's type, or transform it before the pipe.

<a id="ag6023"></a>

## AG6023 — Splat argument cannot follow a named argument in call to '&#123;fn&#125;'.

*Default severity: error.*

A splat argument cannot come after a named argument in a call. The splat fills positional slots, and those are resolved before names.

**How to fix:** move the splat ahead of any named arguments.

<a id="ag6024"></a>

## AG6024 — Positional argument cannot follow a named argument in call to '&#123;fn&#125;'.

*Default severity: error.*

Once a call uses a named argument, every following argument must also be named — a positional argument cannot come after a named one.

**How to fix:** move positional arguments before the named ones, or name them too.

<a id="ag6025"></a>

## AG6025 — Unknown named argument '&#123;name&#125;' in call to '&#123;fn&#125;'.

*Default severity: error.*

A named argument in this call does not correspond to any parameter of the function.

**How to fix:** use a declared parameter name, or fix a typo.

<a id="ag6026"></a>

## AG6026 — Named argument '&#123;name&#125;' conflicts with positional argument at position &#123;position&#125; in call to '&#123;fn&#125;'.

*Default severity: error.*

A parameter was filled both positionally and by name in the same call, so it is bound twice.

**How to fix:** supply the argument once — either positionally or by name, not both.

<a id="ag6027"></a>

## AG6027 — Positional argument cannot feed variadic parameter '&#123;param&#125;' when it is also bound by name in call to '&#123;fn&#125;'.

*Default severity: error.*

A positional argument would feed a variadic parameter that is also being bound by name in the same call. The parameter cannot collect positionals and take a named value at once.

**How to fix:** bind the variadic parameter one way — either by name or with positional arguments.

<a id="ag6028"></a>

## AG6028 — Tool '&#123;tool&#125;' has required function-typed parameter '&#123;param&#125;' is unbound. Bind it with .partial(&#123;param&#125;: &lt;value&gt;) before passing as a tool.

*Default severity: error.*

A function passed as a tool has a required function-typed parameter that is still unbound. The LLM cannot supply a function value, so a required function parameter must be fixed before the function becomes a tool.

**How to fix:** bind it first with `.partial(...)` — e.g. `fn.partial(callback: myImpl)` — then pass the result as the tool.

<a id="ag6029"></a>

## AG6029 — Tool '&#123;tool&#125;' has required function-typed parameter '&#123;param&#125;' is unbound (&#123;type&#125;). Bind it with .partial(&#123;param&#125;: &lt;value&gt;) before passing as a tool.

*Default severity: error.*

This is the same problem as an unbound required function-typed tool parameter, with the parameter's function type shown. The LLM cannot provide a function value, so the parameter must be bound before the function is used as a tool.

**How to fix:** bind it with `.partial(...)` before passing the function as a tool.

<a id="ag6030"></a>

## AG6030 — Tool '&#123;tool&#125;' will be exposed to the LLM without optional function-typed parameter(s): &#123;params&#125;. The function body must be prepared to run with the declared default for each.

*Default severity: warning.*

A function passed as a tool has optional function-typed parameters that the LLM cannot fill, so they are dropped and the tool runs with each parameter's declared default. This is a warning, not an error, because a default exists — but the body must be prepared to run without those functions.

**How to fix:** confirm the defaults are correct for the tool use, or bind the parameters explicitly with `.partial(...)` if you need specific implementations.

<a id="ag6031"></a>

## AG6031 — saveDraft() cannot be called at module top level — there is no enclosing function, node, or block scope to save a draft for.

*Default severity: error.*

`saveDraft(v)` records a best-so-far value for the scope that calls it, so an enclosing `guard(...)` can return that value if it trips. At module top level there is no enclosing scope: nothing could ever read the draft, and the runtime rejects the call for the same reason.

**How to fix:** move the `saveDraft` call inside the function, node, or `guard` block whose result it is a draft of.

<a id="ag6032"></a>

## AG6032 — A scope can declare at most one finalize block. Merge the branches into the first one.

*Default severity: error.*

Only one finalize block per scope: when the scope is stopped, exactly one computation produces its partial result. Two blocks would need merge rules.

**How to fix:** combine the logic into a single finalize; branch inside it if needed.

<a id="ag6033"></a>

## AG6033 — A finalize block must sit at the top level of its function or block body, not inside `&#123;construct&#125;`. A finalize is a declaration — it is always active, so nesting it in control flow has no meaning.

*Default severity: error.*

A finalize is a declaration, not a statement: if the scope has one, it is always active. Nesting it inside an `if`, a loop, or a match arm would make it conditionally armed, which needs "was it armed?" bookkeeping the language deliberately avoids.

**How to fix:** move the finalize to the top level of the function or block body (convention: last), and branch INSIDE the finalize instead.

<a id="ag6034"></a>

## AG6034 — saveDraft() has no effect inside a finalize block: the finalize's return IS the scope's partial result. Return the value instead.

*Default severity: error.*

Inside a finalize, the scope's partial result is being computed right now — the finalize's return value is that result. Saving a draft there is meaningless.

**How to fix:** `return` the value from the finalize instead of calling `saveDraft`.

<a id="ag6035"></a>

## AG6035 — A finalize block in a node has no effect: nothing above a node consumes a partial result yet. Put the finalize in a function or guard block instead.

*Default severity: error.*

Salvaged partial results are consumed by an enclosing `guard`, and guards cannot span nodes — above a node there is only the graph engine, which does not consume partials (root budgets may, later). A finalize declared directly in a node body would compute a value nobody reads.

**How to fix:** put the finalize inside the function or `guard` block doing the guarded work.

<a id="ag6036"></a>

## AG6036 — In a scope with a finalize block, a return expression that contains a call must BE a single direct call. Assign the call to a local first, then return the local — otherwise an aborted call's partial would be consumed inside the expression before the finalize can run.

*Default severity: error.*

When a call inside a return expression is aborted, its aborted result is consumed by the surrounding expression (concatenated, wrapped in an array, ...) before any check can run — so the finalize would be silently skipped and garbage returned. A direct `return f(x)` is safe: the compiler intercepts it. Anything more complex is not interceptable without breaking evaluation order.

**How to fix:** assign the call to a local first, then return the local:

```agency
def f(): string {
  const part = verify()
  return "combined: " + part

  finalize {
    return "partial: " + part
  }
}
```
