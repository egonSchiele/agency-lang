---
name: "Types and aliases"
---

# Types and aliases

<a id="ag1001"></a>

## AG1001 — Type parameter '&#123;param&#125;' (no default) must come before parameters that have defaults in '&#123;alias&#125;'.

*Default severity: error.*

A type alias lists its type parameters left to right, and — like default function arguments — every parameter with a default must come after the parameters that have none. Otherwise a caller who omits a middle argument leaves a later, required one with no way to be positioned.

**How to fix:** reorder the type parameters so all defaulted ones are last.

<a id="ag1002"></a>

## AG1002 — Type '&#123;alias&#125;' is not a value-parameterized type but was given &#123;count&#125; value &#123;argumentWord&#125; (referenced in '&#123;context&#125;').

*Default severity: error.*

Some type aliases take *value* arguments in parentheses (like a validated length), and some take none. This fires when you passed value arguments to an alias that accepts none.

**How to fix:** drop the parenthesized arguments, or point at the alias you actually meant to parameterize.

<a id="ag1003"></a>

## AG1003 — &#123;alias&#125; expects at most &#123;max&#125; value &#123;argumentWord&#125;, got &#123;count&#125; (referenced in '&#123;context&#125;').

*Default severity: error.*

A value-parameterized alias accepts a fixed maximum number of value arguments, and you supplied more than it declares.

**How to fix:** remove the extra arguments, or check whether you meant a different alias with more parameters.

<a id="ag1004"></a>

## AG1004 — '&#123;alias&#125;' is a value-parameterized type and requires value arguments — write '&#123;alias&#125;(&#123;formals&#125;)' (referenced in '&#123;context&#125;').

*Default severity: error.*

This alias is value-parameterized: it needs its value arguments supplied in parentheses before it can be used as a type. Writing the bare name leaves those parameters unfilled.

**How to fix:** call it with its arguments, following the form the message shows for that alias.

<a id="ag1005"></a>

## AG1005 — &#123;alias&#125; requires at least &#123;min&#125; value &#123;argumentWord&#125; (referenced in '&#123;context&#125;').

*Default severity: error.*

A value-parameterized alias requires at least some minimum number of value arguments, and you supplied fewer.

**How to fix:** add the missing arguments; the message names how many the alias needs.

<a id="ag1006"></a>

## AG1006 — Type alias '&#123;alias&#125;' is not defined (referenced in '&#123;context&#125;').

*Default severity: error.*

A type name was used that has no `type` declaration in scope and is not a built-in type. The checker resolves every type name against the aliases visible in the file plus its imports.

**How to fix:** declare the alias, import it from the module that defines it, or fix a typo in the name.

<a id="ag1007"></a>

## AG1007 — Generic type '&#123;alias&#125;' requires type arguments (referenced in '&#123;context&#125;').

*Default severity: error.*

This is a generic type — it is parameterized by other types (like the element type of a list) — and it cannot be used bare. The type arguments are required.

**How to fix:** supply the type arguments in angle brackets, e.g. write the element type the generic wraps.

<a id="ag1008"></a>

## AG1008 — &#123;alias&#125; expects &#123;expected&#125; type &#123;argumentWord&#125;, got &#123;count&#125; (referenced in '&#123;context&#125;').

*Default severity: error.*

A built-in generic type (such as an array or Record) was given the wrong number of type arguments. Each built-in generic takes an exact count.

**How to fix:** supply exactly the number of type arguments the message names.

<a id="ag1009"></a>

## AG1009 — Unknown generic type '&#123;alias&#125;' (referenced in '&#123;context&#125;').

*Default severity: error.*

A generic type name was used with type arguments, but no generic type by that name is defined or imported.

**How to fix:** define or import the generic, or fix the name.

<a id="ag1010"></a>

## AG1010 — Type '&#123;alias&#125;' is not a generic type (referenced in '&#123;context&#125;').

*Default severity: error.*

Type arguments in angle brackets were applied to a name that is not a generic type, so it has no parameters to fill.

**How to fix:** remove the type arguments, or reference the generic type you meant.

<a id="ag1011"></a>

## AG1011 — &#123;alias&#125; expects at most &#123;max&#125; type &#123;argumentWord&#125;, got &#123;count&#125; (referenced in '&#123;context&#125;').

*Default severity: error.*

A generic type accepts a fixed maximum number of type arguments, and you supplied more than it declares.

**How to fix:** remove the extra type arguments.

<a id="ag1012"></a>

## AG1012 — &#123;alias&#125; requires at least &#123;min&#125; type &#123;argumentWord&#125; (referenced in '&#123;context&#125;').

*Default severity: error.*

A generic type requires at least some minimum number of type arguments, and you supplied fewer.

**How to fix:** add the missing type arguments; the message names how many are needed.

<a id="ag1013"></a>

## AG1013 — `&#123;name&#125;` is not a type; &#123;hint&#125;

*Default severity: error.*

A type pattern (`x is T`, or a match arm `p: T`) named something that is not a type. After `is`, a bare identifier is always read as a type reference — the old always-true binder form was retired — so a variable name or a JavaScript class name (like `Date`) in that position is an error rather than a silent match-anything.

**How to fix:** if you meant a type, declare or import it. If you meant to bind the value, write `const name = x` instead. For JavaScript classes, use `is object` or a helper function — type patterns only test Agency types.

<a id="ag1014"></a>

## AG1014 — Cannot cast `&#123;from&#125;` to `&#123;to&#125;` because neither type fits the other. If this is intentional, write `&#123;expr&#125; as unknown as &#123;to&#125;`.

*Default severity: error.*

A cast `x as T` is allowed when the type of `x` fits `T`, or `T` fits the type of `x`. A cast between two unrelated types, like `5 as string`, is almost always a mistake, so it is refused. A cast changes only what the type checker believes. It does not convert the value.

**How to fix:** if you mean it, go through `unknown`: `x as unknown as T`.

<a id="ag1015"></a>

## AG1015 — A checked cast validates the value at runtime, and `&#123;type&#125;` has no schema to validate against. Remove the `!` to cast without checking.

*Default severity: error.*

`x as T!` checks the value against the schema of `T` at runtime and gives a `Result`. Function types have no schema, so they cannot be checked.

**How to fix:** use the unchecked form, `x as T`.

<a id="ag1016"></a>

## AG1016 — A cast is not allowed in this position. Add parentheses: `(&#123;left&#125; &#123;op&#125; &#123;right&#125;) as &#123;type&#125;` or `&#123;left&#125; &#123;op&#125; (&#123;right&#125; as &#123;type&#125;)`.

*Default severity: error.*

In TypeScript, `as` binds looser than arithmetic and comparison: `a + b as T` means `(a + b) as T`. In Agency today a cast binds tighter, so the same text would mean `a + (b as T)`. To keep the two from silently disagreeing, Agency refuses a cast on the right of `**`, `*`, `/`, `%`, `+`, `-`, `<`, `>`, `<=`, `>=`, `in`, and `instanceof`.

**How to fix:** add parentheses to say which grouping you mean. Issue #1088 tracks removing this rule.

<a id="ag1017"></a>

## AG1017 — This checked cast runs validators that can pause the program, and it cannot be resumed safely in this position. Move it to its own line: `const value = &#123;cast&#125;`.

*Default severity: error.*

A checked cast to a type with `@validate` tags runs validator functions, and a validator can raise an interrupt that pauses the program. When a paused program resumes, the statement it paused in runs again, so Agency lifts anything that can pause onto its own line first. It cannot lift out of the right side of `&&`, `||` or `??`, a `catch` or `try` expression, an if-expression branch, a pipe stage, or a statement under `with` or `static`. A checked cast to a type with no `@validate` tags cannot pause and is allowed in these positions.

**How to fix:** write the cast on its own line and use the variable.

<a id="ag1018"></a>

## AG1018 — `&#123;expr&#125;` is a `&#123;from&#125;`. A cast does not unwrap it. Unwrap the Result first, with `match` or `catch`, then cast the value if you still need to.

*Default severity: error.*

A cast changes only what the type checker believes. It does not change the value, so casting a `Result<Person>` to `Person` would leave a `Result` in a variable typed as `Person`. Writing `as unknown as Person` would compile and be wrong at runtime.

**How to fix:** unwrap the Result first: `match` on it, or use `catch` to supply a fallback.

<a id="ag1019"></a>

## AG1019 — `&#123;cast&#125;` runs validators that can pause the program, and a module-level initializer or a parameter default cannot pause. Do the cast inside a node or a def.

*Default severity: error.*

A checked cast to a type with `@validate` tags runs validator functions, and a validator can raise an interrupt that pauses the program. Code at the top level of a file, and a parameter's default value, run where the program cannot pause and resume. There is no line to move the cast to. A checked cast to a type with no `@validate` tags is allowed here.

**How to fix:** do the cast inside a node or a def, and pass the result in.

<a id="ag1020"></a>

## AG1020 — `&#123;cast&#125;` runs validators that can pause the program, and a handler body cannot pause. Do the cast before the `handle` block and use the value here.

*Default severity: error.*

A checked cast to a type with `@validate` tags runs validator functions, and a validator can raise an interrupt that pauses the program. A handler body compiles to plain JavaScript with no steps, so it cannot pause, and the hoist pass never rewrites one. Moving the cast to its own line inside the handler does not help. Handlers are how a user rejects an action, so a cast that would pause there is refused rather than compiled. A checked cast to a type with no `@validate` tags is allowed here.

**How to fix:** do the cast before the `handle` block and use the value inside the handler.

<a id="ag1021"></a>

## AG1021 — `&#123;expr&#125;?` cannot be lowered in this position. Move it to its own line: `const value = &#123;expr&#125;?`.

*Default severity: error.*

The `?` operator becomes an early return, so the compiler moves the expression before it onto its own line as a step. It cannot do that from the right side of `&&`, `||` or `??`, from either side of `catch`, from a pipe stage, or from a `try` operand, because code there may not run at all.

**How to fix:** write the unwrap on its own line and use the variable.

<a id="ag1022"></a>

## AG1022 — `&#123;expr&#125;?` returns from a function, and a module-level initializer or a parameter default is not inside one. Use it inside a node or a def.

*Default severity: error.*

The `?` operator returns from the enclosing function. A module-level initializer and a parameter default run outside any function body, so there is nothing to return from.

**How to fix:** move the unwrap into a node or a def.

<a id="ag1023"></a>

## AG1023 — `&#123;expr&#125;?` cannot be used inside a handler body. Unwrap the Result before the `handle` block, or match on it here.

*Default severity: error.*

A handler body (`with (intr) { ... }`) compiles to plain code with no steps, and the `?` operator needs a step to return from.

**How to fix:** unwrap the Result before the `handle` block, or `match` on it inside the handler.

<a id="ag1024"></a>

## AG1024 — `&#123;expr&#125;?` would return from a `parallel` arm, and an arm cannot return early. Do the unwrap inside a def the arm calls.

*Default severity: error.*

Each arm of a `parallel` block hands its bindings back when it finishes, and the compiler reads them after the block. An arm cannot return early, so a `?` at its top level has nowhere to return to. Inside a block argument within the arm, `?` is fine, because it returns from that block.

**How to fix:** move the work into a def and call it from the arm, or keep the Result in the arm and match on it after the block.

<a id="ag1025"></a>

## AG1025 — `&#123;expr&#125;?` cannot be a write target. Unwrap into a variable first, then assign to its field.

*Default severity: error.*

The `?` operator unwraps a value you read. A write target such as `obj?.field = 1` would have to unwrap and then write back into a Result, which has no meaning.

**How to fix:** unwrap into a variable first, then assign to the variable's field.

<a id="ag1026"></a>

## AG1026 — Type alias '&#123;alias&#125;' is declared in '&#123;module&#125;' but not imported here (referenced in '&#123;context&#125;'). Import it by name, or write the type out.

*Default severity: error.*

A type name was used that the checker knows only through an import's signature: a function you imported takes or returns it, so the checker read its shape to type that call. The name itself was never imported, so the generated code has no binding for it, and a validation or schema built from the type fails at run time with `<Name> is not defined`.

**How to fix:** add the alias to the import line of the module named in the message, or write the type's shape out where it is used.
