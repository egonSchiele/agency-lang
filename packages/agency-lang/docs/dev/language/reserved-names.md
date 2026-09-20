# Reserved names

A name that starts with two underscores belongs to the compiler and runtime. `__ctx` is the runtime context, `__self` is the current frame, and `__matchval_1` holds the result of a `match` used as a value. A user program may not declare one of these names or read one.

```
node main() {
  const __x = 1        // refused
  print(__ctx)         // refused
}
```

```
Line 2, col 9: `__x` is not a legal name: names starting with two underscores are reserved for the compiler.
```

The rule has two purposes. It stops a user's variable from colliding with a name the compiler makes. It also stops code that is not trusted from reading or writing the compiler's own variables.

The rule applies to every Agency program, including ones compiled without `--agency-only`.

## The one function

`isReservedInternalName` in `lib/reservedNames.ts` decides. A name is reserved when it starts with `__`, with two exceptions:

- `__dirname`. User code reads it to find files next to the current one. `lib/parsers/reservedNames.test.ts` checks that every `__` entry in `BUILTIN_VARIABLES` is an exception here, so adding a builtin there without adding it here fails a test.
- A hygienic rename, which looks like `__hyg3_tmp`. Filling a template renames variables this way to avoid capture (`docs/dev/language/template-agency.md`). Generated code is printed to source and parsed again before it runs, so the parser has to accept these names.

## Where it is enforced

### The parser

The parser is the main place, because the parser sees only what the user typed. Lowering runs inside `parseAgency`, straight after the parse, and it adds names such as `__matchval_1` and `__scrutinee_2`. A check on the finished tree would have to tell those apart from names the user wrote. A check inside the parser never sees them.

Three parsers in `lib/parsers/parsers.ts` carry the check:

- `variableNameParser` reads a variable in an expression, an assignment target, or a pattern.
- `userNameParser` reads every other name a user gives: the function in a call, a parameter, a type, a type parameter, an import, a loop variable, a block parameter.
- `declNameParserFor` reads the name after `def` or `node`.

**When you add grammar that reads a user's name, use `userNameParser` or `variableNameParser`.** A bare `many1WithJoin(varNameChar)` skips the check.

Some positions hold a name that is not a variable, and they stay unchecked:

- an object key, `{ __typename: "User" }`
- a property or method name after a dot, `user.__typename`. JSON from an outside service can carry such keys. GraphQL's `__typename` is one. `anyVariableNameParser` and `methodCallParser` exist for these two positions.
- an object pattern key, `const { __typename: t } = user`
- a property name in an object type
- a hole name, a tag name, a named-argument label, and an effect name

### The refusal is a throw

`refuseReservedName` throws a `TarsecError`. Most refusals in the parser return a committed failure instead, and this one did at first. That broke one case. tarsec's expression builder treats a right operand that fails as the end of the expression, and it discards any committed failure recorded while reading that operand. So `1 + f(__ctx)` parsed as `1`, the rest of the line failed to parse, and the user saw "expected node body" with no position.

A throw passes through the expression builder untouched. It is safe because no other reading of the text makes a reserved name legal, so there is no alternative worth trying. The function also records the failure in `getParseState().committedFailure`, which is where `parseAgency` takes the message and position from.

One consequence: a checked parser must not run speculatively at a position where a `__` name is legal. A method name after a dot went through `_functionCallParser` and threw on `o.__toJSON()`. That is why `methodCallParser` exists. The "still accepts" half of `reservedNames.test.ts` covers the legal positions.

### Template fills

`fill(t, { name: "..." })` turns a string into a declaration name without parsing it. `identifierFillFor` in `lib/runtime/template/fill.ts` calls `isReservedInternalName` itself.

### Splices

A splice pastes a `Code` tree into the file, and the tree is never parsed. Code from a `[| ... |]` literal or from `parseStatements` went through the parser when it was made. But `Code` is a plain record, and a generator can build one by hand:

```
return {
  type: "agencyProgram",
  kind: "statements",
  nodes: [{ type: "assignment", declKind: "const", variableName: "__self", value: { type: "number", value: "1" } }]
}
```

`checkNoReservedName` in `lib/preprocessors/expandSplices.ts` refuses this as `AG8017`. It looks at the names the fragment binds, declares, imports, reads, and calls. It collects them with the same helpers the capture check uses, so it shares their limits: a name bound by a `match` arm pattern or by `is success(v)` is not collected.

`runCode` needs no check of its own. It prints the `Code` value to source and parses that.

## The compiler's own Agency text

Some compiler code writes Agency source and parses it, and that source goes through the same parser as user code. It cannot use a `__` name either. Two places did:

- The splice runner named its node `__splice` so that it could not collide with an imported generator. `runnerNodeName` in `lib/compiler/splice/runGenerator.ts` now picks `runSplice`, or `runSplice1` and so on if the runner imports that name.
- The type checker builds the `Code` type by parsing a type alias, and named it `__CodeLiteralValue`. The alias name is discarded, so it is now `CodeLiteralValue`.

If a new piece of compiler code fails with this error, give its generated text an ordinary name. Do not add a way to switch the check off, because code that is not trusted could then reach the switch too.
