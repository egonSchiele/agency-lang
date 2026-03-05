# Ohm.js Parser Spike

## Overview

Exploring whether Ohm.js is a viable replacement for the tarsec parser combinator library. A spike was built covering a subset of the language — literals, binary ops, function calls, access chains, and data structures — to validate the approach.

## Files

- `lib/parsers/ohm/agency.ohm` — Ohm grammar (~115 lines)
- `lib/parsers/ohm/semantics.ts` — CST-to-AST semantic actions producing the same AST types from `lib/types/`
- `lib/parsers/ohm/index.ts` — Entry point exporting `parseWithOhm(input: string): AgencyNode`
- `lib/parsers/ohm/ohm.test.ts` — 59 tests covering the spike subset

## Source Location Tracking

Every parse node has a `source` property (an `Interval` object) with:

- **`startIdx` / `endIdx`** — character offsets in the input
- **`getLineAndColumn()`** — returns `{ lineNum, colNum, offset, line, prevLine, nextLine }`
- **`contents`** — the matched substring
- **`getLineAndColumnMessage()`** — formatted string for display

Example in a semantic action:

```ts
const loc = this.source.getLineAndColumn();
// { lineNum: 1, colNum: 5, offset: 4, line: "...", ... }
```

This gives everything needed for "go to symbol" in editors.

## Custom Error Messages

Two mechanisms:

### Rule descriptions

Add a parenthesized description after a rule name:

```
number (a number) = digit+
ident (an identifier) = letter+
```

When parsing fails, ohm-js uses these descriptions in error messages instead of raw rule names: `expected "}" or an identifier` instead of `expected "}" or ident`.

### MatchFailure API

When `match()` fails, you get:

- `message` — full error with line excerpt and caret pointing to the error position
- `shortMessage` — one-liner version
- `getRightmostFailurePosition()` — character offset of failure
- `getRightmostFailures()` — array of `Failure` objects you can inspect to build fully custom messages

For example, `{ foo: 42` (missing `}`) produces:

```
Line 1, col 10: expected "}"
```

You can also inspect the failures array and map specific patterns to friendlier messages (e.g., "Did you forget a closing brace?").

## Interval Object API

Full list of methods on `source` (the Interval object):

- `startIdx`, `endIdx` — character offsets
- `contents` — matched substring
- `length` — length of interval
- `getLineAndColumn()` — returns `{ offset, lineNum, colNum, line, prevLine, nextLine }`
- `getLineAndColumnMessage()` — formatted string for display
- `coverageWith(...others)` — combine intervals
- `collapsedLeft()` / `collapsedRight()` — zero-width interval at start/end
- `minus(other)` — subtract an interval
- `relativeTo(other)` — make relative to another interval
- `trimmed()` — trim whitespace
- `subInterval(offset, len)` — sub-interval

## References

- [Ohm API Reference](https://ohmjs.org/docs/api-reference)
- [Ohm Syntax Reference](https://ohmjs.org/docs/syntax-reference)
- [Ohm GitHub](https://github.com/ohmjs/ohm)
