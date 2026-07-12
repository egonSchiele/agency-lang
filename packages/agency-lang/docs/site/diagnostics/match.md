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
