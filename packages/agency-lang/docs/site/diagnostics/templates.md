---
name: "Code templates and holes"
---

# Code templates and holes

<a id="ag8001"></a>

## AG8001 — This file is a template with unfilled holes (&#123;names&#125;) and cannot be run directly. Load it with `loadTemplate` and fill it first.

*Default severity: error.*

This file contains template holes (`#name`), which mark gaps for code or values to be filled in later. A file with unfilled holes is a template, not a program, so it cannot be compiled or run directly.

**How to fix:** load the file with `loadTemplate`, fill every hole with `fill`, and run the completed program (for example with `runCode(toSource(filled))`). Use `holesOf` to list what still needs filling.

<a id="ag8002"></a>

## AG8002 — The hole `#&#123;name&#125;` is in a position that gives it no expected type. Annotate it, for example `#&#123;name&#125;: string`.

*Default severity: error.*

An expression hole normally takes its type from its position — in `const x: string = #text`, the hole is a string. This hole sits in a position that supplies no type, so nothing constrains what may fill it.

**How to fix:** annotate the hole inline:

```agency
node main() {
  const x = #mystery: string
  return x
}
```
