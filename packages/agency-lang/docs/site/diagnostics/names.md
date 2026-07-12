---
name: "Names, scope, and reserved words"
---

# Names, scope, and reserved words

<a id="ag4001"></a>

## AG4001 — '{name}' shadows an imported function.

*Default severity: warning.*

A local name here has the same name as a function you imported, so the local shadows the import within this scope. That is legal but often unintended, so it is flagged as a warning.

**How to fix:** rename the local if you meant to keep using the import, or ignore the warning if the shadow is deliberate.

<a id="ag4002"></a>

## AG4002 — '{name}' is a reserved built-in; cannot be redefined.

*Default severity: error.*

The name is a reserved built-in and cannot be redefined. Built-ins are part of the language surface; redefining one would make its ordinary uses ambiguous.

**How to fix:** choose a different name for your definition.

<a id="ag4003"></a>

## AG4003 — '{name}' is a reserved built-in type; cannot be redefined.

*Default severity: error.*

The name is a reserved built-in type and cannot be redefined for the same reason built-in functions cannot: its ordinary uses must stay unambiguous.

**How to fix:** pick a different type name.

<a id="ag4004"></a>

## AG4004 — Function '{name}' is not defined.

*Default severity: error.*

A function was called that has no definition in scope and is not a built-in. The checker resolves every call against the functions visible in the file plus its imports.

**How to fix:** define the function, import it from the module that provides it, or fix a typo in the call.

<a id="ag4005"></a>

## AG4005 — Cannot reassign to constant '{name}'.

*Default severity: error.*

A `const` binding is fixed after its initial value: it cannot be reassigned. This assignment targets a name that was declared `const`.

**How to fix:** declare it with `let` if it needs to change, or assign to a different variable.

```agency
node main() {
  let count = 0
  const limit = 10
  count = count + 1
}
```

<a id="ag4006"></a>

## AG4006 — `{keyword}` is a reserved block keyword. Write `{keyword} {{ ... }}` or `{keyword}(args) {{ ... }}` directly — the `as` keyword is not supported on {keyword} blocks (there's nothing to bind).

*Default severity: error.*

This keyword introduces a block directly — you write it followed by braces (or parentheses then braces) — and it does not support an `as` binding, because there is nothing to bind. The `as` here is not valid on this block form.

**How to fix:** write the block without `as`, e.g. the keyword followed immediately by its `{ ... }` body.

<a id="ag4007"></a>

## AG4007 — Variable '{name}' is not defined.

*Default severity: error.*

The type checker walks every scope — nodes, function bodies, blocks — and resolves each name to a declaration. This error means a name was used with no `let`, `const`, parameter, or import that introduces it in reach.

**How to fix:** declare it before use (`let x = …` / `const x = …`), fix a typo in the name, or import it if it lives in another module. Agency has no implicit variables: a bare assignment like `x = 5` without a prior `let`/`const` is not a declaration.
