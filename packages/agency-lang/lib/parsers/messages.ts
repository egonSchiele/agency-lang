/**
 * Parse-error messages that name an Agency replacement for something the
 * author wrote.
 *
 * These live apart from the grammar because they are prose, not parsing: they
 * are the longest strings in the parser and they change for editorial reasons
 * rather than syntactic ones.
 *
 * **Indent every code example by exactly two spaces.** `errorExamples.test.ts`
 * extracts examples from these strings by that indentation and asserts each one
 * is valid Agency. An example that does not parse teaches the wrong thing to
 * precisely the reader who is already stuck, so the test reads the real string
 * rather than a transcription of it.
 */

export const BODY_DECLARATION_MESSAGE =
  "`node`, `def` and `function` declarations are only legal at the top level of a file.";

export const BODY_RESERVED_MODIFIER_MESSAGE =
  "`static` and `export` declarations are only supported at module top level. " +
  "Inside function and node bodies, use `optimize const ...` for optimizable local declarations or ordinary `const`/`let` declarations.";

export const STATIC_LET_MESSAGE =
  "`static let` is not allowed. Use `static const <name> = ...` for a " +
  "once-per-process binding, or `static <expr>` (e.g. `static foo()`) " +
  "for a once-per-process side effect.";

export const STATIC_ASSIGN_MESSAGE =
  "`static <name> = ...` is not allowed. Use `static const <name> = ...` " +
  "for a once-per-process binding, or `static <expr>` (e.g. `static foo()`) " +
  "for a once-per-process side effect.";

export const STATIC_INNER_MESSAGE =
  "`static` at top level must be followed by `const <name> = ...` " +
  "or an expression statement (e.g., `static foo()` or " +
  "`static logger.flush()`).";

export const RESERVED_CLASS_MESSAGE =
  "`class` definitions are no longer supported in Agency. " +
  "Use functions and plain objects instead, or instantiate an imported " +
  "JS class with `new Foo(...)`.";

export const INTERFACE_EXTENDS_MESSAGE =
  "Agency has no interface inheritance. Write `type Foo = Bar & { ... }` instead.";

export const SWITCH_MESSAGE = `Agency has no \`switch\` statement. Use a \`match\` block instead:

  match (x) {
    "a" => doThing()
    "b" => doOtherThing()
    _   => fallback()
  }

Arms do not fall through, so no \`break\` is needed, and \`match\` checks that you covered every case. \`_\` is the catch-all.`;

export const C_STYLE_FOR_MESSAGE = `Agency has no C-style \`for\` loop. To count, iterate a range:

  for (i in range(0, 10)) { print(i) }

To walk a collection, iterate it directly:

  for (item in items) { print(item) }
  for (item, i in items) { print(i, item) }

To build a list from another list, use a comprehension:

  const doubled = [x * 2 for x in items]

For a condition-driven loop, use \`while (cond) { ... }\`.`;

export const TERNARY_MESSAGE = `Agency has no ternary (\`? :\`). Use an \`if ... then ... else\` expression:

  const label = if isProd then "Production" else "Local"

The \`else\` is required. The expression is only allowed as a \`const\`/\`let\` value or a \`return\` — for anything more involved, use \`match\`.`;

export const IF_EXPRESSION_MESSAGE = `an \`if ... then ... else\` expression requires an \`else\` branch:

  const label = if isProd then "Production" else "Local"

This is Agency's replacement for the ternary, so it always produces a value and the \`else\` is not optional. It is allowed only as a \`const\`/\`let\` value or a \`return\`, and does not nest — use \`match\` for more than two cases.`;

export const MATCH_CASES_MESSAGE = `expected match cases of the form \`value => expression\`, separated by \`;\` or newlines, followed by \`}\`:

  match (shape) {
    { kind: "circle", r } => 3.14 * r * r
    { kind: "square", side } if (side > 0) => side * side
    _ => {
      print("unknown")
      return 0
    }
  }

An arm is \`pattern => expression\`, with an optional \`if (...)\` guard before the arrow. Use a block when an arm needs several statements. \`_\` is the catch-all, and an open type such as \`string\` requires one.`;

export const HANDLER_BODY_MESSAGE = `expected \`{\` to open handler body:

  handle {
    read("./notes.md")
  } with (intr) {
    if (intr.effect == "std::read") { return approve() }
    return reject()
  }

The handler takes the interrupt and returns \`approve()\`, \`reject()\`, \`propagate()\` or \`pass()\`. \`with approve\` is shorthand for a handler that approves everything.`;
