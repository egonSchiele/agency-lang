---
name: "Assignability and checking"
---

# Assignability and checking

## AG2001 — Type '{actual}' is not assignable to type '{expected}' ({context}).

*Default severity: error.*

Agency assigns each value a type and checks that it fits where you use it. This is the assignability error with the surrounding context named (a return, an argument, a field) — the value's type does not fit that slot.

**How to fix:** change one side so they line up — convert the value, widen the declared type, or fix the expression that produced the wrong type. If the value can legitimately be several types, declare the slot as a union.

## AG2002 — Type '{actual}' is not assignable to type 'boolean' (condition).

*Default severity: error.*

The condition of an `if` or `while` must be a boolean. Agency does not treat non-boolean values as truthy or falsy, so a number or string here is an error rather than a silent coercion.

**How to fix:** compare explicitly — e.g. `count > 0` instead of `count`, or `name != ""` instead of `name`.

## AG2003 — Unknown property '{key}' on type '{expected}' ({context}).

*Default severity: error.*

An object literal (or similar structured value) included a key that the target type does not declare. The checker knows the exact shape the context expects and rejects keys outside it.

**How to fix:** remove the stray key, fix a typo in the key name, or add the field to the target type if it belongs there.

## AG2004 — Variable '{name}' has no type annotation (strict mode).

*Default severity: error.*

In strict mode every variable needs a type annotation; this one has none and its type could not be inferred with certainty. Strict mode trades a little verbosity for catching type mistakes early.

**How to fix:** add an annotation, e.g. `let total: number = …`, or turn strict mode off if you do not want this requirement.

## AG2005 — Type '{actual}' is not assignable to type '{expected}'.

*Default severity: error.*

Agency assigns each value a type and checks that the value you store, return, or pass matches the type the destination expects. This error fires when they disagree — for example putting a `string` where a `number` is required.

**How to fix:** change one side so they line up — convert the value, widen the declared type, or fix the expression that produced the wrong type. If the value can legitimately be one of several types, declare the destination as a union.

```agency
def half(n: number): number {
  return n / 2
}

node main() {
  const count: number = 3
  half(count)
}
```

## AG2006 — For-loop iterable must be an array or Record, got '{actual}'.

*Default severity: error.*

A `for (x in xs)` loop iterates an array or a Record; the value after `in` here is neither. The checker needs a container it knows how to walk.

**How to fix:** iterate an array or Record, or convert the value into one before the loop.

```agency
node main() {
  const names = ["ada", "grace"]
  for (name in names) {
    print(name)
  }
}
```

## AG2007 — {kind} '{name}' has validated parameters but its return type is not a Result type. Validated parameters can short-circuit with a failure, so the return type must be 'Result<...>'.

*Default severity: error.*

A parameter marked with `!` validation can short-circuit the call with a failure when the data does not pass. A function that can fail must advertise it in its return type, so its return type must be a `Result`.

**How to fix:** change the return type to `Result<...>`, or remove the `!` validation from the parameters if the call cannot fail.

## AG2008 — Property '{field}' is not available on every member of '{union}'; narrow the value (e.g. with a guard) before accessing it.

*Default severity: error.*

The value has a union type, and the field you accessed exists on some members of the union but not all. Reading it directly would be unsafe on the members that lack it.

**How to fix:** narrow the value first — for example with a guard that establishes which member you have — then access the field inside that narrowed branch.

## AG2009 — '.{field}' is only available on a {branch} Result; guard with 'if (isSuccess(r))' / 'if (isFailure(r))', use 'r catch …', or 'match (r) {{ … }}'.

*Default severity: error.*

A `Result` is either a success or a failure, and the field you accessed only exists on one of those branches. Reading it without first checking which branch you have would be unsafe.

**How to fix:** guard with `if (isSuccess(r))` or `if (isFailure(r))`, use `r catch …`, or handle both arms with `match`.

```agency
node main() {
  const r = compute()
  if (isSuccess(r)) {
    print(r.value)
  }
}
```

## AG2010 — Cannot {op} values of different dimensions ({leftDim} and {rightDim}): '{left}' and '{right}'.

*Default severity: error.*

Agency tracks physical dimensions (like duration versus size) on some values and refuses arithmetic that mixes incompatible ones, the way you cannot add seconds to bytes. This caught an operation on two different dimensions.

**How to fix:** operate on values of the same dimension, or convert one so both agree before combining them.

## AG2011 — Property '{property}' does not exist on type '{type}'.

*Default severity: error.*

The property you accessed is not declared on the value's type. The checker knows the type's shape and only allows the fields it declares.

**How to fix:** fix a typo in the property name, access a field the type actually has, or add the field to the type if it belongs there.

## AG2012 — Not all code paths return a value in '{fn}'.

*Default severity: error.*

The function declares a return type, so every path through its body must produce a value — but at least one path (often a missing `else`, or a fall-through past a loop) reaches the end without returning.

**How to fix:** add a `return` on the path that is missing one, or a final `return` that covers the fall-through.
