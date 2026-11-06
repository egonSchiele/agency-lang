# Statement boundaries

A statement must be the last thing on its line. A second statement on the same line needs a `;` before it.

```ts
print(1); print(2)   // two statements
print(1) print(2)    // parse error
const x = 1.2.3      // parse error, pointing at `.3`
```

## Why the check exists

A statement parser stops where its statement ends, and the block parser then reads whatever comes next as the next statement. It never asked whether a line had ended in between. So in `const x = 1.2.3` the number parser stopped after `1.2`, and `.3` was read as a second statement that did nothing. The program ran with `x` equal to `1.2`, and nothing told the author.

The same thing happened to a misspelled keyword. `global let threshold = 10` was read as the bare name `global` followed by `let threshold = 10`.

## How it works

`statementOnItsLine` in `lib/parsers/parsers.ts` wraps the statement parser. Block bodies use it (`_bodyParserImpl`), and so does the top level of a file (`nodeParser` in `lib/parser.ts`).

After a statement is read, `endsItsLine` decides whether it may be followed by more text. It may when any of these holds:

- The text the statement took ends with a line break or a `;`. Most statement parsers take their own line ending.
- What follows is a line break, a `}`, a `//` comment, or the end of the text.
- The statement is a comment or a tag. A tag such as `@validate(...)` may sit on the line of the declaration it describes.

A `/* ... */` comment after a statement does not end its line. The check skips any block comments (`pastBlockComments`) and looks at what comes after them, so `print(1) /* note */ print(2)` is refused and `print(1) /* note */` is not.

Otherwise more text follows on the same line, and there are two cases.

1. **The text reads as one or more statements that run to the end of the line.** This is the silent case, and the parser reports it at the start of that text. `readsAsStatements` decides it.
2. **The text does not read as statements.** In `const broken =` the parser reads `const` and `broken` as bare names and cannot read `=`. The check stays out of it, and the block's closing `}` reports the unreadable statement at the `=`, as it did before the check existed. Reporting case 1 here would point at `broken`, which is further from the mistake.

## The three messages

`textAfterStatementMessage` picks the message for case 1. The general one, `TEXT_AFTER_STATEMENT_MESSAGE`, tells the author to add a `;`. Two mistakes get their own, because a `;` would not help:

- **`with` after a statement that cannot take it** (`WITH_NOT_ALLOWED_HERE_MESSAGE`). `foo() with myHandler` and `match(x) { ... } with approve` both used to run with no handler: the words after the statement were read as bare names. The message says what `with` accepts and shows the `handle` block.
- **A bare name before a statement** (`NAME_BEFORE_STATEMENT_MESSAGE`). In `global let x = 1` the author meant `global` as a keyword. The message names the word.

## What it does not catch

The check looks only at the end of the text a statement took. A statement that spans several lines ends with a line break, so nothing here looks inside it.
