---
name: Troubleshooting
description: Solutions to common issues when using Agency, such as module-not-found errors from global installs and other gotchas.
---

# Troubleshooting

Here are some common issues you might run into when using agency, and how to solve them.

## Global install issue

If you get an error that looks like this:

```
node:internal/modules/package_json_reader:316
  throw new ERR_MODULE_NOT_FOUND(packageName, fileURLToPath(base), null);
        ^

Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'agency-lang' imported from /Users/foo/hello.js
    at Object.getPackageJSONURL (node:internal/modules/package_json_reader:316:9)
    at packageResolve (node:internal/modules/esm/resolve:768:81)
    at moduleResolve (node:internal/modules/esm/resolve:858:18)
    at defaultResolve (node:internal/modules/esm/resolve:990:11)
    at #cachedDefaultResolve (node:internal/modules/esm/loader:737:20)
    at ModuleLoader.resolve (node:internal/modules/esm/loader:714:38)
    at ModuleLoader.getModuleJobForImport (node:internal/modules/esm/loader:293:38)
    at #link (node:internal/modules/esm/module_job:208:49) {
  code: 'ERR_MODULE_NOT_FOUND'
}
```

You may have installed agency globally and tried to run an agent.

Two options:

Option 1: If you compiled and ran in separate steps like this:

```
agency compile foo.agency
node foo.js
```

Use the `run` command instead:

```
agency run foo.agency
```

Option 2: use `pack` to produce a standalone script:

```
agency pack foo.agency -o foo.mjs
./foo.mjs
```

- [More info on this issue here](/cli/run).
- [More info on pack here](/cli/pack).

## Debugging your agent

Turn on logging. Create an `agency.json` with this content:

```json
{
  "observability": true,
  "log": {
    "logFile": "logs.jsonl"
  }
}
```

Run your agent

```
agency run <filename>
```

Then view the logs

```
agency logs view logs.jsonl
```

## Syntax gotchas

Agency's parser has a few rules that surprise people coming from other
languages. If a file fails to parse or typecheck, check it against these
first:

- **No comments inside object or array literals.** A `//` or `/* */`
  comment placed *between* entries of an object/array literal fails to
  parse, and the reported error location is often misleading (it points
  at the enclosing declaration, not the comment). Move the comment above
  the literal.

  ```
  // BAD — comment between entries fails to parse
  const x = {
    a: 1,
    // the b field
    b: 2,
  }

  // GOOD — comment above the literal
  // the b field
  const x = { a: 1, b: 2 }
  ```

- **`if` / `while` / `for` require parentheses around the condition and
  braces around the body.** `if x > 5 { ... }` and `if (x > 5): ...` are
  both wrong; write `if (x > 5) { ... }`. `for` loops use `in`:
  `for (item in items) { ... }`.

- **No Python-style `def`/`node` headers.** Use
  `def foo(x: number): string { ... }` and `node main() { ... }`, not
  `function foo() -> string:` or `node main -> end:`.

- **Variables must be declared before use.** Bare assignment (`x = 5`)
  without a prior `let`/`const` is not allowed; write `let x = 5`.

- **Pattern binders can't bind inside a boolean expression.**
  `return r is success(v) && v.ok` is a parse error ("binder has nowhere
  to bind"). Use a statement form instead:

  ```
  if (r is success(v)) {
    return v.ok
  }
  ```

- **Avoid literal backslashes in string literals.** A backslash in a
  string literal can currently compile to invalid JavaScript. Prefer a
  regex character class (e.g. `re/[^a-zA-Z0-9]+/g`) over a string like
  `"\\"` when sanitizing text.

When in doubt, check the [Basic Syntax](/guide/basic-syntax) guide or run
`agency ast <file>` to see whether the file parses.