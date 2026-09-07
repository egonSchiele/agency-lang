---
name: "Assignability and checking"
---

# Assignability and checking

<a id="ag2001"></a>

## AG2001 — Type '&#123;actual&#125;' is not assignable to type '&#123;expected&#125;' (&#123;context&#125;).

*Default severity: error.*

Agency assigns each value a type and checks that it fits where you use it. This is the assignability error with the surrounding context named (a return, an argument, a field) — the value's type does not fit that slot.

**How to fix:** change one side so they line up — convert the value, widen the declared type, or fix the expression that produced the wrong type. If the value can legitimately be several types, declare the slot as a union.

<a id="ag2002"></a>

## AG2002 — Type '&#123;actual&#125;' is not assignable to type 'boolean' (condition).

*Default severity: error.*

The condition of an `if` or `while` must be a boolean. Agency does not treat non-boolean values as truthy or falsy, so a number or string here is an error rather than a silent coercion.

**How to fix:** compare explicitly — e.g. `count > 0` instead of `count`, or `name != ""` instead of `name`.

<a id="ag2003"></a>

## AG2003 — Unknown property '&#123;key&#125;' on type '&#123;expected&#125;' (&#123;context&#125;).

*Default severity: error.*

An object literal (or similar structured value) included a key that the target type does not declare. The checker knows the exact shape the context expects and rejects keys outside it.

**How to fix:** remove the stray key, fix a typo in the key name, or add the field to the target type if it belongs there.

<a id="ag2004"></a>

## AG2004 — Variable '&#123;name&#125;' has no type annotation (strict mode).

*Default severity: error.*

In strict mode every variable needs a type annotation; this one has none and its type could not be inferred with certainty. Strict mode trades a little verbosity for catching type mistakes early.

**How to fix:** add an annotation, e.g. `let total: number = …`, or turn strict mode off if you do not want this requirement.

<a id="ag2005"></a>

## AG2005 — Type '&#123;actual&#125;' is not assignable to type '&#123;expected&#125;'.

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

<a id="ag2006"></a>

## AG2006 — For-loop iterable must be an array or Record, got '&#123;actual&#125;'.

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

<a id="ag2007"></a>

## AG2007 — &#123;kind&#125; '&#123;name&#125;' has validated parameters but its return type is not a Result type. Validated parameters can short-circuit with a failure, so the return type must be 'Result&lt;...&gt;'.

*Default severity: error.*

A parameter marked with `!` validation can short-circuit the call with a failure when the data does not pass. A function that can fail must advertise it in its return type, so its return type must be a `Result`.

**How to fix:** change the return type to `Result<...>`, or remove the `!` validation from the parameters if the call cannot fail.

<a id="ag2008"></a>

## AG2008 — Property '&#123;field&#125;' is not available on every member of '&#123;union&#125;'; narrow the value (e.g. with a guard) before accessing it.

*Default severity: error.*

The value has a union type, and the field you accessed exists on some members of the union but not all. Reading it directly would be unsafe on the members that lack it.

**How to fix:** narrow the value first — for example with a guard that establishes which member you have — then access the field inside that narrowed branch.

<a id="ag2009"></a>

## AG2009 — '.&#123;field&#125;' is only available on a &#123;branch&#125; Result; guard with 'if (isSuccess(r))' / 'if (isFailure(r))', use 'r catch …', or 'match (r) &#123; … &#125;'.

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

<a id="ag2010"></a>

## AG2010 — Cannot &#123;op&#125; values of different dimensions (&#123;leftDim&#125; and &#123;rightDim&#125;): '&#123;left&#125;' and '&#123;right&#125;'.

*Default severity: error.*

Agency tracks physical dimensions (like duration versus size) on some values and refuses arithmetic that mixes incompatible ones, the way you cannot add seconds to bytes. This caught an operation on two different dimensions.

**How to fix:** operate on values of the same dimension, or convert one so both agree before combining them.

<a id="ag2011"></a>

## AG2011 — Property '&#123;property&#125;' does not exist on type '&#123;type&#125;'.

*Default severity: error.*

The property you accessed is not declared on the value's type. The checker knows the type's shape and only allows the fields it declares.

**How to fix:** fix a typo in the property name, access a field the type actually has, or add the field to the type if it belongs there.

<a id="ag2012"></a>

## AG2012 — Not all code paths return a value in '&#123;fn&#125;'.

*Default severity: error.*

The function declares a return type, so every path through its body must produce a value — but at least one path (often a missing `else`, or a fall-through past a loop) reaches the end without returning.

**How to fix:** add a `return` on the path that is missing one, or a final `return` that covers the fall-through.

<a id="ag2013"></a>

## AG2013 — The first argument to failure() is the message shown to a person or a model, so it must be a string. Got '&#123;actual&#125;'.

*Default severity: error.*

Every failure carries a string message, because anything that shows a failure to a person or to a model prints that message. The first argument to `failure()` is that message.

**How to fix:** pass a sentence, and put any structured detail in the second argument.

```agency
def parseConfig(path: string): Result {
  return failure("Bad syntax in the config file", { line: 4 })
}
```

<a id="ag2014"></a>

## AG2014 — The second argument to failure() is its structured data, so it must be an object. Got '&#123;actual&#125;'.

*Default severity: error.*

A failure's second argument is its structured data, which callers read as `.data.someField`. That only makes sense for an object.

**How to fix:** wrap the value in an object, or fold it into the message.

```agency
def parseConfig(path: string): Result {
  return failure("Bad syntax in the config file", { line: 4 })
}
```

<a id="ag2015"></a>

## AG2015 — This function declares '&#123;expected&#125;' as its failure data, so failure() needs a second argument. To allow a failure with no data, declare the return type as 'Result&lt;&#123;success&#125;, &#123;expected&#125; | null&gt;'.

*Default severity: error.*

The function's return type names a data type, so every failure it returns has to supply that data. Otherwise the type says the data is there when it is not, and a caller reading a field off it gets null with nothing to explain why.

**How to fix:** pass the data as a second argument, or add `| null` to the data type to allow a failure without it.

```agency
type ParseFailure = { line: number }

def loadConfig(path: string): Result<string, ParseFailure | null> {
  if (path == "") {
    return failure("No config file was named")
  }
  return failure("Bad syntax in the config file", { line: 4 })
}
```

<a id="ag2016"></a>

## AG2016 — A Result's second type parameter is its failure data, and failure data must be an object. Got '&#123;actual&#125;' (&#123;context&#125;). A failure's message is always a string and is not named in the type.

*Default severity: error.*

A `Result`'s second type parameter is the failure's structured data, which callers read as `.data.someField`. That only makes sense for an object. The failure's message is always a string and is never named in the type, so `Result<T, string>` says "fails with string data", which no `failure()` call can produce.

**How to fix:** drop the second parameter if the failure carries no data, or name an object type.

```agency
def half(x: number): Result<number> {
  if (x % 2 != 0) {
    return failure("Number must be even to be halved")
  }
  return success(x / 2)
}
```
