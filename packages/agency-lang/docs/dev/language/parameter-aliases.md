# Parameter aliases: `def fetch(baseUrl | url: string)`

An alias is a misspelling the tool forgives. It is not a second name for the parameter. Every decision below follows from those two sentences. The ticket is ADI-41.

## Why

In trace wX5GvrUq a model called `fetch` with `url` instead of `baseUrl`, twice, and each miss cost a tool round. Models guess common names. An alias lets the function accept the guess without renaming the parameter, and without the model ever being told about it.

## What an alias is, and is not

```
def fetch(baseUrl | url | href: string | null, path: string = "")
```

`baseUrl` is the parameter's name. `url` and `href` are aliases. After the colon, `|` is still a union type. The parser accepts aliases on `def` parameters only, including variadic ones (`...rest | items: string[]`); node parameters and the inline handler parameter in `with (intr) { }` use the plain parser, because nothing would ever forgive an alias there (a node is not an `AgencyFunction`, and `goto` is lowered at compile time). A `|` after a node or handler parameter name is a parse error that says so.

Inside the body, `url` is not a variable. The tool schema lists `baseUrl`. The "Unknown named argument" message lists `baseUrl`. `@param` lines use `baseUrl`. `agency fmt` prints the aliases back, and `agency doc` shows them on the signature and as `baseUrl (also `url`)` in the parameter table, since a reader deciding whether to add one wants to see what exists.

## Every named call reaches the runtime

It is tempting to think Agency source calls are lowered at compile time and only the type checker needs to refuse an alias. That is true only for `goto` to a node (`resolveNamedArgs` in `lib/backends/typescriptBuilder/namedArgsResolver.ts`). A function call with named arguments is compiled by `buildCallDescriptor` in `typescriptBuilder.ts` into a descriptor:

```ts
fetch.invoke(__run, { type: "named", positionalArgs: [], namedArgs: { url: x } })
```

and `resolveNamed` in `lib/runtime/agencyFunction.ts` binds it at runtime. The type checker is off by default, so if `resolveNamed` forgave every alias, `fetch(url: x)` in Agency source would compile and run, and the alias would be a second name after all.

So forgiveness is opt-in per call. The named descriptor has a `forgiveAliases` flag. Two callers set it, both of which take their arguments from outside the program:

| Caller | Where the descriptor is built |
|---|---|
| A model calling a tool | `prompt.ts`, the tool invoke |
| Served HTTP, MCP, and `agency run` with arguments | `runExportedFunctionCore` in `lib/runtime/node.ts` |

Generated code never sets the flag. For a call without it, an alias key is an error that names the parameter: `'url' is an alias of 'baseUrl' in call to 'fetch'; use 'baseUrl'.` The type checker reports the same mistake earlier, as AG6042, from `checkNamedArgStructure` in `checker.ts` and from the `.partial()` check in `synthesizer.ts`. `.partial()` at runtime binds by name only and never learns aliases.

## One helper, three callers

`lib/utils/parameterAliases.ts` is the one place that answers "which parameter does this key name, and did it get there through an alias?". `parameterForKey` does the lookup; `canonicalKeys` returns the arguments with alias keys renamed, the list of renames, and a conflict message or `null`. Both are pure and never throw, and `canonicalKeys` is idempotent. The checker, the synthesizer, and the runtime all call them, over the shape `{ name, aliases? }` that `FunctionParameter` and `FuncParam` share, so the answer cannot drift between layers.

`resolveNamed` is the only place that decides what a result means for a caller. With `forgiveAliases` it uses the corrected arguments and throws the conflict (`Both 'baseUrl' and 'url' were given for parameter 'baseUrl' in call to 'fetch'. Pass one.`). Without the flag, any rename is itself the error. Either throw happens inside argument binding, so it carries the `preExecution` tag and the tool loop reports it as a failure that never ran. A conflict counts toward the tool's error count the way other pre-execution failures do.

A `null` value under an alias key counts as absent: it is dropped and never conflicts, because a model sends `null` for a parameter it means to leave out.

## The tool-loop gate never throws

`gateInputFor` in `prompt.ts` runs inside the `runnableHandoffs` and `gateVerdicts` steps and at the start of each dispatch. A throw there escapes `runPrompt` and fails the whole `llm()` call, with no tool result for any call in the round. So the gate calls `AgencyFunction.canonicalizeNamedArgs`, a one-line wrapper over `canonicalKeys`, and uses `args` and `corrections` while ignoring `conflict`. On a conflict the arguments stay as the model wrote them, and the invoke reports the conflict through the ordinary failure path.

The gate corrects first, and derives everything else from the corrected arguments: the null-default drop and the markup check match keys by parameter name, and the repeat key must be the same for `fetch(url: x)` and `fetch(baseUrl: x)`. So three identical calls mixing the two spellings trip the repeated-call refusal, and a call rejected under one spelling is `priorRejected` under the other. `resolveNamed` corrects again inside the invoke; the helper is idempotent, so the two agree by construction.

## What the records show

The `toolCallStart` and `toolCall` log events carry the corrected arguments and, when a key was renamed, `argCorrections: [{ from: "url", to: "baseUrl" }]`. That field is the signal for which aliases are earning their keep and which parameters still need one. The `onToolCallStart` and `onToolCallEnd` callbacks and the debugger's stops see the corrected arguments too. The model's own `toolCall` object is untouched, because its `arguments` are what the message history refers to.

## Schemas must never be strict

A provider in strict mode refuses an argument key that is not in the schema before the runtime sees it, and aliases are dead. The zod schema Agency builds does carry `additionalProperties: false` (zod adds it to every object), but the feature does not depend on that field. smoltalk's tool converters rebuild the top level per provider, and with its `strict` default of `false`, OpenAI gets `additionalProperties: true`, Anthropic gets no field, and Google has it deleted. The constraint, recorded at the `tools` line of `toSmolConfig` in `lib/runtime/llmClient.ts` and pinned by a test, is that Agency never passes `strict: true`.

Two paths skip smoltalk. The plain OpenAI client sends the raw schema without `strict`, so OpenAI does not enforce it. The MCP server used to send the raw schema in `tools/list`, and an MCP client that validates arguments against it would have refused `url`. `schemaToJsonSchema` in `lib/serve/mcp/adapter.ts` now drops the top-level `additionalProperties` for every tool, the way smoltalk does for a non-strict OpenAI tool.

## Codegen

The `params` metadata emitted by `buildFunction` in `typescriptBuilder.ts` carries `aliases` only when a parameter has some, so the generated code of a program without aliases is unchanged. Its neighbours (`variadic`, `isFunctionTyped`) are written on every parameter. An `AgencyFunction` works out once, in its constructor, whether any unbound parameter has aliases; a named call to a function without any skips the alias pass.

## Departures from the ticket

The ticket's first draft said `.partial()` accepts an alias and that an Agency-to-Agency call written with an alias type-checks as the canonical name. Both treated the alias as a real name, and both were reversed. The ticket's second motivation, "aliases keep callers working when a parameter is renamed", depended on source calls accepting aliases and was dropped; painless renames would be a different feature.

## Files

- `lib/utils/parameterAliases.ts`: the helper.
- `lib/parsers/parsers.ts`: `defParameterParser` and `defVariadicParameterParser`.
- `lib/typeChecker/index.ts` (`checkParameterAliases`, AG2022), `checker.ts` and `synthesizer.ts` (AG6042).
- `lib/runtime/agencyFunction.ts`: `forgiveAliases`, `canonicalizeNamedArgs`, `namedArgsWithoutAliases`.
- `lib/runtime/prompt.ts` (`gateInputFor`, the tool invoke, the two log records), `lib/runtime/node.ts`, `lib/statelogClient.ts`.
- `lib/serve/mcp/adapter.ts`, `lib/runtime/llmClient.ts`.
- `lib/backends/agencyGenerator.ts`, `lib/cli/doc.ts`, `lib/backends/typescriptBuilder.ts`.
- Tests: `lib/utils/parameterAliases.test.ts`, `lib/typeChecker/parameterAliases.test.ts`, the alias blocks in `agencyFunction.test.ts`, `toolLoopGuards.test.ts`, `llmClient.test.ts`, `adapter.test.ts`, `functionFrame.integration.test.ts`, `agencyGenerator.test.ts`, `doc.test.ts`, `toolSchemaContribution.test.ts`, the fixture `tests/typescriptGenerator/parameterAliases.agency`, and the execution test `tests/agency/parameter-aliases.agency`.
