---
name: "Match and narrowing"
---

# Match and narrowing

<a id="ag5002"></a>

## AG5002 — match is not exhaustive: missing &#123;missing&#125;.

*Default severity: error.*

A `match` over a union or Result must handle every case the scrutinee can take; the checker computes the set of arms you covered and reports the ones missing. An unhandled case would fall through at runtime with no branch to run.

**How to fix:** add an arm for each listed missing case, or add a wildcard `_` arm if a catch-all is genuinely what you want.

```agency
node main() {
  const r = compute()
  match (r) {
    is success(v) { print(v) }
    is failure(e) { print(e) }
  }
}
```

<a id="ag5003"></a>

## AG5003 — `&#123;name&#125;` here binds the value; it does not test the type. Did you mean `p: &#123;name&#125;` or `is &#123;name&#125;`?

*Default severity: warning.*

An un-guarded match arm whose left side is a bare name matches ANY value and binds it to that name — it never tests the type, even when the name is a type in scope. Writing `Person => ...` therefore does something very different from testing "is this a Person".

**How to fix:** to test the type and bind, write `p: Person => ...`; to test only, write `is Person => ...`; to genuinely bind whatever arrives, pick a name that is not a type.

<a id="ag5004"></a>

## AG5004 — `&#123;field&#125;: &#123;name&#125;` here binds the `&#123;field&#125;` field to a variable called `&#123;name&#125;`; it does not test the field type. Field-level type tests are not supported — test the whole value with a typed pattern instead.

*Default severity: warning.*

Inside an object pattern, `{field: name}` binds the field to a new variable called `name` — it does not test the field's type, even when the name is a type in scope. `{name: string}` binds the `name` field to a variable called `string`.

**How to fix:** field-level type tests are not supported; test the whole value against a typed shape instead (`p: Person => ...` or an inline object type), or pick a binder name that is not a type.
