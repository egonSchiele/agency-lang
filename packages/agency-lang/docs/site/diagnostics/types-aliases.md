---
name: "Types and aliases"
---

# Types and aliases

<a id="ag1001"></a>

## AG1001 — Type parameter '{param}' (no default) must come before parameters that have defaults in '{alias}'.

*Default severity: error.*

A type alias lists its type parameters left to right, and — like default function arguments — every parameter with a default must come after the parameters that have none. Otherwise a caller who omits a middle argument leaves a later, required one with no way to be positioned.

**How to fix:** reorder the type parameters so all defaulted ones are last.

<a id="ag1002"></a>

## AG1002 — Type '{alias}' is not a value-parameterized type but was given {count} value {argumentWord} (referenced in '{context}').

*Default severity: error.*

Some type aliases take *value* arguments in parentheses (like a validated length), and some take none. This fires when you passed value arguments to an alias that accepts none.

**How to fix:** drop the parenthesized arguments, or point at the alias you actually meant to parameterize.

<a id="ag1003"></a>

## AG1003 — {alias} expects at most {max} value {argumentWord}, got {count} (referenced in '{context}').

*Default severity: error.*

A value-parameterized alias accepts a fixed maximum number of value arguments, and you supplied more than it declares.

**How to fix:** remove the extra arguments, or check whether you meant a different alias with more parameters.

<a id="ag1004"></a>

## AG1004 — '{alias}' is a value-parameterized type and requires value arguments — write '{alias}({formals})' (referenced in '{context}').

*Default severity: error.*

This alias is value-parameterized: it needs its value arguments supplied in parentheses before it can be used as a type. Writing the bare name leaves those parameters unfilled.

**How to fix:** call it with its arguments, following the form the message shows for that alias.

<a id="ag1005"></a>

## AG1005 — {alias} requires at least {min} value {argumentWord} (referenced in '{context}').

*Default severity: error.*

A value-parameterized alias requires at least some minimum number of value arguments, and you supplied fewer.

**How to fix:** add the missing arguments; the message names how many the alias needs.

<a id="ag1006"></a>

## AG1006 — Type alias '{alias}' is not defined (referenced in '{context}').

*Default severity: error.*

A type name was used that has no `type` declaration in scope and is not a built-in type. The checker resolves every type name against the aliases visible in the file plus its imports.

**How to fix:** declare the alias, import it from the module that defines it, or fix a typo in the name.

<a id="ag1007"></a>

## AG1007 — Generic type '{alias}' requires type arguments (referenced in '{context}').

*Default severity: error.*

This is a generic type — it is parameterized by other types (like the element type of a list) — and it cannot be used bare. The type arguments are required.

**How to fix:** supply the type arguments in angle brackets, e.g. write the element type the generic wraps.

<a id="ag1008"></a>

## AG1008 — {alias} expects {expected} type {argumentWord}, got {count} (referenced in '{context}').

*Default severity: error.*

A built-in generic type (such as an array or Record) was given the wrong number of type arguments. Each built-in generic takes an exact count.

**How to fix:** supply exactly the number of type arguments the message names.

<a id="ag1009"></a>

## AG1009 — Unknown generic type '{alias}' (referenced in '{context}').

*Default severity: error.*

A generic type name was used with type arguments, but no generic type by that name is defined or imported.

**How to fix:** define or import the generic, or fix the name.

<a id="ag1010"></a>

## AG1010 — Type '{alias}' is not a generic type (referenced in '{context}').

*Default severity: error.*

Type arguments in angle brackets were applied to a name that is not a generic type, so it has no parameters to fill.

**How to fix:** remove the type arguments, or reference the generic type you meant.

<a id="ag1011"></a>

## AG1011 — {alias} expects at most {max} type {argumentWord}, got {count} (referenced in '{context}').

*Default severity: error.*

A generic type accepts a fixed maximum number of type arguments, and you supplied more than it declares.

**How to fix:** remove the extra type arguments.

<a id="ag1012"></a>

## AG1012 — {alias} requires at least {min} type {argumentWord} (referenced in '{context}').

*Default severity: error.*

A generic type requires at least some minimum number of type arguments, and you supplied fewer.

**How to fix:** add the missing type arguments; the message names how many are needed.
