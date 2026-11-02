# Issue: ordinary tools do not advertise their return types

Confirmed on November 2, 2026, against Agency revision
`1cee8c0eeac39e874ca671f3b25e8e41d2acad71` and its pinned `smoltalk@0.20.2`.
This file records the issue. It does not implement a fix.

## Observed behavior

An Agency function's tool definition contains its name, docstring, and an
argument schema. The compiler does not add the declared return type to that
definition or its description. A model can learn the result shape from prose
the author wrote or from a completed call, but the type annotation alone does
not tell the model what the tool returns.

For example, a tool returning `{ found: boolean, count: number }` advertises
only its `query` argument in the reproduction below. This can make it harder
for a model to choose a tool or plan how to use its result. The size of that
effect has not been measured.

## Evidence through the request path

| Location | Verified behavior |
| --- | --- |
| [typescriptBuilder.ts:2122](../../../lib/backends/typescriptBuilder.ts#L2122), `buildToolDefinition` | Builds schemas from `parameters`. Emits `name`, trimmed `docString`, and `schema`. Does not read the function's return type. |
| [typescriptBuilder.ts:2663](../../../lib/backends/typescriptBuilder.ts#L2663), `processFunctionDefinition` | Stores that definition on the generated `AgencyFunction`. |
| [agencyFunction.ts:88](../../../lib/runtime/agencyFunction.ts#L88) and [llmClient.ts:7](../../../lib/runtime/llmClient.ts#L7), `ToolDefinition` | Both shapes contain only `name`, `description`, and `schema`. |
| [prompt.ts:554](../../../lib/runtime/prompt.ts#L554) and [prompt.ts:335](../../../lib/runtime/prompt.ts#L335) | Selects ordinary functions' existing definitions and passes them into `PromptConfig.tools`. Does not append return information. |
| [llmClient.ts:456](../../../lib/runtime/llmClient.ts#L456), `toSmolConfig` | Forwards `tools` unchanged to smoltalk. Both streaming and non-streaming calls use this conversion. |

The installed smoltalk package's `dist/util/tool.js` converts the argument
schema into OpenAI Chat `function.parameters` (line 3), OpenAI Responses
`parameters` (line 39), Anthropic `input_schema` (line 69), and Google
`parametersJsonSchema` (line 169). The corresponding clients call these
converters with the tool's name, schema, and description. They do not append a
return contract. These are observations about version 0.20.2's adapters, not a
claim that every provider has the same native schema features.

Three other schema paths have different purposes:

- [Typed `llm()` output](../../../lib/backends/typescriptBuilder.ts#L3878) sets `responseFormat` for the model's final answer. It does not describe each ordinary tool's result.
- [`saveDraft`](../../../lib/runtime/saveDraftTool.ts#L49) receives a synthesized **input** schema for its `value` argument. The compiler derives it from the enclosing function's return type through `draftSchema` ([typescriptBuilder.ts:3886](../../../lib/backends/typescriptBuilder.ts#L3886)). It describes the answer the model saves.
- MCP's `outputSchema` belongs to a separate protocol. Agency's [MCP server adapter](../../../lib/serve/mcp/adapter.ts#L250) currently advertises `inputSchema` only. The [MCP import adapter](../../../../mcp/src/toolAdapter.ts#L64) also builds ordinary metadata from the imported tool's input schema. MCP does not provide an existing return-schema path for these Agency tools.

Actual results still reach the model after execution. The runtime
[unwraps a successful `Result`](../../../lib/runtime/toolInvocation.ts#L34)
before [building the tool reply](../../../lib/runtime/prompt.ts#L1289).
A future description must account for this difference between an Agency
return type and the value the model sees.

## Deterministic reproduction

After building Agency, save this inside the package as
`.agency-build/prompt-cleanup/schema-probe.agency`:

```agency
type LookupResult = {
  found: boolean,
  count: number,
}

def lookup(query: string): LookupResult {
  """Look up matching records."""
  return { found: true, count: 3 }
}

node main() {
  return lookup("sample")
}
```

```bash
pnpm run compile --ts --strict --force .agency-build/prompt-cleanup/schema-probe.agency > .agency-build/prompt-cleanup/schema-compile.log 2>&1
rg -n -A5 'name: "lookup",' .agency-build/prompt-cleanup/schema-probe.ts
```

Compilation succeeds. The generated module contains the `LookupResult` Zod
alias. Its tool metadata is:

```ts
toolDefinition: {
  name: "lookup",
  description: `Look up matching records.`,
  schema: z.object({"query": z.string(), })
}
```

The description contains exactly the docstring. The metadata contains no
reference to `LookupResult`, `found`, or `count`. This check compiles code and
inspects metadata without calling a model.

## Expected behavior and acceptance criteria

The model should receive a useful description of an ordinary tool's result
before calling it when Agency knows the return type. The implementation needs
a provider-compatible representation. Adding a field to Agency metadata alone
would not make it visible to a provider. Do not assume a universal native
`outputSchema` field exists.

1. Cover a structured return type with a deterministic compiler and request-capture test. Verify what the model receives, including nested fields and a return alias imported from another file.
2. Preserve argument schemas and docstrings. Check renamed, partially applied, and described functions through the existing derivation paths.
3. Define how to describe success unwrapping, failures, missing return annotations, `any`, and types that cannot be represented as JSON Schema.
4. Check the supported provider adapters with captured requests. Use a documented fallback where a provider cannot accept a native result schema. Do not send unsupported request fields.
5. Keep typed `llm()` responses and `saveDraft` input schemas working. Treat MCP output schemas as a separate compatibility decision.

Changing execution, enforcing runtime return validation, and measuring model
quality are outside this issue's confirmation work.
