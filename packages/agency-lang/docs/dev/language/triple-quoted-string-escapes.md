# Escapes in triple-quoted strings

A triple-quoted string is raw: `\n` is a backslash and an `n`, and quotes
need no escaping. Two sequences are the exception, because the text they
stand for would otherwise change what the string means:

```
"""
Write "Hello, \${name}" to greet someone.
Put a \""" docstring at the top of the body.
"""
```

- `\${` is the text `${`. Written bare, `${` opens an interpolation.
- `\"""` is the text `"""`. Written bare, `"""` closes the string. Under the
  `'''` spelling the escape is `\'''`.

Every other backslash stays as it is.

## Where the rule lives

Three places must agree, or a string changes meaning on the next parse:

- The parser decodes both escapes in `multiLineStringTextSegmentParserFor`
  (`lib/parsers/parsers.ts`). The escape parsers run before the raw-char
  parser, so the `${` or `"""` they cover is consumed as text.
- The generator re-escapes both when it prints a text segment,
  `escapeMultiLineText` in `lib/backends/agencyGenerator.ts`. This is what
  makes `agency fmt` and the optimizer's writeback safe.
- The optimizer's decoded target value keeps both escaped,
  `promptSegmentsToString` in `lib/optimize/targets.ts`. The value is what
  the mutator model reads and what its proposal is parsed back from. Before
  this rule, a bare `${` there became a live interpolation of a name that
  did not exist, and the first optimize run over the coding suite crashed on
  it. `sourceMutator.ts` also escapes a bare `"""` the model sends before
  wrapping a proposal in a block, and unescapes `\"""` again when it falls
  back to a `"..."` string.

## Why `\"""` exists

The coding agent's system prompt explains docstrings, so it contains `"""`.
Before the escape, the optimizer could only write that prompt back as one
10,000-character `"..."` line with `\n` escapes. With it, the prompt is a
block again.

Tests: `lib/parsers/literals.test.ts` (decode), `lib/backends/agencyGenerator.test.ts`
(emit and re-parse), `lib/optimize/sourceMutator.test.ts` (writeback in both
the block and the `"..."` form).
