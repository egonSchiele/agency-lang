---
name: "Names, scope, and reserved words"
---

# Names, scope, and reserved words

<a id="ag4001"></a>

## AG4001 — '&#123;name&#125;' shadows an imported function.

*Default severity: warning.*

A local name here has the same name as a function you imported, so the local shadows the import within this scope. That is legal but often unintended, so it is flagged as a warning.

**How to fix:** rename the local if you meant to keep using the import, or ignore the warning if the shadow is deliberate.

<a id="ag4002"></a>

## AG4002 — '&#123;name&#125;' is a reserved built-in; cannot be redefined.

*Default severity: error.*

The name is a reserved built-in and cannot be redefined. Built-ins are part of the language surface; redefining one would make its ordinary uses ambiguous.

**How to fix:** choose a different name for your definition.

<a id="ag4003"></a>

## AG4003 — '&#123;name&#125;' is a reserved built-in type; cannot be redefined.

*Default severity: error.*

The name is a reserved built-in type and cannot be redefined for the same reason built-in functions cannot: its ordinary uses must stay unambiguous.

**How to fix:** pick a different type name.

<a id="ag4004"></a>

## AG4004 — Function '&#123;name&#125;' is not defined.

*Default severity: error.*

A function was called that has no definition in scope and is not a built-in. The checker resolves every call against the functions visible in the file plus its imports.

**How to fix:** define the function, import it from the module that provides it, or fix a typo in the call.

<a id="ag4005"></a>

## AG4005 — Cannot reassign to constant '&#123;name&#125;'.

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

## AG4006 — `&#123;keyword&#125;` is a reserved block keyword. Write `&#123;keyword&#125; &#123; ... &#125;` or `&#123;keyword&#125;(args) &#123; ... &#125;` directly — the `as` keyword is not supported on &#123;keyword&#125; blocks (there's nothing to bind).

*Default severity: error.*

This keyword introduces a block directly — you write it followed by braces (or parentheses then braces) — and it does not support an `as` binding, because there is nothing to bind. The `as` here is not valid on this block form.

**How to fix:** write the block without `as`, e.g. the keyword followed immediately by its `{ ... }` body.

<a id="ag4007"></a>

## AG4007 — Variable '&#123;name&#125;' is not defined.

*Default severity: error.*

The type checker walks every scope — nodes, function bodies, blocks — and resolves each name to a declaration. This error means a name was used with no `let`, `const`, parameter, or import that introduces it in reach.

**How to fix:** declare it before use (`let x = …` / `const x = …`), fix a typo in the name, or import it if it lives in another module. Agency has no implicit variables: a bare assignment like `x = 5` without a prior `let`/`const` is not a declaration.

<a id="ag4008"></a>

## AG4008 — '&#123;name&#125;' is not defined in '&#123;module&#125;'.

*Default severity: error.*

An import names a symbol that its target Agency module does not define. The checker resolves every `import { ... }` (and `import node { ... }`) against the actual exports of the file it points to, so a name the file never declares — often a typo, or a symbol that was renamed or removed — is an error.

**How to fix:** import a name the module actually defines, correct the spelling, or add the missing definition to the target file. Unlike an undefined bare call (which might be an uncatalogued JavaScript global), an Agency import is unambiguous, so this always errors.

<a id="ag4009"></a>

## AG4009 — Cannot find module '&#123;module&#125;'.

*Default severity: error.*

An import points at a module that does not resolve to any file. The path — a relative `./…` path, a `std::` module, or a `pkg::` package — was resolved the same way the compiler resolves it, and nothing exists there.

**How to fix:** correct the path, create the missing file, or install the package that provides it. Agency imports must resolve to a real module.

<a id="ag4010"></a>

## AG4010 — '&#123;name&#125;' is defined in '&#123;module&#125;' but is not exported. Add the 'export' keyword to its definition.

*Default severity: error.*

An import names a symbol that its target module defines but does not `export`. A plain `import { ... }` can only see `export`ed functions, types, and constants — a bare `def`/`type` without `export` is module-private. (Nodes are the exception: they are importable without `export`.) The compile path already rejects this; the type checker reports it too.

**How to fix:** add the `export` keyword to the definition in the target file, or import a symbol that is exported.
