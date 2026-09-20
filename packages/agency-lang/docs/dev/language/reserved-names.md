# Reserved names

A name that starts with two underscores belongs to the compiler and runtime. `__ctx` is the runtime context, `__self` is the current frame, and `__matchval_1` holds the result of a `match` used as a value. A user program may not declare one of these names or read one.

```
node main() {
  const __x = 1        // refused
  print(__ctx)         // refused
}
```

The rule stops a user's variable from colliding with a name the compiler makes. It also stops code that is not trusted from reading or writing the compiler's own variables. It applies to every Agency program, with or without `--agency-only`.

## What counts as reserved

`isReservedInternalName` in `lib/reservedNames.ts` decides. A name is reserved when it starts with `__`, with two exceptions:

- `__dirname`, which user code reads to find files next to the current one. A test checks that every `__` entry in `BUILTIN_VARIABLES` is an exception, so a new builtin cannot be added there and forgotten here.
- A hygienic rename such as `__hyg3_tmp`. Filling a template renames variables this way (`docs/dev/language/template-agency.md`). The filled code is printed, and often saved to a file that is compiled later, as `std::toolbox` does. So the parser has to accept these names in any file.

## The parser check

Lowering runs inside `parseAgency` and adds names such as `__matchval_1`. The check sits inside the parser because the parser sees only what the user typed.

Three parsers in `lib/parsers/parsers.ts` carry it:

- `variableNameParser` reads a variable in an expression, an assignment target, or a pattern.
- `identifierParser` reads every other name: the function in a call, a parameter, a type, an import, a loop variable, a block parameter.
- `declNameParserFor` reads the name after `def` or `node`.

**When you add grammar that reads a name, use `identifierParser` or `variableNameParser`.** A bare `many1WithJoin(varNameChar)` skips the check.

Some positions hold a string that is not a variable, and they stay unchecked:

- an object key, `{ __typename: "User" }`
- a property or method name after a dot, `user.__typename`. JSON from an outside service can carry such keys.
- an object pattern key, and a property name in an object type
- the exported name in `import { __malloc as alloc } from "./glue.ts"`. Only the alias is bound in Agency scope, and this is the way to reach a JS export with such a name.
- a hole name, a tag name, a named-argument label, and an effect name

### The refusal throws

`refuseReservedName` throws a `TarsecError`. It does not return a committed failure, as most refusals in the parser do. tarsec's expression builder treats a right operand that fails as the end of the expression, and discards any committed failure recorded while reading it. With a returned failure, `1 + f(__ctx)` reported "expected node body" with no position.

Because it throws, a checked parser must not run as a guess at a position where a `__` name is legal. For example, a method name after a dot is read by `methodCallParser`, which does not check. If a new legal position fails with this error, look for a checked parser being tried there first. The "still accepts" cases in `reservedNames.test.ts` cover the legal positions.

## Code the parser never sees

- **Template fills.** `fill(t, { name: "..." })` turns a string into a declaration name without parsing it. `identifierFillFor` in `lib/runtime/template/fill.ts` calls `isReservedInternalName`.
- **Splices.** A splice pastes a `Code` tree into the file. `Code` is a plain record, so a generator can build one by hand. The graft in `lib/preprocessors/expandSplices.ts` refuses a reserved name as `AG8017`.

The splice check uses `findReservedName` in `lib/utils/findReservedName.ts`. It walks the whole tree and treats every string field as a name, except the fields listed in `DATA_FIELDS`, which are the unchecked positions above. A node kind added later is checked without anyone listing it. If the new kind holds data, the walk refuses a legal program, and the fix is one entry in `DATA_FIELDS`.

The walk and the parser are tested against the same sources, in `lib/parsers/reservedNames.cases.ts`. Add a case there when you add a position.

`runCode` needs no check. It prints the `Code` value and parses the text.

## Agency text the compiler writes

Some compiler code writes Agency source and parses it, such as the splice runner in `lib/compiler/splice/runGenerator.ts`. That text goes through the same parser, so it cannot use a `__` name. Give it an ordinary name. Do not add a way to switch the check off, because code that is not trusted could then reach the switch too.
