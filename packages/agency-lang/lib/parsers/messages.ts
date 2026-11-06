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

/** `"${if a then b else c}"`. Without this check the parse fails somewhere
 *  far from the string, with a message about the enclosing block. */
export const IF_IN_INTERPOLATION_MESSAGE = `an \`if ... then ... else\` expression cannot go inside \`\${...}\`. Give it a name first:

  const size = if count > 3 then "big" else "small"
  const label = "value: \${size}"`;

export const BODY_RESERVED_MODIFIER_MESSAGE =
  "`static` and `export` declarations are only supported at module top level. " +
  "Inside function and node bodies, use `optimize const ...` for optimizable local declarations or ordinary `const`/`let` declarations.";

/** A `def` or `node` name with whitespace inside it. Without this check the
 *  parser accepts `def foo bar(` with the name "foo bar", and the first thing
 *  to object is esbuild, deep in the generated TypeScript. */
export const DECL_NAME_SPACES_MESSAGE = (keyword: string, name: string): string =>
  `a ${keyword} name cannot contain spaces: \`${name}\``;

/** The same mistake when the first word is a modifier: the author wrote
 *  `def handoff getCapital(` and meant `handoff def getCapital(`. */
export const MODIFIER_AFTER_KEYWORD_MESSAGE = (
  modifier: string,
  keyword: string,
  name: string,
): string => `\`${modifier}\` goes before \`${keyword}\`:

  ${modifier} ${keyword} ${name}(...)`;

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

/** `await x` or `sync x`, the prefixes the old async runtime used to wait
 *  for an `async` call. The call now finishes before its value is read. */
export const REMOVED_ASYNC_PREFIX_MESSAGE = (word: string): string =>
  `Agency has no \`${word}\`. An \`async\` call has finished by the time you read its value, ` +
  `so write \`x\`, not \`${word} x\`.`;

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

export const NON_NULL_ASSERTION_MESSAGE = `Agency has no \`!\` after a value. \`!\` belongs to a type, as in \`const n: number! = 42\`. Reading an item of a list or an object gives a value that may be null, so check for null:

  const last = items[items.length - 1]
  if (last == null) {
    return "empty"
  }`;

export const JS_REGEX_MESSAGE = `Agency writes a regex literal as \`re/.../\`, not \`/.../\`:

  const lines = text.split(re/,\\s*/)`;

export const UNREADABLE_STATEMENT_MESSAGE =
  "cannot read the statement that starts here. If the block is finished, close it with `}`";

export const TEXT_AFTER_STATEMENT_MESSAGE =
  "the statement before this has ended, and this text is still on its line. Put it on its own line, or put `;` before it";

/** A bare name with a statement after it on the same line, such as
 *  `global let x = 1` or `safe def f()`. The author meant the name as a
 *  keyword, and Agency read it as a statement of its own. */
export const NAME_BEFORE_STATEMENT_MESSAGE = (name: string): string =>
  `\`${name}\` cannot start a statement here, so it was read as a name on its own, and this text as a second statement on its line. If \`${name}\` was meant as a keyword, remove it or check its spelling`;

/** `interrupt` or `raise` followed by a line break or a comment. The rest of
 *  the interrupt is on the next line, or missing. Read as two statements, the
 *  next line would run with no interrupt in front of it. A block comment is
 *  refused even when it closes on the same line, because it can hide a line
 *  break. */
export const INTERRUPT_KEYWORD_ALONE_MESSAGE = (keyword: string): string =>
  `\`${keyword}\` must be followed by the rest of the interrupt on the same line, with no comment in between. An interrupt cannot be split across two lines:

  ${keyword} deploy("Ship it?", {})`;

/** A `def`, a `node`, an import, or a re-export named `raise` or `interrupt`. The text
 *  `raise(...)` always raises an interrupt, so the function could be declared
 *  and never called. */
export const INTERRUPT_KEYWORD_AS_NAME_MESSAGE = (keyword: string): string =>
  `\`${keyword}\` cannot be the name of a function or a node, or a name in an import or an export. \`${keyword}(...)\` always raises an interrupt, so it would never call one. Use another name. To import a JavaScript function that has this name, rename it in the import:

  import { ${keyword} as ${keyword}FromJs } from "./helper.js"`;

/** `with` after a statement that cannot take it: `foo() with myHandler`, or
 *  `with approve` after a `match` block. Without this the words after the
 *  statement were read as bare names and the statement ran with no handler. */
export const WITH_NOT_ALLOWED_HERE_MESSAGE = `\`with\` cannot go here. After a call, an assignment, or a \`return\`, it takes \`approve\`, \`reject\`, or \`propagate\` and nothing else. To use a handler of your own, or to cover any other statement, write a \`handle\` block:

  handle {
    read("./notes.md")
  } with myHandler`;

export const DECLARATION_WITHOUT_VALUE_MESSAGE = `a \`let\` or \`const\` needs a value. Agency has no declaration without one:

  let subject: string = ""

To set it in an \`if\`, give it a starting value first, or use an \`if ... then ... else\` expression as the value.`;

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

An arm is \`pattern => expression\`, with an optional \`if (...)\` guard before the arrow. Use a block when an arm needs several statements. \`_\` is the catch-all, and an open type such as \`string\` requires one.

An object as an arm's value needs parentheses, \`ok => ({ done: true })\`, because a bare \`{\` opens a block.`;

export const HANDLER_BODY_MESSAGE = `expected \`{\` to open handler body:

  handle {
    read("./notes.md")
  } with (intr) {
    if (intr.effect == "std::read") { return approve() }
    return reject()
  }

The handler takes the interrupt and returns \`approve()\`, \`reject()\`, \`propagate()\` or \`pass()\`. \`with approve\` is shorthand for a handler that approves everything.`;

export const EMPTY_HANDLER_BLOCK = `a handler needs at least one \`on\` clause:

  handle {
    read("./notes.md")
  } with {
    on std::read(data) { approve() }
    on _ { reject() }
  }

Each clause names an effect and returns \`approve()\`, \`reject()\`, \`propagate()\` or \`pass()\`.`;

export const MALFORMED_ON_CLAUSE = `a handler clause must look like \`on <effect>(param) { ... }\`:

  handle {
    read("./notes.md")
  } with {
    on std::read(data) { approve() }
    on _ { reject() }
  }

Each clause opens with \`on\`, names an effect, and has a \`{ ... }\` body.`;

export const CATCH_ALL_NOT_LAST = `\`on _\` matches every effect, so it must be the last clause:

  handle {
    read("./notes.md")
  } with {
    on std::read(data) { approve() }
    on _ { reject() }
  }

Any clause after \`on _\` can never run.`;

export const DUPLICATE_ON_CLAUSE = (effect: string): string =>
  `each effect may appear once in a handler — \`on ${effect}\` is repeated:

  handle {
    read("./notes.md")
  } with {
    on std::read(data) { approve() }
    on std::write(data) { reject() }
  }

Give each clause a different effect, or merge the two into one.`;

export const ASYNC_BLOCK_MESSAGE = `\`async\` cannot mark a block. In Agency, \`async\` starts a call that runs beside the
statements after it, so it goes on a call statement:

  map(xs, (x) => summarize(x))          // a block: no \`async\`
  let summary = async summarize(text)   // a call that runs beside what follows

Remove \`async\` from the block. Every call inside it is awaited already.`;

export const BLOCK_AS_VALUE_MESSAGE = `Agency blocks are arguments, not values, so a block cannot be assigned to a variable:

  const double = (n) => n * 2      // not allowed
  const doubled = map(xs, (n) => n * 2)

Pass the block directly to the function that takes it. If you want a reusable
function, declare one with \`def\`:

  def double(n: number): number { return n * 2 }
  const doubled = map(xs, double)`;
