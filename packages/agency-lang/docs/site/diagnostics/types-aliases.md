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
